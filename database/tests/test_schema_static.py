from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIG = ROOT / "migrations"

def read(name):
    return (MIG / name).read_text(encoding="utf-8")

def test_migration_order():
    assert [p.name for p in sorted(MIG.glob("*.sql"))] == [
        "000_extensions.sql","001_rag_pgvector_schema.sql","002_core_university_schema.sql",
        "003_learning_workflow_schema.sql","004_ai_coach_schema.sql","005_verification_schema.sql",
        "006_learning_evidence_schema.sql","007_rls.sql","008_indexes_triggers.sql",
        "009_tenant_integrity.sql","010_domain_lifecycle.sql","011_file_pipeline.sql","012_indexes.sql","013_rls.sql","014_grading.sql","015_whiteboard.sql","016_whiteboard_scene.sql"]

def test_rag_contract():
    s = read("001_rag_pgvector_schema.sql")
    for x in ["documents","document_chunks","embedding vector(2048)","tsv_content tsvector GENERATED ALWAYS",
              "USING gin (tsv_content)","concepts jsonb","assignment_ids jsonb"]:
        assert x in s
    for x in ["pending","parsing","chunking","embedding","stored","failed","definition","explanation","example","code","formula","table","summary","exercise"]:
        assert x in s

def test_ai_ids_are_not_bigint():
    s = "\n".join(p.read_text(encoding="utf-8") for p in MIG.glob("*.sql"))
    assert not re.search(r"\b(student_id|assignment_id|attempt_id|session_id|interaction_id|event_id)\s+bigint\b", s, re.I)

def test_workflow_and_verification_are_separate():
    assert "public.attempts" in read("003_learning_workflow_schema.sql")
    assert "public.submissions" in read("003_learning_workflow_schema.sql")
    s = read("005_verification_schema.sql")
    for x in ["verification_runs","verification_questions","verification_responses","verification_results"]:
        assert f"public.{x}" in s

def test_forbidden_fields_absent():
    s = "\n".join(p.read_text(encoding="utf-8") for p in MIG.glob("*.sql")).lower()
    assert "ai_dependency_score" not in s
    for x in ["chain_of_thought","hidden_reasoning","private_reasoning"]:
        assert x not in s


def test_learning_events_use_the_live_column_names():
    """006 once declared id/timestamp, which no other file (or the live schema) uses, and could not deploy."""
    s = read("006_learning_evidence_schema.sql")
    assert "event_id text PRIMARY KEY" in s and "occurred_at timestamptz" in s and "REFERENCES public.learning_events(event_id)" in s

def test_rls_migration_is_authoritative_and_default_deny():
    s = read("013_rls.sql")
    assert "DROP POLICY" in s and "REVOKE ALL ON ALL TABLES" in s and "ENABLE ROW LEVEL SECURITY" in s
    assert "TO authenticated" in s and "FOR INSERT" not in s and "FOR UPDATE" not in s and "FOR DELETE" not in s   # read-only Data API


def test_grading_migration_reuses_submissions_and_constrains_the_scale():
    s = read("014_grading.sql")
    assert "CREATE TABLE" not in s                                   # one source of truth: columns on public.submissions
    for x in ["max_score", "feedback", "graded_at", "graded_by", "submissions_grade_consistent_chk", "score <= max_score", "max_score > 0"]:
        assert x in s


def test_whiteboard_migration_extends_attempts_without_a_new_table():
    s = read("015_whiteboard.sql")
    assert "CREATE TABLE" not in s and "ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS whiteboard" in s and "attempts_whiteboard_shape_chk" in s


def test_whiteboard_scene_migration_only_raises_the_cap_and_is_idempotent():
    raw = read("016_whiteboard_scene.sql")
    s = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--"))                    # judge the executable SQL, not the comments
    assert "CREATE TABLE" not in s and "DELETE" not in s.upper() and "UPDATE" not in s.upper() and "TRUNCATE" not in s.upper()      # no data is changed or removed
    assert "attempts_whiteboard_shape_chk" in s and "IF EXISTS (SELECT 1 FROM pg_constraint" in s     # re-runnable
    assert "<= 3500000" in s and "<= 400000" not in s
