"""
SmartBoard authorship authentication and tamper prevention.
Enforces that:
1. Coach element IDs issued by the server are cryptographically signed and tied to the student attempt.
2. Students cannot claim coach authorship by simply prefixing an ID (e.g. 'ai_', 'v_', 'sim_').
3. Modifications to coach elements by students are tracked with provenance ('original_author': 'coach', 'student_modified': True).
4. Trusted server-side evidence (HMAC signature or database event registration) is required to grant 'author': 'coach' to any new element.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Optional

from .config import get_backend_config
from .db import one


def _get_secret() -> bytes:
    try:
        cfg = get_backend_config()
        secret = cfg.link_secret()
    except Exception:
        secret = "socratiq-smartboard-default-secret-salt"
    return secret.encode("utf-8")


def sign_coach_element_id(attempt_id: str, prefix: str = "ai") -> str:
    """Generate a server-issued element ID with an HMAC signature tied to the student's attempt."""
    raw = secrets.token_hex(4)  # 8 hex characters
    secret = _get_secret()
    msg = f"{attempt_id}:{prefix}:{raw}".encode("utf-8")
    sig = hmac.new(secret, msg, hashlib.sha256).hexdigest()[:8]
    return f"{prefix}_{raw}_{sig}"


def verify_coach_element_id(attempt_id: str, element_id: Optional[str]) -> bool:
    """Verify whether an element ID contains a valid HMAC signature issued by the server for this attempt."""
    if not element_id or not isinstance(element_id, str):
        return False
    parts = element_id.split("_")
    if len(parts) < 3:
        return False
    prefix = parts[0]
    raw = parts[1]
    sig = parts[2]
    secret = _get_secret()
    msg = f"{attempt_id}:{prefix}:{raw}".encode("utf-8")
    expected = hmac.new(secret, msg, hashlib.sha256).hexdigest()[:8]
    return hmac.compare_digest(sig, expected)


def is_registered_coach_element(conn, attempt_id: str, element_id: Optional[str]) -> bool:
    """Check if the element ID was recorded in learning_events telemetry as coach-authored for this attempt."""
    if not element_id or not isinstance(element_id, str):
        return False
    try:
        row = one(conn, """
            SELECT 1 FROM learning_events
             WHERE attempt_id = %s
               AND event_type = 'AI_INTERACTION'
               AND payload->'coach_element_ids' ? %s
             LIMIT 1
        """, (attempt_id, element_id))
        return row is not None
    except Exception:
        return False
