"""
Reranker provider abstraction and NVIDIA NIM implementation.

Reranks candidate chunks returned from initial hybrid retrieval (top 15-20)
down to the most relevant 4-6 chunks with calibrated scores.
The reranker MUST only receive already-authorized candidates.
"""
from __future__ import annotations

import logging
from typing import Optional, Protocol

import httpx

from ai.rag.config import get_rag_config
from ai.rag.models import RetrievedChunk

logger = logging.getLogger(__name__)


class MissingRerankerCredentialsError(RuntimeError):
    """Raised when a real reranker provider is required (production
    environment) but no credentials are configured. See
    `get_reranker_provider` and
    `ai.rag.embeddings.MissingEmbeddingCredentialsError` (same pattern)."""


class RerankerProvider(Protocol):
    """Abstract protocol for text reranking."""

    def rerank(
        self,
        query: str,
        candidates: list[RetrievedChunk],
        top_k: int = 5,
    ) -> list[RetrievedChunk]:
        """Rerank candidates and return the top_k most relevant chunks."""
        ...


class FallbackRerankerProvider:
    """Heuristic lexical-semantic reranker for offline testing and fallback.

    Combines initial score with concept matches and query term overlap.
    """

    def rerank(
        self,
        query: str,
        candidates: list[RetrievedChunk],
        top_k: int = 5,
    ) -> list[RetrievedChunk]:
        if not candidates:
            return []

        query_terms = [t.lower() for t in query.split() if len(t) > 2]
        scored: list[tuple[float, RetrievedChunk]] = []

        for item in candidates:
            base_score = item.score or 0.0
            content_lower = item.chunk.content.lower()
            section_lower = (item.chunk.section or "").lower()

            term_hits = sum(1 for term in query_terms if term in content_lower)
            section_hits = sum(1 for term in query_terms if term in section_lower)
            concept_hits = sum(
                1 for term in query_terms
                if any(term in c.lower() for c in item.chunk.concepts)
            )

            # Boost calculation
            boost = (term_hits * 0.1) + (section_hits * 0.25) + (concept_hits * 0.35)
            final_score = base_score + boost

            item.rerank_score = final_score
            item.score = final_score
            scored.append((final_score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [c for _, c in scored[:top_k]]


class NVIDIARerankerProvider:
    """NVIDIA NIM Reranker provider using /v1/ranking endpoint.

    Default model: nvidia/llama-3.2-nv-rerankqa-1b-v2 (or nvidia/nv-rerankqa-mistral-4b-v3).
    Falls back gracefully to FallbackRerankerProvider if call fails.
    """

    def __init__(
        self,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        fallback: Optional[RerankerProvider] = None,
    ) -> None:
        cfg = get_rag_config()
        self.model = model or cfg.reranker_model
        self.api_key = api_key or cfg.reranker_api_key
        raw_base = base_url or cfg.reranker_base_url or "https://integrate.api.nvidia.com/v1"
        self.base_url = raw_base.rstrip("/")
        self.timeout = timeout
        self.fallback = fallback or FallbackRerankerProvider()

    def rerank(
        self,
        query: str,
        candidates: list[RetrievedChunk],
        top_k: int = 5,
    ) -> list[RetrievedChunk]:
        if not candidates:
            return []

        if not self.api_key:
            logger.debug("NVIDIA API key not set for reranker; using fallback.")
            return self.fallback.rerank(query, candidates, top_k=top_k)

        if self.model == "nvidia/llama-nemotron-rerank-vl-1b-v2":
            url = (
                f"{self.base_url}/retrieval/nvidia/"
                "llama-nemotron-rerank-vl-1b-v2/reranking"
            )
        else:
            url = f"{self.base_url}/ranking"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        # Take up to 20 passages to limit payload size
        eval_candidates = candidates[:20]
        passages = [{"text": c.chunk.content[:1500]} for c in eval_candidates]

        payload = {
            "model": self.model,
            "query": {"text": query},
            "passages": passages,
        }

        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                rankings = data.get("rankings", [])
                # rankings items: {"index": 0, "logit": float}
                reranked_results: list[RetrievedChunk] = []

                # Sort by logit descending
                sorted_rankings = sorted(
                    rankings, key=lambda x: x.get("logit", -999.0), reverse=True
                )

                for r in sorted_rankings[:top_k]:
                    idx = r.get("index")
                    if idx is not None and idx < len(eval_candidates):
                        item = eval_candidates[idx]
                        logit = float(r.get("logit", 0.0))
                        item.rerank_score = logit
                        item.score = max(0.0, logit)
                        reranked_results.append(item)

                return reranked_results
        except Exception as exc:
            logger.warning("NVIDIA reranker call failed, falling back to local reranker: %s", exc)
            return self.fallback.rerank(query, candidates, top_k=top_k)


def get_reranker_provider(provider_name: Optional[str] = None) -> RerankerProvider:
    """Factory returning configured reranker provider.

    In `cfg.environment == "production"`, a configured non-fallback provider
    (`nvidia`/`nvidia_nim`) with no API key raises
    `MissingRerankerCredentialsError` instead of silently returning
    `FallbackRerankerProvider` (a heuristic, non-learned reranker) --
    mirroring the embedding-provider fail-loud behavior in
    `ai.rag.embeddings.get_embedding_provider`. Development/test keep the
    heuristic fallback for offline usability.
    """
    cfg = get_rag_config()
    name = (provider_name or cfg.reranker_provider).lower()
    is_production = cfg.environment == "production"

    if name in ("nvidia", "nvidia_nim"):
        if cfg.reranker_api_key:
            return NVIDIARerankerProvider()
        if is_production:
            raise MissingRerankerCredentialsError(
                "Reranker provider 'nvidia' is configured but no reranker API "
                "key is set, and ENVIRONMENT=production. Refusing to silently "
                "fall back to the heuristic FallbackRerankerProvider in "
                "production -- set the NVIDIA reranker API key or explicitly "
                "configure the 'heuristic' provider if that is intended."
            )
        return FallbackRerankerProvider()

    return FallbackRerankerProvider()
