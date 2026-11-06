"""
MANDATORY Course and Classroom Isolation Tests.

Guarantees:
- Student in Course A CANNOT retrieve materials belonging to Course B.
- Student in Classroom A CANNOT retrieve materials specific to Classroom B.
- Semantic similarity across courses NEVER causes cross-course data leakage.
- Isolation is enforced at the storage/query level, not merely through prompts.
"""
from __future__ import annotations

import pytest

from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, ProcessingStatus, RetrievalScope
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore
from ai.tools.course_retrieval import CourseRetrievalTool


@pytest.fixture
def isolated_rag_service() -> RAGService:
    store = MemoryVectorStore()
    embeddings = MockEmbeddingProvider(dimension=512)
    service = RAGService(vector_store=store, embedding_provider=embeddings)

    # 1. Course A (Machine Learning 101) document
    doc_a = DocumentMetadata(
        document_id="doc_ml_01",
        university_id="stanford",
        course_id="course_ml_101",
        classroom_id="classroom_ml_A",
        filename="gradient_descent.pdf",
        processing_status=ProcessingStatus.STORED,
    )
    content_a = (
        "Gradient descent update formula: theta = theta - alpha * grad(J). "
        "The learning rate alpha determines the step size toward the local minimum."
    )
    chunk_a = DocumentChunk(
        chunk_id="chk_ml_01",
        university_id="stanford",
        course_id="course_ml_101",
        classroom_id="classroom_ml_A",
        document_id="doc_ml_01",
        title="Gradient Descent Lecture",
        page_number=1,
        section="Optimization",
        concepts=["gradient descent", "learning rate"],
        content_type=ContentType.FORMULA,
        content=content_a,
        embedding=embeddings.embed_documents([content_a])[0],
    )
    store.store_document(doc_a, [chunk_a])

    # 2. Course B (History 201) document
    doc_b = DocumentMetadata(
        document_id="doc_hist_01",
        university_id="stanford",
        course_id="course_hist_201",
        classroom_id="classroom_hist_B",
        filename="renaissance_art.pdf",
        processing_status=ProcessingStatus.STORED,
    )
    content_b = (
        "The Italian Renaissance was a period of cultural, artistic, and economic rebirth. "
        "Notable figures include Leonardo da Vinci and Michelangelo."
    )
    chunk_b = DocumentChunk(
        chunk_id="chk_hist_01",
        university_id="stanford",
        course_id="course_hist_201",
        classroom_id="classroom_hist_B",
        document_id="doc_hist_01",
        title="Renaissance Lecture",
        page_number=1,
        section="Italian Renaissance",
        concepts=["renaissance", "leonardo"],
        content_type=ContentType.EXPLANATION,
        content=content_b,
        embedding=embeddings.embed_documents([content_b])[0],
    )
    store.store_document(doc_b, [chunk_b])

    # 3. Course A, Classroom B (Same course, different classroom specific quiz note)
    doc_a_class_b = DocumentMetadata(
        document_id="doc_ml_class_b",
        university_id="stanford",
        course_id="course_ml_101",
        classroom_id="classroom_ml_B",
        filename="classroom_b_only_notes.pdf",
        processing_status=ProcessingStatus.STORED,
    )
    content_a_class_b = (
        "CONFIDENTIAL QUIZ HINT FOR CLASSROOM B ONLY: "
        "Remember that gradient descent step requires calculating partial derivatives."
    )
    chunk_a_class_b = DocumentChunk(
        chunk_id="chk_ml_b_01",
        university_id="stanford",
        course_id="course_ml_101",
        classroom_id="classroom_ml_B",
        document_id="doc_ml_class_b",
        title="Classroom B Special Notes",
        page_number=1,
        section="Quiz Secrets",
        concepts=["gradient descent", "partial derivatives"],
        content_type=ContentType.EXPLANATION,
        content=content_a_class_b,
        embedding=embeddings.embed_documents([content_a_class_b])[0],
    )
    store.store_document(doc_a_class_b, [chunk_a_class_b])

    return service


def test_student_in_course_a_never_retrieves_course_b(isolated_rag_service: RAGService):
    """Student querying in Course ML 101 must NEVER receive Course Hist 201 chunks."""
    results = isolated_rag_service.retrieve_course_material(
        course_id="course_ml_101",
        query="Tell me about Leonardo da Vinci and the Italian Renaissance",
        top_k=5,
    )

    for r in results:
        assert r.metadata["course_id"] == "course_ml_101"
        assert "Renaissance" not in r.content
        assert "da Vinci" not in r.content


def test_student_in_course_b_never_retrieves_course_a(isolated_rag_service: RAGService):
    """Student querying in Course Hist 201 must NEVER receive Course ML 101 chunks."""
    results = isolated_rag_service.retrieve_course_material(
        course_id="course_hist_201",
        query="What is the formula for gradient descent update with learning rate?",
        top_k=5,
    )

    for r in results:
        assert r.metadata["course_id"] == "course_hist_201"
        assert "theta" not in r.content
        assert "gradient descent" not in r.content


def test_student_in_classroom_a_never_retrieves_classroom_b_notes(
    isolated_rag_service: RAGService,
):
    """Student in classroom_ml_A must NOT receive documents tagged for classroom_ml_B."""
    results = isolated_rag_service.retrieve_course_material(
        course_id="course_ml_101",
        classroom_id="classroom_ml_A",
        query="partial derivatives and quiz secrets",
        top_k=5,
    )

    for r in results:
        assert r.metadata.get("classroom_id") in (None, "classroom_ml_A")
        assert "CONFIDENTIAL QUIZ HINT FOR CLASSROOM B" not in r.content


def test_course_retrieval_tool_strict_isolation_enforcement(
    isolated_rag_service: RAGService,
):
    """CourseRetrievalTool acts as secondary defense-in-depth."""
    tool = CourseRetrievalTool(
        retriever=isolated_rag_service.retrieve_course_material,
        strict_isolation=True,
    )

    # Empty course_id must raise ValueError immediately
    with pytest.raises(ValueError, match="course_id is required"):
        tool.retrieve(course_id="", query="test")

    # Scoped retrieval
    results = tool.retrieve(course_id="course_ml_101", query="gradient descent")
    assert len(results) > 0
    for r in results:
        assert r.metadata["course_id"] == "course_ml_101"


def test_student_in_university_a_never_retrieves_university_b(isolated_rag_service: RAGService):
    """University A must NEVER receive chunks belonging to University B, even with identical course IDs."""
    embeddings = MockEmbeddingProvider(dimension=512)
    doc_harvard = DocumentMetadata(
        document_id="doc_harvard_01",
        university_id="harvard",
        course_id="course_ml_101",
        classroom_id="classroom_ml_A",
        filename="harvard_notes.pdf",
        processing_status=ProcessingStatus.STORED,
    )
    content_harvard = "Harvard ML notes: advanced backpropagation techniques."
    chunk_harvard = DocumentChunk(
        chunk_id="chk_harvard_01",
        university_id="harvard",
        course_id="course_ml_101",
        classroom_id="classroom_ml_A",
        document_id="doc_harvard_01",
        title="Harvard Lecture",
        page_number=1,
        section="Backprop",
        concepts=["backpropagation"],
        content_type=ContentType.EXPLANATION,
        content=content_harvard,
        embedding=embeddings.embed_documents([content_harvard])[0],
    )
    isolated_rag_service.vector_store.store_document(doc_harvard, [chunk_harvard])

    results = isolated_rag_service.retrieve_course_material(
        university_id="stanford",
        course_id="course_ml_101",
        query="backpropagation techniques",
        top_k=5,
    )
    for r in results:
        assert r.metadata.get("university_id") == "stanford"
        assert "Harvard" not in r.content


def test_assignment_id_isolation_enforced(isolated_rag_service: RAGService):
    """Chunks explicitly assigned to Assignment 1 must not leak to Assignment 2."""
    embeddings = MockEmbeddingProvider(dimension=512)
    doc_asg1 = DocumentMetadata(
        document_id="doc_asg1",
        university_id="stanford",
        course_id="course_ml_101",
        assignment_ids=["asg_hw1"],
        filename="hw1_rubric.pdf",
        processing_status=ProcessingStatus.STORED,
    )
    content_asg1 = "Assignment 1 Rubric: Must implement vectorized gradient descent."
    chunk_asg1 = DocumentChunk(
        chunk_id="chk_asg1",
        university_id="stanford",
        course_id="course_ml_101",
        document_id="doc_asg1",
        assignment_ids=["asg_hw1"],
        title="HW1 Rubric",
        page_number=1,
        section="Rubric",
        concepts=["vectorized gradient descent"],
        content_type=ContentType.EXPLANATION,
        content=content_asg1,
        embedding=embeddings.embed_documents([content_asg1])[0],
    )
    isolated_rag_service.vector_store.store_document(doc_asg1, [chunk_asg1])

    # Retrieval for asg_hw2 should NOT return asg_hw1 rubric
    results = isolated_rag_service.retrieve_course_material(
        university_id="stanford",
        course_id="course_ml_101",
        assignment_id="asg_hw2",
        query="vectorized gradient descent rubric",
        top_k=5,
    )
    for r in results:
        assert "Assignment 1 Rubric" not in r.content


def test_allowed_document_ids_whitelist_isolation(isolated_rag_service: RAGService):
    """When allowed_document_ids is specified, only documents in the whitelist can be retrieved."""
    # Query with whitelist only allowing doc_ml_01
    results = isolated_rag_service.retrieve_course_material(
        university_id="stanford",
        course_id="course_ml_101",
        allowed_document_ids=["doc_ml_01"],
        query="gradient descent notes and secrets",
        top_k=5,
    )
    assert len(results) > 0
    for r in results:
        assert r.metadata["document_id"] == "doc_ml_01"
        assert r.metadata["document_id"] != "doc_ml_class_b"


def test_retrieval_scope_dataclass_execution(isolated_rag_service: RAGService):
    """Retrieval using trusted RetrievalScope object passes all pre-ranking filters."""
    scope = RetrievalScope(
        university_id="stanford",
        course_id="course_ml_101",
        classroom_id="classroom_ml_A",
        allowed_document_ids=("doc_ml_01",),
    )
    results = isolated_rag_service.retrieve_course_material(
        scope=scope,
        query="gradient descent learning rate",
        top_k=3,
    )
    assert len(results) > 0
    for r in results:
        assert r.metadata["university_id"] == "stanford"
        assert r.metadata["course_id"] == "course_ml_101"
        assert r.metadata["document_id"] == "doc_ml_01"

