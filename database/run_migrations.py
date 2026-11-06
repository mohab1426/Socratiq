#!/usr/bin/env python3
"""Apply database/migrations/*.sql in order, tracking what ran in public.schema_migrations.

    python database/run_migrations.py                      # uses $DATABASE_URL
    python database/run_migrations.py --dry-run
    python database/run_migrations.py --baseline-through 008   # EXISTING Supabase project: mark 000-008 as
                                                                # already applied, then run 009+ (idempotent)

Each file manages its own transaction (BEGIN/COMMIT) where it needs one. A file whose checksum changed after it was
applied is reported (not re-run): write a NEW migration instead of editing applied ones.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
TRACKING_DDL = """
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  baselined  boolean NOT NULL DEFAULT false
);
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;   -- internal bookkeeping, no policies
"""


def _checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


STUB = Path(__file__).parent / "tests" / "supabase_stub.sql"


def run(database_url: str, baseline_through: str | None = None, dry_run: bool = False,
        directory: Path = MIGRATIONS_DIR, local_supabase_stub: bool = False) -> list[str]:
    files = sorted(directory.glob("*.sql"))
    applied: list[str] = []
    with psycopg.connect(database_url, autocommit=True) as conn:
        if local_supabase_stub and not dry_run:
            # plain Postgres only: creates the `auth` schema, auth.uid() and the anon/authenticated/service_role roles Supabase provides
            conn.execute(STUB.read_text(encoding="utf-8"))
        conn.execute(TRACKING_DDL)
        done = {r[0]: r[1] for r in conn.execute("SELECT filename, checksum FROM public.schema_migrations")}
        for f in files:
            prefix = f.name.split("_", 1)[0]
            checksum = _checksum(f)
            if f.name in done:
                if done[f.name] != checksum:
                    print(f"WARNING  {f.name} changed after being applied (skipped, not re-run)", file=sys.stderr)
                continue
            if baseline_through is not None and prefix <= baseline_through:
                if not dry_run:
                    conn.execute("INSERT INTO public.schema_migrations (filename, checksum, baselined) VALUES (%s,%s,true)",
                                 (f.name, checksum))
                print(f"baseline {f.name}")
                continue
            print(f"{'would apply' if dry_run else 'applying'} {f.name}")
            if not dry_run:
                conn.execute(f.read_text(encoding="utf-8"))
                conn.execute("INSERT INTO public.schema_migrations (filename, checksum) VALUES (%s,%s)", (f.name, checksum))
            applied.append(f.name)
    return applied


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database-url", default=os.getenv("DATABASE_URL"))
    ap.add_argument("--baseline-through", help="mark migrations with this numeric prefix or lower as already applied")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--local-supabase-stub", action="store_true", help="for a plain Postgres (docker-compose): create minimal Supabase stand-ins first. NEVER use on a real Supabase project")
    a = ap.parse_args()
    if not a.database_url:
        print("DATABASE_URL (or --database-url) is required", file=sys.stderr)
        return 2
    applied = run(a.database_url, a.baseline_through, a.dry_run, local_supabase_stub=a.local_supabase_stub)
    print(f"done: {len(applied)} migration(s) {'planned' if a.dry_run else 'applied'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
