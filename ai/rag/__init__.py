"""
The Socratic Class — RAG Subsystem.

Production-grade course knowledge retrieval subsystem delivering grounded,
course-isolated context for the AI Learning Coach.
"""
from ai.rag.config import RAGConfig, get_rag_config
from ai.rag.models import (
    ContentType,
    DocumentChunk,
    DocumentMetadata,
    ProcessingStatus,
    QueryUnderstandingResult,
    RetrievedChunk,
    SourceReference,
)
from ai.rag.service import RAGService, get_rag_service

__all__ = [
    "RAGService",
    "get_rag_service",
    "RAGConfig",
    "get_rag_config",
    "DocumentMetadata",
    "DocumentChunk",
    "SourceReference",
    "RetrievedChunk",
    "QueryUnderstandingResult",
    "ContentType",
    "ProcessingStatus",
]
