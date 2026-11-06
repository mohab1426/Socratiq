"""
Vector store protocol definition for RAG retrieval and persistence.
"""
from __future__ import annotations

from typing import Optional, Protocol, Sequence

from ai.rag.models import DocumentChunk, DocumentMetadata, RetrievalScope, RetrievedChunk


class VectorStore(Protocol):
    """Abstract interface for storing and searching vector-embedded document chunks."""

    def store_document(
        self,
        metadata: DocumentMetadata,
        chunks: list[DocumentChunk],
    ) -> None:
        """Persist document metadata and its embedded chunks."""
        ...

    def search_dense(
        self,
        course_id: str,
        query_vector: list[float],
        top_k: int = 20,
        classroom_id: Optional[str] = None,
        university_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
        scope: Optional[RetrievalScope] = None,
    ) -> list[RetrievedChunk]:
        """Perform dense vector similarity search with strict multi-tenant scope isolation."""
        ...

    def search_fts(
        self,
        course_id: str,
        query: str,
        top_k: int = 20,
        classroom_id: Optional[str] = None,
        university_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
        scope: Optional[RetrievalScope] = None,
    ) -> list[RetrievedChunk]:
        """Perform full-text search with strict multi-tenant scope isolation."""
        ...

    def get_chunk(self, chunk_id: str) -> Optional[DocumentChunk]:
        """Retrieve a specific chunk by its identifier."""
        ...

    def get_document_by_hash(
        self, course_id: str, content_hash: str
    ) -> Optional[DocumentMetadata]:
        """Retrieve existing document metadata by SHA-256 content hash for idempotency."""
        ...

    def delete_document(self, document_id: str) -> bool:
        """Delete all chunks and metadata for a document."""
        ...

    def count_chunks(self, course_id: Optional[str] = None) -> int:
        """Return total chunks, optionally filtered by course."""
        ...
