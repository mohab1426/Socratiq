from __future__ import annotations

import importlib
import inspect
import os

import pytest

from conftest import live_enabled

pytestmark = [pytest.mark.live, pytest.mark.coach, pytest.mark.database]

@pytest.mark.skipif(
    not live_enabled("RUN_LIVE_COACH"),
    reason="Set RUN_LIVE_COACH=1 to run the live Coach test"
)
def test_existing_coach_is_importable_and_has_real_entrypoint():
    """
    This test intentionally does not invent a new Coach API.

    It discovers the existing Coach graph/module and verifies that its real
    callable entrypoint can be identified. The next layer should be wired to
    the exact project-specific entrypoint once the repository's current
    constructor/configuration is known.
    """
    module = importlib.import_module("ai.agents.coach.graph")

    candidates = [
        "build_coach_graph",
        "coach_graph",
        "create_coach_graph",
        "CoachGraph",
    ]

    found = []
    for name in candidates:
        obj = getattr(module, name, None)
        if obj is not None:
            found.append((name, obj))

    assert found, (
        "COACH_FAIL no known Coach entrypoint was found in "
        "ai.agents.coach.graph. Inspect that module and add its actual "
        "entrypoint to this test; do not redesign the Coach."
    )

    for name, obj in found:
        assert callable(obj) or inspect.isclass(obj), f"COACH_FAIL {name} is not callable"
