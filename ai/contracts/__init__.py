"""
AI Contracts package for HTTP / FastAPI integration.
"""
from ai.contracts.coach_contract import (
    ChatMessageDto,
    CoachApiRequest,
    CoachApiResponse,
    VerificationChallengeApiRequest,
    VerificationChallengeApiResponse,
    VerificationEvaluateApiRequest,
    VerificationEvaluateApiResponse,
    run_coach_turn,
)

__all__ = [
    "ChatMessageDto",
    "CoachApiRequest",
    "CoachApiResponse",
    "VerificationChallengeApiRequest",
    "VerificationChallengeApiResponse",
    "VerificationEvaluateApiRequest",
    "VerificationEvaluateApiResponse",
    "run_coach_turn",
]
