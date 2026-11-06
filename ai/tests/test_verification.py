"""
Unit tests for the Learning Verification module.

Verifies:
1. Challenge generation across EXPLAIN, MODIFY, TRANSFER modes.
2. Evaluation producing PASS outcome and emitting LearningEvidenceCandidate.
3. Evaluation producing PARTIAL, NEEDS_RETRY, and INSUFFICIENT_EVIDENCE outcomes.
4. Graceful handling of LLM failures with fallback challenges and fallback evaluation results.
5. Proper evidence linkage to verification_id.
"""
from __future__ import annotations

import pytest

from ai.models.schemas import EvidenceStrength, EvidenceType
from ai.tests.conftest import FakeStructuredLLM
from ai.verification import (
    CriterionEvaluation,
    VerificationChallenge,
    VerificationChallengeRequest,
    VerificationEvaluationPayload,
    VerificationOutcome,
    VerificationRequest,
    VerificationResult,
    VerificationService,
    VerificationType,
)
from ai.verification.service import GeneratedChallengePayload


@pytest.fixture
def verification_service():
    return VerificationService()


def test_generate_challenge_explain(monkeypatch, verification_service):
    fake_payload = GeneratedChallengePayload(
        question="Why does gradient descent require subtracting the gradient rather than adding it?",
        criteria=[
            "Explains direction of steepest ascent vs descent",
            "Identifies loss minimization goal",
        ],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=fake_payload),
    )

    req = VerificationChallengeRequest(
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.EXPLAIN,
        student_work="theta = theta - lr * gradient",
    )
    challenge = verification_service.generate_challenge(req)

    assert challenge.verification_type == VerificationType.EXPLAIN
    assert challenge.concept == "gradient_descent"
    assert "gradient descent" in challenge.question.lower()
    assert len(challenge.criteria) == 2


def test_generate_challenge_modify(monkeypatch, verification_service):
    fake_payload = GeneratedChallengePayload(
        question="What changes if we maximize the objective function instead?",
        criteria=["Inverts the sign of the update step", "Explains ascent vs descent"],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=fake_payload),
    )

    req = VerificationChallengeRequest(
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.MODIFY,
        student_work="theta = theta - lr * gradient",
    )
    challenge = verification_service.generate_challenge(req)

    assert challenge.verification_type == VerificationType.MODIFY
    assert "maximize" in challenge.question.lower()
    words = challenge.question.split()
    assert 5 <= len(words) <= 12


def test_generate_challenge_transfer(monkeypatch, verification_service):
    fake_payload = GeneratedChallengePayload(
        question="How would you apply gradient descent to adjust drone altitude?",
        criteria=["Identifies feedback mechanism", "Explains adaptation threshold"],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=fake_payload),
    )

    req = VerificationChallengeRequest(
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.TRANSFER,
        student_work="theta = theta - lr * gradient",
    )
    challenge = verification_service.generate_challenge(req)

    assert challenge.verification_type == VerificationType.TRANSFER
    words = challenge.question.split()
    assert 5 <= len(words) <= 12


def test_generate_challenge_fallback_on_llm_failure(monkeypatch, verification_service):
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(raises=RuntimeError("provider down")),
    )

    req = VerificationChallengeRequest(
        assignment_id="asg_1",
        concept="learning_rate",
        verification_type=VerificationType.EXPLAIN,
        student_work="theta = theta - lr * gradient",
    )
    challenge = verification_service.generate_challenge(req)

    assert challenge.verification_type == VerificationType.EXPLAIN
    assert "learning_rate" in challenge.question
    assert len(challenge.criteria) >= 1


def test_verify_pass_emits_evidence_candidate(monkeypatch, verification_service):
    eval_payload = VerificationEvaluationPayload(
        outcome=VerificationOutcome.PASS,
        score=0.95,
        confidence=0.9,
        feedback="Excellent explanation of the gradient descent update mechanics.",
        criteria_evaluations=[
            CriterionEvaluation(
                criterion="Explains direction", passed=True, feedback="Accurate"
            ),
            CriterionEvaluation(
                criterion="Explains step scaling", passed=True, feedback="Accurate"
            ),
        ],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=eval_payload),
    )

    req = VerificationRequest(
        student_id="student_123",
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.EXPLAIN,
        challenge_question="Why do we subtract?",
        student_response="The gradient points towards the steepest ascent, so subtracting it moves parameters toward the minimum of the loss.",
        criteria=["Explains direction", "Explains step scaling"],
    )
    result: VerificationResult = verification_service.verify(req)

    assert result.outcome == VerificationOutcome.PASS
    assert result.score == 0.95
    assert result.confidence == 0.9
    assert len(result.criteria_evaluations) == 2

    # Verify evidence candidate emission and linkage
    assert result.evidence_candidate is not None
    assert result.evidence_candidate.evidence_type == EvidenceType.EXPLANATION
    assert result.evidence_candidate.strength == EvidenceStrength.STRONG
    assert result.evidence_candidate.concept == "gradient_descent"
    assert result.evidence_candidate.source_event_ids == [result.verification_id]


def test_verify_transfer_pass_emits_transfer_evidence(monkeypatch, verification_service):
    eval_payload = VerificationEvaluationPayload(
        outcome=VerificationOutcome.PASS,
        score=0.88,
        confidence=0.85,
        feedback="Good transfer to financial modeling.",
        criteria_evaluations=[
            CriterionEvaluation(criterion="Transfers concept", passed=True, feedback="Clear")
        ],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=eval_payload),
    )

    req = VerificationRequest(
        student_id="student_123",
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.TRANSFER,
        challenge_question="How would this apply to portfolio optimization?",
        student_response="We adjust asset weights along the gradient of the Sharpe ratio.",
    )
    result = verification_service.verify(req)

    assert result.outcome == VerificationOutcome.PASS
    assert result.evidence_candidate is not None
    assert result.evidence_candidate.evidence_type == EvidenceType.TRANSFER


def test_verify_partial_outcome(monkeypatch, verification_service):
    eval_payload = VerificationEvaluationPayload(
        outcome=VerificationOutcome.PARTIAL,
        score=0.65,
        confidence=0.75,
        feedback="Understands subtraction direction, but forgot how learning rate affects oscillation.",
        criteria_evaluations=[
            CriterionEvaluation(criterion="Explains direction", passed=True, feedback="Good"),
            CriterionEvaluation(criterion="Explains stability", passed=False, feedback="Missed"),
        ],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=eval_payload),
    )

    req = VerificationRequest(
        student_id="student_123",
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.EXPLAIN,
        challenge_question="Why do we subtract?",
        student_response="To decrease loss.",
    )
    result = verification_service.verify(req)

    assert result.outcome == VerificationOutcome.PARTIAL
    assert result.score == 0.65
    assert result.evidence_candidate is not None
    assert result.evidence_candidate.strength == EvidenceStrength.MODERATE


def test_verify_needs_retry_no_evidence_emitted(monkeypatch, verification_service):
    eval_payload = VerificationEvaluationPayload(
        outcome=VerificationOutcome.NEEDS_RETRY,
        score=0.3,
        confidence=0.8,
        feedback="The explanation incorrectly claims that the gradient is always positive.",
        criteria_evaluations=[
            CriterionEvaluation(criterion="Explains direction", passed=False, feedback="Incorrect"),
        ],
    )
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(result=eval_payload),
    )

    req = VerificationRequest(
        student_id="student_123",
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.EXPLAIN,
        challenge_question="Why do we subtract?",
        student_response="Because gradients are always positive numbers.",
    )
    result = verification_service.verify(req)

    assert result.outcome == VerificationOutcome.NEEDS_RETRY
    assert result.evidence_candidate is None


def test_verify_insufficient_evidence_on_llm_failure(monkeypatch, verification_service):
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(raises=RuntimeError("timeout")),
    )

    req = VerificationRequest(
        student_id="student_123",
        assignment_id="asg_1",
        concept="gradient_descent",
        verification_type=VerificationType.EXPLAIN,
        challenge_question="Why do we subtract?",
        student_response="I don't know.",
    )
    result = verification_service.verify(req)

    assert result.outcome == VerificationOutcome.INSUFFICIENT_EVIDENCE
    assert result.score == 0.0
    assert result.confidence == 0.0
    assert result.evidence_candidate is None
    assert "issue evaluating" in result.feedback


def test_verification_challenge_prompts_enforce_short_constraints():
    """Verify that challenge and evaluation prompts enforce 5-12 words, single direct question, and concise answers."""
    from ai.verification.strategies.explain import ExplainStrategy
    from ai.verification.strategies.modify import ModifyStrategy
    from ai.verification.strategies.transfer import TransferStrategy

    explain = ExplainStrategy()
    modify = ModifyStrategy()
    transfer = TransferStrategy()

    req = VerificationChallengeRequest(
        assignment_id="asg_1",
        concept="binary_search",
        verification_type=VerificationType.EXPLAIN,
        student_work="def search(arr, x): ...",
    )

    # Explain prompt checks
    explain_msgs = explain.build_challenge_prompt(req)
    explain_sys = explain_msgs[0].content
    assert "5–12 words" in explain_sys or "5-12 words" in explain_sys
    assert "one direct question" in explain_sys.lower()
    assert "short answer" in explain_sys.lower()
    assert "multiple choice" in explain_sys.lower()

    # Modify prompt checks
    req.verification_type = VerificationType.MODIFY
    modify_msgs = modify.build_challenge_prompt(req)
    modify_sys = modify_msgs[0].content
    assert "5–12 words" in modify_sys or "5-12 words" in modify_sys
    assert "one condition or assumption" in modify_sys.lower()
    assert "what changes" in modify_sys.lower()
    assert "short answer" in modify_sys.lower()

    # Transfer prompt checks
    req.verification_type = VerificationType.TRANSFER
    transfer_msgs = transfer.build_challenge_prompt(req)
    transfer_sys = transfer_msgs[0].content
    assert "5–12 words" in transfer_sys or "5-12 words" in transfer_sys
    assert "simple case" in transfer_sys.lower() or "novel" in transfer_sys.lower()
    assert "short answer" in transfer_sys.lower()

    # Evaluation prompts check that concise 1-sentence answers can PASS
    eval_req = VerificationRequest(
        student_id="s1",
        assignment_id="a1",
        concept="binary_search",
        verification_type=VerificationType.EXPLAIN,
        challenge_question="Why divide by 2?",
        student_response="It cuts the search space in half.",
    )
    for strat in (explain, modify, transfer):
        eval_req.verification_type = strat.verification_type
        eval_msgs = strat.build_evaluation_prompt(eval_req)
        eval_sys = eval_msgs[0].content
        assert "concise" in eval_sys.lower()
        assert "sentence" in eval_sys.lower()


def test_generate_challenge_fallbacks_are_concise_and_distinct(monkeypatch, verification_service):
    """Verify fallbacks across Explain, Modify, and Transfer are 5-12 words, contain concept, and are distinct."""
    monkeypatch.setattr(
        "ai.verification.service.get_structured_llm",
        lambda role, schema: FakeStructuredLLM(raises=RuntimeError("LLM unavailable")),
    )

    concept = "recursion"
    challenges = {}
    for vtype in (VerificationType.EXPLAIN, VerificationType.MODIFY, VerificationType.TRANSFER):
        req = VerificationChallengeRequest(
            assignment_id="asg_1",
            concept=concept,
            verification_type=vtype,
            student_work="def fact(n): return 1 if n<=1 else n*fact(n-1)",
        )
        ch = verification_service.generate_challenge(req)
        challenges[vtype] = ch

        # Verify concept inclusion
        assert concept in ch.question

        # Verify word count 5-12 words
        words = ch.question.split()
        assert 5 <= len(words) <= 12, f"Fallback for {vtype} had {len(words)} words: '{ch.question}'"

    # Verify all 3 questions are mutually distinct
    questions = [ch.question for ch in challenges.values()]
    assert len(set(questions)) == 3, f"Fallback questions must be distinct: {questions}"

    # Verify distinct pedagogical focuses
    assert "why" in challenges[VerificationType.EXPLAIN].question.lower()
    assert "changes" in challenges[VerificationType.MODIFY].question.lower()
    assert "where else" in challenges[VerificationType.TRANSFER].question.lower()
