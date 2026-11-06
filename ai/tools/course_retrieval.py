"""
Course-material retrieval tool.

The AI Coach only depends on this thin interface; the actual RAG pipeline
(ingestion/chunking/embeddings/vector DB -- see ai/rag/) is owned and
implemented separately and plugged in here via the `retriever` callable.

Multi-tenant isolation is critical: this tool enforces defense-in-depth isolation
across university_id, course_id, classroom_id, assignment_id, and allowed_document_ids.
"""
from __future__ import annotations

from typing import Callable, Optional, Protocol

from ai.models.schemas import RetrievedContext
from ai.rag.models import RetrievalScope
from ai.rag.security import sanitize_untrusted_text


class CourseRetriever(Protocol):
    def __call__(self, course_id: str, query: str, top_k: int = 4) -> list[RetrievedContext]:
        ...


def _default_rag_retriever(
    course_id: str,
    query: str,
    top_k: int = 4,
    student_context: Optional[dict] = None,
) -> list[RetrievedContext]:
    """Connects to the RAG service to retrieve grounded course materials."""
    try:
        from ai.rag.service import get_rag_service
        return get_rag_service().retrieve_course_material(
            course_id=course_id, query=query, top_k=top_k, student_context=student_context
        )
    except Exception as exc:
        raise CourseRetrievalError(f"RAG service retrieval error: {exc}") from exc


def _fallback_retriever(course_id: str, query: str, top_k: int = 4) -> list[RetrievedContext]:
    """Used when a dummy/empty retriever is explicitly required."""
    return []


class CourseRetrievalError(RuntimeError):
    """Raised when the underlying retriever fails."""


class CourseRetrievalTool:
    """Injectable wrapper so tests/dev can supply a fake retriever, and the
    real RAG module can be plugged in without touching the Coach graph.

    Multi-tenant isolation is critical: this tool must never return material tagged
    with a different course, classroom, or unauthorized document than the one requested.
    """

    name = "course_retriever"

    def __init__(
        self,
        retriever: Optional[CourseRetriever] = None,
        strict_isolation: bool = True,
    ):
        self._retriever: CourseRetriever = retriever if retriever is not None else _default_rag_retriever
        self.strict_isolation = strict_isolation

    def retrieve(
        self,
        course_id: str,
        query: str,
        top_k: int = 4,
        student_context: Optional[dict] = None,
    ) -> list[RetrievedContext]:
        if not course_id or not course_id.strip():
            raise ValueError("course_id is required for course-scoped retrieval.")
        try:
            try:
                results = self._retriever(course_id, query, top_k, student_context=student_context)
            except TypeError:
                # Injected retriever (fake/legacy) doesn't accept student_context.
                results = self._retriever(course_id, query, top_k)
        except Exception as exc:  # tool failures must not crash the graph
            raise CourseRetrievalError(str(exc)) from exc

        filtered = []
        for r in results:
            metadata = r.metadata if isinstance(r.metadata, dict) else {}
            chunk_course = metadata.get("course_id")
            matches = (chunk_course == course_id) if self.strict_isolation else (chunk_course in (None, course_id))
            if matches:
                safe_content = sanitize_untrusted_text(r.content)
                filtered.append(
                    RetrievedContext(
                        source=r.source,
                        content=safe_content,
                        metadata=metadata,
                    )
                )
        return filtered

    def retrieve_scoped(
        self,
        scope: RetrievalScope,
        query: str,
        top_k: int = 4,
        student_context: Optional[dict] = None,
    ) -> list[RetrievedContext]:
        """Use the richer trusted scope when the injected retriever supports it.

        Enforces defense-in-depth isolation across university_id, course_id,
        classroom_id, assignment_id, and allowed_document_ids.

        `student_context` (message/attempt/assignment context/diagnosis) is
        purely advisory input for query construction (see QueryUnderstander);
        it never influences `scope`, which remains the sole, trusted source
        of retrieval authorization.
        """
        if not scope.course_id or not scope.course_id.strip():
            raise ValueError("course_id is required for course-scoped retrieval.")
        try:
            if hasattr(self._retriever, "retrieve_scoped"):
                try:
                    results = self._retriever.retrieve_scoped(  # type: ignore[attr-defined]
                        scope, query, top_k, student_context=student_context
                    )
                except TypeError:
                    # Injected retriever/adapter (fake/legacy) doesn't accept student_context.
                    results = self._retriever.retrieve_scoped(scope, query, top_k)  # type: ignore[attr-defined]
            else:
                # Attempt keyword call with scope, or fallback to positional course_id
                try:
                    results = self._retriever(
                        scope=scope, query=query, top_k=top_k, student_context=student_context
                    )  # type: ignore[call-arg]
                except TypeError:
                    try:
                        results = self._retriever(scope=scope, query=query, top_k=top_k)  # type: ignore[call-arg]
                    except TypeError:
                        results = self._retriever(scope.course_id, query, top_k)
        except Exception as exc:
            raise CourseRetrievalError(str(exc)) from exc

        return self._filter(results, scope)

    def _filter(self, results: list[RetrievedContext], scope: RetrievalScope) -> list[RetrievedContext]:
        """Defense in depth for adapters and fakes; scope was also applied in SQL/storage."""
        filtered = []
        for r in results:
            meta = r.metadata if isinstance(r.metadata, dict) else {}
            chunk_uni = meta.get("university_id")
            chunk_course = meta.get("course_id")
            chunk_room = meta.get("classroom_id")
            chunk_asgs = meta.get("assignment_ids") or []
            chunk_doc = meta.get("document_id")

            if self.strict_isolation:
                if chunk_course != scope.course_id:
                    continue
                if scope.university_id and chunk_uni not in (None, scope.university_id):
                    continue

            if scope.classroom_id and chunk_room not in (None, scope.classroom_id):
                continue
            if scope.assignment_id and chunk_asgs and scope.assignment_id not in chunk_asgs:
                continue
            if scope.allowed_document_ids and chunk_doc not in scope.allowed_document_ids:
                continue

            safe_content = sanitize_untrusted_text(r.content)
            filtered.append(
                RetrievedContext(
                    source=r.source,
                    content=safe_content,
                    metadata=meta,
                )
            )
        return filtered


class RAGCourseRetriever:
    """Adapter connecting the AI Coach to RAGService with authenticated university and classroom.

    Supplies the trusted RetrievalScope directly to RAGService.
    """

    def __init__(self, rag_service, *, university_id: str, classroom_id: Optional[str] = None):
        self.rag_service = rag_service
        self.university_id = university_id
        self.classroom_id = classroom_id

    def __call__(
        self,
        course_id: str,
        query: str,
        top_k: int = 4,
        student_context: Optional[dict] = None,
    ) -> list[RetrievedContext]:
        scope = RetrievalScope(
            university_id=self.university_id,
            course_id=course_id,
            classroom_id=self.classroom_id,
        )
        return self.retrieve_scoped(scope, query, top_k, student_context=student_context)

    def retrieve_scoped(
        self,
        scope: RetrievalScope,
        query: str,
        top_k: int = 4,
        student_context: Optional[dict] = None,
    ) -> list[RetrievedContext]:
        return self.rag_service.retrieve_course_material(
            course_id=scope.course_id,
            query=query,
            top_k=top_k,
            scope=scope,
            student_context=student_context,
        )
