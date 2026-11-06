"""Backend test harness: REAL Postgres (a fresh clone of the migrated schema per test), REAL storage/pipeline/RAG stack
(mock embeddings, real pgvector store), REAL routers and authorisation. Only true external boundaries are faked:
Supabase Auth (token -> identity) and the LLM-backed AI adapter."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "backend", ROOT, ROOT / "database" / "tests"):
    sys.path.insert(0, str(p))
os.environ.setdefault("ENVIRONMENT", "test")

import psycopg  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import dbtools  # noqa: E402

AUTH = {"P1": "00000000-0000-0000-0000-0000000000a1", "P2": "00000000-0000-0000-0000-0000000000a2", "P3": "00000000-0000-0000-0000-0000000000a3",
        "S1": "00000000-0000-0000-0000-0000000000b1", "S2": "00000000-0000-0000-0000-0000000000b2", "S3": "00000000-0000-0000-0000-0000000000b3"}


class FakeVerifier:
    def verify(self, token: str):
        from app.auth import Identity
        from app.errors import AppError
        if not token.startswith("tok:"):
            raise AppError(401, "bad token")
        uid = token[4:]
        return Identity(auth_user_id=uid, email=f"{uid[-2:]}@test")


class FakeAI:
    """Stands in for the LLM-backed adapter; records every call so tests can assert what the backend handed to the AI."""

    def __init__(self):
        from app.ai_adapter import CoachOutcome
        self.calls, self.fail = [], False
        self.coach_outcome = CoachOutcome(
            response="What parameter controls the step size?", intervention={"type": "QUESTION", "assistance_level": "GUIDED", "rationale": "r"},
            diagnosis={"category": "CONCEPTUAL_GAP", "concept": "learning rate", "explanation": "e", "evidence": "ev", "confidence": 0.82},
            referenced_concepts=["learning rate"], tools_used=["course_retriever"],
            evidence=[{"evidence_type": "MISCONCEPTION", "strength": "MODERATE", "observation": "omits the learning-rate factor", "concept": "learning rate"}],
            risk_signals=[{"signal": "long_polished_answer", "observation": "pasted a long structured answer in one turn", "metadata": {"chars": 900}}],
            sources=[])
        self.eval_score, self.eval_outcome = 0.8, "PASS"

    def _check(self):
        from app.errors import AIUnavailable
        if self.fail:
            raise AIUnavailable()

    def coach_turn(self, **kw):
        self._check()
        self.calls.append(("coach", kw))
        return self.coach_outcome

    def coach_turn_stream(self, **kw):
        self._check()
        self.calls.append(("coach", kw))
        for node in ("understand_context", "diagnose", "generate_response", "validate"):
            yield ("stage", node)
        yield ("outcome", self.coach_outcome)

    def generate_challenge(self, **kw):
        from app.ai_adapter import Challenge
        self._check()
        self.calls.append(("challenge", kw))
        return Challenge(kw["verification_type"], kw["concept"], f"{kw['verification_type']} question about {kw['concept']}?", ["shows understanding"])

    def evaluate(self, **kw):
        from app.ai_adapter import Evaluation
        self._check()
        self.calls.append(("evaluate", kw))
        return Evaluation(self.eval_outcome, self.eval_score, 0.9, "Good reasoning.", [{"criterion": "shows understanding", "passed": True, "feedback": "ok"}],
                          {"evidence_type": "EXPLANATION", "strength": "MODERATE", "observation": "explained the concept", "concept": kw["concept"]})


class World:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def h(self, who: str) -> dict:
        return {"Authorization": f"Bearer tok:{AUTH[who]}"}

    def q(self, sql: str, *params):
        with psycopg.connect(self.url, autocommit=True, row_factory=psycopg.rows.dict_row) as c:
            return c.execute(sql, params).fetchall()

    def x(self, sql: str, *params):
        with psycopg.connect(self.url, autocommit=True) as c:
            c.execute(sql, params)

    def drain(self):
        """Run the ingestion worker synchronously until the queue is empty (deterministic tests)."""
        n = 0
        while self.pipeline.process() is not None:
            n += 1
        return n


@pytest.fixture(scope="session")
def template():
    if not dbtools.postgres_available():
        pytest.skip("no Postgres reachable (set TEST_ADMIN_URL)")
    return dbtools.build_template(name="socratiq_backend_template")


@pytest.fixture()
def world(template, tmp_path):
    from ai.rag.embeddings import MockEmbeddingProvider
    from ai.rag.storage.pgvector import PgVectorStore
    from app.config import reset_backend_config
    from app.db import Database
    from app.files.rag_bridge import build_rag_service
    from app.files.storage import LocalObjectStorage
    from app.main import create_app
    from app.ratelimit import reset_limits

    reset_backend_config()
    reset_limits()
    name = dbtools.clone(template)
    url = dbtools.url_for(name)
    with psycopg.connect(url, autocommit=True) as c:
        dbtools.seed(c)
        c.execute("UPDATE users SET first_name='First'||user_id, last_name='Last'")
    db = Database(url, 1, 6)
    db.open()
    storage = LocalObjectStorage(tmp_path / "objects", bucket="test", secret="test-secret")
    ai = FakeAI()
    rag = build_rag_service(vector_store=PgVectorStore(database_url=url), embedding_provider=MockEmbeddingProvider(dimension=2048))  # must equal the schema's vector(2048) (NVIDIA model dimension)
    app = create_app(db=db, storage=storage, token_verifier=FakeVerifier(), ai_adapter=ai, rag=rag, run_worker=False)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield World(client=client, db=db, url=url, storage=storage, ai=ai, rag=rag, app=app, pipeline=app.state.pipeline)
    db.close()
    dbtools.drop(name)
