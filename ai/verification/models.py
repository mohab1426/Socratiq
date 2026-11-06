"""
Learning Verification domain models and contracts.

Provides explicit, typed structures for assessing student conceptual mastery
via three distinct modes (EXPLAIN, MODIFY, TRANSFER) with calibrated outcomes
(PASS, PARTIAL, NEEDS_RETRY, INSUFFICIENT_EVIDENCE).

Completely decoupled from the LangGraph AI Coach core.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field

from ai.models.schemas import (
    EvidenceStrength,
    EvidenceType,
    LearningEvidenceCandidate,
)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class VerificationType(str, Enum):
    """The pedagogical mode of the learning verification challenge."""

    EXPLAIN = "EXPLAIN"    # Explain why a mechanism or line of reasoning works
    MODIFY = "MODIFY"      # Adapt or modify the solution under changed constraints
    TRANSFER = "TRANSFER"  # Apply the underlying concept to a novel problem context


class VerificationOutcome(str, Enum):
    """Calibrated evaluation outcome of a learning verification assessment."""

    PASS = "PASS"                              # Demonstrated clear conceptual understanding
    PARTIAL = "PARTIAL"                        # Partial understanding with minor conceptual gaps
    NEEDS_RETRY = "NEEDS_RETRY"                # Substantial misconceptions; needs revision
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"  # Evasive, off-topic, or non-evaluable answer


class CriterionEvaluation(BaseModel):
    """Evaluation against a single rubric criterion."""

    criterion: str = Field(description="The rubric criterion being assessed.")
    passed: bool = Field(description="Whether the student met this criterion.")
    feedback: str = Field(description="Specific feedback regarding this criterion.")


class VerificationChallengeRequest(BaseModel):
    """Input parameters for generating a verification challenge."""

    assignment_id: str
    concept: str
    verification_type: VerificationType
    student_work: str
    course_context: Optional[str] = None


class VerificationChallenge(BaseModel):
    """The generated verification challenge presented to the student."""

    challenge_id: str = Field(default_factory=lambda: _new_id("vc"))
    verification_type: VerificationType
    concept: str
    question: str
    criteria: list[str] = Field(default_factory=list)


class VerificationRequest(BaseModel):
    """Input payload for evaluating a student's verification response."""

    student_id: str
    assignment_id: str
    concept: str
    verification_type: VerificationType
    challenge_question: str
    student_response: str
    criteria: list[str] = Field(default_factory=list)
    original_attempt: Optional[str] = None


class VerificationEvaluationPayload(BaseModel):
    """Structured LLM output schema for evaluation."""

    outcome: VerificationOutcome
    score: float = Field(ge=0.0, le=1.0, description="Estimated score between 0.0 and 1.0.")
    confidence: float = Field(ge=0.0, le=1.0, description="Model confidence in the evaluation.")
    feedback: str = Field(description="Constructive student-facing feedback.")
    criteria_evaluations: list[CriterionEvaluation] = Field(
        default_factory=list, description="Per-criterion rubric assessment."
    )


class VerificationResult(BaseModel):
    """Full public result of a learning verification assessment."""

    verification_id: str = Field(default_factory=lambda: _new_id("ver"))
    student_id: str
    assignment_id: str
    concept: str
    verification_type: VerificationType
    outcome: VerificationOutcome
    score: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    feedback: str
    criteria_evaluations: list[CriterionEvaluation] = Field(default_factory=list)
    evidence_candidate: Optional[LearningEvidenceCandidate] = None
    created_at: datetime = Field(default_factory=_utcnow)
