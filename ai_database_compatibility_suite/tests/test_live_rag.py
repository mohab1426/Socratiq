from __future__ import annotations

import os
import uuid

import pytest

from conftest import live_enabled

pytestmark = [pytest.mark.live, pytest.mark.database, pytest.mark.rag]

@pytest.mark.skipif(
    not live_enabled("RUN_LIVE_RAG"),
    reason="Set RUN_LIVE_RAG=1 to run live RAG integration"
)
def test_actual_pgvector_store_and_hybrid_retrieval(db_engine):
    """
    This test deliberately uses the real AI RAG classes.

    Constructor signatures vary between project revisions, so this test first
    discovers them and then provides the database connection using common names.
    If the current implementation uses a different constructor contract, the
    failure tells you exactly which real constructor needs an adapter/configuration.
    """
    from ai.rag.storage.pgvector import PgVectorStore
    from ai.rag.retrieval.hybrid_retriever import HybridRetriever
    import inspect

    store_sig = inspect.signature(PgVectorStore)
    store_params = set(store_sig.parameters)

    candidates = {
        "engine": db_engine,
        "db_engine": db_engine,
        "database_url": os.getenv("DATABASE_URL"),
    }

    kwargs = {k: v for k, v in candidates.items() if k in store_params and v is not None}

    try:
        store = PgVectorStore(**kwargs)
    except Exception as exc:
        pytest.fail(
            "RAG_FAIL actual PgVectorStore could not be constructed with the "
            f"available DB configuration. Constructor={store_sig}. Error={exc}"
        )

    assert store is not None

    retriever_sig = inspect.signature(HybridRetriever)
    retriever_params = set(retriever_sig.parameters)
    retriever_kwargs = {}
    for key, value in {
        "store": store,
        "vector_store": store,
        "pgvector_store": store,
    }.items():
        if key in retriever_params:
            retriever_kwargs[key] = value

    try:
        retriever = HybridRetriever(**retriever_kwargs)
    except Exception as exc:
        pytest.fail(
            "RAG_FAIL actual HybridRetriever could not be constructed. "
            f"Constructor={retriever_sig}. Error={exc}"
        )

    assert retriever is not None
