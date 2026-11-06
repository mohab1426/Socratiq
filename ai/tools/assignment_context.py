"""
Assignment-context tool.

Supplies the assignment's requirements/instructions to the Coach. The
backend owns the actual assignment store; this module only defines the
interface the Coach depends on, plus a no-op default so the Coach package
is importable/runnable standalone (e.g. in tests).
"""
from __future__ import annotations

from typing import Optional, Protocol

from ai.agents.coach.state import TaskContext


class AssignmentContextError(RuntimeError):
    pass


class AssignmentContextProvider(Protocol):
    def __call__(self, assignment_id: str) -> Optional[TaskContext]:
        ...


class AssignmentContextTool:
    """Typically the backend already has the TaskContext (it renders the
    assignment page) and passes it directly into `Coach.invoke(...)`. This
    tool exists for the case where the Coach needs to (re)fetch it itself,
    e.g. a background job."""

    name = "assignment_context"

    def __init__(self, provider: Optional[AssignmentContextProvider] = None):
        self._provider: AssignmentContextProvider = provider or (lambda assignment_id: None)

    def get(self, assignment_id: str) -> Optional[TaskContext]:
        try:
            return self._provider(assignment_id)
        except Exception as exc:
            raise AssignmentContextError(str(exc)) from exc
