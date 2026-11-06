"""
Embedding provider abstraction.

Allows the retrieval subsystem to seamlessly switch between NVIDIA, OpenAI,
and offline mock embedding providers without modifying downstream retrieval logic.
"""
from __future__ import annotations

from typing import Protocol


class EmbeddingProvider(Protocol):
    """Abstract interface for text embedding models."""

    @property
    def dimension(self) -> int:
        """The output embedding vector dimension."""
        ...

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Compute embeddings for a list of document chunks (passages)."""
        ...

    def embed_query(self, query: str) -> list[float]:
        """Compute embedding for a search query."""
        ...
