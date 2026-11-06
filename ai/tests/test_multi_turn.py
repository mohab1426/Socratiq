"""
Multi-turn end-to-end session test.

Simulates a 3-turn student journey:
1. Turn 1: Initial incorrect attempt -> Misconception -> Guiding Question
2. Turn 2: Partial revision -> Revised Misconception -> Guided Debugging Hint
3. Turn 3: Correct revision -> Correct Reasoning -> Encouragement + Evidence
"""
from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.graph import Coach
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision, ValidationResult
from ai.models.schemas import (
    AssistancePolicy,
    DiagnosisCategory,
    EvidenceType,
    InterventionType,
)
from ai.tests.conftest import FakeStructuredLLM


def test_three_turn_student_learning_progression(monkeypatch, task_context):
    diagnoses = iter(
        [
            # Turn 1: Missing gradient and lr
            DiagnosisResult(
                category=DiagnosisCategory.MISCONCEPTION,
                concept="gradient_descent",
                explanation="Updates parameters directly by raw prediction error.",
                evidence="theta = theta - prediction",
                confidence=0.8,
            ),
            # Turn 2: Added gradient, but forgot learning rate
            DiagnosisResult(
                category=DiagnosisCategory.MISCONCEPTION,
                concept="learning_rate",
                explanation="Now uses gradient, but missing learning rate scaling.",
                evidence="theta = theta - gradient",
                confidence=0.85,
            ),
            # Turn 3: Full correct solution
            DiagnosisResult(
                category=DiagnosisCategory.CORRECT_REASONING,
                concept="gradient_descent",
                explanation="Properly updates theta using learning rate and gradient.",
                evidence="theta = theta - lr * gradient",
                confidence=0.95,
            ),
        ]
    )

    interventions = iter(
        [
            # Turn 1
            InterventionDecision(
                intervention_type=InterventionType.QUESTION,
                rationale="Prompt student to think about the direction of steepest descent.",
            ),
            # Turn 2
            InterventionDecision(
                intervention_type=InterventionType.HINT,
                rationale="Hint about step-size control.",
            ),
            # Turn 3
            InterventionDecision(
                intervention_type=InterventionType.ENCOURAGEMENT,
                rationale="Reinforce complete mastery of the update rule.",
            ),
        ]
    )

    responses = iter(
        [
            GeneratedResponse(
                response="What vector tells you the direction of steepest ascent of the loss?",
                referenced_concepts=["gradient"],
            ),
            GeneratedResponse(
                response="You have the gradient direction now! What quantity prevents taking too large a step?",
                referenced_concepts=["learning_rate"],
            ),
            GeneratedResponse(
                response="Spot on! Scaling the gradient by the learning rate gives the exact parameter step.",
                referenced_concepts=["gradient_descent", "learning_rate"],
            ),
        ]
    )

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(side_effect=lambda m: next(diagnoses))
        if schema is InterventionDecision:
            return FakeStructuredLLM(side_effect=lambda m: next(interventions))
        if schema is GeneratedResponse:
            return FakeStructuredLLM(side_effect=lambda m: next(responses))
        raise AssertionError(schema)

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod,
        "validate_response",
        lambda **kwargs: ValidationResult(passes=True, violations=[]),
    )

    coach = Coach()
    conversation = []

    # ======================== TURN 1 ========================
    result1 = coach.invoke(
        student_id="student_bob",
        assignment_id="asg_gd",
        session_id="sess_123",
        task_context=task_context,
        attempt="theta = theta - prediction",
        policy=AssistancePolicy.GUIDED,
        conversation=conversation,
        turn_index=0,
    )

    assert result1.metadata["turn_index"] == 1
    assert result1.diagnosis_summary.category == DiagnosisCategory.MISCONCEPTION
    assert result1.intervention.type == InterventionType.QUESTION
    # On turn 1 with incorrect attempt, no independence evidence emitted
    evidence_types_1 = [e.evidence_type for e in result1.evidence_candidates]
    assert EvidenceType.INDEPENDENCE not in evidence_types_1
    assert EvidenceType.MISCONCEPTION in evidence_types_1

    # Update conversation history as backend would
    conversation.append(HumanMessage(content="theta = theta - prediction"))
    conversation.append(AIMessage(content=result1.response))

    # ======================== TURN 2 ========================
    result2 = coach.invoke(
        student_id="student_bob",
        assignment_id="asg_gd",
        session_id="sess_123",
        task_context=task_context,
        attempt="theta = theta - gradient",
        message="I changed it to use the gradient",
        policy=AssistancePolicy.GUIDED,
        conversation=conversation,
        turn_index=1,
    )

    assert result2.metadata["turn_index"] == 2
    assert result2.diagnosis_summary.concept == "learning_rate"
    assert result2.intervention.type == InterventionType.HINT
    evidence_types_2 = [e.evidence_type for e in result2.evidence_candidates]
    assert EvidenceType.REVISION in evidence_types_2

    conversation.append(HumanMessage(content="theta = theta - gradient\n\nI changed it to use the gradient"))
    conversation.append(AIMessage(content=result2.response))

    # ======================== TURN 3 ========================
    result3 = coach.invoke(
        student_id="student_bob",
        assignment_id="asg_gd",
        session_id="sess_123",
        task_context=task_context,
        attempt="theta = theta - lr * gradient",
        policy=AssistancePolicy.GUIDED,
        conversation=conversation,
        turn_index=2,
    )

    assert result3.metadata["turn_index"] == 3
    assert result3.diagnosis_summary.category == DiagnosisCategory.CORRECT_REASONING
    assert result3.intervention.type == InterventionType.ENCOURAGEMENT
    evidence_types_3 = [e.evidence_type for e in result3.evidence_candidates]
    assert EvidenceType.UNDERSTANDING in evidence_types_3
    assert EvidenceType.REVISION in evidence_types_3


def test_prior_diagnosis_and_intervention_reach_turn_two_prompts(monkeypatch, task_context):
    """Regression: Coach.invoke() previously hardcoded diagnosis=None and
    intervention=None into initial_state on every call, so the "prior
    diagnosis" / "previous intervention" context that diagnose() and
    choose_intervention() build for their prompts was always empty --
    even on revision turns. Passing prior_diagnosis/prior_intervention
    into Coach.invoke() must make that context actually appear in the
    turn-2 prompts."""
    diagnosis_calls: list[list] = []
    intervention_calls: list[list] = []

    turn1_diagnosis = DiagnosisResult(
        category=DiagnosisCategory.MISCONCEPTION,
        concept="gradient_descent",
        explanation="Updates parameters directly by raw prediction error.",
        evidence="theta = theta - prediction",
        confidence=0.8,
    )
    turn2_diagnosis = DiagnosisResult(
        category=DiagnosisCategory.MISCONCEPTION,
        concept="learning_rate",
        explanation="Now uses gradient, but missing learning rate scaling.",
        evidence="theta = theta - gradient",
        confidence=0.85,
    )
    diagnoses = iter([turn1_diagnosis, turn2_diagnosis])

    turn1_intervention = InterventionDecision(
        intervention_type=InterventionType.QUESTION,
        rationale="Prompt student to think about the direction of steepest descent.",
    )
    turn2_intervention = InterventionDecision(
        intervention_type=InterventionType.HINT,
        rationale="Hint about step-size control.",
    )
    interventions = iter([turn1_intervention, turn2_intervention])

    responses = iter(
        [
            GeneratedResponse(
                response="What vector points toward steepest ascent of the loss?",
                referenced_concepts=["gradient"],
            ),
            GeneratedResponse(
                response="Good, you have the gradient! What controls the size of each step?",
                referenced_concepts=["learning_rate"],
            ),
        ]
    )

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            def _diag(messages):
                diagnosis_calls.append(messages)
                return next(diagnoses)
            return FakeStructuredLLM(side_effect=_diag)
        if schema is InterventionDecision:
            def _interv(messages):
                intervention_calls.append(messages)
                return next(interventions)
            return FakeStructuredLLM(side_effect=_interv)
        if schema is GeneratedResponse:
            return FakeStructuredLLM(side_effect=lambda m: next(responses))
        raise AssertionError(schema)

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod,
        "validate_response",
        lambda **kwargs: ValidationResult(passes=True, violations=[]),
    )

    coach = Coach()
    conversation = []

    result1 = coach.invoke(
        student_id="student_bob",
        assignment_id="asg_gd",
        session_id="sess_123",
        task_context=task_context,
        attempt="theta = theta - prediction",
        policy=AssistancePolicy.GUIDED,
        conversation=conversation,
        turn_index=0,
    )
    conversation.append(HumanMessage(content="theta = theta - prediction"))
    conversation.append(AIMessage(content=result1.response))

    # Turn 1 has no prior diagnosis/intervention -- the prompts should say so.
    turn1_diag_prompt = "\n".join(m.content for m in diagnosis_calls[0])
    assert "(none)" in turn1_diag_prompt
    turn1_interv_prompt = "\n".join(m.content for m in intervention_calls[0])
    assert "(none, first turn)" in turn1_interv_prompt

    # Turn 2: caller passes turn 1's diagnosis/intervention back in, exactly
    # as a backend would using the previous CoachResult.
    coach.invoke(
        student_id="student_bob",
        assignment_id="asg_gd",
        session_id="sess_123",
        task_context=task_context,
        attempt="theta = theta - gradient",
        message="I changed it to use the gradient",
        policy=AssistancePolicy.GUIDED,
        conversation=conversation,
        turn_index=1,
        prior_diagnosis=result1.diagnosis_summary,
        prior_intervention=result1.intervention,
    )

    turn2_diag_prompt = "\n".join(m.content for m in diagnosis_calls[1])
    assert "gradient_descent" in turn2_diag_prompt
    assert "MISCONCEPTION" in turn2_diag_prompt

    turn2_interv_prompt = "\n".join(m.content for m in intervention_calls[1])
    assert "QUESTION" in turn2_interv_prompt
    assert "(none, first turn)" not in turn2_interv_prompt
