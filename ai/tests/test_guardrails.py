"""Unit tests for the response validation guardrail."""
from __future__ import annotations

from ai.agents.coach.schemas import ValidationResult
from ai.guardrails import coach_validator
from ai.models.schemas import AssistancePolicy


def test_rule_based_check_flags_answer_reveal_under_guided():
    violations = coach_validator.rule_based_check(
        policy=AssistancePolicy.GUIDED,
        draft_response="The answer is theta = theta - learning_rate * gradient.",
    )
    assert violations


def test_rule_based_check_flags_answer_reveal_under_open():
    """Answer-revealing phrases are now blocked under ALL policies."""
    violations = coach_validator.rule_based_check(
        policy=AssistancePolicy.OPEN,
        draft_response="The answer is theta = theta - learning_rate * gradient.",
    )
    assert violations
    assert any("answer-revealing" in v for v in violations)


def test_rule_based_check_flags_empty_response():
    violations = coach_validator.rule_based_check(policy=AssistancePolicy.GUIDED, draft_response="   ")
    assert violations == ["Response is empty."]


def test_validate_response_without_llm_uses_only_rules():
    result = coach_validator.validate_response(
        policy=AssistancePolicy.GUIDED,
        diagnosis_category="MISCONCEPTION",
        diagnosis_confidence=0.7,
        intervention_type="QUESTION",
        course_material="",
        draft_response="What does the learning rate control in each parameter update?",
        use_llm=False,
    )
    assert isinstance(result, ValidationResult)
    assert result.passes


def test_validate_response_falls_back_gracefully_when_llm_check_fails(monkeypatch):
    def broken_llm_check(**kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(coach_validator, "llm_check", broken_llm_check)

    result = coach_validator.validate_response(
        policy=AssistancePolicy.GUIDED,
        diagnosis_category="MISCONCEPTION",
        diagnosis_confidence=0.7,
        intervention_type="QUESTION",
        course_material="",
        draft_response="What does the learning rate control?",
        use_llm=True,
    )
    # LLM check failed -> falls back to rule-based-only result, doesn't crash.
    assert result.passes


def test_validate_response_combines_rule_and_llm_violations(monkeypatch):
    def fake_llm_check(**kwargs):
        return ValidationResult(passes=False, violations=["off-topic"], revised_response=None)

    monkeypatch.setattr(coach_validator, "llm_check", fake_llm_check)

    result = coach_validator.validate_response(
        policy=AssistancePolicy.GUIDED,
        diagnosis_category="MISCONCEPTION",
        diagnosis_confidence=0.7,
        intervention_type="QUESTION",
        course_material="",
        draft_response="The answer is 42.",
        use_llm=True,
    )
    assert not result.passes
    assert any("GUIDED policy violation" in v for v in result.violations)
    assert "off-topic" in result.violations
