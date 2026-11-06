"""
Instructor analytics. Every number is derived from stored rows and says what it is:

  task_submission      % of the course's PUBLISHED assignments the student has submitted
  socratic_ai_usage    % of published assignments where the student had at least one Coach interaction
  observed_signal_rate % of published assignments with at least one OBSERVED structural review indicator.
                       The AI reports observations only ("pasted a long polished answer"); it never asserts that a student
                       used an external tool, so this is a prompt to look, not a finding.
  mastery              mean score over the student's completed verification results in this course
                       (Strong >= 0.75, Moderate >= 0.5, else Weak); None = not enough evidence yet.
  verification_rate    % of submitted assignments whose verification finished with PASS or PARTIAL
  average_grade        None unless instructors have graded work: mean percentage of each student's latest graded submission per assignment

Risk fields come from app/risk.py (deterministic, evidence-backed, computed on read). `overview` counts are plain SQL/roster counts:
  students / active_students (any learning event in the last 14 days) / assignments (published) / verifications_completed.
Every assessment is limited to the instructor's own course(s): assignment ids are derived from the courses passed in, never from the client.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import risk as risk_model
from .auth import CurrentUser
from .db import many, one
from .records import mastery_label
from .views import iso


def _pct(n: int, d: int) -> int:
    return round(100 * n / d) if d else 0


def _name(r) -> str:
    return (" ".join(p for p in (r.get("first_name"), r.get("last_name")) if p)) or (r.get("email") or "").split("@")[0]


def course_students(c, course_id: str, university_id: str) -> list[dict]:
    """Per-student rows for a course (active enrolments only)."""
    total = one(c, "SELECT count(*)::int AS n FROM assignments WHERE course_id=%s AND status='PUBLISHED'", (course_id,))["n"]
    rows = many(c, """
        WITH roster AS (
          SELECT DISTINCT u.user_id, u.first_name, u.last_name, u.email FROM enrollments e JOIN users u ON u.user_id = e.student_id
           WHERE e.course_id = %(c)s AND e.status = 'active' AND e.university_id = %(u)s),
        pub AS (SELECT assignment_id FROM assignments WHERE course_id = %(c)s AND status = 'PUBLISHED')
        SELECT r.*,
          (SELECT count(DISTINCT t.assignment_id) FROM attempts t WHERE t.student_id = r.user_id AND t.status = 'SUBMITTED' AND t.assignment_id IN (SELECT assignment_id FROM pub))::int AS submitted,
          (SELECT count(DISTINCT i.assignment_id) FROM ai_interactions i WHERE i.student_id = r.user_id AND i.assignment_id IN (SELECT assignment_id FROM pub))::int AS coached,
          (SELECT count(DISTINCT s.assignment_id) FROM risk_signals s WHERE s.student_id = r.user_id AND s.assignment_id IN (SELECT assignment_id FROM pub))::int AS signalled,
          (SELECT count(*) FROM risk_signals s WHERE s.student_id = r.user_id AND s.assignment_id IN (SELECT assignment_id FROM pub))::int AS signal_count,
          (SELECT avg(res.score)::float FROM verification_results res JOIN verification_questions q ON q.question_id = res.question_id
             JOIN verification_runs v ON v.verification_id = q.verification_id
            WHERE v.student_id = r.user_id AND v.assignment_id IN (SELECT assignment_id FROM pub) AND res.outcome <> 'INSUFFICIENT_EVIDENCE') AS mastery_score,
          (SELECT count(DISTINCT v.assignment_id) FROM verification_runs v WHERE v.student_id = r.user_id AND v.status = 'COMPLETED' AND v.overall_outcome IN ('PASS','PARTIAL') AND v.assignment_id IN (SELECT assignment_id FROM pub))::int AS verified_ok
        FROM roster r ORDER BY r.last_name NULLS LAST, r.first_name NULLS LAST, r.email""", {"c": course_id, "u": university_id})
    return [{"id": r["user_id"], "name": _name(r), "email": r["email"], "task_submission": _pct(r["submitted"], total),
             "socratic_ai_usage": _pct(r["coached"], total), "observed_signal_rate": _pct(r["signalled"], total),
             "observed_signal_count": r["signal_count"], "mastery": mastery_label(r["mastery_score"]), "_submitted": r["submitted"], "_verified_ok": r["verified_ok"]}
            for r in rows]


def _course_assignment_ids(c, course_ids: list[str], university_id: str) -> list[str]:
    if not course_ids:
        return []
    return [r["assignment_id"] for r in many(c, "SELECT assignment_id FROM assignments WHERE course_id = ANY(%s) AND university_id = %s", (course_ids, university_id))]


def _last_activity(c, university_id: str, student_ids: list[str], assignment_ids: list[str]) -> dict[str, datetime]:
    if not student_ids or not assignment_ids:
        return {}
    return {r["student_id"]: r["at"] for r in many(c, """SELECT student_id, max(occurred_at) AS at FROM learning_events
                                                          WHERE university_id = %s AND student_id = ANY(%s) AND assignment_id = ANY(%s) GROUP BY student_id""",
                                                    (university_id, student_ids, assignment_ids))}


def _risk_brief(r: dict, last_at: Optional[datetime]) -> dict:
    """The compact, structured risk object embedded in roster rows (the full explanation lives on the student page)."""
    return {"level": r["level"], "level_label": r["level_label"], "score": r["score"], "confidence_label": r["confidence_label"], "evidence_count": r["evidence_count"],
            "primary_reason": r["primary_reason"], "focus": r["focus"], "last_activity_at": iso(last_at)}


_QUEUE_ORDER = {"high": 0, "moderate": 1}


def _top_signal_assignment(risk: dict) -> Optional[str]:
    """The assignment behind the strongest signal's most recent evidence: where a teacher should start looking."""
    for sig in risk.get("top_signals") or []:
        for ev in sig["evidence"]:           # newest first
            if ev.get("assignment_id"):
                return ev["assignment_id"]
    return None


def review_queue(students: list[dict], risks: dict[str, dict], last_seen: dict[str, datetime], titles: Optional[dict[str, str]] = None) -> list[dict]:
    """Attention Center rows. Two different reasons are kept apart on purpose:
       risk_review       a moderate/high external-AI-dependence *indicator* level (evidence-backed, see risk.py)
       learning_support  weak verified mastery: a learning difficulty, not an AI question."""
    rows: list[dict] = []
    for st in students:
        r = risks[st["id"]]
        base = {"student_id": st["id"], "name": st["name"], "confidence_label": r["confidence_label"], "last_activity_at": iso(last_seen.get(st["id"])),
                "assignment_id": None, "assignment_title": None}
        if r["level"] in _QUEUE_ORDER:
            aid = _top_signal_assignment(r)
            base = {**base, "assignment_id": aid, "assignment_title": (titles or {}).get(aid) if aid else None}
            rows.append({**base, "kind": "risk_review", "level": r["level"], "level_label": r["level_label"], "primary_reason": r["primary_reason"], "focus": r["focus"],
                         "evidence_count": r["evidence_count"], "_k": (_QUEUE_ORDER[r["level"]], -(r["score"] or 0))})
        elif st["mastery"] == "Weak":
            rows.append({**base, "kind": "learning_support", "level": None, "level_label": None, "primary_reason": "Weak understanding shown in learning verification",
                         "focus": "learning_difficulty", "evidence_count": None, "_k": (2, 0)})
    rows.sort(key=lambda x: (x["_k"], x["name"].lower()))
    return [{k: v for k, v in x.items() if k != "_k"} for x in rows]


def course_dashboard(c, user: CurrentUser, course_id: str) -> dict[str, Any]:
    students = course_students(c, course_id, user.university_id)
    n = len(students)
    submitted = sum(s["_submitted"] for s in students)
    verified = sum(s["_verified_ok"] for s in students)
    # mean of each student's LATEST graded submission per assignment, as a percentage of ITS OWN maximum (scales differ per assignment)
    grade = one(c, """SELECT avg(pct)::float AS g FROM (
                        SELECT DISTINCT ON (sub.student_id, sub.assignment_id) sub.score / NULLIF(sub.max_score, 0) * 100 AS pct
                          FROM submissions sub JOIN assignments a ON a.assignment_id = sub.assignment_id JOIN attempts t ON t.attempt_id = sub.attempt_id
                         WHERE a.course_id = %s AND sub.score IS NOT NULL AND sub.student_id = ANY(%s)       -- enrolled roster only
                         ORDER BY sub.student_id, sub.assignment_id, t.attempt_number DESC) g""", (course_id, [s["id"] for s in students]))["g"]
    metrics = {"assignment_completion": round(sum(s["task_submission"] for s in students) / n) if n else 0,
               "average_grade": None if grade is None else round(grade),
               "socratic_ai_usage": round(sum(s["socratic_ai_usage"] for s in students) / n) if n else 0,
               "observed_signal_rate": round(sum(s["observed_signal_rate"] for s in students) / n) if n else 0,
               "verification_rate": _pct(verified, submitted)}
    ids = [s["id"] for s in students]
    asg_ids = _course_assignment_ids(c, [course_id], user.university_id)
    risks = risk_model.assess_students(c, user.university_id, ids, asg_ids)
    last_seen = _last_activity(c, user.university_id, ids, asg_ids)
    titles = {r["assignment_id"]: r["title"] for r in many(c, "SELECT assignment_id, title FROM assignments WHERE course_id=%s AND university_id=%s", (course_id, user.university_id))}
    queue = review_queue(students, risks, last_seen, titles)
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    dist = {k: sum(1 for r in risks.values() if r["level"] == k) for k in ("low", "moderate", "high", "insufficient")}
    overview = {"students": n, "active_students": sum(1 for t in last_seen.values() if t >= cutoff),
                "needs_review": sum(1 for q in queue if q["kind"] == "risk_review"), "needs_support": sum(1 for q in queue if q["kind"] == "learning_support"),
                "assignments": one(c, "SELECT count(*)::int AS n FROM assignments WHERE course_id=%s AND status='PUBLISHED'", (course_id,))["n"],
                "verifications_completed": one(c, """SELECT count(*)::int AS n FROM verification_runs v JOIN assignments a ON a.assignment_id = v.assignment_id
                                                      WHERE a.course_id = %s AND v.status = 'COMPLETED'""", (course_id,))["n"],
                "risk_distribution": dist}
    rows = [{**{k: v for k, v in s.items() if not k.startswith("_")}, "risk": _risk_brief(risks[s["id"]], last_seen.get(s["id"]))} for s in students]
    return {"metrics": metrics, "overview": overview, "review_queue": queue, "risk_disclaimer": risk_model.DISCLAIMER, "students": rows,
            "attention": attention_items(c, course_id, user.university_id), "activity": activity_feed(c, course_id=course_id, university_id=user.university_id, limit=12)}


def attention_items(c, course_id: str, university_id: str) -> list[dict]:
    items: list[dict] = []
    for r in many(c, """
        SELECT v.verification_id, v.student_id, v.assignment_id, v.overall_outcome, a.title, u.first_name, u.last_name, u.email
          FROM verification_runs v JOIN assignments a ON a.assignment_id = v.assignment_id JOIN users u ON u.user_id = v.student_id
         WHERE a.course_id = %s AND v.university_id = %s AND v.status = 'COMPLETED' AND v.overall_outcome IN ('NEEDS_RETRY','PARTIAL')
         ORDER BY v.completed_at DESC LIMIT 4""", (course_id, university_id)):
        items.append({"id": f"rev_{r['verification_id']}", "kind": "review", "tone": "warning", "title": f"Review {_name(r)}'s verification",
                      "description": f"{r['title']}: verification finished as {r['overall_outcome'].replace('_', ' ').lower()}.",
                      "target": {"type": "submission", "assignment_id": r["assignment_id"], "student_id": r["student_id"]}})
    for r in many(c, """
        SELECT s.student_id, count(*)::int AS n, max(s.created_at) AS last_at, u.first_name, u.last_name, u.email
          FROM risk_signals s JOIN assignments a ON a.assignment_id = s.assignment_id JOIN users u ON u.user_id = s.student_id
         WHERE a.course_id = %s AND s.university_id = %s AND s.created_at > now() - interval '14 days'
         GROUP BY s.student_id, u.first_name, u.last_name, u.email ORDER BY n DESC LIMIT 3""", (course_id, university_id)):
        items.append({"id": f"sig_{r['student_id']}", "kind": "signal", "tone": "neutral", "title": f"{r['n']} review indicator(s) for {_name(r)}",
                      "description": "Observed patterns worth a look. These are observations, not a determination of intent.",
                      "target": {"type": "student", "student_id": r["student_id"]}})
    for r in many(c, """
        SELECT a.assignment_id, a.title, a.due_at,
               (SELECT count(*) FROM enrollments e WHERE e.classroom_id = a.classroom_id AND e.status = 'active')::int AS total,
               (SELECT count(DISTINCT t.student_id) FROM attempts t WHERE t.assignment_id = a.assignment_id AND t.status = 'SUBMITTED')::int AS done
          FROM assignments a WHERE a.course_id = %s AND a.status = 'PUBLISHED' AND a.due_at BETWEEN now() AND now() + interval '3 days' ORDER BY a.due_at LIMIT 3""", (course_id,)):
        if r["done"] < r["total"]:
            items.append({"id": f"due_{r['assignment_id']}", "kind": "deadline", "tone": "danger", "title": f"{r['title']} is due soon",
                          "description": f"{r['done']} of {r['total']} students have submitted.", "target": {"type": "assignment", "assignment_id": r["assignment_id"]}})
    return items


def activity_feed(c, *, university_id: str, course_id: Optional[str] = None, student_id: Optional[str] = None, teacher: Optional[CurrentUser] = None, limit: int = 20) -> list[dict]:
    """Learning-evidence feed built from real events (submissions, revisions, completed verifications, coach conversations)."""
    where, params = ["a.university_id = %(u)s"], {"u": university_id, "lim": limit}
    if course_id:
        where.append("a.course_id = %(c)s"); params["c"] = course_id
    if student_id:
        where.append("x.student_id = %(s)s"); params["s"] = student_id
    if teacher:
        where.append("(co.instructor_id = %(t)s OR EXISTS (SELECT 1 FROM classrooms k WHERE k.course_id = co.course_id AND k.professor_id = %(t)s))"); params["t"] = teacher.user_id
    sql = f"""
      SELECT * FROM (
        SELECT t.attempt_id::text AS id, t.ended_at AS at, 'submission' AS kind, t.student_id, t.assignment_id, format('Submitted %%s', 'work') AS detail
          FROM attempts t WHERE t.status = 'SUBMITTED' AND t.ended_at IS NOT NULL
        UNION ALL
        SELECT t.attempt_id, t.started_at, 'revision', t.student_id, t.assignment_id, format('Started revision (attempt %%s)', t.attempt_number)
          FROM attempts t WHERE t.attempt_number > 1
        UNION ALL
        SELECT v.verification_id, v.completed_at, 'verification', v.student_id, v.assignment_id, format('Completed learning verification (%%s)', lower(replace(v.overall_outcome, '_', ' ')))
          FROM verification_runs v WHERE v.status = 'COMPLETED' AND v.completed_at IS NOT NULL
        UNION ALL
        SELECT s.session_id, s.started_at, 'coach_session', s.student_id, s.assignment_id, format('Coach conversation (%%s turns)', s.turn_count)
          FROM ai_sessions s WHERE s.turn_count > 0
      ) x JOIN assignments a ON a.assignment_id = x.assignment_id JOIN courses co ON co.course_id = a.course_id
      WHERE {' AND '.join(where)} ORDER BY x.at DESC LIMIT %(lim)s"""
    return [{"id": f"{r['kind']}_{r['id']}", "date": iso(r["at"]), "course_id": r["course_id"], "assignment_id": r["assignment_id"], "assignment_title": r["title"],
             "kind": r["kind"], "detail": r["detail"], "student_id": r["student_id"]} for r in _feed_rows(c, sql, params)]


def _feed_rows(c, sql, params):
    # x.* has no course/title; join them here so the SELECT list stays simple above
    wrapped = sql.replace("SELECT * FROM (", "SELECT x.id, x.at, x.kind, x.student_id, x.assignment_id, x.detail, a.course_id, a.title FROM (", 1)
    return many(c, wrapped, params)


_INTERVENTIONS = {"QUESTION": "Guiding question", "HINT": "Hint", "EXPLANATION": "Explanation", "GUIDED_DEBUGGING": "Guided debugging", "FEEDBACK": "Feedback",
                  "CLARIFICATION": "Clarification", "ENCOURAGEMENT": "Encouragement"}
_DIAGNOSES = {"MISCONCEPTION": "misconception", "CONCEPTUAL_GAP": "conceptual gap", "PROCEDURAL_ERROR": "procedural error", "LOGICAL_ERROR": "logical error",
              "CODE_ERROR": "code error", "INCOMPLETE_REASONING": "incomplete reasoning", "CORRECT_REASONING": "correct reasoning", "UNCERTAIN": "uncertain"}
_OUTCOMES = {"PASS": "passed", "PARTIAL": "partly demonstrated", "NEEDS_RETRY": "needs another try", "INSUFFICIENT_EVIDENCE": "not enough evidence"}


def _timeline_entry(e: dict, signal_labels: list[str]) -> dict:
    """One real learning event -> a sentence. Nothing is invented: every field comes from the event row / its payload."""
    t, p = e["event_type"], (e["payload"] or {})
    kind, label = "other", t.replace("_", " ").capitalize()
    if t == "ATTEMPT":
        kind, label = "attempt", f"Started attempt {p['attempt_number']}" if p.get("attempt_number") else "Started an attempt"
    elif t == "AI_INTERACTION":
        kind = "coach"
        label = f"Coach: {_INTERVENTIONS.get(p.get('intervention'), 'reply').lower()}" + (f" (diagnosed: {_DIAGNOSES.get(p.get('diagnosis'), str(p['diagnosis']).lower())})" if p.get("diagnosis") else "")
    elif t == "SUBMISSION":
        kind, label = "submission", f"Submitted work ({p['characters']} characters)" if p.get("characters") else "Submitted work"
    elif t == "REVISION":
        kind, label = "revision", "Revised work"
    elif t == "VERIFICATION":
        kind, stage, out = "verification", p.get("stage"), _OUTCOMES.get(p.get("outcome"))
        if stage == "started":
            label = "Started the learning verification"
        elif stage == "completed":
            label = f"Verification finished: {out}" if out else "Verification finished"
        elif stage:
            label = f"Answered the {str(stage).lower()} question" + (f": {out}" if out else "")
        else:
            label = "Verification activity"
    return {"id": e["event_id"], "at": iso(e["occurred_at"]), "kind": kind, "label": label, "assignment_id": e["assignment_id"], "assignment_title": e["title"],
            "course_id": e["course_id"], "flagged": bool(signal_labels), "signals": signal_labels}


def student_detail(c, user: CurrentUser, student_id: str) -> dict[str, Any]:
    """One student across the courses this instructor teaches. EVERY query below is restricted to `ids` (the instructor's own courses in
    which the student is actively enrolled), so nothing from another instructor's course, or another student, can appear."""
    st = one(c, "SELECT user_id, email, first_name, last_name FROM users WHERE user_id=%s AND university_id=%s", (student_id, user.university_id))
    courses = many(c, """SELECT DISTINCT co.course_id FROM enrollments e JOIN courses co ON co.course_id = e.course_id
                          WHERE e.student_id = %s AND e.status = 'active' AND (co.instructor_id = %s OR EXISTS
                                (SELECT 1 FROM classrooms k WHERE k.course_id = co.course_id AND k.professor_id = %s))""", (student_id, user.user_id, user.user_id))
    ids = [r["course_id"] for r in courses]
    rows = [next((s for s in course_students(c, cid, user.university_id) if s["id"] == student_id), None) for cid in ids]
    rows = [r for r in rows if r]
    avg = lambda k: round(sum(r[k] for r in rows) / len(rows)) if rows else 0  # noqa: E731
    scores = [r for r in many(c, """SELECT avg(res.score)::float AS m FROM verification_results res JOIN verification_questions q ON q.question_id = res.question_id
                                    JOIN verification_runs v ON v.verification_id = q.verification_id JOIN assignments a ON a.assignment_id = v.assignment_id
                                   WHERE v.student_id = %s AND a.course_id = ANY(%s) AND res.outcome <> 'INSUFFICIENT_EVIDENCE'""", (student_id, ids))] if ids else []
    attempts = one(c, "SELECT count(*)::int AS n, count(*) FILTER (WHERE attempt_number > 1)::int AS rev FROM attempts t JOIN assignments a ON a.assignment_id=t.assignment_id WHERE t.student_id=%s AND a.course_id = ANY(%s)", (student_id, ids)) if ids else {"n": 0, "rev": 0}
    concepts = _concepts(c, user.university_id, student_id, ids) if ids else []
    struggling = [k["name"] for k in concepts if k["level"] == "Weak"][:5]
    sigs = []
    for r in many(c, """SELECT s.signal, s.observation, s.created_at FROM risk_signals s JOIN assignments a ON a.assignment_id = s.assignment_id
                         WHERE s.student_id = %s AND a.course_id = ANY(%s) ORDER BY s.created_at DESC LIMIT 5""", (student_id, ids or [""])):
        sigs.append({"label": r["signal"].replace("_", " ").capitalize(), "detail": r["observation"] or "Observed by the AI Coach during a conversation.", "tone": "watch"})
    for r in many(c, """SELECT e.evidence_type, e.observation FROM evidence_candidates e JOIN assignments a ON a.assignment_id = e.assignment_id
                         WHERE e.student_id = %s AND a.course_id = ANY(%s) AND e.strength = 'STRONG' ORDER BY e.created_at DESC LIMIT 3""", (student_id, ids or [""])):
        sigs.append({"label": r["evidence_type"].replace("_", " ").capitalize(), "detail": r["observation"], "tone": "positive"})
    asg_ids = _course_assignment_ids(c, ids, user.university_id)
    assessment = risk_model.assess_one(c, user.university_id, student_id, asg_ids)
    last_seen = _last_activity(c, user.university_id, [student_id], asg_ids).get(student_id)
    return {"id": student_id, "name": _name(st), "email": st["email"], "course_ids": ids,
            "mastery": mastery_label(scores[0]["m"]) if scores else None, "task_submission": avg("task_submission"), "socratic_ai_usage": avg("socratic_ai_usage"),
            "observed_signal_rate": avg("observed_signal_rate"), "attempts": attempts["n"], "revisions": attempts["rev"], "struggling_topics": struggling,
            "signals": sigs, "activity": activity_feed(c, university_id=user.university_id, student_id=student_id, teacher=user, limit=20),
            # ---- investigation workflow (all scoped to `ids`)
            "risk": assessment, "last_activity_at": iso(last_seen), "assignments": _assignment_progress(c, student_id, ids),
            "ai_usage": _ai_usage(c, user.university_id, student_id, ids), "verification": _verification_runs(c, user.university_id, student_id, ids),
            "concepts": concepts, "timeline": _timeline(c, user.university_id, student_id, ids)}


def _assignment_progress(c, student_id: str, course_ids: list[str]) -> list[dict]:
    if not course_ids:
        return []
    return [{"assignment_id": r["assignment_id"], "course_id": r["course_id"], "title": r["title"], "due_at": iso(r["due_at"]), "submitted": r["submitted"],
             "verification_outcome": r["verification_outcome"], "coach_turns": r["coach_turns"]} for r in many(c, """
        SELECT a.assignment_id, a.course_id, a.title, a.due_at,
               EXISTS (SELECT 1 FROM attempts t WHERE t.student_id = %(s)s AND t.assignment_id = a.assignment_id AND t.status = 'SUBMITTED') AS submitted,
               (SELECT v.overall_outcome FROM verification_runs v WHERE v.student_id = %(s)s AND v.assignment_id = a.assignment_id AND v.status = 'COMPLETED'
                 ORDER BY v.completed_at DESC LIMIT 1) AS verification_outcome,
               (SELECT count(*)::int FROM ai_interactions i WHERE i.student_id = %(s)s AND i.assignment_id = a.assignment_id) AS coach_turns
          FROM assignments a
         WHERE a.course_id = ANY(%(c)s) AND a.status = 'PUBLISHED'
           AND (a.classroom_id IS NULL OR a.classroom_id IN (SELECT e.classroom_id FROM enrollments e WHERE e.student_id = %(s)s AND e.status = 'active'))
         ORDER BY a.due_at NULLS LAST, a.created_at""", {"s": student_id, "c": course_ids})]


def _ai_usage(c, university_id: str, student_id: str, course_ids: list[str]) -> dict:
    """How the student uses the SOCRATIC COACH. Normal use, reported as such. External-AI indicators live in `risk`, not here."""
    if not course_ids:
        return {"interactions": 0, "sessions": 0, "by_intervention": [], "by_diagnosis": [], "per_assignment": [], "first_at": None, "last_at": None}
    p = (student_id, university_id, course_ids)
    tot = one(c, """SELECT count(*)::int AS n, min(i.created_at) AS first_at, max(i.created_at) AS last_at, count(DISTINCT i.session_id)::int AS sessions
                      FROM ai_interactions i JOIN assignments a ON a.assignment_id = i.assignment_id WHERE i.student_id = %s AND i.university_id = %s AND a.course_id = ANY(%s)""", p)
    by_i = many(c, """SELECT i.intervention_type AS k, count(*)::int AS n FROM ai_interactions i JOIN assignments a ON a.assignment_id = i.assignment_id
                       WHERE i.student_id = %s AND i.university_id = %s AND a.course_id = ANY(%s) GROUP BY 1 ORDER BY 2 DESC""", p)
    by_d = many(c, """SELECT i.diagnosis AS k, count(*)::int AS n FROM ai_interactions i JOIN assignments a ON a.assignment_id = i.assignment_id
                       WHERE i.student_id = %s AND i.university_id = %s AND a.course_id = ANY(%s) AND i.diagnosis IS NOT NULL GROUP BY 1 ORDER BY 2 DESC""", p)
    per = many(c, """SELECT a.assignment_id, a.title, count(*)::int AS n FROM ai_interactions i JOIN assignments a ON a.assignment_id = i.assignment_id
                      WHERE i.student_id = %s AND i.university_id = %s AND a.course_id = ANY(%s) GROUP BY 1, 2 ORDER BY 3 DESC""", p)
    return {"interactions": tot["n"], "sessions": tot["sessions"], "first_at": iso(tot["first_at"]), "last_at": iso(tot["last_at"]),
            "by_intervention": [{"type": r["k"], "label": _INTERVENTIONS.get(r["k"], r["k"]), "count": r["n"]} for r in by_i],
            "by_diagnosis": [{"type": r["k"], "label": _DIAGNOSES.get(r["k"], r["k"]).capitalize(), "count": r["n"]} for r in by_d],
            "per_assignment": [{"assignment_id": r["assignment_id"], "title": r["title"], "turns": r["n"]} for r in per],
            "not_tracked": ["Requests for a direct answer", "Any use of tools outside SocratiQ"]}


def _verification_runs(c, university_id: str, student_id: str, course_ids: list[str]) -> list[dict]:
    if not course_ids:
        return []
    runs = many(c, """SELECT v.verification_id, v.assignment_id, v.status, v.overall_outcome, v.score::float AS score, v.created_at, v.completed_at, a.title, a.course_id
                        FROM verification_runs v JOIN assignments a ON a.assignment_id = v.assignment_id
                       WHERE v.student_id = %s AND v.university_id = %s AND a.course_id = ANY(%s) ORDER BY v.created_at DESC LIMIT 20""", (student_id, university_id, course_ids))
    qs: dict[str, list[dict]] = {}
    if runs:
        for r in many(c, """SELECT q.verification_id, q.verification_type, q.concept, res.outcome, res.feedback FROM verification_questions q
                              LEFT JOIN verification_results res ON res.question_id = q.question_id WHERE q.verification_id = ANY(%s) ORDER BY q.verification_id, q.display_order""",
                      ([r["verification_id"] for r in runs],)):
            qs.setdefault(r["verification_id"], []).append({"type": r["verification_type"], "concept": r["concept"], "outcome": r["outcome"], "feedback": r["feedback"]})
    return [{"id": r["verification_id"], "assignment_id": r["assignment_id"], "course_id": r["course_id"], "assignment_title": r["title"], "status": r["status"],
             "outcome": r["overall_outcome"], "score": r["score"], "started_at": iso(r["created_at"]), "completed_at": iso(r["completed_at"]),
             "questions": qs.get(r["verification_id"], [])} for r in runs]


def _concepts(c, university_id: str, student_id: str, course_ids: list[str]) -> list[dict]:
    """student_concept_state restricted to concepts that belong to THIS instructor's courses (tagged on an assignment, verified in one, or the
    assignment topic used as the verification fallback). `concepts` are university-wide rows, so without this filter another instructor's
    concept names would leak into this view."""
    rows = many(c, """
        SELECT k.name, k.normalized_name AS key, s.mastery_estimate::float AS mastery, s.evidence_count, s.last_evaluated_at
          FROM student_concept_state s JOIN concepts k ON k.concept_id = s.concept_id
         WHERE s.student_id = %(s)s AND s.university_id = %(u)s AND (
               k.concept_id IN (SELECT ac.concept_id FROM assignment_concepts ac JOIN assignments a ON a.assignment_id = ac.assignment_id WHERE a.course_id = ANY(%(c)s))
            OR k.normalized_name IN (SELECT lower(btrim(q.concept)) FROM verification_questions q JOIN verification_runs v ON v.verification_id = q.verification_id
                                       JOIN assignments a ON a.assignment_id = v.assignment_id WHERE v.student_id = %(s)s AND a.course_id = ANY(%(c)s) AND q.concept IS NOT NULL)
            OR k.normalized_name IN (SELECT lower(btrim(coalesce(a.subject_area, a.title))) FROM assignments a WHERE a.course_id = ANY(%(c)s)))
         ORDER BY s.mastery_estimate NULLS LAST, k.name""", {"s": student_id, "u": university_id, "c": course_ids})
    hist: dict[str, list[dict]] = {}
    for r in many(c, """SELECT lower(btrim(coalesce(q.concept, a.subject_area, a.title))) AS key, res.score::float AS score, res.outcome, res.created_at, a.assignment_id, a.title
                          FROM verification_results res JOIN verification_questions q ON q.question_id = res.question_id JOIN verification_runs v ON v.verification_id = q.verification_id
                          JOIN assignments a ON a.assignment_id = v.assignment_id
                         WHERE v.student_id = %s AND a.course_id = ANY(%s) AND res.outcome <> 'INSUFFICIENT_EVIDENCE' ORDER BY res.created_at""", (student_id, course_ids)):
        hist.setdefault(r["key"], []).append(r)
    coach = {r["key"]: r["n"] for r in many(c, """SELECT lower(btrim(x)) AS key, count(*)::int AS n FROM ai_interactions i JOIN assignments a ON a.assignment_id = i.assignment_id,
                                                        jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.referenced_concepts) = 'array' THEN i.referenced_concepts ELSE '[]'::jsonb END) AS x
                                                   WHERE i.student_id = %s AND a.course_id = ANY(%s) GROUP BY 1""", (student_id, course_ids))}
    out = []
    for r in rows:
        h = hist.get(r["key"], [])
        scores = [x["score"] for x in h][-5:]
        trend = None if len(scores) < 2 else "up" if scores[-1] > scores[-2] + 0.05 else "down" if scores[-1] < scores[-2] - 0.05 else "flat"
        out.append({"name": r["name"], "level": mastery_label(r["mastery"], r["evidence_count"]), "mastery": None if r["mastery"] is None else round(r["mastery"], 2),
                    "evidence_count": r["evidence_count"], "last_evaluated_at": iso(r["last_evaluated_at"]), "recent_scores": scores, "trend": trend,
                    "assignments": [{"assignment_id": a, "title": t} for a, t in {(x["assignment_id"], x["title"]) for x in h}], "coach_mentions": coach.get(r["key"], 0)})
    return out


def _timeline(c, university_id: str, student_id: str, course_ids: list[str], limit: int = 60) -> list[dict]:
    if not course_ids:
        return []
    events = many(c, """SELECT e.event_id, e.event_type, e.occurred_at, e.assignment_id, e.payload, a.title, a.course_id FROM learning_events e
                          JOIN assignments a ON a.assignment_id = e.assignment_id
                         WHERE e.student_id = %s AND e.university_id = %s AND a.course_id = ANY(%s) ORDER BY e.occurred_at DESC LIMIT %s""", (student_id, university_id, course_ids, limit))
    flagged: dict[str, list[str]] = {}
    if events:
        for r in many(c, "SELECT learning_event_id, signal FROM risk_signals WHERE student_id = %s AND learning_event_id = ANY(%s)", (student_id, [e["event_id"] for e in events])):
            flagged.setdefault(r["learning_event_id"], []).append(risk_model.spec_for(r["signal"]).label)
    return [_timeline_entry(e, flagged.get(e["event_id"], [])) for e in events]
