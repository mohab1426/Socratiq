"""Core API behaviour on a real database. Scenarios 1-13 are ported from the legacy fake-DB suite (same names)."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.usefixtures("world")
API = "/api/v1"


# ---------------------------------------------------------------- ported legacy scenarios
def test_no_token_is_401(world):
    assert world.client.get(f"{API}/me").status_code == 401
    assert world.client.get(f"{API}/me", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_me_maps_auth_user_to_student(world):
    r = world.client.get(f"{API}/me", headers=world.h("S1"))
    assert r.status_code == 200 and r.json()["id"] == "S1" and r.json()["role"] == "student" and r.json()["university_id"] == "U1"


def test_student_sees_only_own_courses(world):
    ids = [c["id"] for c in world.client.get(f"{API}/student/courses", headers=world.h("S1")).json()["courses"]]
    assert ids == ["C1"]


def test_student_cannot_open_other_course_assignment(world):
    assert world.client.get(f"{API}/student/assignments/A2", headers=world.h("S1")).status_code == 404   # other course
    assert world.client.get(f"{API}/student/assignments/A3", headers=world.h("S1")).status_code == 404   # other university
    assert world.client.get(f"{API}/student/assignments/A1d", headers=world.h("S1")).status_code == 404  # unpublished draft


def test_student_cannot_touch_another_students_attempt(world):
    assert world.client.patch(f"{API}/student/attempts/T2", json={"draft_text": "x"}, headers=world.h("S1")).status_code == 404
    assert world.client.post(f"{API}/student/attempts/T2/submit", json={"text": "x"}, headers=world.h("S1")).status_code == 404


def test_teacher_cannot_open_other_teachers_course(world):
    assert world.client.get(f"{API}/teacher/courses/C2", headers=world.h("P1")).status_code == 404      # same university
    assert world.client.get(f"{API}/teacher/courses/C3", headers=world.h("P1")).status_code == 404      # other university
    assert world.client.get(f"{API}/teacher/courses/C1", headers=world.h("P1")).status_code == 200


def test_student_cannot_use_teacher_routes(world):
    assert world.client.get(f"{API}/teacher/courses", headers=world.h("S1")).status_code == 403
    assert world.client.post(f"{API}/teacher/courses/C1/assignments", json={"title": "t", "prompt": "p"}, headers=world.h("S1")).status_code == 403
    assert world.client.get(f"{API}/student/courses", headers=world.h("P1")).status_code == 403


def test_coach_uses_server_side_identity_and_policy_and_persists(world):
    r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "is my update right?"}, headers=world.h("S1"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"]["role"] == "coach" and body["intervention"]["type"] == "QUESTION" and body["turn"] == 1
    kind, kw = world.ai.calls[-1]
    assert kind == "coach" and kw["student_id"] == "S1" and kw["policy"] == "GUIDED"                 # from the DB, not the client
    assert kw["assignment"]["university_id"] == "U1" and kw["assignment"]["classroom_id"] == "K1"
    ix = world.q("select intervention_type, diagnosis, diagnosis_confidence, assistance_level, university_id from ai_interactions")
    assert len(ix) == 1 and ix[0]["intervention_type"] == "QUESTION" and ix[0]["diagnosis"] == "CONCEPTUAL_GAP"   # real AI result shape
    assert float(ix[0]["diagnosis_confidence"]) == pytest.approx(0.82) and ix[0]["university_id"] == "U1"
    assert [m["sender"] for m in world.q("select sender from messages order by created_at, message_id")] == ["STUDENT", "COACH"]
    assert world.q("select turn_count, policy from ai_sessions")[0] == {"turn_count": 1, "policy": "GUIDED"}
    assert world.q("select count(*) n from evidence_candidates")[0]["n"] == 2                          # seed row + this turn
    assert world.q("select count(*) n from evidence_candidates where evidence_type='MISCONCEPTION'")[0]["n"] == 1
    assert world.q("select count(*) n from evidence_sources")[0]["n"] == 1                             # linked to the causing event
    sig = world.q("select signal, severity from risk_signals where signal='long_polished_answer'")
    assert sig and sig[0]["severity"] == "LOW"                                                          # catalogue class (unknown signal -> LOW); see app/risk.py
    assert world.q("select count(*) n from learning_events where event_type='AI_INTERACTION'")[0]["n"] == 1


def test_coach_rejects_forged_identity_fields(world):
    for extra in ({"student_id": "S2"}, {"policy": "OPEN"}, {"university_id": "U2"}, {"allowed_document_ids": ["x"]}):
        r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "hi", **extra}, headers=world.h("S1"))
        assert r.status_code == 422, extra


def test_coach_failure_writes_nothing(world):
    world.ai.fail = True
    r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help"}, headers=world.h("S1"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "ai_unavailable"
    for t in ("ai_interactions", "messages", "ai_interaction_sources"):
        assert world.q(f"select count(*) n from {t}")[0]["n"] == 0
    assert world.q("select count(*) n from learning_events where event_type='AI_INTERACTION'")[0]["n"] == 0
    assert world.q("select turn_count from ai_sessions")[0]["turn_count"] == 0


def test_coach_requires_open_attempt(world):
    world.x("update attempts set status='SUBMITTED' where attempt_id='T1'")
    r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help"}, headers=world.h("S1"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_open_attempt"


def test_verification_ownership_and_flow(world):
    h = world.h("S1")
    assert world.client.post(f"{API}/student/assignments/A1/verification", headers=h).status_code == 409        # not submitted yet
    assert world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "theta = theta - lr * grad"}, headers=h).status_code == 200
    st = world.client.post(f"{API}/student/assignments/A1/verification", headers=h).json()
    vid = st["verification_id"]
    assert [s["status"] for s in st["steps"]] == ["current", "upcoming", "upcoming"] and st["current"]["type"] == "EXPLAIN"
    assert world.client.get(f"{API}/student/verification/{vid}", headers=world.h("S2")).status_code == 404            # someone else's
    assert world.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "x"}, headers=world.h("S2")).status_code == 404
    seen = []
    for expected_next in ("MODIFY", "TRANSFER", None):
        r = world.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "because the gradient points uphill"}, headers=h)
        assert r.status_code == 200, r.text
        seen.append(r.json()["state"]["current"] and r.json()["state"]["current"]["type"])
        assert seen[-1] == expected_next
    end = r.json()
    assert end["completed"] and end["state"]["status"] == "COMPLETED" and end["state"]["outcome"] == "PASS"
    assert world.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "again"}, headers=h).status_code == 409
    run = world.q("select status, overall_outcome, attempt_id from verification_runs")[0]
    assert run["status"] == "COMPLETED" and run["attempt_id"] == "T1"
    assert world.q("select count(*) n from verification_results")[0]["n"] == 3
    st = world.q("select mastery_estimate, evidence_count from student_concept_state")[0]
    assert float(st["mastery_estimate"]) == pytest.approx(0.8) and st["evidence_count"] == 3
    assert world.client.get(f"{API}/student/assignments/A1", headers=h).json()["status"] == "verified"


def test_verification_outage_is_not_recorded_as_a_result(world):
    h = world.h("S1")
    world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "work"}, headers=h)
    vid = world.client.post(f"{API}/student/assignments/A1/verification", headers=h).json()["verification_id"]
    world.ai.fail = True
    assert world.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "x"}, headers=h).status_code == 503
    assert world.q("select count(*) n from verification_responses")[0]["n"] == 0        # the student can simply try again
    world.ai.fail = False
    assert world.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "x"}, headers=h).status_code == 200


def test_attempt_work_is_stored_in_submission_snapshot(world):
    h = world.h("S1")
    assert world.client.patch(f"{API}/student/attempts/T1", json={"draft_text": "draft v1"}, headers=h).status_code == 200
    r = world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "final answer"}, headers=h)
    assert r.status_code == 200
    sub = world.q("select submission_text, student_id, assignment_id, university_id, submission_type from submissions")[0]
    assert sub == {"submission_text": "final answer", "student_id": "S1", "assignment_id": "A1", "university_id": "U1", "submission_type": "text"}
    assert world.q("select status, ended_at is not null e from attempts where attempt_id='T1'")[0] == {"status": "SUBMITTED", "e": True}
    assert world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "twice"}, headers=h).status_code == 409   # double submit
    assert world.client.patch(f"{API}/student/attempts/T1", json={"draft_text": "late edit"}, headers=h).status_code == 409


def test_teacher_course_uses_instructor_id(world):
    cards = world.client.get(f"{API}/teacher/courses", headers=world.h("P1")).json()["courses"]
    assert [c["id"] for c in cards] == ["C1"]
    assert [c["id"] for c in world.client.get(f"{API}/teacher/courses", headers=world.h("P2")).json()["courses"]] == ["C2"]


# ---------------------------------------------------------------- new behaviour
def test_validation_errors_have_a_uniform_shape(world):
    r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1"}, headers=world.h("S1"))
    e = r.json()["error"]
    assert r.status_code == 422 and e["code"] == "validation_error" and e["details"][0]["field"] == "message" and e["request_id"]


def test_unhandled_errors_do_not_leak_internals(world, monkeypatch):
    import app.routers.student as st
    monkeypatch.setattr(st, "student_status", lambda *a, **k: 1 / 0)
    r = world.client.get(f"{API}/student/home", headers=world.h("S1"))
    assert r.status_code == 500 and "division" not in r.text and r.json()["error"]["code"] == "internal_error"


def test_attempt_start_is_idempotent_and_versioned(world):
    h = world.h("S2")
    world.x("update assignments set status='PUBLISHED' where assignment_id='A2'")
    a = world.client.post(f"{API}/student/assignments/A2/attempts", headers=h).json()
    b = world.client.post(f"{API}/student/assignments/A2/attempts", headers=h).json()
    assert a["id"] == b["id"] == "T2"                                    # the seeded open attempt is returned, no duplicate
    world.client.post(f"{API}/student/attempts/T2/submit", json={"text": "x"}, headers=h)
    c = world.client.post(f"{API}/student/assignments/A2/attempts", headers=h).json()
    assert c["attempt_number"] == 2 and c["assignment_version"] == 1     # revision = new attempt
    assert world.client.get(f"{API}/teacher/assignments/A2", headers=world.h("P2")).status_code == 200


def test_student_home_and_course_detail_only_expose_ready_material(world):
    d = world.client.get(f"{API}/student/courses/C1", headers=world.h("S1")).json()
    assert d["course"]["id"] == "C1" and [a["id"] for a in d["assignments"]] == ["A1"] and d["materials"] == []
    assert world.client.get(f"{API}/student/courses/C2", headers=world.h("S1")).status_code == 404
    home = world.client.get(f"{API}/student/home", headers=world.h("S1")).json()
    assert home["assignments"][0]["status"] == "in_progress"
