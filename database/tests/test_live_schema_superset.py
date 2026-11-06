"""Migration safety: a database built from database/migrations must contain EVERYTHING the live Supabase schema
(as pasted by the project owner, "supabase schema") already has: every table, every column, and the composite tenant
foreign-key names. Columns may only get stricter (e.g. NOT NULL), never disappear. If this fails, a fresh deploy would differ
from production."""
from __future__ import annotations

import psycopg
import pytest

import dbtools

pytestmark = pytest.mark.skipif(not dbtools.postgres_available(), reason="no Postgres reachable (TEST_ADMIN_URL)")

LIVE_COLUMNS = {
    "documents": "document_id university_id course_id classroom_id uploader_id filename file_type storage_path content_hash upload_date processing_status total_pages total_chunks extra_metadata",
    "document_chunks": "chunk_id university_id course_id classroom_id document_id title page_number section subsection concepts content_type assignment_ids chunk_index created_at content embedding token_count tsv_content",
    "universities": "university_id name created_at",
    "users": "user_id auth_user_id university_id email first_name last_name role created_at updated_at",
    "students": "student_id student_code university_id",
    "professors": "professor_id professor_code university_id",
    "courses": "course_id university_id instructor_id code title description created_at",
    "classrooms": "classroom_id course_id professor_id name created_at university_id",
    "enrollments": "enrollment_id student_id course_id classroom_id status created_at university_id",
    "materials": "material_id classroom_id document_id title created_at",
    "concepts": "concept_id university_id name description parent_concept_id normalized_name",
    "assignments": "assignment_id course_id classroom_id title instructions subject_area is_programming default_policy created_at university_id",
    "assignment_concepts": "assignment_id concept_id",
    "assignment_materials": "assignment_id document_id",
    "document_chunk_assignments": "assignment_id chunk_id",
    "document_chunk_concepts": "chunk_id concept_id",
    "attempts": "attempt_id student_id assignment_id attempt_number status started_at ended_at created_at university_id",
    "submissions": "submission_id attempt_id submission_type submission_text submission_file_url submitted_at score university_id student_id assignment_id",
    "ai_sessions": "session_id student_id assignment_id attempt_id policy status client_session_id turn_count started_at ended_at created_at university_id",
    "ai_interactions": "interaction_id session_id student_id assignment_id intervention_type assistance_level diagnosis diagnosis_confidence diagnosis_explanation diagnosis_evidence response referenced_concepts tools_used external_interaction_id created_at university_id",
    "messages": "message_id session_id sender content created_at",
    "ai_interaction_sources": "interaction_id document_id chunk_id dense_score fts_score rrf_score rerank_score final_score retrieval_rank",
    "verification_runs": "verification_id student_id assignment_id submission_id status overall_outcome score confidence feedback created_at completed_at university_id attempt_id",
    "verification_questions": "question_id verification_id challenge_id display_order verification_type concept question_text criteria created_at",
    "verification_responses": "response_id question_id student_id response_text response_payload created_at",
    "verification_results": "result_id question_id response_id outcome score confidence feedback criteria_evaluations created_at",
    "learning_events": "event_id student_id assignment_id session_id attempt_id interaction_id verification_id event_type occurred_at payload external_event_id university_id",
    "evidence_candidates": "evidence_id student_id assignment_id concept evidence_type strength observation confidence external_evidence_id created_at university_id",
    "evidence_sources": "evidence_id event_id",
    "verification_question_evidence": "question_id evidence_id",
    "risk_signals": "risk_signal_id student_id assignment_id session_id learning_event_id signal observation severity metadata confidence created_at university_id",
    "student_concept_state": "student_id concept_id mastery_estimate confidence evidence_count last_evaluated_at state_metadata university_id",
}

LIVE_TENANT_FKS = """documents_course_university_fk documents_classroom_course_university_fk documents_uploader_university_fk
document_chunks_document_integrity_fk document_chunks_classroom_integrity_fk students_user_university_fk professors_user_university_fk
courses_instructor_university_fk classrooms_course_university_fk classrooms_professor_university_fk enrollments_student_university_fk
enrollments_course_university_fk enrollments_classroom_course_university_fk concepts_parent_university_fk attempts_student_university_fk
attempts_assignment_university_fk submissions_attempt_integrity_fk ai_sessions_student_university_fk ai_sessions_assignment_university_fk
ai_sessions_attempt_integrity_fk ai_interactions_session_integrity_fk verification_runs_student_university_fk verification_runs_assignment_university_fk
verification_runs_submission_integrity_fk learning_events_student_university_fk learning_events_assignment_university_fk
learning_events_session_integrity_fk learning_events_attempt_integrity_fk learning_events_interaction_integrity_fk
learning_events_verification_integrity_fk evidence_candidates_student_university_fk evidence_candidates_assignment_university_fk
risk_signals_student_university_fk risk_signals_assignment_university_fk student_concept_state_student_university_fk
student_concept_state_concept_university_fk""".split()


@pytest.fixture(scope="module")
def conn():
    name = dbtools.build_template(name="socratiq_superset_check")
    with psycopg.connect(dbtools.url_for(name), autocommit=True) as c:
        yield c


def test_every_live_table_and_column_exists_after_migrating(conn):
    have: dict[str, set[str]] = {}
    for t, c in conn.execute("select table_name, column_name from information_schema.columns where table_schema='public'").fetchall():
        have.setdefault(t, set()).add(c)
    problems = []
    for table, cols in LIVE_COLUMNS.items():
        if table not in have:
            problems.append(f"missing table {table}")
            continue
        missing = set(cols.split()) - have[table]
        if missing:
            problems.append(f"{table}: missing columns {sorted(missing)}")
    assert not problems, problems


def test_live_composite_tenant_foreign_keys_exist_with_the_same_names(conn):
    have = {r[0] for r in conn.execute("select conname from pg_constraint where connamespace='public'::regnamespace and contype='f'").fetchall()}
    assert set(LIVE_TENANT_FKS) - have == set()


def test_tenant_columns_are_now_not_null(conn):
    nullable = conn.execute("""select table_name||'.'||column_name from information_schema.columns
        where table_schema='public' and column_name='university_id' and is_nullable='YES'
          and table_name in ('students','professors','classrooms','enrollments','assignments','attempts','submissions','ai_sessions','ai_interactions',
                             'verification_runs','learning_events','evidence_candidates','risk_signals','student_concept_state','assignment_concepts','assignment_materials','materials')""").fetchall()
    assert nullable == []      # live had these nullable, which silently disabled the composite FK (MATCH SIMPLE)
