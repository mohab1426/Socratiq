"""Shared harness: build a Supabase-like Postgres once (template DB) and clone it cheaply per test.

Needs a superuser connection: TEST_ADMIN_URL (default postgresql://postgres:postgres@localhost:5432/postgres).
Tests skip cleanly when no Postgres is reachable.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import psycopg

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
import run_migrations  # noqa: E402

ADMIN_URL = os.getenv("TEST_ADMIN_URL", "postgresql://postgres:postgres@localhost:5432/postgres")
TEMPLATE = "socratiq_test_template"


def url_for(dbname: str) -> str:
    p = urlparse(ADMIN_URL)
    return urlunparse(p._replace(path="/" + dbname))


def postgres_available() -> bool:
    try:
        with psycopg.connect(ADMIN_URL, connect_timeout=3):
            return True
    except Exception:
        return False


def build_template(upto: str | None = None, name: str = TEMPLATE) -> str:
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}"')
        c.execute(f'CREATE DATABASE "{name}"')
    with psycopg.connect(url_for(name), autocommit=True) as c:
        c.execute((HERE / "supabase_stub.sql").read_text())
    if upto is None:
        run_migrations.run(url_for(name))
    else:  # apply only migrations with prefix <= upto (used to simulate the pre-upgrade schema)
        import tempfile, shutil
        with tempfile.TemporaryDirectory() as d:
            for f in sorted(run_migrations.MIGRATIONS_DIR.glob("*.sql")):
                if f.name.split("_", 1)[0] <= upto:
                    shutil.copy(f, d)
            run_migrations.run(url_for(name), directory=Path(d))
    return name


def clone(template: str = TEMPLATE) -> str:
    name = "t_" + uuid.uuid4().hex[:12]
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}" TEMPLATE "{template}"')
    return name


def drop(name: str) -> None:
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


SEED_SQL = """
INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1','p1@u1.test'),('00000000-0000-0000-0000-0000000000a2','p2@u1.test'),
 ('00000000-0000-0000-0000-0000000000a3','p3@u2.test'),('00000000-0000-0000-0000-0000000000b1','s1@u1.test'),
 ('00000000-0000-0000-0000-0000000000b2','s2@u1.test'),('00000000-0000-0000-0000-0000000000b3','s3@u2.test');
INSERT INTO universities (university_id, name) VALUES ('U1','Uni One'),('U2','Uni Two');
INSERT INTO users (user_id, auth_user_id, university_id, email, role) VALUES
 ('P1','00000000-0000-0000-0000-0000000000a1','U1','p1@u1.test','PROFESSOR'),
 ('P2','00000000-0000-0000-0000-0000000000a2','U1','p2@u1.test','PROFESSOR'),
 ('P3','00000000-0000-0000-0000-0000000000a3','U2','p3@u2.test','PROFESSOR'),
 ('S1','00000000-0000-0000-0000-0000000000b1','U1','s1@u1.test','STUDENT'),
 ('S2','00000000-0000-0000-0000-0000000000b2','U1','s2@u1.test','STUDENT'),
 ('S3','00000000-0000-0000-0000-0000000000b3','U2','s3@u2.test','STUDENT');
INSERT INTO professors (professor_id, university_id) VALUES ('P1','U1'),('P2','U1'),('P3','U2');
INSERT INTO students (student_id, university_id) VALUES ('S1','U1'),('S2','U1'),('S3','U2');
INSERT INTO courses (course_id, university_id, instructor_id, code, title) VALUES
 ('C1','U1','P1','CS101','Intro'),('C2','U1','P2','CS202','Other'),('C3','U2','P3','CS101','Intro at U2');
INSERT INTO classrooms (classroom_id, course_id, professor_id, name, university_id) VALUES
 ('K1','C1','P1','A','U1'),('K2','C2','P2','A','U1'),('K3','C3','P3','A','U2');
INSERT INTO enrollments (enrollment_id, student_id, course_id, classroom_id, university_id) VALUES
 ('E1','S1','C1','K1','U1'),('E2','S2','C2','K2','U1'),('E3','S3','C3','K3','U2');
INSERT INTO assignments (assignment_id, course_id, classroom_id, title, instructions, university_id, status) VALUES
 ('A1','C1','K1','Pub','do it','U1','PUBLISHED'),('A1d','C1','K1','Draft','later','U1','DRAFT'),
 ('A2','C2','K2','Other','x','U1','PUBLISHED'),('A3','C3','K3','U2 asg','x','U2','PUBLISHED');
INSERT INTO attempts (attempt_id, student_id, assignment_id, university_id, status) VALUES
 ('T1','S1','A1','U1','IN_PROGRESS'),('T2','S2','A2','U1','IN_PROGRESS'),('T3','S3','A3','U2','IN_PROGRESS');
INSERT INTO risk_signals (risk_signal_id, student_id, assignment_id, signal, university_id) VALUES
 ('R1','S1','A1','pasted_polished_answer','U1');
INSERT INTO evidence_candidates (evidence_id, student_id, assignment_id, evidence_type, strength, observation, university_id) VALUES
 ('V1','S1','A1','UNDERSTANDING','MODERATE','explained gradient','U1');
"""


def seed(conn: psycopg.Connection) -> None:
    conn.execute(SEED_SQL)
