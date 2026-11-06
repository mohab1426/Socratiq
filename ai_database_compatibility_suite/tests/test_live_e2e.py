from __future__ import annotations

import pytest

from conftest import live_enabled

pytestmark = [pytest.mark.live, pytest.mark.e2e, pytest.mark.database]

@pytest.mark.skipif(
    not live_enabled("RUN_LIVE_E2E"),
    reason="Set RUN_LIVE_E2E=1 to run full live E2E"
)
def test_ai_database_e2e_prerequisites(db_engine):
    """
    Gate test for the complete workflow.

    It intentionally validates prerequisites first rather than manufacturing
    calls to undocumented AI entrypoints. The project's actual Coach and
    Verification APIs are protected; this test becomes executable end-to-end
    once those existing entrypoints are discovered from the repository.
    """
    from sqlalchemy import text

    with db_engine.connect() as conn:
        required = [
            "users", "students", "courses", "classrooms", "enrollments",
            "assignments", "documents", "document_chunks",
            "attempts", "submissions", "ai_sessions", "ai_interactions",
            "learning_events", "evidence_candidates",
            "verification_runs", "verification_questions",
            "verification_responses", "verification_results",
        ]
        rows = conn.execute(text("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema='public'
        """)).scalars()
        present = set(rows)

    missing = [t for t in required if t not in present]
    assert not missing, "E2E_FAIL missing prerequisites: " + ", ".join(missing)
