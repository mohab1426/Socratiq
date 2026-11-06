"""
Storage package for vector and document persistence.
"""
from typing import Optional

from ai.rag.config import get_rag_config
from ai.rag.storage.base import VectorStore
from ai.rag.storage.memory import MemoryVectorStore
from ai.rag.storage.pgvector import PgVectorStore

__all__ = [
    "VectorStore",
    "MemoryVectorStore",
    "PgVectorStore",
    "get_vector_store",
]

_shared_memory_store: Optional[MemoryVectorStore] = None


def get_vector_store(store_type: Optional[str] = None) -> VectorStore:
    """Factory returning configured vector store (pgvector or in-memory)."""
    global _shared_memory_store
    cfg = get_rag_config()
    chosen_type = (store_type or cfg.vector_store_type).lower()

    if chosen_type == "pgvector":
        if cfg.database_url:
            try:
                return PgVectorStore()
            except Exception:
                # If database connection fails, fall back to in-memory store
                pass

    if _shared_memory_store is None:
        _shared_memory_store = MemoryVectorStore()
    return _shared_memory_store
