"""
Learning Verification Service.

Standalone pedagogical assessment service that challenges students via
Explain, Modify, and Transfer tasks to verify authentic understanding.
Emits structured VerificationResult records and observable evidence candidates.
"""
from __future__ import annotations

import logging
from typing import Optional

from pydantic import BaseModel, Field

from ai.models.llm import ModelRole, get_structured_llm
from ai.models.schemas import (
    EvidenceStrength,
    EvidenceType,
    LearningEvidenceCandidate,
)
from ai.verification.models import (
    VerificationChallenge,
    VerificationChallengeRequest,
    VerificationEvaluationPayload,
    VerificationOutcome,
    VerificationRequest,
    VerificationResult,
    VerificationType,
)
from ai.verification.strategies import (
    BaseVerificationStrategy,
    ExplainStrategy,
    ModifyStrategy,
    TransferStrategy,
)

logger = logging.getLogger(__name__)


class GeneratedChallengePayload(BaseModel):
    """Schema for challenge generation LLM response."""

    question: str = Field(
        description="The short verification question (prefer 5-12 words, single direct question, requires a short 1-sentence answer)."
    )
    criteria: list[str] = Field(
        default_factory=list, description="2-3 specific rubric criteria for evaluation."
    )


class VerificationService:
    """Service orchestrating Learning Verification challenge generation and evaluation."""

    def __init__(self):
        self._strategies: dict[VerificationType, BaseVerificationStrategy] = {
            VerificationType.EXPLAIN: ExplainStrategy(),
            VerificationType.MODIFY: ModifyStrategy(),
            VerificationType.TRANSFER: TransferStrategy(),
        }

    def generate_challenge(self, request: VerificationChallengeRequest) -> VerificationChallenge:
        """Generate a concept verification challenge for a student."""
        strategy = self._strategies.get(request.verification_type)
        if not strategy:
            raise ValueError(f"Unsupported verification type: {request.verification_type}")

        prompt_messages = strategy.build_challenge_prompt(request)

        try:
            llm = get_structured_llm(ModelRole.VERIFICATION, GeneratedChallengePayload)
            payload: GeneratedChallengePayload = llm.invoke(prompt_messages)
            return VerificationChallenge(
                verification_type=request.verification_type,
                concept=request.concept,
                question=payload.question,
                criteria=payload.criteria,
            )
        except Exception as exc:
            logger.exception("Challenge generation failed, returning fallback challenge.")
            if request.verification_type == VerificationType.MODIFY:
                fallback_question = f"What changes if {request.concept} is modified or reversed?"
                criteria = [f"Identifies how changes affect {request.concept}"]
            elif request.verification_type == VerificationType.TRANSFER:
                fallback_question = f"Where else could you apply {request.concept}?"
                criteria = [f"Identifies a new application of {request.concept}"]
            else:
                fallback_question = f"Why does {request.concept} work in your solution?"
                criteria = [f"Explains the mechanism of {request.concept}"]

            return VerificationChallenge(
                verification_type=request.verification_type,
                concept=request.concept,
                question=fallback_question,
                criteria=criteria,
            )

    def verify(self, request: VerificationRequest) -> VerificationResult:
        """Evaluate a student's response to a verification challenge."""
        strategy = self._strategies.get(request.verification_type)
        if not strategy:
            raise ValueError(f"Unsupported verification type: {request.verification_type}")

        prompt_messages = strategy.build_evaluation_prompt(request)

        try:
            llm = get_structured_llm(ModelRole.VERIFICATION, VerificationEvaluationPayload)
            evaluation: VerificationEvaluationPayload = llm.invoke(prompt_messages)

            # Build result
            result = VerificationResult(
                student_id=request.student_id,
                assignment_id=request.assignment_id,
                concept=request.concept,
                verification_type=request.verification_type,
                outcome=evaluation.outcome,
                score=evaluation.score,
                confidence=evaluation.confidence,
                feedback=evaluation.feedback,
                criteria_evaluations=evaluation.criteria_evaluations,
            )

            # Generate evidence candidate if student passed or showed partial understanding
            if evaluation.outcome in (VerificationOutcome.PASS, VerificationOutcome.PARTIAL):
                ev_type = (
                    EvidenceType.TRANSFER
                    if request.verification_type == VerificationType.TRANSFER
                    else (
                        EvidenceType.EXPLANATION
                        if request.verification_type == VerificationType.EXPLAIN
                        else EvidenceType.UNDERSTANDING
                    )
                )
                ev_strength = (
                    EvidenceStrength.STRONG
                    if evaluation.outcome == VerificationOutcome.PASS and evaluation.confidence >= 0.8
                    else EvidenceStrength.MODERATE
                )
                result.evidence_candidate = LearningEvidenceCandidate(
                    student_id=request.student_id,
                    assignment_id=request.assignment_id,
                    concept=request.concept,
                    evidence_type=ev_type,
                    strength=ev_strength,
                    observation=(
                        f"Student successfully completed {request.verification_type.value.lower()} verification "
                        f"for concept '{request.concept}' with score {evaluation.score:.2f}."
                    ),
                    source_event_ids=[result.verification_id],
                )

            return result

        except Exception as exc:
            logger.exception("Learning verification evaluation failed.")
            return VerificationResult(
                student_id=request.student_id,
                assignment_id=request.assignment_id,
                concept=request.concept,
                verification_type=request.verification_type,
                outcome=VerificationOutcome.INSUFFICIENT_EVIDENCE,
                score=0.0,
                confidence=0.0,
                feedback="We encountered an issue evaluating your verification response. Please try again in a moment.",
                criteria_evaluations=[],
                evidence_candidate=None,
            )


_default_verification_service: Optional[VerificationService] = None


def get_default_verification_service() -> VerificationService:
    """Lazily-instantiated default service singleton."""
    global _default_verification_service
    if _default_verification_service is None:
        _default_verification_service = VerificationService()
    return _default_verification_service
