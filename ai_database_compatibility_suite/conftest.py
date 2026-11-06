from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = Path(os.getenv("SOCRATIC_PROJECT_ROOT", ROOT)).resolve()

load_dotenv(PROJECT_ROOT / ".env")

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def live_enabled(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in {"1", "true", "yes", "on"}


@pytest.fixture(scope="session")
def project_root() -> Path:
    return PROJECT_ROOT


@pytest.fixture(scope="session")
def database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        pytest.skip("DATABASE_URL is not set")
    return value


@pytest.fixture(scope="session")
def db_engine(database_url):
    from sqlalchemy import create_engine
    return create_engine(database_url, future=True, pool_pre_ping=True)
