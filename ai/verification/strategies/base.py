"""
Base class for Learning Verification strategies.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from langchain_core.messages import HumanMessage, SystemMessage

from ai.verification.models import (
    VerificationChallenge,
    VerificationChallengeRequest,
    VerificationEvaluationPayload,
    VerificationRequest,
    VerificationType,
)


class BaseVerificationStrategy(ABC):
    """Abstract strategy for challenge generation and evaluation."""

    verification_type: VerificationType

    @abstractmethod
    def build_challenge_prompt(self, request: VerificationChallengeRequest) -> list:
        """Build messages for LLM challenge generation."""
        ...

    @abstractmethod
    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        """Build messages for LLM response evaluation."""
        ...
