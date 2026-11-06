"""Backend <-> AI contract. The REAL Coach graph, retrieval tool, history tool and VerificationService run against the REAL database
and RAG index; only the LLM calls are faked (the same technique the AI package's own tests use)."""
from __future__ import annotations

import time

import pytest

from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision
from ai.models.schemas import DiagnosisCategory, InterventionType
from ai.tests.conftest import FakeStructuredLLM
from ai.verification.models import CriterionEvaluation, VerificationEvaluationPayload, VerificationOutcome
from ai.verification.service import GeneratedChallengePayload

from .helpers import API, retrieve, sample, upload


@pytest.fixture()
def real(world, monkeypatch):
    """World whose AI adapter is the production wiring; LLM calls are answered by fakes."""
    from app.ai_adapter import build_ai_adapter
    state = {"prompts": [], "eval_raises": False, "challenge_raises": False, "eval_score": 0.9}

    def fake_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(result=DiagnosisResult(category=DiagnosisCategory.MISCONCEPTION, concept="learning rate",
                                                            explanation="The update omits the learning rate.", evidence="theta = theta - grad", confidence=0.85))
        if schema is InterventionDecision:
            return FakeStructuredLLM(result=InterventionDecision(intervention_type=InterventionType.QUESTION, rationale="prompt reflection",
                                                                 needs_course_material=True, needs_student_history=True))
        if schema is GeneratedResponse:
            def respond(messages):
                state["prompts"].append(str(messages))
                return GeneratedResponse(response="What scales the size of each step?", referenced_concepts=["learning rate"])
            return FakeStructuredLLM(side_effect=respond)
        if schema is GeneratedChallengePayload:
            return FakeStructuredLLM(raises=RuntimeError("llm down")) if state["challenge_raises"] else \
                FakeStructuredLLM(result=GeneratedChallengePayload(question="Why does the learning rate matter here?", criteria=["names the step size"]))
        if schema is VerificationEvaluationPayload:
            if state["eval_raises"]:
                return FakeStructuredLLM(raises=RuntimeError("llm down"))
            return FakeStructuredLLM(result=VerificationEvaluationPayload(
                outcome=VerificationOutcome.PASS, score=state["eval_score"], confidence=0.9, feedback="Clear reasoning.",
                criteria_evaluations=[CriterionEvaluation(criterion="names the step size", passed=True, feedback="yes")]))
        return FakeStructuredLLM(result={"passes": True, "violations": []})

    monkeypatch.setattr("ai.agents.coach.nodes.get_structured_llm", fake_llm)
    monkeypatch.setattr("ai.verification.service.get_structured_llm", fake_llm)
    ok = lambda **kw: type("V", (), {"passes": True, "violations": [], "revised_response": None})()  # noqa: E731
    monkeypatch.setattr("ai.guardrails.coach_validator.validate_response", ok)
    try:
        monkeypatch.setattr("ai.agents.coach.nodes.validate_response", ok)
    except AttributeError:
        pass
    adapter = build_ai_adapter(world.db, world.rag)
    calls = []
    orig = adapter.coach.invoke
    adapter.coach.invoke = lambda **kw: (calls.append(kw), orig(**kw))[1]
    world.app.state.ai = adapter
    world.state, world.calls, world.adapter = state, calls, adapter
    return world


def coach(w, msg="is my update right?", who="S1"):
    return w.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": msg}, headers=w.h(who))


def test_real_coach_result_is_persisted_faithfully(real):
    upload(real, "P1", "sample.txt", sample("sample.txt")); real.drain()
    doc = real.q("select document_id from stored_files")[0]["document_id"]
    r = coach(real)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["message"]["content"] == "What scales the size of each step?" and b["intervention"]["type"] == "QUESTION" and b["message"]["kind"] == "question"
    ix = real.q("select intervention_type, assistance_level, diagnosis, diagnosis_confidence, diagnosis_explanation, diagnosis_evidence, referenced_concepts, tools_used from ai_interactions")[0]
    assert ix["intervention_type"] == "QUESTION" and ix["assistance_level"] == "GUIDED" and ix["diagnosis"] == "MISCONCEPTION"
    assert float(ix["diagnosis_confidence"]) == pytest.approx(0.85) and ix["diagnosis_explanation"] == "The update omits the learning rate."
    assert ix["referenced_concepts"] == ["learning rate"] and {"course_retriever", "student_history"} <= set(ix["tools_used"])
    src = real.q("select s.document_id, s.retrieval_rank, c.university_id, c.course_id from ai_interaction_sources s join document_chunks c on c.chunk_id=s.chunk_id")
    assert src and {s["document_id"] for s in src} == {doc} and all((s["university_id"], s["course_id"]) == ("U1", "C1") for s in src)
    assert b["sources"] and b["sources"][0]["document_title"]
    ev = real.q("select evidence_type from evidence_candidates where evidence_id like 'evd_%%'")
    assert ev and all(e["evidence_type"] in ("MISCONCEPTION", "UNDERSTANDING", "REVISION", "INDEPENDENCE", "EXPLANATION", "TRANSFER") for e in ev)
    assert real.q("select payload->>'intervention' i, payload->>'diagnosis' d from learning_events where event_type='AI_INTERACTION'")[0] == {"i": "QUESTION", "d": "MISCONCEPTION"}


def test_student_name_is_resolved_server_side_and_reaches_response_prompt(real):
    coach(real)
    assert real.calls[-1]["student_id"] == "S1"
    assert real.calls[-1]["student_name"] == "FirstS1 Last"           # first_name/last_name come from the users row
    prompt = real.state["prompts"][-1]
    assert "FirstS1 Last" in prompt
    import re
    assert re.search(r"\bS1\b", prompt) is None                       # the raw student id is never shown (the seeded name merely contains it)


def test_whitelist_is_never_empty_and_tenant_context_is_server_supplied(real):
    assert coach(real).status_code == 200
    t = real.calls[-1]["task_context"]
    assert t.allowed_document_ids == ["__no_documents_allowed__"]                     # empty would mean "no restriction" inside the AI
    assert (t.university_id, t.classroom_id, t.course_id, t.assignment_id) == ("U1", "K1", "C1", "A1")
    assert real.calls[-1]["policy"].value == "GUIDED" and real.calls[-1]["student_id"] == "S1"
    assert real.q("select count(*) n from ai_interaction_sources")[0]["n"] == 0
    upload(real, "P1", "sample.txt", sample("sample.txt")); real.drain()
    doc = real.q("select document_id from stored_files")[0]["document_id"]
    coach(real)
    assert real.calls[-1]["task_context"].allowed_document_ids == [doc]


def test_coach_cannot_retrieve_other_tenants_documents_even_if_whitelisted_by_mistake(real, monkeypatch):
    upload(real, "P3", "sample.txt", sample("sample.txt"), course="C3"); real.drain()          # university U2, same text as would match
    foreign = real.q("select document_id from documents where university_id='U2'")[0]["document_id"]
    import app.routers.ai as ai_router
    monkeypatch.setattr(ai_router, "allowed_document_ids", lambda c, a: [foreign])             # simulate a backend bug leaking an id
    b = coach(real).json()
    assert b["sources"] == [] and real.q("select count(*) n from ai_interaction_sources")[0]["n"] == 0
    assert "course_retriever" in real.q("select tools_used from ai_interactions")[0]["tools_used"]      # it did search, and was denied by scope


def test_history_tool_only_reads_the_students_own_evidence(real):
    real.x("insert into evidence_candidates (evidence_id, student_id, assignment_id, evidence_type, strength, observation, university_id, concept) "
           "values ('V2','S2','A2','MISCONCEPTION','STRONG','S2-PRIVATE-OBSERVATION','U1','learning rate')")
    from app.ai_adapter import DbHistoryProvider
    rows = DbHistoryProvider(real.db)("S1", "A1", "learning rate")
    assert rows and all("S2-PRIVATE" not in r.content for r in rows) and any("explained gradient" in r.content for r in rows)
    coach(real)
    assert not any("S2-PRIVATE" in p for p in real.state["prompts"])


def test_prior_diagnosis_and_intervention_are_passed_on_the_next_turn(real):
    coach(real)
    assert real.calls[-1]["prior_diagnosis"] is None and real.calls[-1]["turn_index"] == 0
    coach(real, "I changed it")
    k = real.calls[-1]
    assert k["prior_diagnosis"].category.value == "MISCONCEPTION" and k["prior_intervention"].type.value == "QUESTION" and k["turn_index"] == 1
    assert len(k["conversation"]) == 2 and k["conversation"][0].content == "is my update right?"


def test_history_window_is_respected(real, monkeypatch):
    from app.config import get_backend_config
    monkeypatch.setattr(get_backend_config(), "coach_history_window", 2)
    for i in range(3):
        coach(real, f"message {i}")
    assert [m.content for m in real.calls[-1]["conversation"]][-1].startswith("What scales")
    assert len(real.calls[-1]["conversation"]) == 2


def test_real_verification_flow_and_llm_outage_is_not_recorded(real):
    h = real.h("S1")
    real.client.post(f"{API}/student/attempts/T1/submit", json={"text": "theta = theta - lr * grad"}, headers=h)
    st = real.client.post(f"{API}/student/assignments/A1/verification", headers=h).json()
    assert st["current"]["question"] == "Why does the learning rate matter here?"
    q = real.q("select criteria, concept from verification_questions")[0]
    assert q["criteria"] == ["names the step size"] and q["concept"]
    vid = st["verification_id"]
    real.state["eval_raises"] = True                                                       # VerificationService swallows this and returns a fake "0.0" result
    r = real.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "it scales steps"}, headers=h)
    assert r.status_code == 503 and "not recorded" in r.json()["error"]["message"]
    assert real.q("select count(*) n from verification_responses")[0]["n"] == 0 and real.q("select count(*) n from verification_results")[0]["n"] == 0
    real.state["eval_raises"] = False
    for _ in range(3):
        r = real.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "it scales the step size"}, headers=h)
        assert r.status_code == 200
    assert r.json()["state"]["outcome"] == "PASS"
    assert float(real.q("select score from verification_runs")[0]["score"]) == pytest.approx(0.9)
    assert float(real.q("select mastery_estimate from student_concept_state")[0]["mastery_estimate"]) == pytest.approx(0.9)


def test_challenge_generation_failure_falls_back_to_a_valid_question(real):
    real.state["challenge_raises"] = True                                                  # AI returns its documented fallback question
    h = real.h("S1")
    real.client.post(f"{API}/student/attempts/T1/submit", json={"text": "work"}, headers=h)
    st = real.client.post(f"{API}/student/assignments/A1/verification", headers=h).json()
    assert "in your own words" in st["current"]["question"]


def test_a_slow_ai_times_out_cleanly_and_persists_nothing(real):
    real.adapter.timeout = 0.3
    real.adapter.coach.invoke = lambda **kw: time.sleep(2)
    r = coach(real)
    assert r.status_code == 503 and r.json()["error"]["code"] == "ai_unavailable"
    assert real.q("select count(*) n from ai_interactions")[0]["n"] == 0 and real.q("select count(*) n from messages")[0]["n"] == 0


def test_turn_after_submission_is_refused_and_persists_nothing(real):
    # the attempt gets submitted while the Coach is "thinking": the reply must be discarded, not recorded against a closed attempt
    real.app.state.ai = _Racy(real)
    r = coach(real)
    assert r.status_code == 409 and r.json()["error"]["code"] == "attempt_closed"
    assert real.q("select count(*) n from ai_interactions")[0]["n"] == 0 and real.q("select count(*) n from messages")[0]["n"] == 0


class _Racy:
    def __init__(self, w):
        self.w = w

    def coach_turn(self, **kw):
        from app.ai_adapter import CoachOutcome
        self.w.client.post(f"{API}/student/attempts/T1/submit", json={"text": "done"}, headers=self.w.h("S1"))
        return CoachOutcome("late", {"type": "HINT", "assistance_level": "GUIDED", "rationale": "r"}, None)
