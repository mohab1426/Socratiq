"""
Regression tests for document ingestion idempotency and rollback on corrupt files.

Verifies:
- Ingesting a truncated or corrupt PDF raises a clean failure.
- No partial or corrupted files are left on disk in storage when ingestion fails.
- Ingesting the exact same document bytes multiple times is idempotent (returns
  existing DocumentMetadata and does not duplicate files or vector store chunks).
"""
from __future__ import annotations

from pathlib import Path
import pymupdf
import pytest

from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.ingestion.storage import LocalFileStorage
from ai.rag.models import ProcessingStatus
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore


def test_corrupt_pdf_clean_failure_no_partial_file_left(tmp_path):
    storage = LocalFileStorage(base_dir=str(tmp_path))
    vector_store = MemoryVectorStore()
    embedding_provider = MockEmbeddingProvider(dimension=256)

    service = RAGService(
        vector_store=vector_store,
        embedding_provider=embedding_provider,
        storage=storage,
    )

    # Corrupt / truncated PDF content (like doc_d7e1d020461c_broken.pdf)
    corrupted_bytes = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"

    with pytest.raises(RuntimeError, match="Ingestion failed"):
        service.ingest_document(
            file_input=corrupted_bytes,
            university_id="test_univ",
            course_id="test_course",
            classroom_id="test_classroom",
            filename="corrupt_document.pdf",
        )

    # Verify no partial or broken file was left in the storage directory
    saved_files = list(tmp_path.rglob("*.pdf"))
    assert len(saved_files) == 0, f"Expected 0 files on disk after failure, but found: {saved_files}"


def test_truncated_garbage_bytes_clean_failure_no_partial_file(tmp_path):
    storage = LocalFileStorage(base_dir=str(tmp_path))
    vector_store = MemoryVectorStore()

    service = RAGService(
        vector_store=vector_store,
        storage=storage,
    )

    garbage_bytes = b"%PDF-truncated-garbage-bytes-12345"

    with pytest.raises(RuntimeError, match="Ingestion failed"):
        service.ingest_document(
            file_input=garbage_bytes,
            university_id="test_univ",
            course_id="test_course",
            filename="garbage.pdf",
        )

    saved_files = list(tmp_path.rglob("*.pdf"))
    assert len(saved_files) == 0, f"Expected 0 files left on disk, found: {saved_files}"


def test_ingestion_idempotency_by_content_hash(tmp_path):
    storage = LocalFileStorage(base_dir=str(tmp_path))
    vector_store = MemoryVectorStore()
    embedding_provider = MockEmbeddingProvider(dimension=256)

    service = RAGService(
        vector_store=vector_store,
        embedding_provider=embedding_provider,
        storage=storage,
    )

    # Create a valid test PDF
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 50), "# Lecture 1\n\nGradient descent minimizes loss function iteratively.")
    pdf_bytes = doc.tobytes()
    doc.close()

    # 1. First ingestion
    meta1 = service.ingest_document(
        file_input=pdf_bytes,
        university_id="stanford",
        course_id="cs101",
        classroom_id="room_a",
        filename="lecture_1.pdf",
    )
    assert meta1.processing_status == ProcessingStatus.STORED
    initial_doc_id = meta1.document_id
    initial_chunks = vector_store.count_chunks(course_id="cs101")
    assert initial_chunks > 0

    saved_files_run1 = list(tmp_path.rglob("*.pdf"))
    assert len(saved_files_run1) == 1

    # 2. Re-ingest exact same content
    meta2 = service.ingest_document(
        file_input=pdf_bytes,
        university_id="stanford",
        course_id="cs101",
        classroom_id="room_a",
        filename="lecture_1.pdf",
    )

    # Idempotency checks:
    # Must return existing document identity and not duplicate chunks or files
    assert meta2.document_id == initial_doc_id
    assert meta2.content_hash == meta1.content_hash
    assert vector_store.count_chunks(course_id="cs101") == initial_chunks

    saved_files_run2 = list(tmp_path.rglob("*.pdf"))
    assert len(saved_files_run2) == 1
