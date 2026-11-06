"""Authentication: verify the Supabase access token, then load the application profile from OUR users table.
The token proves identity only; role, university and every permission come from the database, never from the token
or the request body."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol

from fastapi import Depends, Request

from .db import Database, one
from .errors import AppError


@dataclass(frozen=True)
class Identity:
    auth_user_id: str
    email: str


@dataclass(frozen=True)
class CurrentUser:
    user_id: str
    auth_user_id: str
    university_id: str
    role: str                       # STUDENT | PROFESSOR | ADMIN
    email: str
    first_name: Optional[str]
    last_name: Optional[str]

    @property
    def name(self) -> str:
        return " ".join(p for p in (self.first_name, self.last_name) if p) or self.email.split("@")[0]

    @property
    def is_student(self) -> bool:
        return self.role == "STUDENT"

    @property
    def is_professor(self) -> bool:
        return self.role == "PROFESSOR"


class TokenVerifier(Protocol):
    def verify(self, token: str) -> Identity: ...


class SupabaseTokenVerifier:
    """Validates the JWT with Supabase Auth (works with legacy HS256 secrets and asymmetric signing keys alike)."""

    def __init__(self, url: str, service_key: str):
        from supabase import create_client
        self._client = create_client(url, service_key)

    def verify(self, token: str) -> Identity:
        try:
            res = self._client.auth.get_user(token)
            user = res.user if res else None
        except Exception:  # noqa: BLE001
            user = None
        if user is None or not getattr(user, "id", None):
            raise AppError(401, "Your session is invalid or has expired. Please sign in again.")
        return Identity(auth_user_id=str(user.id), email=(user.email or "").lower())


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise AppError(401, "Missing bearer token.")
    return token.strip()


def get_identity(request: Request) -> Identity:
    return request.app.state.token_verifier.verify(_bearer(request))


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_current_user(request: Request, identity: Identity = Depends(get_identity), db: Database = Depends(get_db)) -> CurrentUser:
    with db.tx() as c:
        row = one(c, "SELECT user_id, auth_user_id::text AS auth_user_id, university_id, role, email, first_name, last_name FROM users WHERE auth_user_id = %s",
                  (identity.auth_user_id,))
    if row is None:
        raise AppError(403, "Your profile is not set up yet.", code="profile_required")
    return CurrentUser(**row)


def require_student(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_student:
        raise AppError(403, "This action is for students.")
    return user


def require_professor(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_professor:
        raise AppError(403, "This action is for instructors.")
    return user
