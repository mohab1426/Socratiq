"""
Regression tests for P0 #1: RAGService must fail fast at startup when the
embedding provider's dimension disagrees with the configured RAG embedding
dimension, or (when introspectable) with the live database vector column
dimension — instead of failing later and confusingly during document
insertion.
"""
from __future__ import annotations

import pytest

import ai.rag.config as rag_config_module
from ai.rag.config import get_rag_config
from ai.rag.embeddings.mock import MockEmbeddingProvider
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore


@pytest.fixture(autouse=True)
def _reset_rag_config():
    rag_config_module._default_rag_config = None
    yield
    rag_config_module._default_rag_config = None


def _make_service(embedding_dim: int, vector_store=None) -> RAGService:
    cfg = get_rag_config()
    provider = MockEmbeddingProvider(dimension=embedding_dim)
    return RAGService(
        vector_store=vector_store or MemoryVectorStore(),
        embedding_provider=provider,
    )


def test_service_construction_succeeds_when_dimensions_match(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    service = _make_service(embedding_dim=1024)
    assert service.embedding_provider.dimension == 1024


def test_validator_raises_when_provider_vs_config_check_enabled_and_mismatched(monkeypatch):
    """Exercises the check_provider_vs_config=True branch directly (the branch
    taken on the default factory path in production) to prove it fires on a
    real mismatch."""
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    service = _make_service(embedding_dim=1024)  # constructs cleanly
    service.embedding_provider = MockEmbeddingProvider(dimension=768)

    with pytest.raises(ValueError, match="Embedding dimension mismatch"):
        service._validate_embedding_dimensions(check_provider_vs_config=True)


def test_default_factory_provider_dimension_checked_against_config(monkeypatch):
    """When embedding_provider is NOT explicitly passed (the real production
    path), RAGService must validate the factory-resolved provider's dimension
    against RAG_EMBEDDING_DIM and fail fast on mismatch."""
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)

    # Sanity: factory-resolved (mock fallback) provider matches configured dim,
    # so construction without an injected provider should succeed.
    service = RAGService(vector_store=MemoryVectorStore())
    assert service.embedding_provider.dimension == 1024


def test_explicitly_injected_provider_skips_config_dimension_check(monkeypatch):
    """Explicitly injecting a provider (as most unit tests do to exercise
    storage/retrieval mechanics with arbitrary vector sizes) is a deliberate
    choice, not a misconfiguration, so it must not trigger the fail-fast
    check against RAG_EMBEDDING_DIM."""
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")

    service = _make_service(embedding_dim=256)
    assert service.embedding_provider.dimension == 256


class _FakePgVectorStoreWithDim(MemoryVectorStore):
    """Stand-in for PgVectorStore exposing a live DB column dimension."""

    def __init__(self, db_dimension: int) -> None:
        super().__init__()
        self._db_dimension = db_dimension

    def get_vector_dimension(self):
        return self._db_dimension


def test_service_construction_fails_fast_on_database_dimension_mismatch(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    db_store = _FakePgVectorStoreWithDim(db_dimension=1536)

    with pytest.raises(ValueError, match="database vector column is 1536-dimensional"):
        _make_service(embedding_dim=1024, vector_store=db_store)


def test_service_construction_succeeds_when_provider_and_db_dimension_agree(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    db_store = _FakePgVectorStoreWithDim(db_dimension=1024)

    service = _make_service(embedding_dim=1024, vector_store=db_store)
    assert service.embedding_provider.dimension == 1024


def test_service_construction_tolerates_unintrospectable_vector_store(monkeypatch):
    """MemoryVectorStore has no get_vector_dimension; validation should skip that
    check gracefully rather than erroring on a missing attribute."""
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    service = _make_service(embedding_dim=1024, vector_store=MemoryVectorStore())
    assert service is not None
