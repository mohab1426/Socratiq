"""
Core domain schemas and Pydantic models for the RAG subsystem.

Defines the contracts for document metadata, structured document chunks,
retrieval results, source references, query understanding, and trusted
retrieval scopes.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional, Sequence, Union

from pydantic import BaseModel, Field


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ContentType(str, Enum):
    """Semantic classification of a document chunk."""

    DEFINITION = "definition"
    EXPLANATION = "explanation"
    EXAMPLE = "example"
    CODE = "code"
    FORMULA = "formula"
    TABLE = "table"
    SUMMARY = "summary"
    EXERCISE = "exercise"


class ProcessingStatus(str, Enum):
    """Document ingestion processing lifecycle state."""

    PENDING = "pending"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    STORED = "stored"
    FAILED = "failed"


@dataclass(frozen=True)
class RetrievalScope:
    """Trusted multi-tenant authorization scope for RAG retrieval operations.

    Supplied solely by the backend/session authorization layer. Never populated
    from untrusted student prompt text.

    Enforced strictly at the database/storage query layer as pre-ranking predicates.
    """

    university_id: str
    course_id: str
    classroom_id: Optional[str] = None
    assignment_id: Optional[str] = None
    allowed_document_ids: tuple[str, ...] = ()

    def __init__(
        self,
        university_id: str,
        course_id: str,
        classroom_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
    ) -> None:
        if not university_id or not str(university_id).strip():
            raise ValueError("university_id is required for scoped retrieval.")
        if not course_id or not str(course_id).strip():
            raise ValueError("course_id is required for scoped retrieval.")

        object.__setattr__(self, "university_id", str(university_id).strip())
        object.__setattr__(self, "course_id", str(course_id).strip())
        object.__setattr__(self, "classroom_id", str(classroom_id).strip() if classroom_id else None)
        object.__setattr__(self, "assignment_id", str(assignment_id).strip() if assignment_id else None)

        docs: tuple[str, ...] = ()
        if allowed_document_ids:
            docs = tuple(str(d).strip() for d in allowed_document_ids if d and str(d).strip())
        object.__setattr__(self, "allowed_document_ids", docs)


class DocumentMetadata(BaseModel):
    """Metadata identifying an ingested document."""

    document_id: str = Field(default_factory=lambda: _new_id("doc"))
    university_id: str = Field(description="University identifier for multi-tenancy.")
    course_id: str = Field(description="Course identifier for course isolation.")
    classroom_id: Optional[str] = Field(
        default=None, description="Classroom identifier for classroom-level scoping."
    )
    uploader_id: Optional[str] = Field(default=None, description="User who uploaded the document.")
    filename: str = Field(description="Original filename of the document.")
    file_type: str = Field(default="pdf", description="MIME type or file extension.")
    storage_path: Optional[str] = Field(default=None,description="Path in storage bucket/filesystem.")
    content_hash: Optional[str] = Field(default=None, description="SHA-256 hash of raw document bytes.")
    upload_date: datetime = Field(default_factory=_utcnow)
    processing_status: ProcessingStatus = Field(default=ProcessingStatus.PENDING)
    total_pages: int = Field(default=0, ge=0)
    total_chunks: int = Field(default=0, ge=0)
    extra_metadata: dict[str, Any] = Field(default_factory=dict)


class DocumentChunk(BaseModel):
    """A semantic chunk derived from an ingested document."""

    chunk_id: str = Field(default_factory=lambda: _new_id("chk"))
    university_id: str
    course_id: str
    classroom_id: Optional[str] = None
    document_id: str
    title: str = Field(description="Document title or top-level chapter heading.")
    page_number: int = Field(default=1, ge=1)
    section: Optional[str] = Field(default=None, description="Primary section heading.")
    subsection: Optional[str] = Field(default=None, description="Subsection heading, if any.")
    concepts: list[str] = Field(default_factory=list, description="Extracted key domain concepts.")
    content_type: ContentType = Field(default=ContentType.EXPLANATION)
    assignment_ids: list[str] = Field(default_factory=list, description="Associated assignment IDs.")
    chunk_index: int = Field(default=0, ge=0, description="0-indexed position in document.")
    created_at: datetime = Field(default_factory=_utcnow)
    content: str = Field(description="Cleaned, readable chunk text.")
    embedding: Optional[list[float]] = Field(default=None, description="Dense vector embedding.")
    token_count: int = Field(default=0, ge=0)


class SourceReference(BaseModel):
    """Immutable source citation ensuring the AI never hallucinates sources."""

    document_id: str
    document_title: str
    filename: str
    page_number: int
    section: Optional[str] = None
    subsection: Optional[str] = None
    chunk_id: str
    score: float = Field(ge=0.0, description="Final fused/reranked relevance score.")
    content_snippet: str = Field(description="Short preview of cited material.")


class RetrievedChunk(BaseModel):
    """A chunk returned by the retrieval pipeline with scoring details."""

    chunk: DocumentChunk
    score: float = Field(default=0.0, description="Final combined score.")
    dense_score: Optional[float] = None
    fts_score: Optional[float] = None
    rrf_score: Optional[float] = None
    rerank_score: Optional[float] = None

    @property
    def source_reference(self) -> SourceReference:
        return SourceReference(
            document_id=self.chunk.document_id,
            document_title=self.chunk.title,
            filename=self.chunk.title,
            page_number=self.chunk.page_number,
            section=self.chunk.section,
            subsection=self.chunk.subsection,
            chunk_id=self.chunk.chunk_id,
            score=self.score,
            content_snippet=self.chunk.content[:200] + ("..." if len(self.chunk.content) > 200 else ""),
        )


class QueryUnderstandingResult(BaseModel):
    """Structured understanding of student query within educational context."""

    needs_retrieval: bool = Field(
        default=True, description="Whether course material retrieval is necessary."
    )
    retrieval_query: str = Field(
        description="Enriched, standalone query formulated for dense/FTS retrieval."
    )
    concepts: list[str] = Field(
        default_factory=list, description="Target domain concepts detected in query/attempt."
    )
    content_types: list[ContentType] = Field(
        default_factory=list, description="Preferred content types (e.g. definition, code, example)."
    )
    rationale: str = Field(default="", description="Why retrieval was or was not requested.")


# Domain Exceptions
class RAGError(RuntimeError):
    """Base exception for RAG subsystem errors."""


class IngestionError(RAGError):
    """Raised when document ingestion, parsing, or chunking fails."""


class ProviderError(RAGError):
    """Raised when an external embedding, reranking, or storage provider fails."""
