"""Browsers preflight every cross-origin PUT/PATCH/DELETE (and any request with an Authorization header). If the API does not allow the
method or header, the call fails in production even though same-origin dev and TestClient requests work."""
from __future__ import annotations

import pytest

from .helpers import API

ORIGIN = "http://localhost:5173"          # the default CORS_ORIGINS


@pytest.mark.parametrize("method,path", [
    ("PUT", "/teacher/assignments/A1/students/S1/grade"),            # grading
    ("DELETE", "/teacher/assignments/A1/students/S1/grade"),
    ("PUT", "/student/assignments/A1/whiteboard"),                   # thinking space autosave
    ("PATCH", "/student/attempts/T1"),                               # draft autosave
    ("POST", "/ai/coach/stream"),                                    # SSE
])
def test_preflight_allows_every_method_the_frontend_uses(world, method, path):
    r = world.client.options(f"{API}{path}", headers={"Origin": ORIGIN, "Access-Control-Request-Method": method,
                                                       "Access-Control-Request-Headers": "authorization,content-type"})
    assert r.status_code == 200, r.text
    assert method in r.headers["access-control-allow-methods"]
    assert r.headers["access-control-allow-origin"] == ORIGIN
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed and "content-type" in allowed


def test_unknown_origins_are_not_allowed(world):
    r = world.client.options(f"{API}/student/assignments/A1/whiteboard", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"})
    assert "access-control-allow-origin" not in r.headers
