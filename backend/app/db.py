"""
PostgreSQL access with REAL transactions (psycopg 3 + connection pool).

Why not PostgREST/supabase-py for data: it offers no multi-statement transactions, so multi-table writes (submit an
attempt, record a coach turn, complete a verification) could not be atomic and race conditions could not be closed.
Supabase is still used for what it is good at here: Auth (JWT verification) and Storage.

The backend connects with the database owner/service role (bypasses RLS). That is deliberate: authorisation is enforced
in app/access.py and by the composite tenant foreign keys; RLS (migration 013) protects the Data API surface instead.
"""
from __future__ import annotations

import contextlib
import uuid
from typing import Any, Iterator, Optional

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

Row = dict[str, Any]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class Database:
    def __init__(self, url: str, min_size: int = 1, max_size: int = 10) -> None:
        self._pool = ConnectionPool(url, min_size=min_size, max_size=max_size, open=False,
                                    kwargs={"row_factory": dict_row, "autocommit": False}, timeout=15)

    def open(self) -> None:
        self._pool.open(wait=True, timeout=15)

    def close(self) -> None:
        self._pool.close()

    @contextlib.contextmanager
    def tx(self) -> Iterator[psycopg.Connection]:
        """One transaction: commits on success, rolls back on any exception."""
        with self._pool.connection() as conn:
            yield conn

    def ping(self) -> bool:
        try:
            with self.tx() as c:
                c.execute("SELECT 1")
            return True
        except Exception:  # noqa: BLE001
            return False


def one(conn: psycopg.Connection, sql: str, params: Any = None) -> Optional[Row]:
    return conn.execute(sql, params).fetchone()


def many(conn: psycopg.Connection, sql: str, params: Any = None) -> list[Row]:
    return conn.execute(sql, params).fetchall()


def scalar(conn: psycopg.Connection, sql: str, params: Any = None) -> Any:
    row = conn.execute(sql, params).fetchone()
    return None if row is None else next(iter(row.values()))
