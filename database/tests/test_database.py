"""Database integration tests against a real Postgres (pgvector) built from database/migrations.

Covers: deployability, idempotency, constraints, lifecycle triggers, tenant integrity, RLS (real roles), and the
upgrade path for a database that already contains pre-009 data.
"""
from __future__ import annotations

import contextlib
import re
import uuid

import psycopg
import pytest
from psycopg import errors as E

import dbtools

pytestmark = pytest.mark.skipif(not dbtools.postgres_available(), reason="no Postgres reachable (TEST_ADMIN_URL)")

UID = {  # auth.users ids seeded by dbtools.SEED_SQL
    "P1": "00000000-0000-0000-0000-0000000000a1", "P2": "00000000-0000-0000-0000-0000000000a2",
    "P3": "00000000-0000-0000-0000-0000000000a3", "S1": "00000000-0000-0000-0000-0000000000b1",
    "S2": "00000000-0000-0000-0000-0000000000b2", "S3": "00000000-0000-0000-0000-0000000000b3",
}


@pytest.fixture(scope="session")
def template():
    return dbtools.build_template()


@pytest.fixture()
def db(template):
    name = dbtools.clone(template)
    with psycopg.connect(dbtools.url_for(name), autocommit=True) as conn:
        dbtools.seed(conn)
        yield conn
    dbtools.drop(name)


@contextlib.contextmanager
def as_user(conn, who: str | None, role: str = "authenticated"):
    """Run statements as a Supabase-style JWT user (RLS applies)."""
    conn.execute(f"SET ROLE {role}")
    conn.execute("SELECT set_config('request.jwt.claim.sub', %s, false)", (UID.get(who, "") if who else "",))
    try:
        yield conn
    finally:
        conn.execute("RESET ROLE")
        conn.execute("SELECT set_config('request.jwt.claim.sub', '', false)")


def ids(conn, sql, *params):
    return sorted(r[0] for r in conn.execute(sql, params).fetchall())


# ------------------------------------------------------------------ deployability / idempotency
def test_all_migrations_applied_and_tracked(db):
    names = ids(db, "select filename from schema_migrations")
    assert names[0].startswith("000_") and names[-1].startswith("016_") and len(names) == 17


def _fingerprint(conn):
    con = conn.execute("select conrelid::regclass::text||':'||conname||':'||contype::text from pg_constraint "
                       "where connamespace='public'::regnamespace order by 1").fetchall()
    idx = conn.execute("select indexname from pg_indexes where schemaname='public' order by 1").fetchall()
    pol = conn.execute("select tablename||':'||policyname from pg_policies where schemaname='public' order by 1").fetchall()
    return con, idx, pol


def test_reapplying_upgrade_migrations_is_a_noop(db):
    before = _fingerprint(db)
    for f in sorted(dbtools.run_migrations.MIGRATIONS_DIR.glob("*.sql")):
        if f.name.split("_", 1)[0] >= "009":
            db.execute(f.read_text())
    assert _fingerprint(db) == before


def test_runner_is_idempotent(db):
    assert dbtools.run_migrations.run(str(db.info.dsn) if False else dbtools.url_for(db.info.dbname)) == []


# ------------------------------------------------------------------ RLS posture
def test_every_public_table_has_rls(db):
    missing = ids(db, "select tablename from pg_tables where schemaname='public' and not rowsecurity")
    assert missing == []


def test_anon_has_no_grants_and_authenticated_is_read_only(db):
    assert db.execute("select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public'").fetchone()[0] == 0
    writes = db.execute("select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' "
                        "and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')").fetchone()[0]
    assert writes == 0


def test_private_tables_are_unreadable_through_data_api(db):
    for who in ("P1", "S1"):
        with as_user(db, who):
            for t in ("document_chunks", "ai_interaction_sources", "evidence_sources", "document_chunk_concepts"):
                with pytest.raises(E.InsufficientPrivilege):
                    db.execute(f"select * from {t}")


def test_anon_cannot_read_anything(db):
    with as_user(db, None, role="anon"):
        for t in ("courses", "assignments", "documents", "users"):
            with pytest.raises(E.InsufficientPrivilege):
                db.execute(f"select * from {t}")


def test_storage_paths_never_exposed_to_data_api(db):
    with as_user(db, "P1"):
        with pytest.raises(E.InsufficientPrivilege):
            db.execute("select storage_path from documents")
        with pytest.raises(E.InsufficientPrivilege):
            db.execute("select storage_path from stored_files")


# ------------------------------------------------------------------ RLS behaviour (tenant / course / classroom / student isolation)
def test_student_sees_only_own_attempts(db):
    with as_user(db, "S1"):
        assert ids(db, "select attempt_id from attempts") == ["T1"]
    with as_user(db, "S2"):
        assert ids(db, "select attempt_id from attempts") == ["T2"]


def test_student_sees_only_published_assignments_of_enrolled_classroom(db):
    with as_user(db, "S1"):
        assert ids(db, "select assignment_id from assignments") == ["A1"]     # not draft A1d, not other course A2, not U2's A3


def test_student_cannot_see_other_courses_or_universities(db):
    with as_user(db, "S1"):
        assert ids(db, "select course_id from courses") == ["C1"]
        assert ids(db, "select university_id from universities") == ["U1"]
        assert ids(db, "select classroom_id from classrooms") == ["K1"]


def test_professor_sees_only_own_classes(db):
    with as_user(db, "P1"):
        assert ids(db, "select course_id from courses") == ["C1"]
        assert ids(db, "select attempt_id from attempts") == ["T1"]
        assert ids(db, "select assignment_id from assignments") == ["A1", "A1d"]
    with as_user(db, "P2"):
        assert ids(db, "select attempt_id from attempts") == ["T2"]


def test_professor_of_other_university_sees_nothing_of_u1(db):
    with as_user(db, "P3"):
        assert ids(db, "select course_id from courses") == ["C3"]
        assert ids(db, "select attempt_id from attempts") == ["T3"]
        assert ids(db, "select user_id from users where user_id in ('S1','S2','P1')") == []


def test_learning_indicators_are_instructor_only(db):
    with as_user(db, "S1"):
        assert ids(db, "select risk_signal_id from risk_signals") == []
        assert ids(db, "select evidence_id from evidence_candidates") == []
    with as_user(db, "P1"):
        assert ids(db, "select risk_signal_id from risk_signals") == ["R1"]
        assert ids(db, "select evidence_id from evidence_candidates") == ["V1"]
    with as_user(db, "P2"):
        assert ids(db, "select risk_signal_id from risk_signals") == []   # another instructor, same university


def test_authenticated_cannot_write(db):
    with as_user(db, "S1"):
        with pytest.raises(E.InsufficientPrivilege):
            db.execute("update attempts set status='SUBMITTED' where attempt_id='T1'")
        with pytest.raises(E.InsufficientPrivilege):
            db.execute("insert into enrollments (enrollment_id, student_id, course_id, classroom_id, university_id) values ('X','S1','C2','K2','U1')")


def test_file_visibility_rules(db):
    db.execute("""INSERT INTO stored_files (file_id, university_id, course_id, classroom_id, uploader_id, purpose, original_filename,
      extension, mime_type, kind, size_bytes, sha256, storage_bucket, storage_path, index_mode, status) VALUES
      ('F1','U1','C1','K1','P1','MATERIAL','a.pdf','pdf','application/pdf','DOCUMENT',10,%s,'b','p1','RAG','READY'),
      ('F2','U1','C1','K1','P1','MATERIAL','b.pdf','pdf','application/pdf','DOCUMENT',10,%s,'b','p2','RAG','QUEUED'),
      ('F3','U1','C1',NULL,'S1','SUBMISSION','w.txt','txt','text/plain','TEXT',10,%s,'b','p3','EXTRACT_ONLY','READY')""",
               ("a" * 64, "b" * 64, "c" * 64))
    with as_user(db, "S1"):
        assert ids(db, "select file_id from stored_files") == ["F1", "F3"]      # ready material + own submission, not the queued one
    with as_user(db, "S2"):
        assert ids(db, "select file_id from stored_files") == []                 # other classroom
    with as_user(db, "P1"):
        assert ids(db, "select file_id from stored_files") == ["F1", "F2", "F3"]
    with as_user(db, "P2"):
        assert ids(db, "select file_id from stored_files") == []


# ------------------------------------------------------------------ tenant integrity (enforced by FKs, even for a privileged writer)
def test_null_tenant_column_is_rejected(db):
    with pytest.raises(E.NotNullViolation):
        db.execute("insert into attempts (attempt_id, student_id, assignment_id) values ('N','S1','A1')")


def test_cross_tenant_rows_cannot_be_created(db):
    with pytest.raises(E.ForeignKeyViolation):   # classroom of U1 pointing at U2's course
        db.execute("insert into classrooms (classroom_id, course_id, professor_id, name, university_id) values ('KX','C3','P1','x','U1')")
    with pytest.raises(E.ForeignKeyViolation):   # student of U2 enrolled in a U1 classroom
        db.execute("insert into enrollments (enrollment_id, student_id, course_id, classroom_id, university_id) values ('EX','S3','C1','K1','U1')")
    with pytest.raises(E.ForeignKeyViolation):   # assignment claims U2 but lives in U1's course (was possible before 009)
        db.execute("insert into assignments (assignment_id, course_id, classroom_id, title, instructions, university_id) values ('AX','C1','K1','t','i','U2')")
    with pytest.raises(E.ForeignKeyViolation):   # attempt by a U2 student on a U1 assignment
        db.execute("insert into attempts (attempt_id, student_id, assignment_id, university_id) values ('TX','S3','A1','U1')")


def test_link_tables_cannot_cross_universities_or_courses(db):
    db.execute("insert into concepts (concept_id, university_id, name) values (gen_random_uuid(),'U2','Loops')")
    cid = db.execute("select concept_id from concepts where university_id='U2'").fetchone()[0]
    with pytest.raises(E.ForeignKeyViolation):
        db.execute("insert into assignment_concepts (assignment_id, concept_id, university_id) values ('A1',%s,'U1')", (cid,))
    db.execute("""insert into documents (document_id, university_id, course_id, classroom_id, filename, file_type, storage_path)
                  values ('D2','U1','C2','K2','x.pdf','pdf','p')""")
    with pytest.raises(E.ForeignKeyViolation):   # document of course C2 linked to an assignment of C1
        db.execute("insert into assignment_materials (assignment_id, document_id, university_id, course_id) values ('A1','D2','U1','C1')")


def test_submission_and_ai_session_must_match_their_attempt(db):
    with pytest.raises(E.ForeignKeyViolation):
        db.execute("insert into ai_sessions (session_id, student_id, assignment_id, attempt_id, policy, university_id) values ('X','S2','A1','T1','GUIDED','U1')")
    with pytest.raises(E.ForeignKeyViolation):
        db.execute("insert into submissions (submission_id, attempt_id, student_id, assignment_id, university_id) values ('SX','T1','S2','A1','U1')")


# ------------------------------------------------------------------ lifecycle rules
def test_assignment_lifecycle_and_versioning(db):
    assert db.execute("select version, published_at is null from assignments where assignment_id='A1d'").fetchone() == (1, True)
    db.execute("update assignments set status='PUBLISHED' where assignment_id='A1d'")
    assert db.execute("select published_at is not null from assignments where assignment_id='A1d'").fetchone()[0]
    db.execute("update assignments set instructions='changed' where assignment_id='A1d'")
    assert db.execute("select version from assignments where assignment_id='A1d'").fetchone()[0] == 2
    assert ids(db, "select version from assignment_versions where assignment_id='A1d'") == [1, 2]
    db.execute("update assignments set status='ARCHIVED' where assignment_id='A1d'")
    with pytest.raises(E.CheckViolation):
        db.execute("update assignments set status='DRAFT' where assignment_id='A1d'")          # ARCHIVED -> DRAFT is illegal


def test_cannot_unpublish_an_assignment_students_already_started(db):
    with pytest.raises(E.CheckViolation):
        db.execute("update assignments set status='DRAFT' where assignment_id='A1'")            # T1 exists


def test_attempt_snapshot_version_is_immutable_and_set_on_insert(db):
    assert db.execute("select assignment_version from attempts where attempt_id='T1'").fetchone()[0] == 1
    db.execute("update assignments set instructions='v2' where assignment_id='A1'")
    db.execute("update attempts set assignment_version=99 where attempt_id='T1'")
    assert db.execute("select assignment_version from attempts where attempt_id='T1'").fetchone()[0] == 1


def test_one_open_attempt_per_student_assignment(db):
    with pytest.raises(E.UniqueViolation):
        db.execute("insert into attempts (attempt_id, student_id, assignment_id, university_id, attempt_number) values ('T1b','S1','A1','U1',2)")
    db.execute("update attempts set status='SUBMITTED' where attempt_id='T1'")
    db.execute("insert into attempts (attempt_id, student_id, assignment_id, university_id, attempt_number) values ('T1b','S1','A1','U1',2)")


def test_attempt_state_machine(db):
    db.execute("update attempts set status='SUBMITTED' where attempt_id='T1'")
    assert db.execute("select ended_at is not null from attempts where attempt_id='T1'").fetchone()[0]
    with pytest.raises(E.CheckViolation):
        db.execute("update attempts set status='IN_PROGRESS' where attempt_id='T1'")           # SUBMITTED is terminal


def test_one_submission_per_attempt(db):
    db.execute("insert into submissions (submission_id, attempt_id, student_id, assignment_id, university_id, submission_type, submission_text) values ('SB1','T1','S1','A1','U1','text','x')")
    with pytest.raises(E.UniqueViolation):
        db.execute("insert into submissions (submission_id, attempt_id, student_id, assignment_id, university_id, submission_type, submission_text) values ('SB2','T1','S1','A1','U1','text','y')")


def test_one_active_ai_session_and_one_open_verification_per_attempt(db):
    db.execute("insert into ai_sessions (session_id, student_id, assignment_id, attempt_id, policy, university_id) values ('X1','S1','A1','T1','GUIDED','U1')")
    with pytest.raises(E.UniqueViolation):
        db.execute("insert into ai_sessions (session_id, student_id, assignment_id, attempt_id, policy, university_id) values ('X2','S1','A1','T1','GUIDED','U1')")
    db.execute("insert into verification_runs (verification_id, student_id, assignment_id, attempt_id, university_id) values ('VR1','S1','A1','T1','U1')")
    with pytest.raises(E.UniqueViolation):
        db.execute("insert into verification_runs (verification_id, student_id, assignment_id, attempt_id, university_id) values ('VR2','S1','A1','T1','U1')")


def test_join_codes_are_unique_random_and_unambiguous(db):
    codes = [r[0] for r in db.execute("select join_code from classrooms").fetchall()]
    assert len(set(codes)) == 3 and all(re.fullmatch(r"[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}", c) for c in codes)


def test_stored_file_rules(db):
    ins = """INSERT INTO stored_files (file_id, university_id, course_id, classroom_id, uploader_id, purpose, original_filename,
      extension, mime_type, kind, size_bytes, sha256, storage_bucket, storage_path, index_mode, status)
      VALUES (%s,'U1','C1','K1','P1','MATERIAL','a.pdf','pdf','application/pdf','DOCUMENT',10,%s,'b',%s,'RAG','QUEUED')"""
    db.execute(ins, ("F1", "a" * 64, "p1"))
    with pytest.raises(E.UniqueViolation):                                   # same bytes twice as material in one course
        db.execute(ins, ("F2", "a" * 64, "p2"))
    with pytest.raises(E.CheckViolation):                                    # bad hash
        db.execute(ins, ("F3", "zz", "p3"))
    with pytest.raises(E.CheckViolation):                                    # FAILED requires an error message
        db.execute("update stored_files set status='FAILED' where file_id='F1'")
    db.execute("update stored_files set status='PROCESSING' where file_id='F1'")
    assert db.execute("select attempts, locked_at is not null from stored_files where file_id='F1'").fetchone() == (1, True)
    db.execute("update stored_files set status='READY' where file_id='F1'")
    assert db.execute("select locked_at is null, processed_at is not null from stored_files where file_id='F1'").fetchone() == (True, True)
    with pytest.raises(E.CheckViolation):
        db.execute("update stored_files set sha256=%s where file_id='F1'", ("b" * 64,))     # identity columns immutable
    with pytest.raises(E.CheckViolation):
        db.execute("update stored_files set status='PROCESSING' where file_id='F1'")         # READY -> PROCESSING must go via QUEUED


def test_file_purpose_is_enforced_on_attachment_points(db):
    db.execute("""INSERT INTO stored_files (file_id, university_id, course_id, classroom_id, uploader_id, purpose, original_filename,
      extension, mime_type, kind, size_bytes, sha256, storage_bucket, storage_path, index_mode, status) VALUES
      ('W1','U1','C1',NULL,'S1','SUBMISSION','w.txt','txt','text/plain','TEXT',5,%s,'b','w1','EXTRACT_ONLY','READY')""", ("d" * 64,))
    with pytest.raises(E.CheckViolation):     # a submission file cannot be posted as course material
        db.execute("insert into materials (material_id, classroom_id, title, university_id, course_id, file_id) values ('M1','K1','t','U1','C1','W1')")
    with pytest.raises(E.CheckViolation):     # another student cannot claim S1's file
        db.execute("insert into submissions (submission_id, attempt_id, student_id, assignment_id, university_id, file_id) values ('SB','T2','S2','A2','U1','W1')")


# ------------------------------------------------------------------ upgrade of a database that already holds data (pre-009 schema)
LEGACY_ROWS = """
INSERT INTO auth.users (id,email) VALUES ('00000000-0000-0000-0000-0000000000c1','l@x');
INSERT INTO universities (university_id,name) VALUES ('U1','One');
INSERT INTO users (user_id,auth_user_id,university_id,email,role) VALUES
  ('P1','00000000-0000-0000-0000-0000000000c1','U1','l@x','PROFESSOR'),('S1',NULL,'U1','s@x','STUDENT');
INSERT INTO professors (professor_id) VALUES ('P1');
INSERT INTO students (student_id) VALUES ('S1');
INSERT INTO courses (course_id,university_id,instructor_id,code,title) VALUES ('C1','U1','P1','X1','T');
INSERT INTO classrooms (classroom_id,course_id,professor_id,name) VALUES ('K1','C1','P1','A');
INSERT INTO enrollments (enrollment_id,student_id,course_id,classroom_id) VALUES ('E1','S1','C1','K1');
INSERT INTO assignments (assignment_id,course_id,classroom_id,title,instructions) VALUES ('A1','C1','K1','t','i');
INSERT INTO attempts (attempt_id,student_id,assignment_id,attempt_number,status,started_at) VALUES
  ('T1','S1','A1',1,'IN_PROGRESS', now()-interval '2 days'),('T2','S1','A1',2,'IN_PROGRESS', now()-interval '1 day');
INSERT INTO submissions (submission_id,attempt_id,submission_type,submission_text) VALUES ('SB1','T2','text','hello');
INSERT INTO ai_sessions (session_id,student_id,assignment_id,attempt_id,policy) VALUES ('X1','S1','A1','T2','GUIDED');
INSERT INTO verification_runs (verification_id,student_id,assignment_id,submission_id) VALUES ('VR1','S1','A1','SB1');
"""


@pytest.fixture(scope="module")
def legacy_template():
    return dbtools.build_template(upto="008", name="socratiq_legacy_template")


def test_upgrade_backfills_existing_rows_and_closes_duplicate_open_attempts(legacy_template):
    name = dbtools.clone(legacy_template)
    try:
        with psycopg.connect(dbtools.url_for(name), autocommit=True) as c:
            c.execute(LEGACY_ROWS)
        dbtools.run_migrations.run(dbtools.url_for(name), baseline_through="008")
        with psycopg.connect(dbtools.url_for(name), autocommit=True) as c:
            assert c.execute("select university_id from students").fetchone()[0] == "U1"
            assert c.execute("select university_id, student_id from submissions").fetchone() == ("U1", "S1")
            assert c.execute("select attempt_id from verification_runs").fetchone()[0] == "T2"      # via submission
            assert c.execute("select status from attempts order by attempt_number").fetchall() == [("ABANDONED",), ("IN_PROGRESS",)]
            assert c.execute("select status, published_at is not null from assignments").fetchone() == ("PUBLISHED", True)
            assert c.execute("select join_code is not null from classrooms").fetchone()[0]
            assert c.execute("select assignment_version from attempts where attempt_id='T1'").fetchone()[0] == 1
    finally:
        dbtools.drop(name)


def test_upgrade_aborts_loudly_on_cross_tenant_drift(legacy_template):
    name = dbtools.clone(legacy_template)
    try:
        with psycopg.connect(dbtools.url_for(name), autocommit=True) as c:
            c.execute(LEGACY_ROWS)
            c.execute("INSERT INTO courses (course_id,university_id,instructor_id,code,title) VALUES ('C9','U1','P1','X9','T9')")
            c.execute("UPDATE enrollments SET course_id='C9'")     # enrollment disagrees with its classroom's course
        with pytest.raises(psycopg.errors.RaiseException, match="disagrees with its classroom"):
            dbtools.run_migrations.run(dbtools.url_for(name), baseline_through="008")
    finally:
        dbtools.drop(name)


def test_valid_file_attachments_are_accepted_on_every_attachment_point(db):
    """Positive path (the purpose trigger is generic and runs on tables with different columns)."""
    ins = """INSERT INTO stored_files (file_id, university_id, course_id, classroom_id, uploader_id, purpose, original_filename,
      extension, mime_type, kind, size_bytes, sha256, storage_bucket, storage_path, index_mode, status)
      VALUES (%s,'U1','C1',%s,%s,%s,'f.txt','txt','text/plain','TEXT',5,%s,'b',%s,'EXTRACT_ONLY','READY')"""
    db.execute(ins, ("FM", "K1", "P1", "MATERIAL", "1" * 64, "pm"))
    db.execute(ins, ("FA", "K1", "P1", "ASSIGNMENT_ATTACHMENT", "2" * 64, "pa"))
    db.execute(ins, ("FS", None, "S1", "SUBMISSION", "3" * 64, "ps"))
    db.execute("insert into materials (material_id, classroom_id, title, university_id, course_id, file_id) values ('M1','K1','t','U1','C1','FM')")
    db.execute("insert into assignment_attachments (attachment_id, assignment_id, university_id, course_id, file_id) values ('AT1','A1','U1','C1','FA')")
    db.execute("insert into submissions (submission_id, attempt_id, student_id, assignment_id, university_id, file_id) values ('SB1','T1','S1','A1','U1','FS')")
    assert db.execute("select count(*) from materials").fetchone()[0] == 1


# ------------------------------------------------------------------ grading + whiteboard (migrations 014/015): same row-level isolation as the work they belong to
def _seed_graded_work(db):
    db.execute("UPDATE attempts SET whiteboard = '{\"steps\":[\"x = 7\"],\"strokes\":[]}'::jsonb WHERE attempt_id = 'T1'")
    db.execute("INSERT INTO submissions (submission_id, attempt_id, submission_type, submission_text, university_id, student_id, assignment_id, "
               "score, max_score, feedback, graded_at, graded_by) "
               "VALUES ('SUBX', 'T1', 'text', 'theta = theta - lr*grad', 'U1', 'S1', 'A1', 8, 10, 'private feedback', now(), 'P1')")


def _visible(db, who, sql):
    """Rows `who` can read through the Data API; a permission error counts as 'nothing visible'."""
    try:
        with as_user(db, who, role="anon" if who is None else "authenticated"):
            return db.execute(sql).fetchall()
    except psycopg.errors.InsufficientPrivilege:
        return []


def test_grades_and_whiteboards_are_visible_only_to_the_student_and_their_instructor(db):
    _seed_graded_work(db)
    grades, boards = "SELECT score, feedback FROM submissions", "SELECT whiteboard FROM attempts"
    for who in ("S1", "P1"):                                                          # the student, and the instructor of that classroom
        assert [tuple(r) for r in _visible(db, who, grades)] == [(8, "private feedback")], who
        assert len(_visible(db, who, boards)) >= 1 and any(r[0] for r in _visible(db, who, boards)), who
    for who in ("S2", "S3", "P2", "P3", None):                                        # classmates elsewhere, another university, other instructors, anonymous
        assert _visible(db, who, grades) == [], who
        assert not any(r[0] for r in _visible(db, who, boards)), who


def test_students_cannot_write_their_own_grade_or_whiteboard_through_the_data_api(db):
    _seed_graded_work(db)
    for sql in ("UPDATE submissions SET score = 10, max_score = 10 WHERE submission_id = 'SUBX'",
                "UPDATE attempts SET whiteboard = '{\"steps\":[\"forged\"]}'::jsonb WHERE attempt_id = 'T1'",
                "UPDATE submissions SET feedback = 'forged' WHERE submission_id = 'SUBX'"):
        for who in ("S1", "P1"):
            try:
                with as_user(db, who):
                    assert db.execute(sql).rowcount == 0, (who, sql)
            except psycopg.errors.InsufficientPrivilege:
                pass
    assert float(db.execute("SELECT score FROM submissions WHERE submission_id='SUBX'").fetchone()[0]) == 8
    assert db.execute("SELECT feedback FROM submissions WHERE submission_id='SUBX'").fetchone()[0] == "private feedback"
    assert db.execute("SELECT whiteboard->'steps'->>0 FROM attempts WHERE attempt_id='T1'").fetchone()[0] == "x = 7"
