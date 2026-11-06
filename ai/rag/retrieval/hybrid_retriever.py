"""
Hybrid Retrieval engine combining Dense Vector Search, Full-Text Search, and RRF.

Implements:
1. Dense vector similarity search (semantic concepts, paraphrases)
2. PostgreSQL FTS (exact terms, acronyms, code identifiers, formulas)
3. Reciprocal Rank Fusion (RRF) for rank harmonization
4. Reranking for high-precision final candidate selection
5. Strict multi-tenant scope isolation (course, classroom, university, assignment, allowed docs)
"""
from __future__ import annotations

import logging
from typing import Optional, Sequence

from ai.rag.config import get_rag_config
from ai.rag.embeddings.base import EmbeddingProvider
from ai.rag.language import is_arabic_dominant, normalize_arabic_text
from ai.rag.models import RetrievalScope, RetrievedChunk
from ai.rag.retrieval.reranker import RerankerProvider, get_reranker_provider
from ai.rag.storage.base import VectorStore
from ai.rag.tracing import rag_traceable

logger = logging.getLogger(__name__)


def compute_rrf_fusion(
    dense_results: list[RetrievedChunk],
    fts_results: list[RetrievedChunk],
    rrf_k: int = 60,
) -> list[RetrievedChunk]:
    """Fuse dense and FTS candidate lists using Reciprocal Rank Fusion (RRF).

    Formula:
        RRF_score(d) = sum(1.0 / (k + rank_i(d)))
    """
    chunk_map: dict[str, RetrievedChunk] = {}
    dense_ranks: dict[str, int] = {}
    fts_ranks: dict[str, int] = {}

    for rank, item in enumerate(dense_results, start=1):
        cid = item.chunk.chunk_id
        chunk_map[cid] = item
        dense_ranks[cid] = rank

    for rank, item in enumerate(fts_results, start=1):
        cid = item.chunk.chunk_id
        if cid not in chunk_map:
            chunk_map[cid] = item
        else:
            # Preserve fts_score in existing item
            chunk_map[cid].fts_score = item.fts_score
        fts_ranks[cid] = rank

    fused_items: list[RetrievedChunk] = []

    for cid, item in chunk_map.items():
        rrf_score = 0.0
        if cid in dense_ranks:
            rrf_score += 1.0 / (rrf_k + dense_ranks[cid])
        if cid in fts_ranks:
            rrf_score += 1.0 / (rrf_k + fts_ranks[cid])

        item.rrf_score = rrf_score
        item.score = rrf_score
        fused_items.append(item)

    # Sort descending by RRF score
    fused_items.sort(key=lambda x: x.score, reverse=True)
    return fused_items


def _concat_dedup(
    dense_results: list[RetrievedChunk],
    fts_results: list[RetrievedChunk],
) -> list[RetrievedChunk]:
    """Rank-preserving concatenation of dense then FTS results, deduplicated
    by chunk_id (dense keeps priority on collision). Used for the "Hybrid
    (concat)" evaluation row (`use_rrf=False`) -- a naive fusion baseline to
    compare against RRF, not a production retrieval path."""
    seen: set[str] = set()
    combined: list[RetrievedChunk] = []
    for item in (*dense_results, *fts_results):
        cid = item.chunk.chunk_id
        if cid in seen:
            continue
        seen.add(cid)
        combined.append(item)
    return combined


class HybridRetriever:
    """Orchestrates multi-tenant dense search, FTS, RRF, and reranking."""

    def __init__(
        self,
        vector_store: VectorStore,
        embedding_provider: EmbeddingProvider,
        reranker: Optional[RerankerProvider] = None,
        dense_top_k: Optional[int] = None,
        fts_top_k: Optional[int] = None,
        rrf_k: Optional[int] = None,
        final_top_k: Optional[int] = None,
    ) -> None:
        cfg = get_rag_config()
        self.vector_store = vector_store
        self.embedding_provider = embedding_provider
        self.reranker = reranker or get_reranker_provider()
        self.dense_top_k = dense_top_k or cfg.dense_top_k
        self.fts_top_k = fts_top_k or cfg.fts_top_k
        self.rrf_k = rrf_k or cfg.rrf_k
        self.final_top_k = final_top_k or cfg.rerank_top_k

    _DEFAULT_RERANKER = object()

    @rag_traceable(name="rag.retrieval.hybrid", run_type="retriever")
    def retrieve(
        self,
        course_id: str,
        query: str,
        classroom_id: Optional[str] = None,
        university_id: Optional[str] = None,
        top_k: Optional[int] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
        scope: Optional[RetrievalScope] = None,
        use_dense: bool = True,
        use_fts: bool = True,
        use_rrf: bool = True,
        reranker: Optional[RerankerProvider] = _DEFAULT_RERANKER,  # type: ignore[assignment]
    ) -> list[RetrievedChunk]:
        """Execute the end-to-end hybrid retrieval pipeline with course and tenant isolation.

        `use_dense`/`use_fts`/`use_rrf`/`reranker` are ablation switches used
        by `ai/evaluation/framework.py` to compare retrieval strategies
        (FTS-only, dense-only, hybrid-concat, hybrid+RRF,
        hybrid+RRF+reranker per section 13 of the spec). Production callers
        never need to pass these -- the defaults reproduce the exact
        previous (pre-ablation) behavior:
          - both dense and FTS run,
          - results are fused via RRF,
          - `self.reranker` (configured at construction) reranks the fusion.

        `reranker=None` explicitly (as opposed to the omitted/default
        sentinel) skips reranking entirely, returning the fused/concatenated
        order as-is -- this is how the "Hybrid (concat)" and "Hybrid + RRF"
        (pre-reranker) evaluation rows are produced.
        """
        eff_course = scope.course_id if scope else course_id
        eff_uni = scope.university_id if scope else university_id
        eff_room = scope.classroom_id if scope else classroom_id
        eff_asg = scope.assignment_id if scope else assignment_id
        eff_docs = scope.allowed_document_ids if scope else (tuple(allowed_document_ids) if allowed_document_ids else ())

        if not eff_course:
            raise ValueError("course_id is required for course-scoped retrieval.")

        clean_query = normalize_arabic_text(query.strip())
        if not clean_query:
            return []

        # Arabic/mixed-language handling: PostgreSQL FTS here is configured
        # with the `english` text-search config, which provides no Arabic
        # stemming/normalization (see docs/RAG.md and the RAG audit). Rather
        # than pretend English FTS gives meaningful recall on Arabic-
        # dominant queries, treat dense retrieval as the reliable path for
        # them and skip FTS -- this never touches English queries/content,
        # which keep the full hybrid path unchanged.
        #
        # This auto-skip only applies to the normal hybrid path (both
        # dense and FTS requested) -- a caller doing a deliberate FTS-only
        # ablation (use_fts=True, use_dense=False, e.g. the evaluation
        # framework measuring how weak FTS really is on Arabic) still gets
        # a real FTS run, not a silently-empty one.
        query_is_arabic_dominant = use_dense and use_fts and is_arabic_dominant(clean_query)
        if query_is_arabic_dominant:
            logger.info(
                "Arabic-dominant query detected; skipping English-configured "
                "FTS and relying on dense retrieval."
            )

        # Step 1: Dense Retrieval
        dense_results: list[RetrievedChunk] = []
        if use_dense:
            try:
                query_vector = self.embedding_provider.embed_query(clean_query)
                dense_results = self.vector_store.search_dense(
                    course_id=eff_course,
                    query_vector=query_vector,
                    top_k=self.dense_top_k,
                    classroom_id=eff_room,
                    university_id=eff_uni,
                    assignment_id=eff_asg,
                    allowed_document_ids=eff_docs,
                    scope=scope,
                )
            except Exception as exc:
                logger.warning("Dense search failed, falling back to FTS only: %s", exc)

        # Step 2: Full-Text Search (skipped for Arabic-dominant queries in
        # the normal hybrid path -- see above).
        fts_results: list[RetrievedChunk] = []
        if use_fts and not query_is_arabic_dominant:
            try:
                fts_results = self.vector_store.search_fts(
                    course_id=eff_course,
                    query=clean_query,
                    top_k=self.fts_top_k,
                    classroom_id=eff_room,
                    university_id=eff_uni,
                    assignment_id=eff_asg,
                    allowed_document_ids=eff_docs,
                    scope=scope,
                )
            except Exception as exc:
                logger.warning("FTS search failed: %s", exc)

        if not dense_results and not fts_results:
            return []

        # Step 3: Fusion -- RRF by default, or plain rank-preserving
        # concatenation (dense first) when `use_rrf=False` (the "Hybrid
        # (concat)" evaluation row).
        if use_rrf:
            fused_results = compute_rrf_fusion(dense_results, fts_results, rrf_k=self.rrf_k)
        else:
            fused_results = _concat_dedup(dense_results, fts_results)

        # Step 4: Reranking. `reranker=None` (explicit) skips reranking;
        # the omitted/default sentinel uses `self.reranker`, matching prior
        # behavior exactly.
        k = top_k or self.final_top_k
        active_reranker = self.reranker if reranker is HybridRetriever._DEFAULT_RERANKER else reranker
        if active_reranker is None:
            return fused_results[:k]

        reranked_results = active_reranker.rerank(
            query=clean_query,
            candidates=fused_results,
            top_k=k,
        )

        return reranked_results
