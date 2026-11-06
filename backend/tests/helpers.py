"""Shared helpers for backend integration tests."""
from __future__ import annotations

from pathlib import Path

FX = Path(__file__).parent / "fixtures"
API = "/api/v1"


def upload(w, who, name, data, *, ctype="application/octet-stream", course="C1", title=None, path="materials", classroom=None):
    files = {"file": (name, data, ctype)}
    form = {k: v for k, v in (("title", title), ("classroom_id", classroom)) if v}
    return w.client.post(f"{API}/teacher/courses/{course}/{path}", files=files, data=form or None, headers=w.h(who))


def sample(name):
    return (FX / name).read_bytes()


def retrieve(w, query, *, uni="U1", course="C1", room="K1", asg=None, allowed=()):
    from ai.rag.models import RetrievalScope
    scope = RetrievalScope(uni, course, room, asg, tuple(allowed))
    return w.rag.retrieve_course_material(course_id=course, query=query, top_k=5, scope=scope)
