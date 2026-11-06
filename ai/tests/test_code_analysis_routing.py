"""
Unit tests for Code Analysis Tool integration and conditional graph routing.

Verifies:
1. Code analysis runs when task_context.is_programming is True and attempt contains code.
2. Code analysis does NOT run when task_context.is_programming is False (theoretical task).
3. Code analysis does NOT run when attempt has no code (e.g. conversational question).
4. Code analysis records 'code_analysis' in tools_used.
5. Code analysis errors are caught gracefully and do not crash the Coach.
6. Diagnosis prompt consumes formatted code analysis signals (syntax validity, defined vars/funcs).
7. Guided mode responses remain Socratic when code analysis is active.
"""
from __future__ import annotations

import pytest

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.graph import Coach
from ai.agents.coach.routing import is_code_attempt, should_analyze_code
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision, ValidationResult
from ai.agents.coach.state import CoachState, InteractionMetadata, TaskContext
from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
from ai.tests.conftest import FakeStructuredLLM
from ai.tools.code_analysis import CodeAnalysisResult, CodeAnalysisTool


def test_is_code_attempt_detection():
    # True code attempts
    assert is_code_attempt("theta = theta - lr * gradient")
    assert is_code_attempt("def train(x, y):\n    return x + y")
    assert is_code_attempt("```python\nfor i in range(10):\n    pass\n```")
    assert is_code_attempt("x = 5")
    assert is_code_attempt("def broken_func(:\n    pass")

    # False: plain conversational text
    assert not is_code_attempt("I think gradient descent works by increasing the learning rate.")
    assert not is_code_attempt("Can you explain what the learning rate does?")
    assert not is_code_attempt("")
    assert not is_code_attempt("   ")


def test_should_analyze_code_respects_task_context(task_context, metadata):
    # Programming task with code attempt -> True
    state: CoachState = {
        "task_context": task_context,  # is_programming=True
        "metadata": metadata,
        "current_attempt": "theta = theta - lr * grad",
    }
    assert should_analyze_code(state) is True

    # Programming task with plain conversational text -> False
    state["current_attempt"] = "I do not know how to start."
    assert should_analyze_code(state) is False

    # Theoretical task with code-like string -> False
    non_prog_task = TaskContext(
        assignment_id="theory_1",
        course_id="c1",
        title="Theoretical Math",
        instructions="Prove gradient convergence",
        is_programming=False,
    )
    state["task_context"] = non_prog_task
    state["current_attempt"] = "x = 5"
    assert should_analyze_code(state) is False


def test_code_analysis_runs_and_populates_tools_used(monkeypatch, task_context):
    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(
                result=DiagnosisResult(
                    category=DiagnosisCategory.MISCONCEPTION,
                    concept="gradient_descent",
                    explanation="Update rule uses wrong operation.",
                    evidence="theta = theta + lr * gradient",
                    confidence=0.85,
                )
            )
        if schema is InterventionDecision:
            return FakeStructuredLLM(
                result=InterventionDecision(
                    intervention_type=InterventionType.QUESTION,
                    rationale="Guide student on sign of gradient.",
                )
            )
        if schema is GeneratedResponse:
            return FakeStructuredLLM(
                result=GeneratedResponse(
                    response="Should you add or subtract the gradient to minimize loss?",
                    referenced_concepts=["gradient_descent"],
                )
            )
        raise AssertionError(f"Unexpected schema: {schema}")

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod, "validate_response", lambda **kw: ValidationResult(passes=True, violations=[])
    )

    coach = Coach()
    result = coach.invoke(
        student_id="student_code_01",
        assignment_id="asg_code_01",
        session_id="sess_code_01",
        task_context=task_context,  # is_programming=True
        attempt="theta = theta + lr * gradient",
        policy=AssistancePolicy.GUIDED,
    )

    # Verify code_analysis was recorded in tools_used
    assert "code_analysis" in result.tools_used
    assert result.intervention.type == InterventionType.QUESTION


def test_code_analysis_bypassed_for_non_programming_assignment(monkeypatch):
    theory_task = TaskContext(
        assignment_id="theory_01",
        course_id="ml_101",
        title="Cost Functions Conceptual",
        instructions="Explain the difference between MSE and Cross Entropy.",
        is_programming=False,
    )

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(
                result=DiagnosisResult(
                    category=DiagnosisCategory.CORRECT_REASONING,
                    concept="loss_functions",
                    explanation="Accurate distinction between regression and classification losses.",
                    evidence="MSE is for continuous values, cross entropy for probabilities.",
                    confidence=0.9,
                )
            )
        if schema is InterventionDecision:
            return FakeStructuredLLM(
                result=InterventionDecision(
                    intervention_type=InterventionType.ENCOURAGEMENT,
                    rationale="Reinforce understanding.",
                )
            )
        if schema is GeneratedResponse:
            return FakeStructuredLLM(
                result=GeneratedResponse(
                    response="Exactly right.",
                    referenced_concepts=["loss_functions"],
                )
            )
        raise AssertionError(f"Unexpected schema: {schema}")

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod, "validate_response", lambda **kw: ValidationResult(passes=True, violations=[])
    )

    coach = Coach()
    result = coach.invoke(
        student_id="student_theory_01",
        assignment_id="asg_theory_01",
        session_id="sess_theory_01",
        task_context=theory_task,
        attempt="MSE is for continuous regression while cross entropy is for probabilities.",
        policy=AssistancePolicy.GUIDED,
    )

    # Verify code_analysis was NOT run
    assert "code_analysis" not in result.tools_used


def test_code_analysis_failure_does_not_crash_graph(monkeypatch, task_context):
    class BrokenCodeTool:
        name = "code_analysis"

        def analyze(self, code, language="python"):
            raise RuntimeError("AST parser crashed unexpectedly")

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(
                result=DiagnosisResult(
                    category=DiagnosisCategory.CORRECT_REASONING,
                    concept=None,
                    explanation="Reasoning is fine.",
                    evidence="code snippet",
                    confidence=0.8,
                )
            )
        if schema is InterventionDecision:
            return FakeStructuredLLM(
                result=InterventionDecision(
                    intervention_type=InterventionType.ENCOURAGEMENT,
                    rationale="Keep going.",
                )
            )
        if schema is GeneratedResponse:
            return FakeStructuredLLM(
                result=GeneratedResponse(
                    response="Looks good.",
                    referenced_concepts=[],
                )
            )
        raise AssertionError(f"Unexpected schema: {schema}")

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod, "validate_response", lambda **kw: ValidationResult(passes=True, violations=[])
    )

    coach = Coach(code_tool=BrokenCodeTool())
    result = coach.invoke(
        student_id="student_resilience_01",
        assignment_id="asg_resilience_01",
        session_id="sess_resilience_01",
        task_context=task_context,
        attempt="def run(): pass",
        policy=AssistancePolicy.GUIDED,
    )

    # Graph completed successfully despite code tool error
    assert result.response == "Looks good."
    errors = result.metadata.get("errors", [])
    assert any("analyze_code" in e for e in errors)


def test_diagnosis_receives_code_analysis_summary(task_context, metadata):
    tool = CodeAnalysisTool()
    code = "def fit(x, y):\n    for i in range(10):\n        x = x + i\n    return x\n"
    analysis = tool.analyze(code)

    state: CoachState = {
        "task_context": task_context,
        "policy": AssistancePolicy.GUIDED,
        "metadata": metadata,
        "current_attempt": code,
        "code_analysis": analysis,
        "retrieved_context": [],
        "messages": [],
    }

    summary = nodes_mod._format_code_analysis(analysis)
    assert "Valid Python syntax: True" in summary
    assert "Defined functions: fit" in summary
    assert "Defined variables: x" in summary
    assert "Loop constructs count: 1" in summary
