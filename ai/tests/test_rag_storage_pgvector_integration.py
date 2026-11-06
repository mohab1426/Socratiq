"""
Real-infrastructure integration tests for `PgVectorStore` (P0 #3).

These tests exercise the ACTUAL PostgreSQL + pgvector code path, not
`MemoryVectorStore`. Prior to this file, `PgVectorStore` had no meaningful
coverage: only `MemoryVectorStore` was exercised in `test_rag_retrieval.py`
and friends, even though `MemoryVectorStore` and `PgVectorStore` share the
same `VectorStore` protocol but have completely independent implementations
(raw SQL, pgvector's `<=>` operator, PostgreSQL FTS/`tsvector`/`plainto_tsquery`,
JSON columns, etc.).

These tests are a clearly separated "real integration" path:
- They connect to an actual Postgres+pgvector instance.
- They are SKIPPED (not faked, not silently passed) if that instance isn't
  reachable in the current environment. Do not read a skip here as a mocked
  test standing in for real Postgres validation — it stands in for nothing;
  the coverage simply does not run without real infrastructure.
- They apply the real `database/migrations/001_rag_pgvector_schema.sql`
  schema (or expect it to already be applied) so behavior reflects the
  actual generated columns, GIN/HNSW indexes, and pgvector operators.

Configure via the `TEST_DATABASE_URL` environment variable, e.g.:

    export TEST_DATABASE_URL="postgresql://postgres:postgres_dev_password@localhost:5432/socratic_class_test"
    psql "$TEST_DATABASE_URL" -f database/migrations/001_rag_pgvector_schema.sql
    pytest ai/tests/test_rag_storage_pgvector_integration.py -v -m integration

If `TEST_DATABASE_URL` is unset, or the database is unreachable, or the
`document_chunks`/`documents` tables don't exist yet, every test in this
module is skipped with a clear reason -- never silently treated as passing.
"""
from __future__ import annotations

import os
import uuid

import pytest

from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, ProcessingStatus
from ai.rag.storage.pgvector import PgVectorStore

pytestmark = pytest.mark.integration

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")


def _pgvector_available() -> tuple[bool, str]:
    """Best-effort real-infrastructure availability probe.

    Returns (available, reason). Never raises -- a probe failure just means
    "not available", which the caller turns into a pytest skip.
    """
    if not TEST_DATABASE_URL:
        return False, "TEST_DATABASE_URL (or DATABASE_URL) is not set."
    try:
        import psycopg
    except ImportError:
        return False, "psycopg is not installed."

    try:
        with psycopg.connect(TEST_DATABASE_URL, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT to_regclass('documents'), to_regclass('document_chunks');"
                )
                docs_tbl, chunks_tbl = cur.fetchone()
                if docs_tbl is None or chunks_tbl is None:
                    return False, (
                        "documents/document_chunks tables do not exist. Run "
                        "database/migrations/001_rag_pgvector_schema.sql against "
                        "TEST_DATABASE_URL first."
                    )
        return True, ""
    except Exception as exc:  # pragma: no cover - environment dependent
        return False, f"Could not connect to TEST_DATABASE_URL: {exc}"


_AVAILABLE, _SKIP_REASON = _pgvector_available()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not _AVAILABLE, reason=_SKIP_REASON),
]


@pytest.fixture
def store() -> PgVectorStore:
    return PgVectorStore(database_url=TEST_DATABASE_URL)


@pytest.fixture
def unique_ids():
    """Unique per-test identifiers so parallel/rerun tests never collide."""
    suffix = uuid.uuid4().hex[:8]
    return {
        "university_id": f"itest_univ_{suffix}",
        "course_id": f"itest_course_{suffix}",
        "classroom_id": f"itest_room_{suffix}",
        "document_id": f"itest_doc_{suffix}",
    }


def _vector(dim: int, seed: float) -> list[float]:
    """Small deterministic unit-ish vector for pgvector inserts."""
    import math

    vec = [0.0] * dim
    vec[0] = seed
    vec[1] = 1.0 - seed
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


@pytest.fixture(autouse=True)
def _cleanup(store: PgVectorStore, unique_ids):
    """Create the tenant parents this test's documents hang off, then delete everything afterwards.

    Since migration 009 the database enforces (course, university) and (classroom, course, university) foreign keys, so a
    document can no longer be stored under a university/course/classroom that does not exist.
    """
    import psycopg

    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as conn:
        conn.execute("INSERT INTO universities (university_id, name) VALUES (%s, 'itest')", (unique_ids["university_id"],))
        conn.execute("INSERT INTO courses (course_id, university_id, code, title) VALUES (%s, %s, %s, 'itest')",
                     (unique_ids["course_id"], unique_ids["university_id"], unique_ids["course_id"]))
        conn.execute("INSERT INTO classrooms (classroom_id, course_id, name, university_id) VALUES (%s, %s, 'itest', %s)",
                     (unique_ids["classroom_id"], unique_ids["course_id"], unique_ids["university_id"]))
        conn.execute("INSERT INTO users (user_id, university_id, email, role) VALUES ('prof_1', %s, %s, 'PROFESSOR')",   # uploader FK is tenant-scoped
                     (unique_ids["university_id"], f"prof_1@{unique_ids['university_id']}.test"))
    yield
    try:
        store.delete_document(unique_ids["document_id"])
    except Exception:
        pass
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as conn:
        conn.execute("DELETE FROM documents WHERE university_id = %s", (unique_ids["university_id"],))   # any extra docs a test created
        conn.execute("DELETE FROM users WHERE user_id = 'prof_1' AND university_id = %s", (unique_ids["university_id"],))
        conn.execute("DELETE FROM classrooms WHERE classroom_id = %s", (unique_ids["classroom_id"],))
        conn.execute("DELETE FROM courses WHERE course_id = %s", (unique_ids["course_id"],))
        conn.execute("DELETE FROM universities WHERE university_id = %s", (unique_ids["university_id"],))


def _dim(store: PgVectorStore) -> int:
    dim = store.get_vector_dimension()
    assert dim is not None, "Expected to introspect the embedding column dimension"
    return dim


# ---------------------------------------------------------------------------
# store_document -> get_document_by_hash -> metadata reconstruction
# ---------------------------------------------------------------------------

def test_store_document_then_get_by_hash_reconstructs_metadata(store, unique_ids):
    content_hash = uuid.uuid4().hex
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        classroom_id=unique_ids["classroom_id"],
        uploader_id="prof_1",
        filename="lecture_01.pdf",
        file_type="pdf",
        storage_path="/data/lecture_01.pdf",
        content_hash=content_hash,
        processing_status=ProcessingStatus.STORED,
        total_pages=3,
        total_chunks=0,
        extra_metadata={"note": "integration-test"},
    )

    store.store_document(metadata, chunks=[])

    fetched = store.get_document_by_hash(
        course_id=unique_ids["course_id"], content_hash=content_hash
    )

    assert fetched is not None
    assert fetched.document_id == unique_ids["document_id"]
    assert fetched.university_id == unique_ids["university_id"]
    assert fetched.course_id == unique_ids["course_id"]
    assert fetched.classroom_id == unique_ids["classroom_id"]
    assert fetched.uploader_id == "prof_1"
    assert fetched.filename == "lecture_01.pdf"
    assert fetched.file_type == "pdf"
    assert fetched.content_hash == content_hash
    assert fetched.processing_status == ProcessingStatus.STORED
    assert fetched.total_pages == 3
    assert fetched.extra_metadata.get("note") == "integration-test"


def test_get_document_by_hash_returns_none_for_unknown_hash(store, unique_ids):
    # No document stored for this course/hash combination.
    result = store.get_document_by_hash(
        course_id=unique_ids["course_id"], content_hash="does-not-exist"
    )
    assert result is None


def test_get_document_by_hash_scoped_to_course(store, unique_ids):
    """A document stored under one course must not be found by content hash
    under a different, unrelated course_id."""
    content_hash = uuid.uuid4().hex
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        filename="notes.pdf",
        content_hash=content_hash,
        processing_status=ProcessingStatus.STORED,
        storage_path="test/course-materials/test.pdf",
    )
    store.store_document(metadata, chunks=[])

    other_course_result = store.get_document_by_hash(
        course_id=f"unrelated_{unique_ids['course_id']}", content_hash=content_hash
    )
    assert other_course_result is None


# ---------------------------------------------------------------------------
# store chunks -> dense retrieval
# ---------------------------------------------------------------------------

def test_store_chunks_then_dense_retrieval_orders_by_similarity(store, unique_ids):
    dim = _dim(store)
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        classroom_id=unique_ids["classroom_id"],
        filename="gradient_descent.pdf",
        processing_status=ProcessingStatus.STORED,
        total_chunks=2,
        storage_path="test/course-materials/gradient_descent.pdf",
    )

    close_vec = _vector(dim, seed=0.9)
    far_vec = _vector(dim, seed=0.1)

    close_chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_close",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        classroom_id=unique_ids["classroom_id"],
        document_id=unique_ids["document_id"],
        title="Gradient Descent",
        page_number=1,
        section="Optimization",
        content="Gradient descent updates parameters using the loss gradient.",
        content_type=ContentType.EXPLANATION,
        chunk_index=0,
        embedding=close_vec,
        token_count=10,
    )
    far_chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_far",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        classroom_id=unique_ids["classroom_id"],
        document_id=unique_ids["document_id"],
        title="Gradient Descent",
        page_number=2,
        section="Unrelated",
        content="Unrelated filler content about supply and demand curves.",
        content_type=ContentType.EXPLANATION,
        chunk_index=1,
        embedding=far_vec,
        token_count=8,
    )

    store.store_document(metadata, chunks=[close_chunk, far_chunk])

    query_vec = _vector(dim, seed=0.95)  # closest to close_vec
    results = store.search_dense(
        course_id=unique_ids["course_id"],
        query_vector=query_vec,
        top_k=5,
        classroom_id=unique_ids["classroom_id"],
        university_id=unique_ids["university_id"],
    )

    assert len(results) == 2
    # Closest vector should rank first.
    assert results[0].chunk.chunk_id == close_chunk.chunk_id
    assert results[0].dense_score is not None
    assert results[0].dense_score >= results[1].dense_score


def test_dense_retrieval_respects_course_scope(store, unique_ids):
    """A chunk stored under one course must never surface for a dense search
    scoped to a different course_id."""
    dim = _dim(store)
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        filename="secret.pdf",
        processing_status=ProcessingStatus.STORED,
        total_chunks=1,
        storage_path="test/course-materials/secret.pdf",
    )
    chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_secret",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        document_id=unique_ids["document_id"],
        title="Secret",
        content="Confidential course-A-only material.",
        embedding=_vector(dim, seed=0.5),
        chunk_index=0,
    )
    store.store_document(metadata, chunks=[chunk])

    results = store.search_dense(
        course_id=f"other_{unique_ids['course_id']}",
        query_vector=_vector(dim, seed=0.5),
        top_k=5,
    )
    assert results == []


# ---------------------------------------------------------------------------
# store chunks -> FTS retrieval
# ---------------------------------------------------------------------------

def test_store_chunks_then_fts_retrieval_matches_keyword(store, unique_ids):
    dim = _dim(store)
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        filename="backpropagation.pdf",
        processing_status=ProcessingStatus.STORED,
        total_chunks=2,
        storage_path="test/course-materials/backpropagation.pdf",
    )
    matching_chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_match",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        document_id=unique_ids["document_id"],
        title="Backpropagation",
        content="Backpropagation computes gradients via the chain rule through the network.",
        embedding=_vector(dim, seed=0.3),
        chunk_index=0,
    )
    unrelated_chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_unrelated",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        document_id=unique_ids["document_id"],
        title="Supply and Demand",
        content="Market equilibrium occurs where supply meets demand.",
        embedding=_vector(dim, seed=0.7),
        chunk_index=1,
    )
    store.store_document(metadata, chunks=[matching_chunk, unrelated_chunk])

    results = store.search_fts(
        course_id=unique_ids["course_id"],
        query="backpropagation chain rule",
        top_k=5,
    )

    assert len(results) == 1
    assert results[0].chunk.chunk_id == matching_chunk.chunk_id
    assert results[0].fts_score is not None
    assert results[0].fts_score > 0


def test_fts_retrieval_respects_course_scope(store, unique_ids):
    dim = _dim(store)
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        filename="secret.pdf",
        processing_status=ProcessingStatus.STORED,
        total_chunks=1,
        storage_path="test/course-materials/secret.pdf",
    )
    chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_secret",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        document_id=unique_ids["document_id"],
        title="Secret",
        content="uniquetokenxyz123 confidential course-A-only material",
        embedding=_vector(dim, seed=0.5),
        chunk_index=0,
    )
    store.store_document(metadata, chunks=[chunk])

    results = store.search_fts(
        course_id=f"other_{unique_ids['course_id']}",
        query="uniquetokenxyz123",
        top_k=5,
    )
    assert results == []


def test_dense_retrieval_respects_university_and_classroom_scope(store, unique_ids):
    """Cross-tenant isolation at the real Postgres query level: a chunk scoped
    to one university/classroom must never surface for a dense search scoped
    to a different university or classroom, even within the same course_id."""
    dim = _dim(store)
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        classroom_id=unique_ids["classroom_id"],
        filename="tenant_a_only.pdf",
        processing_status=ProcessingStatus.STORED,
        total_chunks=1,
        storage_path="test/course-materials/tenant_a_only.pdf",
    )
    chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_tenant_a",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        classroom_id=unique_ids["classroom_id"],
        document_id=unique_ids["document_id"],
        title="Tenant A Material",
        content="Material exclusive to university/classroom A.",
        embedding=_vector(dim, seed=0.42),
        chunk_index=0,
    )
    store.store_document(metadata, chunks=[chunk])

    same_query = _vector(dim, seed=0.42)

    # Same course_id, but wrong university_id -> must not leak.
    wrong_university = store.search_dense(
        course_id=unique_ids["course_id"],
        query_vector=same_query,
        top_k=5,
        university_id=f"other_{unique_ids['university_id']}",
    )
    assert wrong_university == []

    # Same course_id, but wrong classroom_id -> must not leak.
    wrong_classroom = store.search_dense(
        course_id=unique_ids["course_id"],
        query_vector=same_query,
        top_k=5,
        classroom_id=f"other_{unique_ids['classroom_id']}",
    )
    assert wrong_classroom == []

    # Correct university_id and classroom_id -> must retrieve it.
    correct_scope = store.search_dense(
        course_id=unique_ids["course_id"],
        query_vector=same_query,
        top_k=5,
        university_id=unique_ids["university_id"],
        classroom_id=unique_ids["classroom_id"],
    )
    assert len(correct_scope) == 1
    assert correct_scope[0].chunk.chunk_id == chunk.chunk_id


def test_dense_retrieval_respects_allowed_document_ids_whitelist(store, unique_ids):
    """Document whitelist enforcement at the real Postgres query level."""
    dim = _dim(store)
    metadata = DocumentMetadata(
        document_id=unique_ids["document_id"],
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        filename="not_whitelisted.pdf",
        processing_status=ProcessingStatus.STORED,
        total_chunks=1,
        storage_path="test/course-materials/not_whitelisted.pdf",
    )
    chunk = DocumentChunk(
        chunk_id=f"{unique_ids['document_id']}_chunk_not_whitelisted",
        university_id=unique_ids["university_id"],
        course_id=unique_ids["course_id"],
        document_id=unique_ids["document_id"],
        title="Not Whitelisted",
        content="This document was not explicitly allow-listed for the assignment.",
        embedding=_vector(dim, seed=0.61),
        chunk_index=0,
    )
    store.store_document(metadata, chunks=[chunk])

    results = store.search_dense(
        course_id=unique_ids["course_id"],
        query_vector=_vector(dim, seed=0.61),
        top_k=5,
        allowed_document_ids=[f"other_{unique_ids['document_id']}"],
    )
    assert results == []

    allowed_results = store.search_dense(
        course_id=unique_ids["course_id"],
        query_vector=_vector(dim, seed=0.61),
        top_k=5,
        allowed_document_ids=[unique_ids["document_id"]],
    )
    assert len(allowed_results) == 1


# ---------------------------------------------------------------------------
# get_vector_dimension() introspection (supports P0 #1 fail-fast validation)
# ---------------------------------------------------------------------------

def test_get_vector_dimension_matches_migrated_schema(store):
    dim = store.get_vector_dimension()
    assert dim is not None
    assert dim > 0
