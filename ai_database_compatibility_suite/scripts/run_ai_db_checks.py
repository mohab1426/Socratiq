from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

groups = [
    ("Safe database/schema checks", [
        "tests/test_database_schema.py",
        "tests/test_rag_database.py",
        "tests/test_ai_source_contracts.py",
        "tests/test_ai_modules.py",
    ]),
]

print("The Socratic Class — AI ↔ Database compatibility checks")
print(f"Project: {ROOT}")
print()

env = os.environ.copy()
env.setdefault("RUN_LIVE_RAG", "0")
env.setdefault("RUN_LIVE_COACH", "0")
env.setdefault("RUN_LIVE_VERIFICATION", "0")
env.setdefault("RUN_LIVE_E2E", "0")

failed = False
for title, tests in groups:
    print("=" * 72)
    print(title)
    print("=" * 72)
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *tests],
        cwd=ROOT,
        env=env,
    )
    if result.returncode != 0:
        failed = True

print()
if failed:
    print("RESULT: FAIL — inspect the first failing test for the exact incompatibility.")
    raise SystemExit(1)

print("RESULT: PASS — safe compatibility checks passed.")
print()
print("Next optional checks:")
print("  PowerShell: $env:RUN_LIVE_RAG='1'; python -m pytest -q tests/test_live_rag.py")
print("  PowerShell: $env:RUN_LIVE_COACH='1'; python -m pytest -q tests/test_live_coach.py")
print("  PowerShell: $env:RUN_LIVE_VERIFICATION='1'; python -m pytest -q tests/test_live_verification.py")
print("  PowerShell: $env:RUN_LIVE_E2E='1'; python -m pytest -q tests/test_live_e2e.py")
