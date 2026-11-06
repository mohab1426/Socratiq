"""Shared pytest fixtures for the AI Coach test suite."""
from __future__ import annotations

from typing import Any, Callable

import pytest

from ai.agents.coach.state import InteractionMetadata, TaskContext
from ai.models.schemas import AssistancePolicy


class FakeStructuredLLM:
    """Stand-in for `llm.with_structured_output(Schema)`.

    Accepts either a fixed return value or a callable(messages) -> instance,
    and can be told to raise instead (to test error paths).
    """

    def __init__(self, result: Any = None, side_effect: Callable | None = None, raises: Exception | None = None):
        self.result = result
        self.side_effect = side_effect
        self.raises = raises
        self.calls: list[list] = []

    def invoke(self, messages):
        self.calls.append(messages)
        if self.raises is not None:
            raise self.raises
        if self.side_effect is not None:
            return self.side_effect(messages)
        return self.result


@pytest.fixture
def task_context() -> TaskContext:
    return TaskContext(
        assignment_id="asg_1",
        course_id="course_ml_101",
        title="Implement Linear Regression using Gradient Descent",
        instructions=(
            "Implement gradient descent to fit a linear regression model. Update the parameters "
            "using the gradient of the loss with respect to each parameter, scaled by the learning "
            "rate."
        ),
        subject_area="machine_learning",
        is_programming=True,
    )


@pytest.fixture
def metadata() -> InteractionMetadata:
    return InteractionMetadata(
        student_id="student_1", assignment_id="asg_1", session_id="sess_1", turn_index=0
    )


@pytest.fixture
def guided_policy() -> AssistancePolicy:
    return AssistancePolicy.GUIDED
