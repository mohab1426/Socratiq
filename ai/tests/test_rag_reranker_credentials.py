"""Unit tests for the reranker provider factory, mirroring the embedding
provider's environment-aware credential handling (P2)."""
from __future__ import annotations

import pytest

import ai.rag.config as rag_config_module
from ai.rag.retrieval.reranker import (
    FallbackRerankerProvider,
    MissingRerankerCredentialsError,
    NVIDIARerankerProvider,
    get_reranker_provider,
)


@pytest.fixture(autouse=True)
def _reset_rag_config():
    rag_config_module._default_rag_config = None
    yield
    rag_config_module._default_rag_config = None


def test_factory_returns_fallback_without_credentials_in_development(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("RAG_RERANKER_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)

    monkeypatch.delenv("AI_API_KEY", raising=False)

    provider = get_reranker_provider("nvidia")
    assert isinstance(provider, FallbackRerankerProvider)


def test_factory_raises_in_production_without_credentials(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("RAG_RERANKER_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)

    monkeypatch.delenv("AI_API_KEY", raising=False)
    
    with pytest.raises(MissingRerankerCredentialsError):
        get_reranker_provider("nvidia")


def test_factory_succeeds_in_production_with_credentials(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("RAG_RERANKER_API_KEY", "real-prod-key")

    provider = get_reranker_provider("nvidia")
    assert isinstance(provider, NVIDIARerankerProvider)


def test_factory_explicit_heuristic_allowed_in_production(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")

    provider = get_reranker_provider("heuristic")
    assert isinstance(provider, FallbackRerankerProvider)
