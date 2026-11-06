"""Risk intelligence through the real API + database (only the LLM is faked). NOT runnable without Postgres; see docs/RISK_AND_DASHBOARD_REPORT.md.
Covers: structured output, insufficient evidence, evidence traceability, authorisation, student isolation, tenant/course scoping of concepts."""
from __future__ import annotations

import re
from pathlib import Path

from .helpers import API
from .test_flows import _run_student_journey

SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"


def _dash(w, who="P1"):
    r = w.client.get(f"{API}/teacher/courses/C1/dashboard", headers=w.h(who))
    assert r.status_code == 200, r.text
    return r.json()


def _detail(w, sid="S1", who="P1"):
    r = w.client.get(f"{API}/teacher/students/{sid}", headers=w.h(who))
    assert r.status_code == 200, r.text
    return r.json()


def _add_signal(w, rid, sid, signal, asg="A1"):
    w.x("insert into risk_signals (risk_signal_id, student_id, assignment_id, signal, observation, severity, university_id) values (%s,%s,%s,%s,%s,'LOW','U1')",
        rid, sid, asg, signal, f"observed {signal}")


def test_no_activity_is_insufficient_evidence_not_low(world):
    d = _dash(world)
    r = d["students"][0]["risk"]
    # the world seeds exactly one risk signal: with no recorded activity it is shown for context only, never rated
    assert r["level"] == "insufficient" and r["score"] is None and r["evidence_count"] == 1
    assert d["review_queue"] == [] and d["overview"]["risk_distribution"]["insufficient"] == 1
    assert d["overview"]["students"] == 1 and d["overview"]["verifications_completed"] == 0 and d["overview"]["active_students"] == 0


def test_one_coach_turn_with_signals_is_not_rated(world):
    assert world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help me"}, headers=world.h("S1")).status_code == 200
    for i, s in enumerate(("unusually_large_attempt_jump", "could_not_explain_submitted_work", "style_shift_between_attempts")):
        _add_signal(world, f"RX{i}", "S1", s)
    r = _dash(world)["students"][0]["risk"]
    assert r["level"] == "insufficient" and r["score"] is None            # 1 activity unit < 3: signals are context, never a rating
    assert _dash(world)["review_queue"] == []


def test_normal_journey_is_low_and_fully_traceable(world):
    _run_student_journey(world)
    d = _dash(world)
    assert d["students"][0]["risk"]["level"] == "low"
    assert d["overview"]["verifications_completed"] == 1 and d["overview"]["active_students"] == 1 and d["overview"]["assignments"] == 1
    sd = _detail(world)
    r = sd["risk"]
    assert r["level"] == "low" and r["disclaimer"] and r["model_version"] == "risk-v1" and r["confidence_label"] in ("Medium", "High")
    ids = {x["risk_signal_id"] for x in world.q("select risk_signal_id from risk_signals where student_id='S1'")}
    refs = {e["ref_id"] for s in r["top_signals"] for e in s["evidence"] if e["source"] == "risk_signal"}
    assert refs and refs <= ids                                             # every displayed signal points at a real row
    assert any(t["flagged"] for t in sd["timeline"])                        # the same signal is visible on the timeline


def test_multiple_signals_reach_the_review_queue_with_a_reason(world):
    _run_student_journey(world)
    for i, s in enumerate(("unusually_large_attempt_jump", "solution_sophistication_inconsistent_with_prior_attempt", "style_shift_between_attempts")):
        _add_signal(world, f"RM{i}", "S1", s)
    d = _dash(world)
    assert d["students"][0]["risk"]["level"] in ("moderate", "high")
    q = d["review_queue"]
    assert len(q) == 1 and q[0]["kind"] == "risk_review" and q[0]["student_id"] == "S1" and q[0]["primary_reason"] and q[0]["evidence_count"] >= 3
    assert d["risk_disclaimer"].lower().startswith("this is an indicator")


def test_verification_and_coach_data_are_in_the_student_detail(world):
    _run_student_journey(world)
    sd = _detail(world)
    assert sd["ai_usage"]["interactions"] == 1 and sd["ai_usage"]["by_intervention"][0]["type"] == "QUESTION"
    assert len(sd["verification"]) == 1 and len(sd["verification"][0]["questions"]) == 3 and sd["verification"][0]["outcome"]
    assert sd["assignments"][0]["submitted"] is True and sd["assignments"][0]["coach_turns"] == 1
    # (the seeded attempt row was inserted directly, so only the API-created events appear; POST /attempts' ATTEMPT event is covered separately)
    assert {t["kind"] for t in sd["timeline"]} >= {"coach", "submission", "verification"}


def test_student_a_evidence_never_changes_student_b(world):
    _run_student_journey(world)
    before = _detail(world)["risk"]
    for i in range(8):
        _add_signal(world, f"RI{i}", "S2", "unusually_large_attempt_jump")           # S2 is not in this instructor's class at all
    assert _detail(world)["risk"] == before
    assert _dash(world)["students"][0]["risk"]["evidence_count"] == before["evidence_count"]
    assert world.client.get(f"{API}/teacher/students/S2", headers=world.h("P1")).status_code == 404


def test_another_instructor_cannot_read_risk(world):
    _run_student_journey(world)
    for who in ("P2", "P3"):
        assert world.client.get(f"{API}/teacher/students/S1", headers=world.h(who)).status_code == 404
        assert world.client.get(f"{API}/teacher/courses/C1/dashboard", headers=world.h(who)).status_code == 404
        assert world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h(who)).status_code == 404
    for who in ("S1", "S2"):
        assert world.client.get(f"{API}/teacher/students/S1", headers=world.h(who)).status_code == 403
    assert "risk" not in world.client.get(f"{API}/student/assignments/A1", headers=world.h("S1")).text.lower()


def test_submission_review_carries_only_this_assignments_assessment(world):
    _run_student_journey(world)
    rv = world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P1")).json()
    assert rv["risk"]["level"] in ("insufficient", "low", "moderate", "high") and rv["risk"]["model_version"] == "risk-v1"


def test_concepts_from_other_courses_do_not_leak_into_the_instructors_view(world):
    world.x("insert into concepts (concept_id, university_id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','U1','Unrelated Concept'), ('aaaaaaaa-0000-0000-0000-000000000002','U1','Tagged Concept')")
    world.x("insert into student_concept_state (student_id, concept_id, mastery_estimate, confidence, evidence_count, university_id) "
            "values ('S1','aaaaaaaa-0000-0000-0000-000000000001',0.1,0.8,3,'U1'), ('S1','aaaaaaaa-0000-0000-0000-000000000002',0.2,0.8,3,'U1')")
    world.x("insert into assignment_concepts (assignment_id, concept_id, university_id) values ('A1','aaaaaaaa-0000-0000-0000-000000000002','U1')")
    sd = _detail(world)
    names = [c["name"] for c in sd["concepts"]]
    assert "Tagged Concept" in names and "Unrelated Concept" not in names
    assert "Unrelated Concept" not in sd["struggling_topics"] and "Tagged Concept" in sd["struggling_topics"]


def test_severity_is_written_from_the_catalogue(world):
    import psycopg
    from app.records import insert_risk_signal
    with psycopg.connect(world.url, autocommit=True) as c:
        insert_risk_signal(c, student_id="S1", university_id="U1", assignment_id="A1", session_id=None, event_id=None,
                           sig={"signal": "unusually_large_attempt_jump", "observation": "x", "metadata": {}})
    assert world.q("select severity, confidence from risk_signals where signal='unusually_large_attempt_jump'")[0] == {"severity": "MEDIUM", "confidence": None}


def test_teacher_ui_makes_no_accusatory_or_ungrounded_claims():
    """Static guard over the instructor UI source: a grade metric only with a real grade writer and an empty state, no detection language."""
    files = list((SRC / "pages" / "teacher").rglob("*.tsx")) + list((SRC / "components" / "socratiq").rglob("*.tsx"))
    text = "\n".join(f.read_text() for f in files)
    if "averageGrade" in text:                                                     # displayed => a grade writer exists and "no grades yet" is an explicit empty state
        assert "/grade" in (SRC / "lib" / "queries.ts").read_text() and "No graded work yet" in text
    assert not re.search(r"cheat|plagiar|dishonest|chatgpt|ai[- ]detect|detected", text, re.I)
    assert "not proof of external ai use" in (Path(__file__).resolve().parents[1] / "app" / "risk.py").read_text().lower()
