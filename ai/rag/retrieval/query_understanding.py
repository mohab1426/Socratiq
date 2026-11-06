"""
Structured Query Understanding for course material retrieval.

Enriches raw student questions ("Why is this wrong?", "I don't understand")
with assignment context, student attempt, and diagnosed misconceptions into a
standalone retrieval query.
"""
from __future__ import annotations

import logging
import re
from typing import Optional, Sequence

from pydantic import BaseModel, Field

from ai.config import ModelRole
from ai.models.llm import get_structured_llm
from ai.models.schemas import Diagnosis
from ai.rag.models import ContentType, QueryUnderstandingResult

logger = logging.getLogger(__name__)

# Phrases indicating conversational acknowledgments that do not require knowledge retrieval
_NO_RETRIEVAL_PHRASES = frozenset({
    "thank you", "thanks", "got it", "i understand now", "ok", "okay",
    "makes sense", "understood", "will do", "goodbye", "bye", "cool",
})


class StructuredQueryDecision(BaseModel):
    """Pydantic schema for LLM-based query understanding."""

    needs_retrieval: bool = Field(description="True if course material lookup is needed.")
    retrieval_query: str = Field(description="Enriched, standalone search query.")
    concepts: list[str] = Field(default_factory=list, description="Target domain concepts.")
    content_types: list[ContentType] = Field(
        default_factory=list, description="Preferred content types (e.g. formula, code, definition)."
    )
    rationale: str = Field(default="", description="Reasoning for query formulation.")


class QueryUnderstander:
    """Understands student intent and crafts search-optimized retrieval queries."""

    def __init__(self, use_llm: bool = True) -> None:
        self.use_llm = use_llm

    def understand(
        self,
        student_message: Optional[str],
        student_attempt: str,
        assignment_title: Optional[str] = None,
        assignment_instructions: Optional[str] = None,
        prior_diagnosis: Optional[Diagnosis] = None,
        is_programming: bool = False,
    ) -> QueryUnderstandingResult:
        msg = (student_message or "").strip().lower()

        # Deterministic check: conversational pleasantries / acknowledgments
        if msg in _NO_RETRIEVAL_PHRASES and not student_attempt:
            return QueryUnderstandingResult(
                needs_retrieval=False,
                retrieval_query="",
                concepts=[],
                content_types=[],
                rationale="Conversational acknowledgment; retrieval unnecessary.",
            )

        # Build fallback deterministic query
        fallback_query_parts = []
        if assignment_title:
            fallback_query_parts.append(assignment_title)
        if prior_diagnosis and prior_diagnosis.concept:
            fallback_query_parts.append(prior_diagnosis.concept)
        if student_message:
            fallback_query_parts.append(student_message)
        elif student_attempt:
            # First 120 chars of attempt
            fallback_query_parts.append(student_attempt[:120].strip())

        fallback_query = " ".join(fallback_query_parts).strip() or "Course material"
        fallback_concepts = [prior_diagnosis.concept] if (prior_diagnosis and prior_diagnosis.concept) else []
        fallback_types = [ContentType.CODE] if is_programming else [ContentType.EXPLANATION, ContentType.DEFINITION]

        if not self.use_llm:
            return QueryUnderstandingResult(
                needs_retrieval=True,
                retrieval_query=fallback_query,
                concepts=fallback_concepts,
                content_types=fallback_types,
                rationale="Deterministic query understanding based on assignment context.",
            )

        # Attempt structured LLM understanding
        prompt = (
            "You are a query-understanding assistant for an AI Learning Coach.\n"
            "Formulate a standalone course-retrieval query to find relevant lecture notes, definitions, or formulas.\n"
            "Do NOT include conversational chatter in the retrieval query.\n\n"
            f"Assignment: {assignment_title or 'N/A'}\n"
            f"Instructions: {assignment_instructions or 'N/A'}\n"
            f"Diagnosed Concept: {prior_diagnosis.concept if prior_diagnosis else 'N/A'}\n"
            f"Student Message: {student_message or 'N/A'}\n"
            f"Student Current Attempt:\n{student_attempt[:400]}"
        )

        try:
            llm = get_structured_llm(ModelRole.LIGHTWEIGHT, StructuredQueryDecision)
            decision: StructuredQueryDecision = llm.invoke(prompt)
            return QueryUnderstandingResult(
                needs_retrieval=decision.needs_retrieval,
                retrieval_query=decision.retrieval_query or fallback_query,
                concepts=decision.concepts or fallback_concepts,
                content_types=decision.content_types or fallback_types,
                rationale=decision.rationale,
            )
        except Exception as exc:
            logger.debug("LLM query understanding failed; falling back to deterministic: %s", exc)
            return QueryUnderstandingResult(
                needs_retrieval=True,
                retrieval_query=fallback_query,
                concepts=fallback_concepts,
                content_types=fallback_types,
                rationale="Fallback deterministic formulation after LLM failure.",
            )
