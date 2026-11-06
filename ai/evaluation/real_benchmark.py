"""
Real-PDF retrieval-quality benchmark harness.

Unlike `ai/evaluation/fixtures/ci_smoke_dataset.py` (a small, hand-written
fixture whose only job is proving the framework's plumbing works), this
module is meant to be pointed at real course PDFs and independently
authored held-out queries with real ground truth, to actually measure
retrieval quality per section 13 of the spec.

This repo does not ship real course PDFs or a real query/ground-truth set
(none existed prior to this rebuild, and fabricating "real-looking" ones
would just reintroduce a milder version of the self-referential problem
this rebuild fixes). What it ships instead is this harness plus the JSON
schema it expects, so real PDFs can be dropped in later without writing any
new evaluation code:

    queries.json:
    [
      {
        "query_id": "q1",
        "query": "<a real, independently-written student question -- must
                   NOT be copy-pasted from the source PDF>",
        "course_id": "...",
        "classroom_id": "...",
        "expected_document_id": "<must match a document_id used when
                                  ingesting the corresponding PDF>",
        "expected_page": 12,
        "expected_section": "3.2 Regularization",
        "tag": "paraphrase"
      },
      ...
    ]

Documents are ingested through the real ingestion pipeline
(`ai.rag.ingestion.DocumentParser` -> `DocumentCleaner` ->
`ai.rag.chunking.StructureAwareChunker`), not hand-written `EvalChunk`
objects -- so this harness exercises the exact same parsing/chunking code
production ingestion uses, not a shortcut.

Usage (once real PDFs + queries.json exist, e.g. under a
`fixtures/real_corpus/` directory you create locally -- not committed to
this repo without institutional permission to redistribute the PDFs):

    from ai.evaluation.real_benchmark import run_real_pdf_benchmark
    results = run_real_pdf_benchmark(
        pdf_paths=[("doc_1", "univ_x", "course_x", "room_x", Path("lecture1.pdf")), ...],
        queries_json_path=Path("queries.json"),
    )
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from ai.evaluation.framework import (
    EvalChunk,
    EvalDocument,
    EvalQuery,
    load_documents_into_store,
    run_strategy_comparison,
    validate_no_leakage,
)
from ai.rag.chunking import StructureAwareChunker
from ai.rag.embeddings.base import EmbeddingProvider
from ai.rag.ingestion import DocumentCleaner, PyMuPDF4LLMParser
from ai.rag.models import DocumentMetadata, ProcessingStatus
from ai.rag.retrieval.reranker import RerankerProvider
from ai.rag.storage.base import VectorStore

logger = logging.getLogger(__name__)


def _ingest_pdf_as_eval_document(
    document_id: str,
    university_id: str,
    course_id: str,
    classroom_id: Optional[str],
    pdf_path: Path,
) -> EvalDocument:
    """Parse and chunk a real PDF via the production ingestion pipeline
    (`PyMuPDF4LLMParser` -> `DocumentCleaner` -> `StructureAwareChunker`,
    the same path `ai/rag/service.py`'s ingestion uses) and wrap the result
    as an `EvalDocument` for the evaluation framework. Embeddings are
    intentionally NOT computed here -- `load_documents_into_store` does
    that, using whichever `EmbeddingProvider` the caller configured."""
    parser = PyMuPDF4LLMParser()
    cleaner = DocumentCleaner()
    chunker = StructureAwareChunker()

    parsed = parser.parse(str(pdf_path), title=pdf_path.stem)
    cleaned = cleaner.clean_document(parsed)

    placeholder_metadata = DocumentMetadata(
        document_id=document_id,
        university_id=university_id,
        course_id=course_id,
        classroom_id=classroom_id,
        filename=pdf_path.name,
        file_type="pdf",
        processing_status=ProcessingStatus.STORED,
    )
    real_chunks = chunker.chunk_document(cleaned, placeholder_metadata)

    eval_chunks = [
        EvalChunk(
            page_number=c.page_number,
            section=c.section,
            subsection=c.subsection,
            concepts=list(c.concepts),
            content_type=c.content_type,
            content=c.content,
        )
        for c in real_chunks
    ]
    return EvalDocument(
        document_id=document_id,
        filename=pdf_path.name,
        university_id=university_id,
        course_id=course_id,
        classroom_id=classroom_id,
        chunks=eval_chunks,
    )


def load_queries_from_json(path: Path) -> list[EvalQuery]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [
        EvalQuery(
            query_id=item["query_id"],
            query=item["query"],
            course_id=item["course_id"],
            classroom_id=item.get("classroom_id"),
            expected_document_id=item["expected_document_id"],
            expected_page=item.get("expected_page"),
            expected_section=item.get("expected_section"),
            tag=item.get("tag", ""),
        )
        for item in data
    ]


def run_real_pdf_benchmark(
    pdf_paths: list[tuple[str, str, str, Optional[str], Path]],
    queries_json_path: Path,
    vector_store: VectorStore,
    embedding_provider: EmbeddingProvider,
    reranker: RerankerProvider,
    top_k: int = 10,
) -> dict[str, dict[str, float]]:
    """Ingest real PDFs, load held-out queries with real ground truth, and
    run the five-strategy comparison against them.

    `pdf_paths` is a list of (document_id, university_id, course_id,
    classroom_id, pdf_path) tuples -- the caller supplies real
    university-approved course PDFs; none ship in this repo.
    """
    documents = [
        _ingest_pdf_as_eval_document(doc_id, uni_id, course_id, room_id, path)
        for (doc_id, uni_id, course_id, room_id, path) in pdf_paths
    ]
    queries = load_queries_from_json(queries_json_path)

    validate_no_leakage(documents, queries)
    load_documents_into_store(vector_store, embedding_provider, documents)

    return run_strategy_comparison(
        vector_store=vector_store,
        embedding_provider=embedding_provider,
        reranker=reranker,
        queries=queries,
        top_k=top_k,
    )
