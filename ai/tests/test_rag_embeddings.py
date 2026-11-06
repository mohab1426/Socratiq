"""
Unit tests for embedding providers.

Verifies:
- Output dimension matches configured dimension (1024)
- Document and query vectors have identical length
- Embeddings are unit-normalized
- Provider abstraction permits seamless switching
"""
from __future__ import annotations

import numpy as np
import pytest

import ai.rag.config as rag_config_module
from ai.rag.embeddings import (
    EmbeddingProvider,
    MissingEmbeddingCredentialsError,
    MockEmbeddingProvider,
    NVIDIAEmbeddingProvider,
    OpenAIEmbeddingProvider,
    get_embedding_provider,
)


@pytest.fixture(autouse=True)
def _reset_rag_config(monkeypatch):
    """Ensure the cached RAGConfig singleton is rebuilt for every test in this module.

    RAGConfig is memoized at module import time by `get_rag_config()`, so tests
    that rely on `RAG_EMBEDDING_DIM` env overrides must force a fresh instance.
    """
    rag_config_module._default_rag_config = None
    yield
    rag_config_module._default_rag_config = None


def test_mock_embedding_provider_dimension_and_norm():
    dim = 1024
    provider = MockEmbeddingProvider(dimension=dim)

    assert provider.dimension == dim

    docs = ["Gradient descent optimization", "Linear regression and mean squared error"]
    doc_vectors = provider.embed_documents(docs)

    assert len(doc_vectors) == 2
    for vec in doc_vectors:
        assert len(vec) == dim
        norm = np.linalg.norm(vec)
        assert pytest.approx(norm, 0.001) == 1.0

    query_vec = provider.embed_query("What is gradient descent?")
    assert len(query_vec) == dim
    assert pytest.approx(np.linalg.norm(query_vec), 0.001) == 1.0


def test_mock_embeddings_are_deterministic():
    provider = MockEmbeddingProvider(dimension=512)
    text = "The learning rate scales the gradient step."

    vec1 = provider.embed_query(text)
    vec2 = provider.embed_query(text)

    assert vec1 == vec2


def test_factory_returns_mock_when_no_api_key(monkeypatch):

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)

    provider = get_embedding_provider("nvidia", dimension=1024)
    assert provider.dimension == 1024
    vec = provider.embed_query("test query")
    assert len(vec) == 1024


def test_nvidia_embedding_provider_initialization():
    provider = NVIDIAEmbeddingProvider(
        model="nvidia/nv-embedqa-e5-v5",
        api_key="test_dummy_key",
        dimension=1024,
    )
    assert provider.dimension == 1024
    assert provider.model == "nvidia/nv-embedqa-e5-v5"


# ---------------------------------------------------------------------------
# P0 #1 regression: factory must follow configured RAG_EMBEDDING_DIM, never a
# provider-specific hardcoded dimension (previously OpenAI silently forced 1536).
# ---------------------------------------------------------------------------

def test_factory_openai_follows_configured_dimension_not_hardcoded_1536(monkeypatch):

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "768")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)

    # No API key -> falls back to MockEmbeddingProvider, but must still respect
    # the configured dimension rather than a provider-specific hardcode.
    provider = get_embedding_provider("openai")
    assert provider.dimension == 768
    assert provider.dimension != 1536


def test_factory_openai_uses_configured_dimension_with_api_key(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "768")
    monkeypatch.setenv("RAG_EMBEDDING_API_KEY", "test-openai-key")

    provider = get_embedding_provider("openai")
    assert isinstance(provider, OpenAIEmbeddingProvider)
    assert provider.dimension == 768


def test_factory_nvidia_uses_configured_dimension(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "2048")
    monkeypatch.setenv("RAG_EMBEDDING_API_KEY", "test-nvidia-key")

    provider = get_embedding_provider("nvidia")
    assert isinstance(provider, NVIDIAEmbeddingProvider)
    assert provider.dimension == 2048


def test_factory_explicit_dimension_overrides_configured_dimension(monkeypatch):
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "1024")
    monkeypatch.setenv("RAG_EMBEDDING_API_KEY", "test-key")

    provider = get_embedding_provider("openai", dimension=384)
    assert provider.dimension == 384

    provider_nvidia = get_embedding_provider("nvidia", dimension=384)
    assert provider_nvidia.dimension == 384


def test_factory_mock_fallback_uses_configured_dimension(monkeypatch):

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("RAG_EMBEDDING_DIM", "512")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)

    provider = get_embedding_provider("unknown_provider_name")
    assert isinstance(provider, MockEmbeddingProvider)
    assert provider.dimension == 512


# ---------------------------------------------------------------------------
# P2 regression: production must never silently receive mock embeddings.
# ---------------------------------------------------------------------------

def test_factory_raises_in_production_without_credentials(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)

    with pytest.raises(MissingEmbeddingCredentialsError):
        get_embedding_provider("nvidia")

    with pytest.raises(MissingEmbeddingCredentialsError):
        get_embedding_provider("openai")


def test_factory_succeeds_in_production_with_credentials(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("RAG_EMBEDDING_API_KEY", "real-prod-key")

    provider = get_embedding_provider("nvidia")
    assert isinstance(provider, NVIDIAEmbeddingProvider)


def test_factory_explicit_mock_allowed_in_production(monkeypatch):
    """An operator can still explicitly opt into mock embeddings in
    production (e.g. a deliberate smoke-test deploy) -- only the *silent*
    fallback for a real provider missing credentials is disallowed."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)

    provider = get_embedding_provider("mock", dimension=256)
    assert isinstance(provider, MockEmbeddingProvider)


def test_factory_dev_environment_still_falls_back_to_mock(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("RAG_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)

    provider = get_embedding_provider("nvidia")
    assert isinstance(provider, MockEmbeddingProvider)
