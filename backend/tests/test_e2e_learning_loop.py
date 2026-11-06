"""End-to-end learning loop through the REAL stack: real routers + authorisation + Postgres, the production AI adapter with the real
Coach graph and verification service (only the LLM is faked).

Student: draft + thinking space -> streamed Coach turn (Socratic question) -> revision -> submit -> verification
-> evidence persisted -> teacher dashboard / student evidence / submission review -> teacher grades -> student sees the SAME grade."""
from __future__ import annotations

import json

from .helpers import API
from .test_ai_contract import real  # noqa: F401  (fixture re-export)

DRAFT_1 = "theta = theta - grad"
DRAFT_2 = "theta = theta - learning_rate * grad   # the learning rate scales each step so it cannot overshoot the minimum"
STEPS = ["gradient points uphill", "so subtract it", "scale it by a small step size"]


def _sse(resp):
    out = []
    for block in resp.text.split("\n\n"):
        if block.strip():
            f = dict(line.split(": ", 1) for line in block.splitlines())
            out.append((f["event"], json.loads(f["data"])))
    return out


def test_full_learning_loop_from_student_attempt_to_teacher_insight_and_grade(real):  # noqa: F811
    s, p = real.h("S1"), real.h("P1")
    c = real.client

    # --- student works: draft + thinking space ------------------------------------------------------------------------
    assert c.patch(f"{API}/student/attempts/T1", json={"draft_text": DRAFT_1}, headers=s).status_code == 200
    assert c.put(f"{API}/student/assignments/A1/whiteboard", json={"steps": STEPS, "strokes": [{"t": "p", "w": 4, "pts": [[5, 5], [90, 80]]}]}, headers=s).status_code == 200

    # --- Socratic coaching over the streaming endpoint (same pipeline as the JSON endpoint) ---------------------------
    r = c.post(f"{API}/ai/coach/stream", json={"assignment_id": "A1", "message": "is my update rule right?"}, headers=s)
    ev = _sse(r)
    assert ev[-1][0] == "final" and ev[-1][1]["message"]["content"] == "What scales the size of each step?"       # a question, not the answer
    assert {"diagnose", "generate_response", "validate"} <= {d["stage"] for n, d in ev if n == "stage"}
    prompt = real.state["prompts"][-1]
    assert "CS101" in prompt and "scale it by a small step size" in prompt and DRAFT_1 in prompt                   # course, whiteboard and attempt reached the model

    # --- student revises after the question -> REVISION evidence --------------------------------------------------------
    assert c.patch(f"{API}/student/attempts/T1", json={"draft_text": DRAFT_2}, headers=s).status_code == 200
    # --- submit, then verify understanding ---------------------------------------------------------------------------------
    assert c.post(f"{API}/student/attempts/T1/submit", json={"text": DRAFT_2}, headers=s).status_code == 200
    vid = c.post(f"{API}/student/assignments/A1/verification", headers=s).json()["verification_id"]
    for _ in range(3):
        assert c.post(f"{API}/student/verification/{vid}/response", json={"answer": "the learning rate scales the step so it cannot overshoot"}, headers=s).status_code == 200

    # --- evidence persisted, attributed to the right student / assignment / university --------------------------------------
    rows = real.q("select event_type, student_id, assignment_id, university_id from learning_events where student_id='S1' order by occurred_at")
    kinds = {r["event_type"] for r in rows}
    assert {"AI_INTERACTION", "REVISION", "SUBMISSION", "VERIFICATION"} <= kinds
    assert all(r["student_id"] == "S1" and r["university_id"] == "U1" and r["assignment_id"] == "A1" for r in rows if r["event_type"] != "ATTEMPT")
    assert real.q("select count(*) n from learning_events where event_type='REVISION'")[0]["n"] == 1

    # --- teacher: dashboard reflects the evidence -------------------------------------------------------------------------------
    d = c.get(f"{API}/teacher/courses/C1/dashboard", headers=p).json()
    st = d["students"][0]
    assert st["id"] == "S1" and st["task_submission"] == 100 and st["socratic_ai_usage"] == 100 and st["mastery"] == "Strong"
    assert d["metrics"]["assignment_completion"] == 100 and d["metrics"]["verification_rate"] == 100 and d["metrics"]["average_grade"] is None   # not graded yet: no invented grade
    detail = c.get(f"{API}/teacher/students/S1", headers=p).json()
    assert {"coach", "revision", "submission", "verification"} <= {t["kind"] for t in detail["timeline"]}
    review = c.get(f"{API}/teacher/assignments/A1/students/S1", headers=p).json()
    assert review["submission"]["text_preview"].startswith("theta = theta - learning_rate") and review["coach_interactions"] == 1
    assert review["whiteboard"]["steps"] == STEPS and review["grade"] is None

    # --- teacher grades; the student sees exactly the same grade --------------------------------------------------------------
    g = c.put(f"{API}/teacher/assignments/A1/students/S1/grade", json={"score": 9, "max_score": 10, "feedback": "Clear reasoning about step size."}, headers=p)
    assert g.status_code == 200
    mine = c.get(f"{API}/student/assignments/A1", headers=s).json()["grade"]
    assert mine == g.json()["grade"] == c.get(f"{API}/teacher/assignments/A1/students/S1", headers=p).json()["grade"]
    assert mine["percentage"] == 90.0 and mine["graded_by"]
    assert c.get(f"{API}/teacher/courses/C1/dashboard", headers=p).json()["metrics"]["average_grade"] == 90

    # --- boundaries: other instructor and other student see none of it -------------------------------------------------------------
    assert c.get(f"{API}/teacher/assignments/A1/students/S1", headers=real.h("P2")).status_code == 404
    assert c.get(f"{API}/teacher/students/S1", headers=real.h("P3")).status_code in (403, 404)
    assert c.get(f"{API}/student/assignments/A1", headers=real.h("S2")).status_code == 404
