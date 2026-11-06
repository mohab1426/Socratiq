"""
Unit tests for the FastAPI contracts and adapter functions.
"""
from __future__ import annotations

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision, ValidationResult
from ai.contracts import (
    ChatMessageDto,
    CoachApiRequest,
    CoachApiResponse,
    run_coach_turn,
)
from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
from ai.tests.conftest import FakeStructuredLLM


def test_run_coach_turn_adapter(monkeypatch):
    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(
                result=DiagnosisResult(
                    category=DiagnosisCategory.MISCONCEPTION,
                    concept="learning_rate",
                    explanation="Scales with prediction",
                    evidence="theta = theta - prediction",
                    confidence=0.85,
                )
            )
        if schema is InterventionDecision:
            return FakeStructuredLLM(
                result=InterventionDecision(
                    intervention_type=InterventionType.QUESTION,
                    rationale="Guide student",
                )
            )
        if schema is GeneratedResponse:
            return FakeStructuredLLM(
                result=GeneratedResponse(
                    response="What factor controls the step size in gradient descent?",
                    referenced_concepts=["learning_rate"],
                )
            )
        raise AssertionError(schema)

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod,
        "validate_response",
        lambda **kwargs: ValidationResult(passes=True, violations=[]),
    )

    request = CoachApiRequest(
        student_id="student_1",
        assignment_id="asg_1",
        session_id="sess_1",
        course_id="course_1",
        attempt="theta = theta - prediction",
        policy=AssistancePolicy.GUIDED,
        message="is this right?",
        is_programming=True,
        conversation=[
            ChatMessageDto(role="student", content="I started this assignment"),
            ChatMessageDto(role="coach", content="Great, what is your first step?"),
        ],
    )

    response: CoachApiResponse = run_coach_turn(request)

    assert response.response == "What factor controls the step size in gradient descent?"
    assert response.intervention.type == InterventionType.QUESTION
    assert response.diagnosis.category == DiagnosisCategory.MISCONCEPTION
    assert response.learning_event.session_id == "sess_1"
    assert response.learning_event.student_id == "student_1"
    assert isinstance(response.evidence_candidates, list)
    assert isinstance(response.risk_signals, list)

    # Test serialization to JSON
    json_output = response.model_dump(mode="json")
    assert "response" in json_output
    assert "diagnosis" in json_output
    assert json_output["diagnosis"]["category"] == "MISCONCEPTION"
