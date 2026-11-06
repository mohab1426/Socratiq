"""Static guards for deployment files. These break in production only (browser features, container builds), never in TestClient."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_web_server_allows_the_microphone_for_voice_input():
    nginx = (ROOT / "frontend" / "nginx.conf").read_text()
    policy = re.search(r'Permissions-Policy\s+"([^"]+)"', nginx).group(1)
    assert "microphone=(self)" in policy                              # `microphone=()` would silently disable the voice feature in production
    assert "camera=()" in policy and "geolocation=()" in policy       # everything else stays denied


def test_compose_web_build_context_exists_and_has_a_dockerfile():
    compose = (ROOT / "docker-compose.yml").read_text()
    ctx = re.search(r"web:\s*\n\s*build:\s*\n\s*context:\s*(\S+)", compose).group(1)
    assert (ROOT / ctx / "Dockerfile").is_file() and (ROOT / ctx / "package.json").is_file()


def test_env_example_documents_every_required_production_variable_and_no_secrets():
    env = (ROOT / ".env.example").read_text()
    for name in ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "FILE_LINK_SECRET", "CORS_ORIGINS", "AI_API_KEY", "NVIDIA_API_KEY", "RAG_EMBEDDING_DIM", "VITE_API_URL"]:
        assert re.search(rf"^{name}=", env, re.M), name
    for line in env.splitlines():
        if re.match(r"^[A-Z_]*(KEY|SECRET|PASSWORD)[A-Z_]*=", line):
            assert line.split("=", 1)[1].split("#")[0].strip() in ("", "CHANGE_ME"), f"real-looking secret in .env.example: {line}"
    assert "SERVICE_ROLE" not in "".join(l for l in env.splitlines() if l.startswith("VITE_"))      # never exposed to the browser bundle


def test_env_example_covers_all_variables_the_backend_config_reads():
    cfg = (ROOT / "backend" / "app" / "config.py").read_text()
    read = set(re.findall(r'_(?:clean|int|bool|float)\("([A-Z][A-Z0-9_]+)"', cfg))
    documented = set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", (ROOT / ".env.example").read_text(), re.M))
    missing = sorted(read - documented - {"DB_POOL_MIN", "DB_POOL_MAX"})
    allowed_undocumented = {n for n in missing if n.startswith(("INGEST_", "DB_", "MAX_", "UPLOAD_", "FILE_LINK_TTL"))}   # tuning knobs with safe defaults
    assert not (set(missing) - allowed_undocumented), f"undocumented env vars: {sorted(set(missing) - allowed_undocumented)}"
