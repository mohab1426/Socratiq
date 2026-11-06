"""Regenerate docs/API.md from the running app's OpenAPI schema:  python scripts/gen_api_docs.py"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT)]

from app.files.storage import LocalObjectStorage  # noqa: E402
from app.main import create_app  # noqa: E402

HEADER = """# API reference (generated — `python scripts/gen_api_docs.py`)

Base URL `/api/v1`. Every endpoint except those marked **public** needs `Authorization: Bearer <Supabase access token>`.
Role is decided by the database (`users.role`), never by the request. `interactive docs`: `/docs` (development only).

## Conventions

* **Errors** are always `{"error": {"status", "message", "code", "request_id", "details?"}}`. Useful codes: `profile_required` (403, call `POST /auth/profile`),
  `not_found` (404, also for "not yours"), `no_open_attempt`/`already_submitted`/`attempt_closed`/`duplicate_file`/`invalid_transition` (409),
  `validation_error` (422), `rate_limited` (429), `ai_unavailable` (503, nothing was recorded), file codes below.
* **File upload errors** (415/413/400): `unsupported_type`, `no_extension`, `mime_mismatch`, `content_mismatch`, `not_text`, `corrupt`, `encrypted`, `macros`,
  `active_content`, `archive_bomb`, `unsafe_archive`, `too_large`, `too_many_pages`, `image_too_large`, `empty`.
* **Statuses**: assignment lifecycle `DRAFT → PUBLISHED → ARCHIVED`; student progress `not_started | in_progress | submitted | verified`;
  file `QUEUED → PROCESSING → READY | STORED_ONLY | FAILED`; mastery `Strong ≥ 0.75, Moderate ≥ 0.5, Weak`, or `null` (not enough evidence).
* Uploads are `multipart/form-data` (field `file`). Material upload returns **202**; poll `GET /teacher/materials/{id}`.
* Metric definitions: see `backend/app/analytics.py`.

## Endpoints
"""


def who(path: str) -> str:
    if path.startswith("/api/v1/student"):
        return "student"
    if path.startswith("/api/v1/teacher"):
        return "instructor"
    if path.startswith("/api/v1/ai"):
        return "student"
    if path in ("/health", "/health/ready", "/api/v1/universities", "/api/v1/files/dl/{token}"):
        return "public"
    return "any signed-in user"


def main() -> None:
    with tempfile.TemporaryDirectory() as d:
        app = create_app(db=object(), storage=LocalObjectStorage(Path(d)), token_verifier=object(), ai_adapter=object(), run_worker=False)
        spec = app.openapi()
    rows, groups = [], {}
    for path, item in spec["paths"].items():
        for method, op in item.items():
            doc = (op.get("description") or op.get("summary") or "").strip().split("\n\n")[0].replace("\n", " ")
            groups.setdefault(path.split("/")[3] if path.startswith("/api/v1/") else "health", []).append((method.upper(), path, who(path), doc))
    out = [HEADER]
    for g in sorted(groups):
        out.append(f"\n### {g}\n\n| Method | Path | Who | Notes |\n|---|---|---|---|")
        for m, p, w, d in sorted(groups[g], key=lambda r: (r[1], r[0])):
            out.append(f"| {m} | `{p}` | {w} | {d[:170]} |")
    (ROOT / "docs" / "API.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("wrote docs/API.md with", sum(len(v) for v in groups.values()), "operations")


if __name__ == "__main__":
    main()
