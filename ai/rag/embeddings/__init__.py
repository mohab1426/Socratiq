"""
Embeddings package with NVIDIA, OpenAI, and Mock provider implementations.
"""
from typing import Optional

from ai.rag.config import get_rag_config
from ai.rag.embeddings.base import EmbeddingProvider
from ai.rag.embeddings.mock import MockEmbeddingProvider
from ai.rag.embeddings.nvidia import NVIDIAEmbeddingProvider
from ai.rag.embeddings.openai import OpenAIEmbeddingProvider

__all__ = [
    "EmbeddingProvider",
    "NVIDIAEmbeddingProvider",
    "OpenAIEmbeddingProvider",
    "MockEmbeddingProvider",
    "MissingEmbeddingCredentialsError",
    "get_embedding_provider",
]


class MissingEmbeddingCredentialsError(RuntimeError):
    """Raised when a real embedding provider is required (production
    environment) but no credentials are configured.

    P2 fix: previously, a missing `embedding_api_key` silently downgraded to
    `MockEmbeddingProvider` in every environment, including production --
    meaning production retrieval could silently run on fake embeddings with
    no error, no warning surfaced to an operator, just quietly degraded
    quality. This is now a hard, fatal configuration error in production;
    development/test/staging keep the mock fallback for offline usability.
    """


def get_embedding_provider(
    provider_name: Optional[str] = None,
    dimension: Optional[int] = None,
) -> EmbeddingProvider:
    """Factory returning configured embedding provider.

    The resolved dimension always follows this precedence:
    explicit ``dimension`` argument > ``cfg.embedding_dim`` (the single
    source of truth for the configured RAG / database vector dimension).
    No provider-specific dimension is ever hardcoded here, so the
    factory can never silently disagree with the configured/database
    dimension.

    In `cfg.environment == "production"`, a configured non-mock provider
    (`nvidia`/`nvidia_nim`/`openai`) with no API key raises
    `MissingEmbeddingCredentialsError` instead of silently returning
    `MockEmbeddingProvider` -- see that class's docstring.
    """
    cfg = get_rag_config()
    name = (provider_name or cfg.embedding_provider).lower()
    resolved_dimension = dimension if dimension is not None else cfg.embedding_dim
    is_production = cfg.environment == "production"

    if name in ("nvidia", "nvidia_nim"):
        if cfg.embedding_api_key:
            return NVIDIAEmbeddingProvider(dimension=resolved_dimension)
        if is_production:
            raise MissingEmbeddingCredentialsError(
                "Embedding provider 'nvidia' is configured but no embedding API "
                "key is set, and ENVIRONMENT=production. Refusing to silently "
                "fall back to MockEmbeddingProvider in production -- set the "
                "NVIDIA embedding API key or explicitly configure a different "
                "provider."
            )
        # Non-production: return MockEmbeddingProvider for offline usability.
        return MockEmbeddingProvider(dimension=resolved_dimension)

    if name == "openai":
        if cfg.embedding_api_key:
            return OpenAIEmbeddingProvider(dimension=resolved_dimension)
        if is_production:
            raise MissingEmbeddingCredentialsError(
                "Embedding provider 'openai' is configured but no embedding API "
                "key is set, and ENVIRONMENT=production. Refusing to silently "
                "fall back to MockEmbeddingProvider in production -- set the "
                "OpenAI embedding API key or explicitly configure a different "
                "provider."
            )
        return MockEmbeddingProvider(dimension=resolved_dimension)

    if name == "mock" or not is_production:
        return MockEmbeddingProvider(dimension=resolved_dimension)

    # `name` is neither a recognized real provider nor explicitly "mock",
    # and we're in production: don't silently hand back mock embeddings for
    # an unrecognized/misconfigured provider name either.
    raise MissingEmbeddingCredentialsError(
        f"Unrecognized embedding provider {name!r} in production "
        "(ENVIRONMENT=production). Refusing to silently fall back to "
        "MockEmbeddingProvider -- set EMBEDDING_PROVIDER to a supported "
        "provider with valid credentials, or explicitly to 'mock' if that "
        "is really intended."
    )
