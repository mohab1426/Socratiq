"""
Unit tests for Learning Evidence and External AI Risk Signals extraction and propagation.

Verifies:
1. Understanding evidence is emitted on CORRECT_REASONING.
2. Independence evidence is emitted on turn 1 without prior assistance.
3. Misconception evidence is emitted on diagnosed misconceptions.
4. Revision evidence is emitted on turns > 1.
5. Explanation evidence is emitted when student provides explicit reasoning.
6. Uncertain or low-confidence diagnoses do not produce speculative evidence candidates.
7. Evidence is properly linked to source learning event IDs.
8. No mastery, dependency, or cheating claims are stored.
9. Observable risk signals (unusually large jump) are emitted only when anomalous.
10. System produces no risk signals during normal turn progression.
"""
from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.evidence import extract_evidence_candidates, extract_risk_signals
from ai.agents.coach.graph import Coach
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision, ValidationResult
from ai.agents.coach.state import CoachState, InteractionMetadata, TaskContext
from ai.models.schemas import (
    AssistancePolicy,
    Diagnosis,
    DiagnosisCategory,
    EvidenceStrength,
    EvidenceType,
    InterventionType,
)
from ai.tests.conftest import FakeStructuredLLM


@pytest.fixture
def base_state(task_context, metadata):
    return {
        "task_context": task_context,
        "policy": AssistancePolicy.GUIDED,
        "metadata": metadata,
        "messages": [HumanMessage(content="theta = theta - lr * gradient")],
        "current_attempt": "theta = theta - lr * gradient",
        "code_analysis": None,
        "diagnosis": Diagnosis(
            category=DiagnosisCategory.CORRECT_REASONING,
            concept="gradient_descent",
            explanation="Gradient update rule is correct.",
            evidence="theta = theta - lr * gradient",
            confidence=0.9,
        ),
        "intervention": None,
        "evidence_candidates": [],
        "risk_signals": [],
        "retrieved_context": [],
        "tools_used": [],
        "needs_course_material": False,
        "needs_student_history": False,
        "response": None,
        "referenced_concepts": [],
        "validation_passed": None,
        "validation_violations": [],
        "retry_count": 0,
        "errors": [],
    }


def test_understanding_and_independence_evidence_on_initial_correct_attempt(base_state):
    base_state["metadata"].turn_index = 1
    candidates = extract_evidence_candidates(base_state, source_event_id="evt_test_123")

    types = [c.evidence_type for c in candidates]
    assert EvidenceType.UNDERSTANDING in types
    assert EvidenceType.INDEPENDENCE in types

    understanding = next(c for c in candidates if c.evidence_type == EvidenceType.UNDERSTANDING)
    assert understanding.strength == EvidenceStrength.STRONG
    assert understanding.concept == "gradient_descent"
    assert understanding.source_event_ids == ["evt_test_123"]

    independence = next(c for c in candidates if c.evidence_type == EvidenceType.INDEPENDENCE)
    assert independence.strength == EvidenceStrength.STRONG
    assert independence.source_event_ids == ["evt_test_123"]


def test_misconception_evidence_emitted(base_state):
    base_state["diagnosis"] = Diagnosis(
        category=DiagnosisCategory.MISCONCEPTION,
        concept="learning_rate",
        explanation="Student scales by prediction instead of gradient.",
        evidence="theta = theta - prediction",
        confidence=0.85,
    )
    candidates = extract_evidence_candidates(base_state, source_event_id="evt_misconception")

    assert len(candidates) >= 1
    misconception = next(c for c in candidates if c.evidence_type == EvidenceType.MISCONCEPTION)
    assert misconception.strength == EvidenceStrength.STRONG
    assert misconception.concept == "learning_rate"
    assert "prediction" in misconception.observation
    assert misconception.source_event_ids == ["evt_misconception"]


def test_revision_evidence_on_turn_greater_than_one(base_state):
    base_state["metadata"].turn_index = 2
    candidates = extract_evidence_candidates(base_state, source_event_id="evt_rev")

    types = [c.evidence_type for c in candidates]
    assert EvidenceType.REVISION in types

    revision = next(c for c in candidates if c.evidence_type == EvidenceType.REVISION)
    assert revision.source_event_ids == ["evt_rev"]


def test_explanation_evidence_when_student_provides_rationale(base_state):
    base_state["current_attempt"] = (
        "theta = theta - lr * gradient because the gradient points in the direction of steepest ascent"
    )
    candidates = extract_evidence_candidates(base_state, source_event_id="evt_exp")

    types = [c.evidence_type for c in candidates]
    assert EvidenceType.EXPLANATION in types

    explanation = next(c for c in candidates if c.evidence_type == EvidenceType.EXPLANATION)
    assert explanation.strength == EvidenceStrength.MODERATE


def test_no_speculative_evidence_on_uncertain_diagnosis(base_state):
    base_state["diagnosis"] = Diagnosis(
        category=DiagnosisCategory.UNCERTAIN,
        concept=None,
        explanation="Insufficient evidence to diagnose.",
        evidence="",
        confidence=0.2,
    )
    base_state["metadata"].turn_index = 1
    base_state["current_attempt"] = "x"

    candidates = extract_evidence_candidates(base_state, source_event_id="evt_uncertain")
    assert candidates == []


def test_no_mastery_dependency_or_cheating_claims_in_evidence(base_state):
    base_state["metadata"].turn_index = 2
    base_state["current_attempt"] = "theta = theta - lr * gradient because it works"
    candidates = extract_evidence_candidates(base_state, source_event_id="evt_clean")

    for c in candidates:
        text = (c.observation + " " + c.evidence_type.value).lower()
        assert "mastery" not in text
        assert "dependency score" not in text
        assert "cheated" not in text
        assert "plagiarism" not in text


def test_risk_signal_detected_on_unusually_large_jump(base_state):
    base_state["metadata"].turn_index = 2
    base_state["messages"] = [
        HumanMessage(content="x = 1"),
        AIMessage(content="How would you update the parameters?"),
        HumanMessage(
            content=(
                "import numpy as np\n"
                "class LinearRegression:\n"
                "    def __init__(self, lr=0.01, n_iters=1000):\n"
                "        self.lr = lr\n"
                "        self.n_iters = n_iters\n"
                "        self.weights = None\n"
                "        self.bias = None\n"
                "    def fit(self, X, y):\n"
                "        n_samples, n_features = X.shape\n"
                "        self.weights = np.zeros(n_features)\n"
                "        self.bias = 0\n"
                "        for _ in range(self.n_iters):\n"
                "            y_predicted = np.dot(X, self.weights) + self.bias\n"
                "            dw = (1 / n_samples) * np.dot(X.T, (y_predicted - y))\n"
                "            db = (1 / n_samples) * np.sum(y_predicted - y)\n"
                "            self.weights -= self.lr * dw\n"
                "            self.bias -= self.lr * db\n"
            )
        ),
    ]
    signals = extract_risk_signals(base_state)
    assert len(signals) >= 1
    sig = signals[0]
    assert sig.signal == "unusually_large_attempt_jump"
    assert "cheated" not in sig.observation.lower()
    assert "used chatgpt" not in sig.observation.lower()
    assert sig.metadata.get("turn_index") == 2


def test_no_risk_signals_on_normal_progression(base_state):
    base_state["metadata"].turn_index = 2
    base_state["messages"] = [
        HumanMessage(content="theta = theta - prediction"),
        AIMessage(content="What should scale theta?"),
        HumanMessage(content="theta = theta - lr * gradient"),
    ]
    signals = extract_risk_signals(base_state)
    assert signals == []


def test_coach_result_end_to_end_contains_evidence_and_event_linkage(monkeypatch, task_context):
    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(
                result=DiagnosisResult(
                    category=DiagnosisCategory.CORRECT_REASONING,
                    concept="gradient_descent",
                    explanation="Student correctly implemented the parameter update rule.",
                    evidence="theta = theta - lr * gradient",
                    confidence=0.95,
                )
            )
        if schema is InterventionDecision:
            return FakeStructuredLLM(
                result=InterventionDecision(
                    intervention_type=InterventionType.ENCOURAGEMENT,
                    rationale="Reinforce correct understanding.",
                )
            )
        if schema is GeneratedResponse:
            return FakeStructuredLLM(
                result=GeneratedResponse(
                    response="Great job! The learning rate and gradient are correctly applied.",
                    referenced_concepts=["gradient_descent", "learning_rate"],
                )
            )
        raise AssertionError(f"Unexpected schema: {schema}")

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    monkeypatch.setattr(
        nodes_mod, "validate_response", lambda **kw: ValidationResult(passes=True, violations=[])
    )

    coach = Coach()
    result = coach.invoke(
        student_id="student_ev_01",
        assignment_id="asg_ev_01",
        session_id="sess_ev_01",
        task_context=task_context,
        attempt="theta = theta - lr * gradient",
        policy=AssistancePolicy.GUIDED,
        turn_index=0,
    )

    # 1. CoachResult contains populated evidence candidates
    assert len(result.evidence_candidates) >= 1
    und = next(c for c in result.evidence_candidates if c.evidence_type == EvidenceType.UNDERSTANDING)
    assert und.concept == "gradient_descent"

    # 2. Evidence candidates are strictly linked to the durable learning_event.id
    event_id = result.learning_event.id
    assert event_id.startswith("evt_")
    assert und.source_event_ids == [event_id]

    # 3. LearningEvent payload contains serialized evidence candidates
    payload = result.learning_event.payload
    assert "evidence_candidates" in payload
    assert len(payload["evidence_candidates"]) == len(result.evidence_candidates)
    assert payload["evidence_candidates"][0]["source_event_ids"] == [event_id]

    # 4. Risk signals are an empty list on normal interaction
    assert result.risk_signals == []
    assert payload["risk_signals"] == []
