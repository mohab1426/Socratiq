"""
OpenAI-compatible Embedding Provider.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from ai.rag.config import get_rag_config

logger = logging.getLogger(__name__)


class OpenAIEmbeddingProvider:
    """Standard OpenAI / OpenAI-compatible /v1/embeddings provider."""

    def __init__(
        self,
        model: str = "text-embedding-3-small",
        api_key: Optional[str] = None,
        base_url: str = "https://api.openai.com/v1",
        dimension: int = 1536,
        timeout: float = 30.0,
    ) -> None:
        cfg = get_rag_config()
        self.model = model
        self.api_key = api_key or cfg.embedding_api_key
        self.base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        self._dim = dimension
        self.timeout = timeout

    @property
    def dimension(self) -> int:
        return self._dim

    def _call(self, inputs: list[str]) -> list[list[float]]:
        if not self.api_key:
            raise ValueError("API key required for OpenAI embeddings.")

        url = f"{self.base_url}/embeddings"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"model": self.model, "input": inputs}

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            items = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
            return [item["embedding"] for item in items]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        clean_texts = [t if t.strip() else " " for t in texts]
        return self._call(clean_texts)

    def embed_query(self, query: str) -> list[float]:
        clean_query = query.strip() or " "
        return self._call([clean_query])[0]
