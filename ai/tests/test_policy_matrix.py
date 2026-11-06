"""
Policy matrix tests: verifies behavioral divergence across GUIDED, ASSISTED, and OPEN modes.
"""
from __future__ import annotations

import pytest

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.graph import Coach
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision, ValidationResult
from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
from ai.tests.conftest import FakeStructuredLLM


@pytest.fixture
def mock_pipeline_for_policy(monkeypatch):
    def setup_mock(intervention_type: InterventionType):
        def fake_get_structured_llm(role, schema):
            if schema is DiagnosisResult:
                return FakeStructuredLLM(
                    result=DiagnosisResult(
                        category=DiagnosisCategory.MISCONCEPTION,
                        concept="gradient_descent",
                        explanation="Miscalculated the step",
                        evidence="theta = theta - prediction",
                        confidence=0.8,
                    )
                )
            if schema is InterventionDecision:
                return FakeStructuredLLM(
                    result=InterventionDecision(
                        intervention_type=intervention_type,
                        rationale="Selected intervention for policy test",
                    )
                )
            if schema is GeneratedResponse:
                return FakeStructuredLLM(
                    result=GeneratedResponse(
                        response="Pedagogical response message",
                        referenced_concepts=["gradient_descent"],
                    )
                )
            raise AssertionError(schema)

        monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
        monkeypatch.setattr(
            nodes_mod,
            "validate_response",
            lambda **kwargs: ValidationResult(passes=True, violations=[]),
        )

    return setup_mock


def test_guided_policy_downgrades_explanation_on_first_attempt(
    mock_pipeline_for_policy, task_context
):
    """Under GUIDED, an EXPLANATION on turn 1 must be strictly downgraded to QUESTION in code."""
    mock_pipeline_for_policy(InterventionType.EXPLANATION)
    coach = Coach()

    result = coach.invoke(
        student_id="s1",
        assignment_id="a1",
        session_id="sess_guided",
        task_context=task_context,
        attempt="theta = theta - prediction",
        policy=AssistancePolicy.GUIDED,
        turn_index=0,
    )

    assert result.intervention.assistance_level == AssistancePolicy.GUIDED
    assert result.intervention.type == InterventionType.QUESTION
    assert "downgraded" in result.intervention.rationale.lower()


def test_assisted_policy_permits_explanation_on_first_attempt(
    mock_pipeline_for_policy, task_context
):
    """Under ASSISTED, an EXPLANATION is preserved even on turn 1."""
    mock_pipeline_for_policy(InterventionType.EXPLANATION)
    coach = Coach()

    result = coach.invoke(
        student_id="s1",
        assignment_id="a1",
        session_id="sess_assisted",
        task_context=task_context,
        attempt="theta = theta - prediction",
        policy=AssistancePolicy.ASSISTED,
        turn_index=0,
    )

    assert result.intervention.assistance_level == AssistancePolicy.ASSISTED
    assert result.intervention.type == InterventionType.EXPLANATION


def test_open_policy_permits_direct_guidance(
    mock_pipeline_for_policy, task_context
):
    """Under OPEN, interventions are not downgraded and direct help is permitted."""
    mock_pipeline_for_policy(InterventionType.EXPLANATION)
    coach = Coach()

    result = coach.invoke(
        student_id="s1",
        assignment_id="a1",
        session_id="sess_open",
        task_context=task_context,
        attempt="theta = theta - prediction",
        policy=AssistancePolicy.OPEN,
        turn_index=0,
    )

    assert result.intervention.assistance_level == AssistancePolicy.OPEN
    assert result.intervention.type == InterventionType.EXPLANATION
