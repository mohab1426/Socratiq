"""
LangSmith tracing instrumentation for the RAG subsystem.

Provides safe @rag_traceable decorators for ingestion and retrieval spans,
with automatic pass-through fallback when LangSmith is not installed or disabled.
"""
from __future__ import annotations

from typing import Any, Callable, Optional, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

try:
    from langsmith import traceable as _langsmith_traceable

    def rag_traceable(
        name: Optional[str] = None,
        run_type: str = "chain",
        **kwargs: Any,
    ) -> Callable[[F], F]:
        """Wrap a function with LangSmith @traceable if available."""
        return _langsmith_traceable(name=name, run_type=run_type, **kwargs)

except ImportError:

    def rag_traceable(
        name: Optional[str] = None,
        run_type: str = "chain",
        **kwargs: Any,
    ) -> Callable[[F], F]:
        """Safe no-op fallback when langsmith is not installed."""
        def decorator(func: F) -> F:
            return func

        return decorator
