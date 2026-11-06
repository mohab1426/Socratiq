"""
Unit tests for structured source references.

Verifies:
- Every retrieved chunk retains verifiable citation metadata
- `document_id`, `page_number`, `section`, and `chunk_id` are always present
- Source citations match the underlying document accurately
"""
from __future__ import annotations

import pytest

from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, ProcessingStatus
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore


def test_retrieval_returns_valid_source_references():
    store = MemoryVectorStore()
    embeddings = MockEmbeddingProvider(dimension=512)
    service = RAGService(vector_store=store, embedding_provider=embeddings)

    doc = DocumentMetadata(
        document_id="doc_linear_alg",
        university_id="mit",
        course_id="18.06",
        filename="lecture_04_eigenvalues.pdf",
        processing_status=ProcessingStatus.STORED,
    )

    chunk = DocumentChunk(
        chunk_id="chk_eigen_01",
        university_id="mit",
        course_id="18.06",
        document_id="doc_linear_alg",
        title="lecture_04_eigenvalues.pdf",
        page_number=14,
        section="Characteristic Equation",
        subsection="Finding Eigenvalues",
        concepts=["eigenvalues", "determinant", "characteristic polynomial"],
        content_type=ContentType.FORMULA,
        content="The characteristic polynomial is det(A - lambda * I) = 0.",
        embedding=embeddings.embed_documents(["The characteristic polynomial is det(A - lambda * I) = 0."])[0],
    )
    store.store_document(doc, [chunk])

    results = service.retrieve_course_material(
        course_id="18.06",
        query="characteristic polynomial determinant",
        top_k=1,
    )

    assert len(results) == 1
    res = results[0]

    # Check top-level citation string
    assert "lecture_04_eigenvalues.pdf" in res.source
    assert "14" in res.source
    assert "Characteristic Equation" in res.source

    # Check rich metadata dictionary
    meta = res.metadata
    assert meta["chunk_id"] == "chk_eigen_01"
    assert meta["document_id"] == "doc_linear_alg"
    assert meta["page_number"] == 14
    assert meta["section"] == "Characteristic Equation"
    assert meta["subsection"] == "Finding Eigenvalues"
    assert "eigenvalues" in meta["concepts"]

    # Check structured source reference object
    ref = meta.get("source_reference")
    assert ref is not None
    assert ref["document_id"] == "doc_linear_alg"
    assert ref["page_number"] == 14
    assert ref["section"] == "Characteristic Equation"
    assert ref["chunk_id"] == "chk_eigen_01"
