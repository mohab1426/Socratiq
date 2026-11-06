"""
Unit tests for hybrid retrieval, RRF fusion, and reranking.

Verifies:
- Dense retrieval returns semantically relevant chunks
- FTS returns exact keyword/acronym matches
- RRF correctly fuses rankings from dense and FTS lists
- Reranker respects top_k and prioritizes most relevant chunks
"""
from __future__ import annotations

import pytest

from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, ProcessingStatus, RetrievedChunk
from ai.rag.retrieval import FallbackRerankerProvider, compute_rrf_fusion
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore


@pytest.fixture
def populated_rag_service() -> RAGService:
    store = MemoryVectorStore()
    embeddings = MockEmbeddingProvider(dimension=512)
    reranker = FallbackRerankerProvider()
    service = RAGService(vector_store=store, embedding_provider=embeddings, reranker=reranker)

    doc = DocumentMetadata(
        document_id="doc_opt_01",
        university_id="stanford",
        course_id="cs_opt",
        filename="optimization.pdf",
        processing_status=ProcessingStatus.STORED,
    )

    chunks = [
        DocumentChunk(
            chunk_id="chk_1",
            university_id="stanford",
            course_id="cs_opt",
            document_id="doc_opt_01",
            title="Optimization Notes",
            page_number=1,
            section="Gradient Descent",
            concepts=["gradient descent", "learning rate"],
            content_type=ContentType.FORMULA,
            content="Gradient descent updates theta: theta = theta - lr * grad. It uses the gradient vector.",
        ),
        DocumentChunk(
            chunk_id="chk_2",
            university_id="stanford",
            course_id="cs_opt",
            document_id="doc_opt_01",
            title="Optimization Notes",
            page_number=2,
            section="Adam Optimizer",
            concepts=["adam", "adaptive moments"],
            content_type=ContentType.EXPLANATION,
            content="Adam optimizer computes adaptive learning rates using first and second moments of gradients.",
        ),
        DocumentChunk(
            chunk_id="chk_3",
            university_id="stanford",
            course_id="cs_opt",
            document_id="doc_opt_01",
            title="Optimization Notes",
            page_number=3,
            section="Newton-Raphson",
            concepts=["newton raphson", "hessian"],
            content_type=ContentType.EXPLANATION,
            content="Newton-Raphson is a second-order optimization method requiring calculation of the Hessian matrix.",
        ),
    ]

    for c in chunks:
        c.embedding = embeddings.embed_documents([c.content])[0]

    store.store_document(doc, chunks)
    return service


def test_dense_search(populated_rag_service: RAGService):
    results = populated_rag_service.search_dense(
        course_id="cs_opt",
        query="first order gradient descent",
        top_k=2,
    )
    assert len(results) <= 2
    assert results[0].dense_score is not None


def test_fts_search_exact_keyword(populated_rag_service: RAGService):
    results = populated_rag_service.search_fts(
        course_id="cs_opt",
        query="Hessian Newton-Raphson",
        top_k=2,
    )
    assert len(results) > 0
    top_chunk = results[0].chunk
    assert "Newton-Raphson" in top_chunk.section or "Hessian" in top_chunk.content


def test_rrf_fusion_combines_ranks():
    c1 = DocumentChunk(
        chunk_id="c1", university_id="u", course_id="c", document_id="d",
        title="T", content="C1",
    )
    c2 = DocumentChunk(
        chunk_id="c2", university_id="u", course_id="c", document_id="d",
        title="T", content="C2",
    )
    c3 = DocumentChunk(
        chunk_id="c3", university_id="u", course_id="c", document_id="d",
        title="T", content="C3",
    )

    dense_list = [
        RetrievedChunk(chunk=c1, score=0.9, dense_score=0.9),
        RetrievedChunk(chunk=c2, score=0.8, dense_score=0.8),
    ]
    fts_list = [
        RetrievedChunk(chunk=c2, score=10.0, fts_score=10.0),
        RetrievedChunk(chunk=c3, score=5.0, fts_score=5.0),
    ]

    fused = compute_rrf_fusion(dense_list, fts_list, rrf_k=60)

    assert len(fused) == 3
    # c2 appeared in both lists (rank 2 in dense, rank 1 in fts) -> highest RRF score: 1/(60+2) + 1/(60+1)
    # c1 appeared in dense rank 1: 1/(60+1)
    # c2 score: (1/62) + (1/61) = 0.0161 + 0.0163 = 0.0325
    # c1 score: 1/61 = 0.0163
    assert fused[0].chunk.chunk_id == "c2"
    assert fused[0].rrf_score is not None
    assert fused[0].score > fused[1].score


def test_reranker_top_k_limits(populated_rag_service: RAGService):
    results = populated_rag_service.retrieve_course_material(
        course_id="cs_opt",
        query="Adam adaptive learning rate",
        top_k=1,
    )
    assert len(results) == 1
    assert "Adam" in results[0].content
