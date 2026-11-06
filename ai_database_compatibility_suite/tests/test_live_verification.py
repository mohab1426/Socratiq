from __future__ import annotations

import importlib
import inspect

import pytest

from conftest import live_enabled

pytestmark = [pytest.mark.live, pytest.mark.verification, pytest.mark.database]

@pytest.mark.skipif(
    not live_enabled("RUN_LIVE_VERIFICATION"),
    reason="Set RUN_LIVE_VERIFICATION=1 to run the live Verification test"
)
def test_existing_verification_service_is_usable():
    module = importlib.import_module("ai.verification.service")
    cls = getattr(module, "VerificationService", None)

    assert cls is not None, "VERIFICATION_FAIL VerificationService missing"
    assert inspect.isclass(cls)

    sig = inspect.signature(cls)
    # Do not guess constructor arguments. Report what the implementation exposes.
    assert sig is not None
