"""Security and concurrency. Each test names the property from the requirements it proves."""
from __future__ import annotations

import concurrent.futures as cf
import re

import pytest

from .helpers import API, sample, upload


# ------------------------------------------------------------------ authentication on EVERY route
PUBLIC = {"/health", "/health/ready", "/api/v1/universities", "/api/v1/files/dl/{token}", "/docs", "/openapi.json", "/docs/oauth2-redirect", "/redoc"}


def test_every_route_rejects_unauthenticated_requests(world):
    checked = 0
    for r in world.app.routes:
        path, methods = getattr(r, "path", None), getattr(r, "methods", None)
        if not path or not methods or path in PUBLIC:
            continue
        url = re.sub(r"\{[^}]+\}", "x", path)
        for m in methods - {"HEAD", "OPTIONS"}:
            resp = world.client.request(m, url)
            assert resp.status_code == 401, f"{m} {path} answered {resp.status_code} without a token"
            resp = world.client.request(m, url, headers={"Authorization": "Bearer forged"})
            assert resp.status_code == 401, f"{m} {path} accepted a forged token"
            checked += 1
    assert checked >= 45                                     # the sweep really covered the API surface


def test_public_routes_expose_no_private_data(world):
    assert world.client.get("/health").json() == {"status": "ok"}
    u = world.client.get(f"{API}/universities").json()["universities"]
    assert {tuple(x) for x in map(lambda d: tuple(sorted(d)), u)} == {("id", "name")}


# ------------------------------------------------------------------ IDOR matrix: resources of S1/P1 as touched by everyone else
ROUTES = [  # (method, path, body)  -- all address S1 / P1 / C1 / A1 resources
    ("GET", "/student/assignments/A1", None), ("GET", "/student/courses/C1", None), ("GET", "/student/assignments/A1/coach", None),
    ("PATCH", "/student/attempts/T1", {"draft_text": "x"}), ("POST", "/student/attempts/T1/submit", {"text": "x"}),
    ("POST", "/student/assignments/A1/attempts", None), ("POST", "/student/assignments/A1/verification", None),
    ("POST", "/ai/coach", {"assignment_id": "A1", "message": "hi"}),
]
TEACHER_ROUTES = [
    ("GET", "/teacher/courses/C1", None), ("GET", "/teacher/courses/C1/dashboard", None), ("GET", "/teacher/courses/C1/students", None),
    ("GET", "/teacher/courses/C1/materials", None), ("GET", "/teacher/assignments/A1", None), ("GET", "/teacher/assignments/A1/students/S1", None),
    ("GET", "/teacher/students/S1", None), ("PATCH", "/teacher/courses/C1", {"title": "hacked"}), ("PATCH", "/teacher/assignments/A1", {"title": "hacked"}),
    ("POST", "/teacher/assignments/A1/publish", None), ("POST", "/teacher/assignments/A1/archive", None),
    ("POST", "/teacher/courses/C1/assignments", {"title": "t", "prompt": "p"}), ("POST", "/teacher/classrooms/K1/join-code/rotate", None),
    ("PATCH", "/teacher/enrollments/E1", {"status": "inactive"}),
]


@pytest.mark.parametrize("who", ["S2", "S3", "P2", "P3"])
def test_other_users_cannot_reach_student_one_resources(world, who):
    for m, path, body in ROUTES:
        r = world.client.request(m, f"{API}{path}", json=body, headers=world.h(who))
        assert r.status_code in (403, 404), f"{who} {m} {path} -> {r.status_code}"
    assert world.q("select status from attempts where attempt_id='T1'")[0]["status"] == "IN_PROGRESS"       # nothing was changed
    assert world.q("select count(*) n from ai_interactions")[0]["n"] == 0


@pytest.mark.parametrize("who", ["S1", "S2", "S3", "P2", "P3"])
def test_other_users_cannot_reach_instructor_one_resources(world, who):
    snap = world.q("select title, status from assignments where assignment_id='A1'")
    for m, path, body in TEACHER_ROUTES:
        r = world.client.request(m, f"{API}{path}", json=body, headers=world.h(who))
        assert r.status_code in (403, 404), f"{who} {m} {path} -> {r.status_code}"
    assert world.q("select title, status from assignments where assignment_id='A1'") == snap
    assert world.q("select title from courses where course_id='C1'")[0]["title"] == "Intro"
    assert world.q("select count(*) n from enrollments where status='inactive'")[0]["n"] == 0


def test_error_bodies_do_not_reveal_whether_a_foreign_id_exists(world):
    a = world.client.get(f"{API}/student/assignments/A2", headers=world.h("S1"))          # exists, not yours
    b = world.client.get(f"{API}/student/assignments/NOPE", headers=world.h("S1"))        # does not exist
    assert a.status_code == b.status_code == 404 and a.json()["error"]["message"] == b.json()["error"]["message"]


def test_role_and_tenant_come_from_the_database_not_the_request(world):
    for extra in ({"role": "PROFESSOR"}, {"university_id": "U2"}):
        r = world.client.post(f"{API}/student/courses/join", json={"code": "ABCD-EFGH", **extra}, headers=world.h("S1"))
        assert r.status_code == 422
    r = world.client.post(f"{API}/teacher/courses", json={"code": "Z9", "title": "t", "university_id": "U2"}, headers=world.h("P1"))
    assert r.status_code == 422
    assert world.client.get(f"{API}/teacher/courses", headers={**world.h("S1"), "X-Role": "PROFESSOR"}).status_code == 403


# ------------------------------------------------------------------ profile creation cannot be used to escalate
def test_profile_creation_rules(world):
    """Teacher signup works WITHOUT any code/secret; the role is fixed once; ADMIN can never be requested."""
    from tests.conftest import FakeVerifier  # noqa: F401
    world.x("insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ff', 'ff@test')")   # what Supabase Auth creates at signup
    fresh = {"Authorization": "Bearer tok:00000000-0000-0000-0000-0000000000ff"}
    body = {"first_name": "Ada", "last_name": "L", "role": "PROFESSOR", "university_id": "U1"}
    assert world.client.get(f"{API}/me", headers=fresh).json()["error"]["code"] == "profile_required"
    assert world.client.post(f"{API}/auth/profile", json={**body, "university_id": "NOPE", "role": "STUDENT"}, headers=fresh).status_code == 422
    assert world.client.post(f"{API}/auth/profile", json={**body, "role": "ADMIN"}, headers=fresh).status_code == 422               # no admin self-signup
    assert world.client.post(f"{API}/auth/profile", json={**body, "teacher_code": "anything"}, headers=fresh).status_code == 422      # the old field is gone (extra=forbid)
    ok = world.client.post(f"{API}/auth/profile", json=body, headers=fresh)
    assert ok.status_code == 201 and ok.json()["role"] == "teacher" and ok.json()["university_id"] == "U1"
    assert world.client.post(f"{API}/auth/profile", json=body, headers=fresh).status_code == 409                                     # only once
    assert world.q("select count(*) n from professors where professor_id=%s", ok.json()["id"])[0]["n"] == 1


def test_existing_student_cannot_become_instructor(world):
    """The role is immutable through the API: a student re-posting a PROFESSOR profile is refused and stays a student."""
    r = world.client.post(f"{API}/auth/profile", json={"first_name": "A", "last_name": "B", "role": "PROFESSOR", "university_id": "U1"}, headers=world.h("S1"))
    assert r.status_code == 409
    assert world.client.get(f"{API}/me", headers=world.h("S1")).json()["role"] == "student"


def test_student_cannot_call_teacher_routes(world):
    assert world.client.get(f"{API}/teacher/courses", headers=world.h("S1")).status_code == 403


# ------------------------------------------------------------------ configuration & secrets
def test_config_accepts_legacy_names_and_validates_production(monkeypatch):
    from app import config
    for k in ("CORS_ORIGINS", "CORS_ALLOWED_ORIGINS", "SUPABASE_BUCKET", "STORAGE_BUCKET", "ENVIRONMENT", "DATABASE_URL",
              "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STORAGE_BACKEND"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://a.example, https://b.example")          # the name the real .env used
    monkeypatch.setenv("STORAGE_BUCKET", "legacy-bucket")
    c = config.BackendConfig()
    assert c.cors_origins == ["https://a.example", "https://b.example"] and c.storage_bucket == "legacy-bucket"
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.setenv("CORS_ORIGINS", "*")
    p = config.BackendConfig().validate()
    assert config.BackendConfig().is_production and len(p) >= 4
    joined = " | ".join(p)
    for needle in ("DATABASE_URL", "SUPABASE_URL", "CORS_ORIGINS", "STORAGE_BACKEND=local"):
        assert needle in joined, needle
    with pytest.raises(RuntimeError, match="FILE_LINK_SECRET"):
        config.BackendConfig().link_secret()


def test_production_refuses_to_start_misconfigured(monkeypatch):
    from app import config
    from app.main import create_app
    monkeypatch.setenv("ENVIRONMENT", "production"); monkeypatch.setenv("DATABASE_URL", "postgresql://x/y")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    config.reset_backend_config()
    try:
        with pytest.raises(RuntimeError, match="Invalid production configuration"):
            create_app()
    finally:
        config.reset_backend_config()


def test_no_secret_like_values_are_committed_anywhere():
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    pat = re.compile(r"(nvapi-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|AQ\.[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{30,}|service_role\s*=\s*\S{20,})")
    offenders = []
    for p in root.rglob("*"):
        if (
            p.is_file()
            and p.name not in {".env", ".env.local", ".env.development", ".env.production", ".env.test"}
            and not any(
                x in p.parts
                for x in (
                    "node_modules",
                    "dist",
                    ".git",
                    ".venv",
                    "__pycache__",
                    ".pytest_cache",
                    "uploads",
                )
            )
            and p.suffix in {".py", ".ts", ".tsx", ".md", ".sql", ".yml", ".yaml", ".json", ".example", ".txt", ".toml", ""}
        ):
            try:
                text = p.read_text(errors="ignore")
            except OSError:
                continue
            if pat.search(text):
                offenders.append(str(p.relative_to(root)))
    assert offenders == [], offenders


def test_service_role_key_never_reaches_the_browser_bundle():
    from pathlib import Path
    fe = Path(__file__).resolve().parents[2] / "frontend"
    for p in (fe / "src").rglob("*"):
        if p.is_file():
            assert "service_role" not in p.read_text(errors="ignore").lower(), p
    # only the public anon key is ever read by the browser code
    assert "SUPABASE_ANON_KEY" in (fe / "src" / "lib" / "supabase.ts").read_text()


# ------------------------------------------------------------------ rate limits
def test_coach_and_upload_rate_limits(world, monkeypatch):
    from app.config import get_backend_config
    monkeypatch.setattr(get_backend_config(), "ai_rate_limit_per_minute", 3)
    codes = [world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": f"m{i}"}, headers=world.h("S1")).status_code for i in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert world.client.post(f"{API}/ai/coach", json={"assignment_id": "A2", "message": "x"}, headers=world.h("S2")).status_code == 200     # limits are per user
    monkeypatch.setattr(get_backend_config(), "upload_rate_limit_per_minute", 2)
    codes = [upload(world, "P1", f"f{i}.txt", f"unique text {i}".encode()).status_code for i in range(4)]
    assert codes == [202, 202, 429, 429]


def test_request_body_size_guard(world, monkeypatch):
    from app.config import get_backend_config
    monkeypatch.setattr(get_backend_config(), "max_upload_mb", 1)
    r = world.client.post(f"{API}/teacher/courses/C1/materials", files={"file": ("big.txt", b"a" * (3 * 1024 * 1024), "text/plain")}, headers=world.h("P1"))
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"


# ------------------------------------------------------------------ concurrency: races are closed by the database, not by luck
def _parallel(fn, n=8):
    with cf.ThreadPoolExecutor(n) as ex:
        return list(ex.map(lambda i: fn(i), range(n)))


def test_parallel_double_submit_creates_exactly_one_submission(world):
    res = _parallel(lambda i: world.client.post(f"{API}/student/attempts/T1/submit", json={"text": f"version {i}"}, headers=world.h("S1")).status_code)
    assert sorted(res).count(200) == 1 and set(res) <= {200, 409}
    assert world.q("select count(*) n from submissions")[0]["n"] == 1
    assert world.q("select count(*) n from learning_events where event_type='SUBMISSION'")[0]["n"] == 1


def test_parallel_attempt_starts_never_create_two_open_attempts(world):
    world.x("update attempts set status='SUBMITTED' where attempt_id='T1'")
    res = _parallel(lambda i: world.client.post(f"{API}/student/assignments/A1/attempts", headers=world.h("S1")))
    assert all(r.status_code == 200 for r in res) and len({r.json()["id"] for r in res}) == 1
    assert world.q("select count(*) n from attempts where student_id='S1' and assignment_id='A1' and status in ('DRAFT','IN_PROGRESS')")[0]["n"] == 1


def test_parallel_identical_uploads_yield_one_file(world):
    data = sample("sample.txt")
    res = _parallel(lambda i: upload(world, "P1", f"copy{i}.txt", data).status_code, 6)
    assert res.count(202) == 1 and set(res) <= {202, 409}
    assert world.q("select count(*) n from stored_files")[0]["n"] == 1
    import pathlib
    assert len([p for p in pathlib.Path(world.storage.root).rglob("*") if p.is_file()]) == 1                       # losers left no orphan object


def test_parallel_joins_create_one_enrollment(world):
    code = world.client.post(f"{API}/teacher/courses", json={"code": "RACE1", "title": "r"}, headers=world.h("P1")).json()["join_code"]
    res = _parallel(lambda i: world.client.post(f"{API}/student/courses/join", json={"code": code}, headers=world.h("S2")).status_code)
    assert set(res) == {201}
    assert world.q("select count(*) n from enrollments where student_id='S2' and status='active'")[0]["n"] == 2       # seeded C2 + this one


def test_parallel_coach_turns_are_serialised_per_session(world):
    res = _parallel(lambda i: world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": f"m{i}"}, headers=world.h("S1")).status_code, 5)
    assert res.count(200) == 5
    assert world.q("select turn_count from ai_sessions")[0]["turn_count"] == 5
    assert world.q("select count(*) n from messages")[0]["n"] == 10 and world.q("select count(*) n from ai_sessions")[0]["n"] == 1
