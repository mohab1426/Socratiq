from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

if not os.getenv("DATABASE_URL"):
    print("DATABASE_FAIL DATABASE_URL is not set in the project .env")
    raise SystemExit(2)

print("Running safe AI ↔ database compatibility suite...")
code = os.system(f'"{sys.executable}" -m pytest -q -m "not live"')
raise SystemExit(os.waitstatus_to_exitcode(code) if hasattr(os, "waitstatus_to_exitcode") else code)
