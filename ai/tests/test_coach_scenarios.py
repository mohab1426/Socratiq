"""Socratic scenarios at the decision level: adaptive support, shown understanding, and the context each prompt receives.

LLM calls are faked, so what is verified is OUR logic (state, deterministic rules, prompt contents), not model quality."""
from __future__ import annotations

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.schemas import DiagnosisResult, InterventionDecision
from ai.models.schemas import AssistancePolicy, Diagnosis, DiagnosisCategory, Intervention, InterventionType
from ai.tests.conftest import FakeStructuredLLM
from ai.tests.test_nodes import _base_state

DC, IT = DiagnosisCategory, InterventionType


def _dx(category, concept="learning rate", confidence=0.8):
    return Diagnosis(category=category, concept=concept, explanation="e", evidence="ev", confidence=confidence)


def _decide(monkeypatch, itype):
    monkeypatch.setattr(nodes_mod, "get_structured_llm", lambda role, schema: FakeStructuredLLM(result=InterventionDecision(intervention_type=itype, rationale="r")))


def _diagnose_with(monkeypatch, state, new):
    monkeypatch.setattr(nodes_mod, "get_structured_llm", lambda role, schema: FakeStructuredLLM(
        result=DiagnosisResult(category=new.category, concept=new.concept or "", explanation="e", evidence="ev", confidence=new.confidence)))
    return nodes_mod.diagnose(state)


# ---- repeated failure -> the support level adapts ---------------------------------------------------------------------------
def test_same_difficulty_on_consecutive_turns_is_flagged_as_repeated(monkeypatch, task_context, metadata):
    metadata.turn_index = 2
    state = _base_state(task_context, metadata, diagnosis=_dx(DC.MISCONCEPTION))
    assert _diagnose_with(monkeypatch, state, _dx(DC.MISCONCEPTION))["repeated_difficulty"] is True
    assert _diagnose_with(monkeypatch, state, _dx(DC.LOGICAL_ERROR, concept="learning rate"))["repeated_difficulty"] is True        # same idea, different label
    assert _diagnose_with(monkeypatch, state, _dx(DC.LOGICAL_ERROR, concept="loss"))["repeated_difficulty"] is False                # a different difficulty
    assert _diagnose_with(monkeypatch, state, _dx(DC.CORRECT_REASONING))["repeated_difficulty"] is False                            # progress
    assert _diagnose_with(monkeypatch, state, _dx(DC.UNCERTAIN, confidence=0.2))["repeated_difficulty"] is False


def test_first_turn_is_never_a_repeat(monkeypatch, task_context, metadata):
    metadata.turn_index = 1
    assert _diagnose_with(monkeypatch, _base_state(task_context, metadata, diagnosis=None), _dx(DC.MISCONCEPTION))["repeated_difficulty"] is False


def test_repeating_the_same_question_after_a_repeated_difficulty_escalates_to_a_hint(monkeypatch, task_context, metadata):
    metadata.turn_index = 3
    _decide(monkeypatch, IT.QUESTION)
    state = _base_state(task_context, metadata, diagnosis=_dx(DC.MISCONCEPTION), repeated_difficulty=True,
                        intervention=Intervention(type=IT.QUESTION, assistance_level=AssistancePolicy.GUIDED, rationale="before"))
    out = nodes_mod.choose_intervention(state)["intervention"]
    assert out.type == IT.HINT and "escalated" in out.rationale


def test_a_repeated_hint_escalates_to_explanation_or_guided_debugging_by_error_kind(monkeypatch, task_context, metadata):
    metadata.turn_index = 4
    _decide(monkeypatch, IT.HINT)
    prev = Intervention(type=IT.HINT, assistance_level=AssistancePolicy.GUIDED, rationale="before")
    conceptual = nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.MISCONCEPTION), repeated_difficulty=True, intervention=prev))["intervention"]
    code = nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.CODE_ERROR), repeated_difficulty=True, intervention=prev))["intervention"]
    assert conceptual.type == IT.EXPLANATION and code.type == IT.GUIDED_DEBUGGING


def test_no_escalation_when_not_repeating_or_when_the_model_already_changed_approach(monkeypatch, task_context, metadata):
    metadata.turn_index = 3
    prev = Intervention(type=IT.QUESTION, assistance_level=AssistancePolicy.GUIDED, rationale="before")
    _decide(monkeypatch, IT.QUESTION)
    assert nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.MISCONCEPTION), repeated_difficulty=False, intervention=prev))["intervention"].type == IT.QUESTION
    _decide(monkeypatch, IT.GUIDED_DEBUGGING)
    assert nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.CODE_ERROR), repeated_difficulty=True, intervention=prev))["intervention"].type == IT.GUIDED_DEBUGGING


def test_uncertain_diagnosis_still_forces_clarification_even_if_repeating(monkeypatch, task_context, metadata):
    metadata.turn_index = 3
    _decide(monkeypatch, IT.QUESTION)
    prev = Intervention(type=IT.QUESTION, assistance_level=AssistancePolicy.GUIDED, rationale="b")
    out = nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.UNCERTAIN, confidence=0.2), repeated_difficulty=True, intervention=prev))["intervention"]
    assert out.type == IT.CLARIFICATION


def test_first_attempt_under_guided_still_never_jumps_to_explanation(monkeypatch, task_context, metadata):      # "Give me the answer" on turn 1
    metadata.turn_index = 1
    _decide(monkeypatch, IT.EXPLANATION)
    assert nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.INCOMPLETE_REASONING)))["intervention"].type == IT.QUESTION


# ---- demonstrated understanding -> acknowledge and move on ----------------------------------------------------------------
def test_shown_understanding_never_gets_a_hint_or_debugging_session(monkeypatch, task_context, metadata):
    metadata.turn_index = 3
    for chosen in (IT.HINT, IT.GUIDED_DEBUGGING):
        _decide(monkeypatch, chosen)
        out = nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.CORRECT_REASONING, confidence=0.9)))["intervention"]
        assert out.type == IT.FEEDBACK and "reasoning is correct" in out.rationale


def test_low_confidence_correct_reasoning_is_not_trusted_enough_to_change_the_plan(monkeypatch, task_context, metadata):
    metadata.turn_index = 3
    _decide(monkeypatch, IT.HINT)
    out = nodes_mod.choose_intervention(_base_state(task_context, metadata, diagnosis=_dx(DC.CORRECT_REASONING, confidence=0.5)))["intervention"]
    assert out.type == IT.HINT                                                                      # below the 0.6 bar the deterministic rule does not fire


# ---- what each prompt actually receives -----------------------------------------------------------------------------------
def test_intervention_prompt_states_repeated_difficulty_and_the_adaptation_rules():
    from ai.prompts.coach.intervention_prompt import build_intervention_messages
    msgs = build_intervention_messages(policy="GUIDED", diagnosis_category="MISCONCEPTION", diagnosis_concept="lr", diagnosis_explanation="e", diagnosis_confidence=0.8,
                                       is_revision=True, previous_intervention="QUESTION", turn_index=3, repeated_difficulty=True)
    system, human = msgs[0].content, msgs[1].content
    assert "Repeated difficulty with the same idea: True" in human
    assert "progressively more concrete" in system and "CORRECT_REASONING" in system and "apply the idea in a new situation" in system


def test_diagnosis_prompt_receives_trusted_application_context():
    from ai.prompts.diagnosis.diagnosis_prompt import build_diagnosis_messages
    kw = dict(assignment_title="GD", assignment_instructions="i", policy="GUIDED", is_revision=False, course_material="", prior_diagnosis_summary="",
              conversation_summary="", current_attempt="x")
    with_ctx = build_diagnosis_messages(**kw, application_context="Course: CS101\nExpected concepts: learning rate")[1].content
    assert "Platform context" in with_ctx and "Expected concepts: learning rate" in with_ctx
    assert "Platform context" not in build_diagnosis_messages(**kw)[1].content


def test_response_prompt_tells_the_model_to_move_on_to_transfer_or_verification_after_understanding():
    """Shown understanding must lead forward (transfer / submit-for-verification), not into more probing questions."""
    from ai.prompts.coach.response_prompt import build_response_messages
    import inspect
    sig = inspect.signature(build_response_messages)
    kw = {k: ("x" if p.annotation in (str, "str") else None) for k, p in sig.parameters.items() if p.default is inspect._empty}
    system = build_response_messages(**kw)[0].content
    low = system.lower()
    assert "feedback or encouragement" in low and "transfer question" in low and "verification" in low
    assert "do not re-teach" in low and "never present this as a grade" in low
    assert "never give the student the final answer" in low                      # the absolute rule is untouched
