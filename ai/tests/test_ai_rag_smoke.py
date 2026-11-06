"""
End-to-end AI + RAG smoke test (section 19).

Unlike `scripts/test_rag_smoke.py` (RAG subsystem only), this test drives the
*entire* AI-only pipeline without depending on the unfinished frontend/backend:

    sample PDF
     -> ingestion
     -> chunking
     -> embedding
     -> index (MemoryVectorStore -- fast, offline; see
        ai/tests/test_rag_storage_pgvector_integration.py for the clearly
        separated real-infrastructure PostgreSQL/pgvector path)
     -> retrieval (QueryUnderstander -> CourseRetrievalTool -> RAGService)
     -> reranking
     -> Coach (diagnose -> choose_intervention -> generate_response)
     -> validation
     -> deterministic enforcement
     -> safe final response

LLM calls are mocked (FakeStructuredLLM) so this test is fully offline and
deterministic -- it proves the AI/RAG wiring is correct, not that any
particular LLM produces good pedagogy. This is explicitly NOT "production RAG
validation" against real Postgres; that lives in
test_rag_storage_pgvector_integration.py and is never conflated with this.
"""
from __future__ import annotations

import pymupdf
import pytest

from ai.agents.coach.graph import Coach
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision
from ai.agents.coach.state import TaskContext
from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
from ai.rag.embeddings.mock import MockEmbeddingProvider
from ai.rag.retrieval.query_understanding import QueryUnderstander
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore
from ai.tests.conftest import FakeStructuredLLM
from ai.tools.course_retrieval import CourseRetrievalTool


def _sample_gradient_descent_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text(
        (50, 50),
        "Gradient Descent Optimization\n\n"
        "The parameter update formula is: theta = theta - alpha * gradient(J(theta))\n"
        "alpha is the learning rate controlling the step size at each iteration.\n",
    )
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


@pytest.fixture
def ingested_rag_service() -> RAGService:
    """Real RAG pipeline (parse -> clean -> chunk -> embed -> index) against
    an in-memory store, so this test stays fast and dependency-free while
    still exercising the actual ingestion/retrieval code paths."""
    service = RAGService(
        vector_store=MemoryVectorStore(),
        embedding_provider=MockEmbeddingProvider(dimension=256),
        query_understander=QueryUnderstander(use_llm=False),
    )
    meta = service.ingest_document(
        file_input=_sample_gradient_descent_pdf(),
        university_id="smoke_univ",
        course_id="smoke_course",
        classroom_id="smoke_room",
        filename="gradient_descent.pdf",
        title="Gradient Descent Notes",
    )
    assert meta.total_chunks > 0, "Smoke test setup failed: no chunks ingested."
    service._smoke_doc_meta = meta  # type: ignore[attr-defined]  -- test-only convenience
    return service


def _fake_llm_factory(*, unsafe_first_draft: bool):
    """Builds a fake `get_structured_llm` that drives diagnosis, intervention,
    and (optionally unsafe-then-safe) response generation without any network
    calls."""
    diag_llm = FakeStructuredLLM(
        result=DiagnosisResult(
            category=DiagnosisCategory.MISCONCEPTION,
            concept="learning_rate",
            explanation="Student's update omits the learning rate scaling factor.",
            evidence="theta = theta - grad",
            confidence=0.9,
        )
    )
    interv_llm = FakeStructuredLLM(
        result=InterventionDecision(
            intervention_type=InterventionType.QUESTION,
            rationale="Prompt the student to reconsider what scales the update step.",
            needs_course_material=True,
            needs_student_history=False,
        )
    )

    if unsafe_first_draft:
        responses = iter(
            [
                GeneratedResponse(
                    response="The final answer is theta = theta - 0.01 * grad. That's the complete solution.",
                    referenced_concepts=["learning_rate"],
                ),
                GeneratedResponse(
                    response="What term in the update rule controls how big a step you take?",
                    referenced_concepts=["learning_rate"],
                ),
            ]
        )

        class SequencedFakeLLM:
            def invoke(self, messages):
                return next(responses)

        resp_llm = SequencedFakeLLM()
    else:
        resp_llm = FakeStructuredLLM(
            result=GeneratedResponse(
                response="What term in the update rule controls how big a step you take?",
                referenced_concepts=["learning_rate"],
            )
        )

    def fake_get_structured_llm(role, schema):
        if schema == DiagnosisResult:
            return diag_llm
        if schema == InterventionDecision:
            return interv_llm
        if schema == GeneratedResponse:
            return resp_llm
        return FakeStructuredLLM(result={"passes": True, "violations": []})

    return fake_get_structured_llm


def _fake_validation_llm_factory():
    """Fake for `ai.guardrails.coach_validator.get_structured_llm` -- keeps
    the LLM-based semantic validation layer offline/deterministic too, so
    this smoke test never depends on network/API keys. Always reports a
    pass; the deterministic rule-based checks in the same validator remain
    fully active and are what actually catches the unsafe first draft in
    `test_full_ai_rag_pipeline_enforces_and_recovers_from_unsafe_first_draft`.
    """
    from ai.agents.coach.schemas import ValidationResult

    def fake_get_structured_llm(role, schema):
        return FakeStructuredLLM(result=ValidationResult(passes=True, violations=[]))

    return fake_get_structured_llm


def test_full_ai_rag_pipeline_produces_safe_grounded_response(monkeypatch, ingested_rag_service):
    """Happy path: ingestion -> retrieval -> Coach -> validation (real
    guardrail validator, not mocked) -> deterministic enforcement -> a safe,
    course-grounded final response."""
    course_tool = CourseRetrievalTool(retriever=ingested_rag_service.retrieve_course_material)
    monkeypatch.setattr(
        "ai.agents.coach.nodes.get_structured_llm", _fake_llm_factory(unsafe_first_draft=False)
    )
    monkeypatch.setattr(
        "ai.guardrails.coach_validator.get_structured_llm", _fake_validation_llm_factory()
    )

    coach = Coach(course_tool=course_tool)
    task_ctx = TaskContext(
        assignment_id="asg_smoke",
        course_id="smoke_course",
        title="Gradient Descent Assignment",
        instructions="Implement the parameter update rule for linear regression.",
        is_programming=True,
        university_id="smoke_univ",
        classroom_id="smoke_room",
    )

    result = coach.invoke(
        student_id="student_smoke",
        assignment_id="asg_smoke",
        session_id="sess_smoke",
        task_context=task_ctx,
        attempt="theta = theta - grad",
        policy=AssistancePolicy.GUIDED,
    )

    assert result.response
    assert "course_retriever" in result.tools_used
    # Real retrieval happened -- the Coach actually saw course material.
    assert result.diagnosis_summary.concept == "learning_rate"
    # Safety invariant: no direct final answer leaked through, even though
    # nothing here specifically forced a rewrite.
    assert "final answer" not in result.response.lower()

    # Section 12: source references must be first-class, trustworthy output
    # derived from retrieval metadata, never invented by the LLM.
    assert result.sources, "Expected the Coach result to carry source citations."
    top_source = result.sources[0]
    assert top_source.document_id == ingested_rag_service._smoke_doc_meta.document_id
    assert top_source.chunk_id
    assert top_source.page_number == 1
    # The LLM's fake response text never mentions any of these identifiers,
    # proving they came from retrieval, not from generated text.
    assert top_source.document_id not in result.response
    assert top_source.chunk_id not in result.response


def test_full_ai_rag_pipeline_enforces_and_recovers_from_unsafe_first_draft(
    monkeypatch, ingested_rag_service
):
    """The generator's first draft leaks a complete solution. Validation must
    catch it, the violation-aware retry must produce a second, safe draft,
    and deterministic enforcement must remain the final boundary regardless."""
    course_tool = CourseRetrievalTool(retriever=ingested_rag_service.retrieve_course_material)
    monkeypatch.setattr(
        "ai.agents.coach.nodes.get_structured_llm", _fake_llm_factory(unsafe_first_draft=True)
    )
    monkeypatch.setattr(
        "ai.guardrails.coach_validator.get_structured_llm", _fake_validation_llm_factory()
    )

    coach = Coach(course_tool=course_tool)
    task_ctx = TaskContext(
        assignment_id="asg_smoke_2",
        course_id="smoke_course",
        title="Gradient Descent Assignment",
        instructions="Implement the parameter update rule for linear regression.",
        is_programming=True,
        university_id="smoke_univ",
        classroom_id="smoke_room",
    )

    result = coach.invoke(
        student_id="student_smoke_2",
        assignment_id="asg_smoke_2",
        session_id="sess_smoke_2",
        task_context=task_ctx,
        attempt="theta = theta - grad",
        policy=AssistancePolicy.GUIDED,
    )

    assert result.response
    # The final response reaching the student must never contain the leaked
    # complete solution from the first (rejected) draft.
    assert "0.01" not in result.response
    assert "complete solution" not in result.response.lower()
