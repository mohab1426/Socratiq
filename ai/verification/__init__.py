"""
Learning Verification package.

Public exports for verifying student conceptual understanding across
Explain, Modify, and Transfer tasks.
"""
from ai.verification.models import (
    CriterionEvaluation,
    VerificationChallenge,
    VerificationChallengeRequest,
    VerificationEvaluationPayload,
    VerificationOutcome,
    VerificationRequest,
    VerificationResult,
    VerificationType,
)
from ai.verification.service import (
    VerificationService,
    get_default_verification_service,
)

__all__ = [
    "CriterionEvaluation",
    "VerificationChallenge",
    "VerificationChallengeRequest",
    "VerificationEvaluationPayload",
    "VerificationOutcome",
    "VerificationRequest",
    "VerificationResult",
    "VerificationService",
    "VerificationType",
    "get_default_verification_service",
]
