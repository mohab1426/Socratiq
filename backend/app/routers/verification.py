from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Request
from psycopg import errors as pgerr

from ..access import student_assignment
from ..auth import CurrentUser, get_db, require_student
from ..db import Database, many, new_id, one
from ..errors import conflict, not_found
from ..ratelimit import ai_rate_limit
from ..records import insert_event, insert_evidence, update_concept_state
from ..schemas import VerificationAnswerIn

router = APIRouter(tags=["verification"])
STEPS = ("EXPLAIN", "MODIFY", "TRANSFER")


def _concept(c, a) -> str:
    row = one(c, "SELECT k.name FROM assignment_concepts ac JOIN concepts k ON k.concept_id=ac.concept_id WHERE ac.assignment_id=%s ORDER BY k.name LIMIT 1", (a["assignment_id"],))
    return (row["name"] if row else None) or a.get("subject_area") or a["title"]


def _state(c, run) -> dict:
    qs = many(c, """SELECT q.*, r.response_id, res.outcome, res.feedback FROM verification_questions q
                      LEFT JOIN verification_responses r ON r.question_id = q.question_id
                      LEFT JOIN verification_results res ON res.question_id = q.question_id
                     WHERE q.verification_id=%s ORDER BY q.display_order""", (run["verification_id"],))
    answered = sum(1 for q in qs if q["response_id"])
    steps, current = [], None
    for i, t in enumerate(STEPS):
        q = qs[i] if i < len(qs) else None
        if q and q["response_id"]:
            st = "done"
        elif i == answered and run["status"] == "IN_PROGRESS":
            st = "current"
            if q:
                current = {"question_id": q["question_id"], "type": q["verification_type"], "question": q["question_text"], "index": i}
        else:
            st = "upcoming"
        steps.append({"type": t, "status": st})
    return {"verification_id": run["verification_id"], "status": run["status"], "outcome": run["overall_outcome"], "steps": steps, "current": current,
            "needs_question": run["status"] == "IN_PROGRESS" and current is None}


def _generate_if_needed(request: Request, db: Database, user: CurrentUser, run_id: str) -> None:
    """Create the next question when the current step has none yet. AI call happens outside any transaction; the insert is guarded
    against a concurrent duplicate by UNIQUE (verification_id, display_order)."""
    with db.tx() as c:
        run = one(c, "SELECT * FROM verification_runs WHERE verification_id=%s AND student_id=%s AND university_id=%s", (run_id, user.user_id, user.university_id))
        if run is None or run["status"] != "IN_PROGRESS":
            return
        st = _state(c, run)
        if not st["needs_question"]:
            return
        idx = next(i for i, s in enumerate(st["steps"]) if s["status"] == "current")
        a = student_assignment(c, user, run["assignment_id"])
        sub = one(c, "SELECT submission_text FROM submissions WHERE attempt_id=%s", (run["attempt_id"],))
        concept = _concept(c, a)
    ch = request.app.state.ai.generate_challenge(assignment=a, concept=concept, verification_type=STEPS[idx], student_work=(sub or {}).get("submission_text") or "")
    try:
        with db.tx() as c:
            c.execute("SELECT 1 FROM verification_runs WHERE verification_id=%s FOR UPDATE", (run_id,))
            c.execute("""INSERT INTO verification_questions (question_id, verification_id, challenge_id, display_order, verification_type, concept, question_text, criteria)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb) ON CONFLICT (verification_id, display_order) DO NOTHING""",
                      (new_id("vq"), run_id, new_id("vc"), idx, STEPS[idx], ch.concept, ch.question, json.dumps(ch.criteria)))
    except pgerr.UniqueViolation:
        pass


@router.post("/student/assignments/{assignment_id}/verification", dependencies=[Depends(ai_rate_limit)])
@router.post("/student/assignments/{assignment_id}/verification/challenge", include_in_schema=False, dependencies=[Depends(ai_rate_limit)])
def start_verification(assignment_id: str, request: Request, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Start or resume the 3-step Explain -> Modify -> Transfer verification for the student's latest SUBMITTED attempt."""
    with db.tx() as c:
        a = student_assignment(c, user, assignment_id)
        att = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s AND status='SUBMITTED' ORDER BY attempt_number DESC LIMIT 1", (user.user_id, assignment_id))
        if att is None:
            raise conflict("Submit your work before starting verification.", "not_submitted")
        run = one(c, "SELECT * FROM verification_runs WHERE attempt_id=%s ORDER BY (status='IN_PROGRESS') DESC, created_at DESC LIMIT 1", (att["attempt_id"],))
        if run is None:
            sub = one(c, "SELECT submission_id FROM submissions WHERE attempt_id=%s", (att["attempt_id"],))
            c.execute("""INSERT INTO verification_runs (verification_id, student_id, assignment_id, submission_id, attempt_id, university_id)
                         VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                      (new_id("ver"), user.user_id, assignment_id, sub["submission_id"] if sub else None, att["attempt_id"], user.university_id))
            run = one(c, "SELECT * FROM verification_runs WHERE attempt_id=%s AND status='IN_PROGRESS'", (att["attempt_id"],))
            insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="VERIFICATION", assignment_id=assignment_id, attempt_id=att["attempt_id"],
                         verification_id=run["verification_id"], payload={"stage": "started"})
        run_id = run["verification_id"]
    _generate_if_needed(request, db, user, run_id)
    with db.tx() as c:
        return _state(c, one(c, "SELECT * FROM verification_runs WHERE verification_id=%s", (run_id,)))


@router.get("/student/verification/{verification_id}")
def get_verification(verification_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        run = one(c, "SELECT * FROM verification_runs WHERE verification_id=%s AND student_id=%s AND university_id=%s", (verification_id, user.user_id, user.university_id))
        if run is None:
            raise not_found("Verification not found")
        return _state(c, run)


def _overall(results: list[dict]) -> tuple[str, float, float]:
    scored = [r for r in results if r["outcome"] != "INSUFFICIENT_EVIDENCE"]
    if not scored:
        return "INSUFFICIENT_EVIDENCE", 0.0, 0.0
    score = sum(float(r["score"]) for r in scored) / len(scored)
    conf = sum(float(r["confidence"]) for r in scored) / len(scored)
    return ("PASS" if score >= 0.75 else "PARTIAL" if score >= 0.4 else "NEEDS_RETRY"), round(score, 4), round(conf, 4)


@router.post("/student/verification/{verification_id}/response", dependencies=[Depends(ai_rate_limit)])
@router.post("/student/verification/{verification_id}/answer", include_in_schema=False, dependencies=[Depends(ai_rate_limit)])
def answer(verification_id: str, body: VerificationAnswerIn, request: Request, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        run = one(c, "SELECT * FROM verification_runs WHERE verification_id=%s AND student_id=%s AND university_id=%s", (verification_id, user.user_id, user.university_id))
        if run is None:
            raise not_found("Verification not found")
        if run["status"] != "IN_PROGRESS":
            raise conflict("This verification is already complete.", "verification_complete")
        a = student_assignment(c, user, run["assignment_id"])
        q = one(c, """SELECT q.* FROM verification_questions q LEFT JOIN verification_responses r ON r.question_id=q.question_id
                       WHERE q.verification_id=%s AND r.response_id IS NULL ORDER BY q.display_order LIMIT 1""", (verification_id,))
        if q is None:
            raise conflict("There is no open question yet. Reload to fetch the next one.", "no_open_question")
        sub = one(c, "SELECT submission_text FROM submissions WHERE attempt_id=%s", (run["attempt_id"],))
    ev = request.app.state.ai.evaluate(student_id=user.user_id, assignment=a, concept=q["concept"] or _concept_fallback(a), verification_type=q["verification_type"],
                                       question=q["question_text"], criteria=list(q["criteria"] or []), answer=body.answer, student_work=(sub or {}).get("submission_text") or "")
    completed = False
    with db.tx() as c:
        c.execute("SELECT 1 FROM verification_runs WHERE verification_id=%s FOR UPDATE", (verification_id,))
        if one(c, "SELECT 1 AS x FROM verification_responses WHERE question_id=%s", (q["question_id"],)):
            raise conflict("This question was already answered.", "already_answered")
        rid = new_id("vr")
        c.execute("INSERT INTO verification_responses (response_id, question_id, student_id, response_text) VALUES (%s,%s,%s,%s)", (rid, q["question_id"], user.user_id, body.answer))
        c.execute("""INSERT INTO verification_results (result_id, question_id, response_id, outcome, score, confidence, feedback, criteria_evaluations)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                  (new_id("vx"), q["question_id"], rid, ev.outcome, ev.score, ev.confidence, ev.feedback, json.dumps(ev.criteria)))
        event_id = insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="VERIFICATION", assignment_id=a["assignment_id"],
                                attempt_id=run["attempt_id"], verification_id=verification_id,
                                payload={"stage": q["verification_type"], "outcome": ev.outcome, "score": ev.score})
        if ev.evidence:
            insert_evidence(c, student_id=user.user_id, university_id=user.university_id, assignment_id=a["assignment_id"], ev=ev.evidence, event_id=event_id)
        update_concept_state(c, student_id=user.user_id, university_id=user.university_id, concept_name=q["concept"] or _concept_fallback(a))
        results = many(c, "SELECT res.outcome, res.score, res.confidence, res.feedback FROM verification_results res JOIN verification_questions qq ON qq.question_id=res.question_id WHERE qq.verification_id=%s ORDER BY qq.display_order", (verification_id,))
        if len(results) >= len(STEPS):
            outcome, score, conf = _overall(results)
            c.execute("UPDATE verification_runs SET status='COMPLETED', overall_outcome=%s, score=%s, confidence=%s, feedback=%s, completed_at=now() WHERE verification_id=%s",
                      (outcome, score, conf, " ".join(r["feedback"] for r in results if r["feedback"])[:4000], verification_id))
            insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="VERIFICATION", assignment_id=a["assignment_id"], attempt_id=run["attempt_id"],
                         verification_id=verification_id, payload={"stage": "completed", "outcome": outcome, "score": score})
            completed = True
    if not completed:
        _generate_if_needed(request, db, user, verification_id)
    with db.tx() as c:
        state = _state(c, one(c, "SELECT * FROM verification_runs WHERE verification_id=%s", (verification_id,)))
    return {"result": {"outcome": ev.outcome, "feedback": ev.feedback, "criteria": ev.criteria}, "completed": completed, "state": state}


def _concept_fallback(a) -> str:
    return a.get("subject_area") or a["title"]
