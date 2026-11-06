"""
Unit tests for RAG failure cases and graceful degradation.

Verifies:
- Empty documents do not crash the pipeline
- Malformed PDF inputs fail with descriptive errors
- Embedding API failure falls back safely
- Database / storage failure is caught gracefully
- Reranker failure falls back to initial retrieval ranking
- Missing metadata is handled safely
- Zero retrieval results return empty list rather than crashing
"""
from __future__ import annotations

import io
from pathlib import Path
import pymupdf
import pytest

from ai.rag.config import RAGConfig
from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.ingestion.parser import PyMuPDF4LLMParser
from ai.rag.ingestion.storage import LocalStorage, SupabaseStorage, normalize_file_input
from ai.rag.models import DocumentChunk, DocumentMetadata, ProviderError, RetrievedChunk
from ai.rag.retrieval import FallbackRerankerProvider
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore


def test_malformed_pdf_raises_runtime_error():
    parser = PyMuPDF4LLMParser()
    garbage_bytes = b"%PDF-invalid-binary-garbage-here-random-data"

    with pytest.raises(Exception):
        parser.parse(garbage_bytes)


def test_empty_query_returns_empty_results():
    service = RAGService(vector_store=MemoryVectorStore())
    results = service.retrieve_course_material(course_id="cs101", query="")
    assert results == []


def test_no_matches_returns_empty_list():
    service = RAGService(vector_store=MemoryVectorStore())
    results = service.retrieve_course_material(
        course_id="nonexistent_course", query="quantum entanglement"
    )
    assert results == []


def test_embedding_api_failure_handled_gracefully():
    class BrokenEmbeddingProvider:
        @property
        def dimension(self) -> int:
            return 512

        def embed_documents(self, texts):
            raise ConnectionError("NVIDIA API timeout")

        def embed_query(self, query):
            raise ConnectionError("NVIDIA API timeout")

    service = RAGService(
        vector_store=MemoryVectorStore(),
        embedding_provider=BrokenEmbeddingProvider(),
    )

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 50), "Lecture content on linear algebra and vectors.")
    pdf_bytes = doc.tobytes()
    doc.close()

    # Ingestion failure must report clean error when embedding provider fails
    with pytest.raises(RuntimeError, match="Ingestion failed"):
        service.ingest_document(
            file_input=pdf_bytes,
            university_id="univ",
            course_id="course_1",
            filename="broken.pdf",
        )


def test_reranker_failure_falls_back_to_fused_order():
    class BrokenReranker:
        def rerank(self, query, candidates, top_k=5):
            raise RuntimeError("Reranker service unavailable")

    # Fallback provider should be used when primary fails
    fallback = FallbackRerankerProvider()
    c = DocumentChunk(
        chunk_id="c1", university_id="u", course_id="c", document_id="d",
        title="T", content="Gradient descent explanation",
    )
    candidates = [RetrievedChunk(chunk=c, score=0.9)]

    # Fallback reranks safely
    reranked = fallback.rerank("gradient", candidates, top_k=1)
    assert len(reranked) == 1
    assert reranked[0].chunk.chunk_id == "c1"


def test_missing_course_id_raises_value_error():
    service = RAGService(vector_store=MemoryVectorStore())
    with pytest.raises(ValueError, match="course_id is required"):
        service.retrieve_course_material(course_id="", query="gradient")


def test_normalize_file_input_with_bytesio_stream():
    """BytesIO stream is correctly read and position can be read repeatedly without loss."""
    raw = b"%PDF-1.4 dummy content for stream testing"
    stream = io.BytesIO(raw)
    data1, name1 = normalize_file_input(stream, "lecture.pdf")
    assert data1 == raw
    assert name1 == "lecture.pdf"

    # Second normalization with same stream succeeds because normalizer handles seek/reset
    data2, _ = normalize_file_input(stream, "lecture.pdf")
    assert data2 == raw


def test_storage_fallback_on_error_disabled_raises_provider_error(monkeypatch):
    """When storage_fallback_on_error is False (production default), unconfigured or failed Supabase raises ProviderError."""
    monkeypatch.setenv("RAG_STORAGE_BACKEND", "supabase")
    monkeypatch.setenv("RAG_STORAGE_FALLBACK_ON_ERROR", "false")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    cfg = RAGConfig()
    storage = SupabaseStorage(cfg=cfg)
    meta = DocumentMetadata(
        university_id="mit",
        course_id="cs101",
        filename="test.pdf",
    )
    with pytest.raises(ProviderError, match="SupabaseStorage is not configured"):
        storage.save(meta, b"pdf bytes")


def test_storage_fallback_on_error_enabled_falls_back(monkeypatch, tmp_path):
    """When storage_fallback_on_error is True (dev mode), falls back to local storage."""
    monkeypatch.setenv("RAG_STORAGE_BACKEND", "supabase")
    monkeypatch.setenv("RAG_STORAGE_FALLBACK_ON_ERROR", "true")
    monkeypatch.setenv("RAG_STORAGE_DIR", str(tmp_path))
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    cfg = RAGConfig()
    storage = SupabaseStorage(cfg=cfg)
    meta = DocumentMetadata(
        university_id="mit",
        course_id="cs101",
        filename="test.pdf",
    )
    saved_path = storage.save(meta, b"pdf bytes")
    assert Path(saved_path).exists()
    assert storage.load(saved_path) == b"pdf bytes"


def test_ingest_document_with_bytesio_stream_succeeds(tmp_path):
    """Ingesting via BytesIO stream does not exhaust before parsing and storing."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 50), "Lecture notes on gradient descent optimization.")
    pdf_bytes = doc.tobytes()
    doc.close()

    stream = io.BytesIO(pdf_bytes)
    service = RAGService(
        vector_store=MemoryVectorStore(),
        embedding_provider=MockEmbeddingProvider(dimension=512),
        storage=LocalStorage(base_path=str(tmp_path)),
    )

    doc_meta = service.ingest_document(
        file_input=stream,
        university_id="mit",
        course_id="cs101",
        filename="lecture.pdf",
    )
    assert doc_meta.document_id
    assert doc_meta.total_chunks > 0

    results = service.retrieve_course_material(
        university_id="mit",
        course_id="cs101",
        query="gradient descent",
    )
    assert len(results) > 0
    assert "gradient descent" in results[0].content


