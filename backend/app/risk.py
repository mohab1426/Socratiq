"""
Risk-of-external-AI-dependence assessment. ONE module owns the definitions, the weights and the arithmetic.

WHAT THIS IS NOT
  It is not a detector and it never proves that a student used an outside AI tool. Nothing in SocratiQ can observe that. It turns
  observations that the platform genuinely recorded into a bounded, explainable "review priority" for the instructor.
  Using the Socratic Coach is EXPECTED behaviour: the number of Coach turns is never a risk signal. It only counts as
  *activity* (how much evidence there is), which raises confidence, never risk.

PIPELINE
  evidence -> observations -> weighted points -> bounded score -> level (+ confidence) -> reasons

  1. Observations (all read from rows that already exist, each carries the id of the row it came from):
       * `risk_signals` written by the Coach (structural patterns between two attempts)          source="risk_signal"
       * a COMPLETED verification where the student could not explain their submitted work        source="verification"
       * a COMPLETED verification that ended NEEDS_RETRY                                          source="verification"
       * a large text answer submitted within minutes of opening the attempt with no draft saved source="submission"
  2. Points. Every signal type has a weight in CATALOG (points). Repeats of the same signal on the same assignment add 25% of
     the weight each, capped at 2x, so ten copies of one pattern cannot dominate. Signals on an assignment whose verification later
     ended in PASS are halved (the student then demonstrated the reasoning) and reported as `mitigated`.
  3. Score = 1 - exp(-points / 6), always in [0, 1). Diminishing returns by construction.
  4. Level: `insufficient` when there is too little activity to assess (< MIN_ACTIVITY units); otherwise low (< 0.30),
     moderate (< 0.60) or high. `high` additionally requires >= 3 independent observations and at least Medium confidence, so a
     thin record can never produce the top bucket.
  5. Confidence describes the ASSESSMENT, not the student: 0.5 * min(activity/10, 1) + 0.5 * (evidence channels present / 3), where
     channels are Coach conversation, submission, verification answers. Low < 0.34 <= Medium < 0.67 <= High.

The thresholds and weights are policy defaults chosen to be conservative and easy to read; they are NOT calibrated against labelled
data (none exists). Change them here, in one place; tests pin the behaviour. Everything is computed on read from live rows, so
the assessment can never be stale and no extra table is needed. `risk_signals.severity` is filled at write time from CATALOG so the
stored rows carry the same vocabulary (LOW/MEDIUM/HIGH); assessment-level confidence is a property of a student, not of one row,
so `risk_signals.confidence` stays NULL.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

MODEL_VERSION = "risk-v1"

MIN_ACTIVITY = 3               # Coach turns + verification answers + submissions needed before any level is assigned
LOW_BELOW = 0.30
MODERATE_BELOW = 0.60
HIGH_MIN_OBSERVATIONS = 3
SCORE_SCALE = 6.0
REPEAT_STEP = 0.25
REPEAT_CAP = 2.0
MITIGATION_FACTOR = 0.5
RAPID_SUBMISSION_MIN_CHARS = 1500
RAPID_SUBMISSION_MAX_SECONDS = 180

DISCLAIMER = ("This is an indicator for instructor review, not proof of external AI use. "
              "Using the Socratic Coach is expected and is not counted as a risk.")

LEVEL_LABELS = {"low": "Low", "moderate": "Moderate", "high": "High", "insufficient": "Insufficient evidence"}
CATEGORY_LABELS = {"work_pattern": "Work pattern", "verification": "Verification", "process": "Process record"}


@dataclass(frozen=True)
class SignalSpec:
    label: str
    category: str          # work_pattern | verification | process
    points: float
    severity: str          # LOW | MEDIUM | HIGH (vocabulary of risk_signals.severity)
    meaning: str


CATALOG: dict[str, SignalSpec] = {
    "unusually_large_attempt_jump": SignalSpec(
        "Large jump between attempts", "work_pattern", 2.0, "MEDIUM",
        "A very short attempt was followed by a much longer one with no intermediate drafting in the conversation."),
    "solution_sophistication_inconsistent_with_prior_attempt": SignalSpec(
        "Solution far more structured than the previous attempt", "work_pattern", 2.0, "MEDIUM",
        "Several structured functions appeared right after an elementary attempt."),
    "style_shift_between_attempts": SignalSpec(
        "Formatting style changed between attempts", "work_pattern", 1.0, "LOW",
        "Formal formatting (code fences, docstrings, comments) appeared suddenly. Weak on its own."),
    "could_not_explain_submitted_work": SignalSpec(
        "Could not explain submitted work in verification", "verification", 2.0, "MEDIUM",
        "The Explain step of the learning verification ended as needs-retry."),
    "verification_not_passed": SignalSpec(
        "Verification ended as needs-retry", "verification", 1.5, "MEDIUM",
        "The learning verification finished without demonstrating the reasoning. This can equally mean a learning difficulty."),
    "rapid_large_submission": SignalSpec(
        "Large answer submitted very quickly with no saved draft", "process", 1.0, "LOW",
        "A long typed answer arrived within minutes of opening the attempt. Work written elsewhere and pasted looks the same."),
}
UNKNOWN_SPEC = SignalSpec("Other observed pattern", "work_pattern", 1.0, "LOW", "A pattern reported by the Coach that has no dedicated definition.")


def spec_for(signal: str) -> SignalSpec:
    return CATALOG.get(signal, UNKNOWN_SPEC)


def severity_for(signal: str) -> str:
    """Stored in `risk_signals.severity` when the Coach writes a signal."""
    return spec_for(signal).severity


@dataclass
class Observation:
    signal: str
    assignment_id: Optional[str]
    at: Optional[datetime]
    source: str                         # risk_signal | verification | submission
    ref_id: str                         # id of the row the observation came from (traceability)
    detail: str = ""
    learning_event_id: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Activity:
    coach_turns: int = 0
    verification_answers: int = 0
    submissions: int = 0
    passed_assignments: frozenset[str] = frozenset()
    strong_positive_evidence: int = 0   # STRONG understanding / explanation / independence / transfer evidence (context only)

    @property
    def units(self) -> int:
        return self.coach_turns + self.verification_answers + self.submissions

    @property
    def channels(self) -> int:
        return sum(1 for n in (self.coach_turns, self.submissions, self.verification_answers) if n > 0)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def confidence_of(activity: Activity) -> float:
    return round(0.5 * min(activity.units / 10, 1.0) + 0.5 * (activity.channels / 3), 2)


def confidence_label(conf: float) -> str:
    return "Low" if conf < 0.34 else "Medium" if conf < 0.67 else "High"


def calculate(observations: Iterable[Observation], activity: Activity) -> dict[str, Any]:
    """Pure function: the whole model. No database, no clock, fully unit-testable."""
    obs = list(observations)
    groups: dict[tuple[str, Optional[str]], list[Observation]] = {}
    for o in obs:
        groups.setdefault((o.signal, o.assignment_id), []).append(o)

    per_signal: dict[str, dict[str, Any]] = {}
    total = 0.0
    for (signal, assignment_id), items in groups.items():
        spec = spec_for(signal)
        pts = spec.points * min(REPEAT_CAP, 1 + REPEAT_STEP * (len(items) - 1))
        mitigated = assignment_id is not None and assignment_id in activity.passed_assignments
        if mitigated:
            pts *= MITIGATION_FACTOR
        total += pts
        agg = per_signal.setdefault(signal, {"signal": signal, "label": spec.label, "category": spec.category, "category_label": CATEGORY_LABELS[spec.category],
                                             "severity": spec.severity, "meaning": spec.meaning, "count": 0, "points": 0.0, "mitigated_count": 0, "evidence": []})
        agg["count"] += len(items)
        agg["points"] += pts
        agg["mitigated_count"] += len(items) if mitigated else 0
        for o in items:
            agg["evidence"].append({"source": o.source, "ref_id": o.ref_id, "assignment_id": o.assignment_id, "at": _iso(o.at), "detail": o.detail,
                                    "learning_event_id": o.learning_event_id, "mitigated": mitigated})
    top = sorted(per_signal.values(), key=lambda s: (-s["points"], s["signal"]))
    for s in top:
        s["points"] = round(s["points"], 2)
        s["evidence"].sort(key=lambda e: e["at"] or "", reverse=True)

    conf = confidence_of(activity)
    conf_label = confidence_label(conf)
    raw_score = 1 - math.exp(-total / SCORE_SCALE)
    score = round(raw_score, 2)
    n_obs = len(obs)

    if activity.units < MIN_ACTIVITY:
        level = "insufficient"
    elif raw_score < LOW_BELOW:
        level = "low"
    elif raw_score < MODERATE_BELOW:
        level = "moderate"
    else:
        level = "high" if (n_obs >= HIGH_MIN_OBSERVATIONS and conf_label != "Low") else "moderate"

    reasons: list[str] = []
    for s in top[:4]:
        reasons.append(f"{s['label']}" + (f" ({s['count']}x)" if s["count"] > 1 else "") + (" - later verified" if s["mitigated_count"] == s["count"] else ""))
    if level == "insufficient":
        summary = (f"Not enough recorded activity to assess yet ({activity.units} of {MIN_ACTIVITY} needed: Coach turns, submissions and verification answers)."
                   + (f" {n_obs} observation(s) are shown for context only." if n_obs else ""))
    elif not obs:
        summary = "No review-worthy observations in the recorded activity."
    else:
        summary = f"{n_obs} observation(s) across {len(top)} kind(s) of signal."
    last_at = max((o.at for o in obs if o.at), default=None)
    return {
        "level": level, "level_label": LEVEL_LABELS[level],
        "score": None if level == "insufficient" else score,           # a number for a student we cannot assess would mislead
        "confidence": conf, "confidence_label": conf_label,
        "evidence_count": n_obs, "activity_units": activity.units, "min_activity_units": MIN_ACTIVITY,
        "top_signals": top, "reasons": reasons, "explanation": summary,
        "primary_reason": top[0]["label"] if top else None, "focus": top[0]["category"] if top else None,
        "mitigating": {"assignments_with_passed_verification": len(activity.passed_assignments), "strong_positive_evidence": activity.strong_positive_evidence},
        "last_evidence_at": _iso(last_at), "disclaimer": DISCLAIMER, "model_version": MODEL_VERSION,
    }


# ------------------------------------------------------------------ database side (read-only)
def assess_students(conn, university_id: str, student_ids: list[str], assignment_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Assess each student using ONLY evidence about that student on the given assignments (the caller decides the scope: the
    instructor's own course(s)). Set-based: a fixed number of queries no matter how many students."""
    from .db import many

    if not student_ids:
        return {}
    if not assignment_ids:
        return {s: calculate([], Activity()) for s in student_ids}
    p = {"u": university_id, "s": list(student_ids), "a": list(assignment_ids)}
    obs: dict[str, list[Observation]] = {s: [] for s in student_ids}
    act: dict[str, dict[str, Any]] = {s: {"coach": 0, "answers": 0, "subs": 0, "passed": set(), "pos": 0} for s in student_ids}

    for r in many(conn, """SELECT risk_signal_id, student_id, assignment_id, signal, observation, learning_event_id, metadata, created_at FROM risk_signals
                            WHERE university_id = %(u)s AND student_id = ANY(%(s)s) AND assignment_id = ANY(%(a)s)""", p):
        obs[r["student_id"]].append(Observation(r["signal"], r["assignment_id"], r["created_at"], "risk_signal", r["risk_signal_id"], r["observation"] or "",
                                                r["learning_event_id"], dict(r["metadata"] or {})))

    for r in many(conn, """
        SELECT v.verification_id, v.student_id, v.assignment_id, v.overall_outcome, v.completed_at,
               bool_or(q.verification_type = 'EXPLAIN' AND res.outcome = 'NEEDS_RETRY') AS explain_failed,
               max(res.feedback) FILTER (WHERE q.verification_type = 'EXPLAIN' AND res.outcome = 'NEEDS_RETRY') AS explain_feedback
          FROM verification_runs v
          LEFT JOIN verification_questions q ON q.verification_id = v.verification_id
          LEFT JOIN verification_results res ON res.question_id = q.question_id
         WHERE v.university_id = %(u)s AND v.student_id = ANY(%(s)s) AND v.assignment_id = ANY(%(a)s) AND v.status = 'COMPLETED'
         GROUP BY v.verification_id, v.student_id, v.assignment_id, v.overall_outcome, v.completed_at""", p):
        if r["overall_outcome"] == "PASS":
            act[r["student_id"]]["passed"].add(r["assignment_id"])
        if r["explain_failed"]:
            obs[r["student_id"]].append(Observation("could_not_explain_submitted_work", r["assignment_id"], r["completed_at"], "verification", r["verification_id"],
                                                    r["explain_feedback"] or "The Explain question of the verification was marked needs-retry."))
        elif r["overall_outcome"] == "NEEDS_RETRY":
            obs[r["student_id"]].append(Observation("verification_not_passed", r["assignment_id"], r["completed_at"], "verification", r["verification_id"],
                                                    "The learning verification finished as needs-retry."))

    for r in many(conn, """
        SELECT s.submission_id, s.student_id, s.assignment_id, s.submitted_at, char_length(s.submission_text)::int AS chars,
               extract(epoch FROM (s.submitted_at - t.started_at))::int AS seconds
          FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id
         WHERE s.university_id = %(u)s AND s.student_id = ANY(%(s)s) AND s.assignment_id = ANY(%(a)s) AND s.submission_type = 'text'
           AND char_length(coalesce(s.submission_text, '')) >= %(min_chars)s
           AND s.submitted_at - t.started_at <= make_interval(secs => %(max_s)s::double precision)
           AND coalesce(char_length(t.draft_text), 0) = 0""", {**p, "min_chars": RAPID_SUBMISSION_MIN_CHARS, "max_s": RAPID_SUBMISSION_MAX_SECONDS}):
        obs[r["student_id"]].append(Observation("rapid_large_submission", r["assignment_id"], r["submitted_at"], "submission", r["submission_id"],
                                                f"{r['chars']} characters submitted {r['seconds']} seconds after the attempt was opened, with no saved draft.",
                                                metadata={"characters": r["chars"], "seconds": r["seconds"]}))

    for r in many(conn, "SELECT student_id, count(*)::int AS n FROM ai_interactions WHERE university_id = %(u)s AND student_id = ANY(%(s)s) AND assignment_id = ANY(%(a)s) GROUP BY student_id", p):
        act[r["student_id"]]["coach"] = r["n"]
    for r in many(conn, "SELECT student_id, count(*)::int AS n FROM submissions WHERE university_id = %(u)s AND student_id = ANY(%(s)s) AND assignment_id = ANY(%(a)s) GROUP BY student_id", p):
        act[r["student_id"]]["subs"] = r["n"]
    for r in many(conn, """SELECT v.student_id, count(*)::int AS n FROM verification_responses vr JOIN verification_questions q ON q.question_id = vr.question_id
                             JOIN verification_runs v ON v.verification_id = q.verification_id
                            WHERE v.university_id = %(u)s AND v.student_id = ANY(%(s)s) AND v.assignment_id = ANY(%(a)s) GROUP BY v.student_id""", p):
        act[r["student_id"]]["answers"] = r["n"]
    for r in many(conn, """SELECT student_id, count(*)::int AS n FROM evidence_candidates
                            WHERE university_id = %(u)s AND student_id = ANY(%(s)s) AND assignment_id = ANY(%(a)s) AND strength = 'STRONG'
                              AND evidence_type IN ('UNDERSTANDING','EXPLANATION','INDEPENDENCE','TRANSFER') GROUP BY student_id""", p):
        act[r["student_id"]]["pos"] = r["n"]

    return {s: calculate(obs[s], Activity(act[s]["coach"], act[s]["answers"], act[s]["subs"], frozenset(act[s]["passed"]), act[s]["pos"])) for s in student_ids}


def assess_one(conn, university_id: str, student_id: str, assignment_ids: list[str]) -> dict[str, Any]:
    return assess_students(conn, university_id, [student_id], assignment_ids)[student_id]
