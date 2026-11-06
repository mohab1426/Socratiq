"""
Configuration settings for the RAG subsystem.

Handles environment loading, provider settings, embedding model dimensions,
storage backends, chunking parameters, and hybrid retrieval thresholds.
Never prints raw API keys or database passwords.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Ensure root .env is loaded
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_ENV_PATH = _PROJECT_ROOT / ".env"
if _ENV_PATH.is_file():
    load_dotenv(dotenv_path=_ENV_PATH)
else:
    load_dotenv()


def _get_clean_env(name: str) -> Optional[str]:
    val = os.getenv(name)
    if val is None:
        return None
    val = val.strip()
    return val if val else None


def _mask_secret(val: Optional[str]) -> str:
    return "[CONFIGURED]" if val else "[NOT SET]"


class RAGConfig:
    """Central configuration class for RAG indexing and retrieval."""

    def __init__(self) -> None:
        self.environment: str = (_get_clean_env("ENVIRONMENT") or "development").lower()

        # Embedding configuration
        # Default: NVIDIA Multilingual Embeddings
        self.embedding_provider: str = (
            _get_clean_env("RAG_EMBEDDING_PROVIDER")
            or _get_clean_env("AI_PROVIDER")
            or "nvidia"
        ).lower()
        self.embedding_model: str = (
            _get_clean_env("RAG_EMBEDDING_MODEL") or "nvidia/nv-embedqa-e5-v5"
        )
        self.embedding_api_key: Optional[str] = (
            _get_clean_env("RAG_EMBEDDING_API_KEY")
            or _get_clean_env("NVIDIA_API_KEY")
            or _get_clean_env("AI_API_KEY")
        )
        self.embedding_base_url: Optional[str] = (
            _get_clean_env("RAG_EMBEDDING_BASE_URL")
            or _get_clean_env("AI_BASE_URL")
            or "https://integrate.api.nvidia.com/v1"
        )
        self.embedding_dim: int = int(_get_clean_env("RAG_EMBEDDING_DIM") or "2048")

        # Reranker configuration
        # Default: NVIDIA Reranker (llama-3.2-nv-rerankqa-1b-v2 or nv-rerankqa-mistral-4b-v3)
        self.reranker_provider: str = (
            _get_clean_env("RAG_RERANKER_PROVIDER") or "nvidia"
        ).lower()
        self.reranker_model: str = (
            _get_clean_env("RAG_RERANKER_MODEL")
            or "nvidia/llama-3.2-nv-rerankqa-1b-v2"
        )
        self.reranker_api_key: Optional[str] = _get_clean_env(
            "RAG_RERANKER_API_KEY"
        )
        self.reranker_base_url: Optional[str] = (
            _get_clean_env("RAG_RERANKER_BASE_URL")
            or "https://integrate.api.nvidia.com/v1"
        )

        # Database and vector storage
        self.database_url: Optional[str] = _get_clean_env("DATABASE_URL")
        self.vector_store_type: str = (
            _get_clean_env("RAG_VECTOR_STORE_TYPE")
            or ("pgvector" if self.database_url else "memory")
        ).lower()

        # Document storage
        self.storage_backend: str = (
            _get_clean_env("RAG_STORAGE_BACKEND") or "local"
        ).lower()
        self.local_storage_dir: str = (
            _get_clean_env("RAG_STORAGE_DIR") or str(_PROJECT_ROOT / "data" / "documents")
        )
        self.supabase_url: Optional[str] = _get_clean_env("SUPABASE_URL")
        self.supabase_key: Optional[str] = _get_clean_env("SUPABASE_KEY")
        self.supabase_bucket: str = _get_clean_env("SUPABASE_BUCKET") or "course-materials"

        # Explicit Storage Fallback policy
        # In production, silent fallback to local disk is disabled by default unless explicitly permitted
        fallback_env = _get_clean_env("RAG_STORAGE_FALLBACK_ON_ERROR")
        if fallback_env is not None:
            self.storage_fallback_on_error: bool = fallback_env.lower() in ("true", "1", "yes")
        else:
            self.storage_fallback_on_error: bool = self.environment in ("development", "test", "testing")

        # Chunking parameters (tokens)
        self.chunk_min_tokens: int = int(_get_clean_env("RAG_CHUNK_MIN_TOKENS") or "500")
        self.chunk_max_tokens: int = int(_get_clean_env("RAG_CHUNK_MAX_TOKENS") or "900")
        self.chunk_overlap_tokens: int = int(_get_clean_env("RAG_CHUNK_OVERLAP_TOKENS") or "100")

        # Retrieval thresholds
        self.dense_top_k: int = int(_get_clean_env("RAG_DENSE_TOP_K") or "20")
        self.fts_top_k: int = int(_get_clean_env("RAG_FTS_TOP_K") or "20")
        self.rrf_k: int = int(_get_clean_env("RAG_RRF_K") or "60")
        self.rerank_top_k: int = int(_get_clean_env("RAG_RERANK_TOP_K") or "5")

        # LLM concept extraction
        self.concept_extraction_mode: str = (
            _get_clean_env("RAG_CONCEPT_EXTRACTION_MODE") or "hybrid"
        ).lower()  # "llm", "deterministic", "hybrid"

    def __repr__(self) -> str:
        return (
            f"RAGConfig(embedding_provider='{self.embedding_provider}', "
            f"embedding_model='{self.embedding_model}', embedding_dim={self.embedding_dim}, "
            f"embedding_api_key={_mask_secret(self.embedding_api_key)}, "
            f"reranker_model='{self.reranker_model}', "
            f"vector_store_type='{self.vector_store_type}', "
            f"storage_backend='{self.storage_backend}', "
            f"storage_fallback_on_error={self.storage_fallback_on_error}, "
            f"chunk_range=({self.chunk_min_tokens}, {self.chunk_max_tokens}))"
        )


_default_rag_config: Optional[RAGConfig] = None


def get_rag_config() -> RAGConfig:
    """Return the shared or newly initialized RAG configuration."""
    global _default_rag_config
    if _default_rag_config is None:
        _default_rag_config = RAGConfig()
    return _default_rag_config
