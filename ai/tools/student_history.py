"""
Student learning-history retrieval tool.

Returns only *relevant* prior learning events/evidence for the current
concept/assignment -- the Coach must never load a student's entire history
into graph state (see docs/AI_SPEC.md).
"""
from __future__ import annotations

from typing import Optional, Protocol

from ai.models.schemas import RetrievedContext


class StudentHistoryError(RuntimeError):
    pass


class StudentHistoryProvider(Protocol):
    def __call__(
        self, student_id: str, assignment_id: str, concept: Optional[str], limit: int = 3
    ) -> list[RetrievedContext]:
        ...


def _fallback_provider(student_id, assignment_id, concept=None, limit=3):
    return []


class StudentHistoryTool:
    name = "student_history"

    def __init__(self, provider: Optional[StudentHistoryProvider] = None):
        self._provider: StudentHistoryProvider = provider or _fallback_provider

    def retrieve(
        self, student_id: str, assignment_id: str, concept: Optional[str] = None, limit: int = 3
    ) -> list[RetrievedContext]:
        try:
            return self._provider(student_id, assignment_id, concept, limit)
        except Exception as exc:
            raise StudentHistoryError(str(exc)) from exc
