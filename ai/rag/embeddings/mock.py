"""
Deterministic mock embedding provider for testing and CI.

Produces unit-normalized vectors of arbitrary dimension without network calls.
Guarantees:
- Identical text produces identical vectors
- Texts sharing terms have higher cosine similarity than unrelated texts
"""
from __future__ import annotations

import hashlib
import math
from typing import Optional

import numpy as np


class MockEmbeddingProvider:
    """Offline, deterministic embedding provider for reproducible testing."""

    def __init__(self, dimension: int = 1024) -> None:
        self._dim = dimension

    @property
    def dimension(self) -> int:
        return self._dim

    def _embed_single(self, text: str) -> list[float]:
        if not text:
            vec = np.zeros(self._dim, dtype=np.float32)
            vec[0] = 1.0
            return vec.tolist()

        # Build pseudo-dense semantic projection based on tokens and full text hash
        vec = np.zeros(self._dim, dtype=np.float32)
        words = text.lower().split()

        for word in words:
            # Deterministic hash for word
            h = int(hashlib.md5(word.encode("utf-8")).hexdigest()[:8], 16)
            idx = h % self._dim
            sign = 1.0 if (h % 2 == 0) else -1.0
            vec[idx] += sign

        # Add global text hash to avoid collision on anagrams
        text_h = int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)
        rng = np.random.RandomState(text_h)
        noise = rng.normal(0, 0.05, self._dim).astype(np.float32)
        vec += noise

        # L2 normalize
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        else:
            vec[0] = 1.0

        return vec.tolist()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_single(t) for t in texts]

    def embed_query(self, query: str) -> list[float]:
        return self._embed_single(query)
