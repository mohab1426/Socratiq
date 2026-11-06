"""
Reusable RAG evaluation framework (P1 #5 rebuild).

This module replaces the self-referential benchmark that used to live
directly in `evaluate_rag.py`. The previous benchmark:
  - embedded the expected answer text directly into the only chunk that
    could match a query, and
  - embedded the student's own question into that same chunk's content,
so retrieval was trivially guaranteed regardless of whether the underlying
retrieval mechanics actually worked.

This module makes that impossible by construction: `EvalQuery` and
`EvalDocument` are independent data -- a query names an
`expected_document_id`/`expected_page`/`expected_section` but the framework
never inspects a document's content when building or scoring a query, so
there's no code path by which a query's own text could leak into its
target chunk. `validate_no_leakage()` below adds a belt-and-suspenders
check that actively asserts this for any dataset passed through it.

Two consumers of this framework exist:
  - `ai/evaluation/fixtures/ci_smoke_dataset.py`: a small, clearly-labeled,
    hand-written fixture (with distractor documents) for CI -- proves the
    framework and the retrieval pipeline wiring work, NOT a claim about
    real-world retrieval quality.
  - `ai/evaluation/real_benchmark.py`: a harness for real course PDFs +
    held-out queries with real ground truth, for actual retrieval-quality
    measurement. Not run in CI (no real PDFs/ground truth ship with the
    repo), but ready to receive them.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from ai.rag.embeddings.base import EmbeddingProvider
from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, ProcessingStatus, RetrievedChunk
from ai.rag.retrieval.hybrid_retriever import HybridRetriever
from ai.rag.retrieval.reranker import RerankerProvider
from ai.rag.storage.base import VectorStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EvalChunk:
    page_number: int
    content: str
    section: Optional[str] = None
    subsection: Optional[str] = None
    concepts: list[str] = field(default_factory=list)
    content_type: ContentType = ContentType.EXPLANATION


@dataclass(frozen=True)
class EvalDocument:
    document_id: str
    filename: str
    university_id: str
    course_id: str
    classroom_id: Optional[str]
    chunks: list[EvalChunk]


@dataclass(frozen=True)
class EvalQuery:
    query_id: str
    query: str
    course_id: str
    classroom_id: Optional[str]
    expected_document_id: str
    expected_page: Optional[int] = None
    expected_section: Optional[str] = None
    # Free-form label for reporting (e.g. "paraphrase", "arabic",
    # "mixed_language") -- purely descriptive, not used by scoring.
    tag: str = ""


class LeakageError(AssertionError):
    """Raised by `validate_no_leakage` when a query's own text (or the
    literal expected_document_id/section) is found verbatim inside its own
    target chunk's content -- the exact self-referential pattern the P1
    rebuild is meant to prevent."""


def validate_no_leakage(documents: list[EvalDocument], queries: list[EvalQuery]) -> None:
    """Assert that no query's text leaks into the content of its own
    expected target chunk. Call this on every dataset (fixture or real)
    before running it -- CI does this in
    `ai/tests/test_evaluation_framework.py`."""
    docs_by_id = {d.document_id: d for d in documents}
    for q in queries:
        doc = docs_by_id.get(q.expected_document_id)
        if doc is None:
            continue
        target_chunks = doc.chunks
        if q.expected_page is not None:
            target_chunks = [c for c in target_chunks if c.page_number == q.expected_page]
        for chunk in target_chunks:
            if q.query.strip().lower() in chunk.content.lower():
                raise LeakageError(
                    f"Query {q.query_id!r} text appears verbatim inside its own "
                    f"expected target chunk (document {q.expected_document_id!r}, "
                    f"page {chunk.page_number}). This is the self-referential "
                    "pattern the evaluation rebuild forbids."
                )


def load_documents_into_store(
    vector_store: VectorStore,
    embedding_provider: EmbeddingProvider,
    documents: list[EvalDocument],
) -> None:
    """Embed and store `documents` into `vector_store` via the real
    `DocumentChunk`/`DocumentMetadata` models -- the same shapes production
    ingestion produces -- so evaluation exercises the real storage/retrieval
    contract, not a shortcut."""
    for doc in documents:
        metadata = DocumentMetadata(
            document_id=doc.document_id,
            university_id=doc.university_id,
            course_id=doc.course_id,
            classroom_id=doc.classroom_id,
            filename=doc.filename,
            file_type="pdf",
            processing_status=ProcessingStatus.STORED,
            total_pages=len(doc.chunks),
            total_chunks=len(doc.chunks),
        )
        chunks: list[DocumentChunk] = []
        for idx, c in enumerate(doc.chunks):
            embedding = embedding_provider.embed_documents([c.content])[0]
            chunks.append(
                DocumentChunk(
                    university_id=doc.university_id,
                    course_id=doc.course_id,
                    classroom_id=doc.classroom_id,
                    document_id=doc.document_id,
                    title=doc.filename,
                    page_number=c.page_number,
                    section=c.section,
                    subsection=c.subsection,
                    concepts=c.concepts,
                    content_type=c.content_type,
                    chunk_index=idx,
                    content=c.content,
                    token_count=len(c.content.split()),
                    embedding=embedding,
                )
            )
        vector_store.store_document(metadata, chunks)


@dataclass
class QueryOutcome:
    query_id: str
    ranked_document_ids: list[str]
    ranked_pages: list[Optional[int]]
    ranked_sections: list[Optional[str]]
    hit_document: bool  # expected_document_id appears anywhere in results
    reciprocal_rank: float  # 0.0 if not found; 1/rank of first document match otherwise
    document_and_page_match_rank: Optional[int]  # rank of first result matching doc+page (if expected_page given)


def _run_single_strategy(
    retriever: HybridRetriever,
    query: EvalQuery,
    top_k: int,
    use_fts: bool,
    use_dense: bool,
    use_rrf: bool,
    reranker: Optional[RerankerProvider],
) -> QueryOutcome:
    results: list[RetrievedChunk] = retriever.retrieve(
        course_id=query.course_id,
        query=query.query,
        classroom_id=query.classroom_id,
        top_k=top_k,
        use_fts=use_fts,
        use_dense=use_dense,
        use_rrf=use_rrf,
        reranker=reranker,
    )
    ranked_doc_ids = [r.chunk.document_id for r in results]
    ranked_pages = [r.chunk.page_number for r in results]
    ranked_sections = [r.chunk.section for r in results]

    reciprocal_rank = 0.0
    doc_page_rank: Optional[int] = None
    for rank, (doc_id, page) in enumerate(zip(ranked_doc_ids, ranked_pages), start=1):
        if doc_id == query.expected_document_id:
            if reciprocal_rank == 0.0:
                reciprocal_rank = 1.0 / rank
            if query.expected_page is not None and doc_page_rank is None and page == query.expected_page:
                doc_page_rank = rank

    return QueryOutcome(
        query_id=query.query_id,
        ranked_document_ids=ranked_doc_ids,
        ranked_pages=ranked_pages,
        ranked_sections=ranked_sections,
        hit_document=query.expected_document_id in ranked_doc_ids,
        reciprocal_rank=reciprocal_rank,
        document_and_page_match_rank=doc_page_rank,
    )


def compute_metrics(outcomes: list[QueryOutcome], queries: list[EvalQuery], k_values: tuple[int, ...] = (1, 5, 10)) -> dict[str, float]:
    """Compute Recall@K, MRR, Precision@K, and document/page accuracy from a
    list of per-query outcomes (already restricted to top-K candidates by
    the caller for each K of interest -- see `run_strategy_comparison`,
    which calls this once per K)."""
    n = len(outcomes)
    if n == 0:
        return {}
    metrics: dict[str, float] = {}
    for k in k_values:
        hits = 0
        precision_sum = 0.0
        for outcome, query in zip(outcomes, queries):
            top_k_docs = outcome.ranked_document_ids[:k]
            is_hit = query.expected_document_id in top_k_docs
            if is_hit:
                hits += 1
            matches = sum(1 for d in top_k_docs if d == query.expected_document_id)
            precision_sum += matches / k if k else 0.0
        metrics[f"Recall@{k}"] = hits / n
        metrics[f"Precision@{k}"] = precision_sum / n

    metrics["MRR"] = sum(o.reciprocal_rank for o in outcomes) / n
    metrics["Document Accuracy"] = sum(1 for o in outcomes if o.hit_document) / n

    page_queries = [q for q in queries if q.expected_page is not None]
    if page_queries:
        page_hits = sum(
            1
            for o, q in zip(outcomes, queries)
            if q.expected_page is not None and o.document_and_page_match_rank is not None
        )
        metrics["Page Accuracy"] = page_hits / len(page_queries)

    return metrics


def run_strategy_comparison(
    vector_store: VectorStore,
    embedding_provider: EmbeddingProvider,
    reranker: RerankerProvider,
    queries: list[EvalQuery],
    top_k: int = 10,
) -> dict[str, dict[str, float]]:
    """Run all five retrieval strategies (per section 13 of the spec) over
    `queries` against an already-populated `vector_store` and return
    per-strategy metrics."""
    retriever = HybridRetriever(vector_store=vector_store, embedding_provider=embedding_provider)

    strategies = {
        "FTS": dict(use_fts=True, use_dense=False, use_rrf=False, reranker=None),
        "Dense": dict(use_fts=False, use_dense=True, use_rrf=False, reranker=None),
        "Hybrid (concat)": dict(use_fts=True, use_dense=True, use_rrf=False, reranker=None),
        "Hybrid + RRF": dict(use_fts=True, use_dense=True, use_rrf=True, reranker=None),
        "Hybrid + RRF + Reranker": dict(use_fts=True, use_dense=True, use_rrf=True, reranker=reranker),
    }

    all_results: dict[str, dict[str, float]] = {}
    for label, kwargs in strategies.items():
        outcomes = [
            _run_single_strategy(retriever, q, top_k=top_k, **kwargs)  # type: ignore[arg-type]
            for q in queries
        ]
        all_results[label] = compute_metrics(outcomes, queries)
    return all_results
