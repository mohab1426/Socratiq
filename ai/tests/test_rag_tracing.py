"""
Unit tests for LangSmith tracing instrumentation across RAG retrieval and ingestion paths.

Verifies:
- Ingestion spans (parse, clean, chunk, embed, ingest) execute cleanly.
- Retrieval spans (dense, fts, rrf_fusion, retrieve) execute cleanly.
- rag_traceable provides a transparent wrapper with zero side effects.
"""
from __future__ import annotations

from unittest.mock import MagicMock
import pymupdf
import pytest

from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.ingestion.storage import LocalFileStorage
from ai.rag.models import ProcessingStatus
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore
from ai.rag.tracing import rag_traceable


def test_rag_traceable_decorator_execution():
    @rag_traceable(name="test.span", run_type="tool")
    def sample_func(x: int, y: int) -> int:
        return x + y

    assert sample_func(3, 4) == 7


def test_tracing_instrumented_ingestion_and_retrieval(tmp_path):
    storage = LocalFileStorage(base_dir=str(tmp_path))
    vector_store = MemoryVectorStore()
    embedding_provider = MockEmbeddingProvider(dimension=256)

    service = RAGService(
        vector_store=vector_store,
        embedding_provider=embedding_provider,
        storage=storage,
    )

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_textbox(
        pymupdf.Rect(50, 50, 500, 500),
        "# Machine Learning\n\nGradient descent minimizes loss function theta = theta - alpha * grad.",
    )
    pdf_bytes = doc.tobytes()
    doc.close()

    # Ingestion executes through @rag_traceable spans
    meta = service.ingest_document(
        file_input=pdf_bytes,
        university_id="stanford",
        course_id="cs101",
        filename="lecture.pdf",
    )
    assert meta.processing_status == ProcessingStatus.STORED

    # Retrieval executes through @rag_traceable spans (dense, fts, rrf, retrieve)
    results = service.retrieve_course_material(
        course_id="cs101",
        query="gradient descent parameter update",
        top_k=2,
    )
    assert len(results) > 0
    assert results[0].metadata["course_id"] == "cs101"

    # Raw dense and FTS spans
    dense_res = service.search_dense(course_id="cs101", query="gradient", top_k=2)
    assert len(dense_res) > 0

    fts_res = service.search_fts(course_id="cs101", query="gradient", top_k=2)
    assert len(fts_res) > 0
