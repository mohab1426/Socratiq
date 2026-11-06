"""SocratiQ API application factory. Everything external is injectable (database, storage, token verifier, AI, RAG) so the
same code runs in production and in tests with only the true boundaries (Supabase Auth, LLMs) replaced."""
from __future__ import annotations

import contextlib
import logging
import time
import uuid
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_backend_config
from .db import Database
from .errors import AppError
from .files.errors import FileRejected
from .files.pipeline import FilePipeline
from .files.storage import LocalObjectStorage, build_storage
from .files.worker import IngestWorker
from .routers import ai, auth_users, files, health, smartboard, student, teacher, verification

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("socratiq")


class _Lazy:
    """Build an expensive/env-dependent component on first use, so a missing AI key never prevents the API from starting."""

    def __init__(self, factory):
        self._factory, self._obj = factory, None

    def get(self):
        if self._obj is None:
            self._obj = self._factory()
        return self._obj

    def __getattr__(self, name):
        return getattr(self.get(), name)


def create_app(*, db: Optional[Database] = None, storage: Any = None, token_verifier: Any = None, ai_adapter: Any = None, rag: Any = None,
               run_worker: Optional[bool] = None) -> FastAPI:
    cfg = get_backend_config()
    problems = cfg.validate() if db is None else []
    if problems:
        if cfg.is_production:
            raise RuntimeError("Invalid production configuration:\n - " + "\n - ".join(problems))
        for p in problems:
            log.warning("config: %s", p)
    if db is None and not cfg.database_url:
        raise RuntimeError("DATABASE_URL is required")

    _db = db or Database(cfg.database_url, cfg.db_pool_min, cfg.db_pool_max)
    _storage = storage or build_storage(cfg)
    if isinstance(_storage, LocalObjectStorage):
        _storage._base = f"{cfg.public_api_url}/api/v1/files/dl"

    def rag_factory():
        from .files.rag_bridge import build_rag_service
        return rag if rag is not None else build_rag_service()
    pipeline = FilePipeline(_db, _storage, rag_factory, max_attempts=cfg.ingest_max_attempts)
    worker = IngestWorker(pipeline, cfg.ingest_workers, cfg.ingest_poll_seconds, cfg.ingest_stale_minutes)

    def make_ai():
        from .ai_adapter import build_ai_adapter
        return build_ai_adapter(_db, pipeline.rag)

    def make_verifier():
        from .auth import SupabaseTokenVerifier
        try:
            url, key = cfg.require_supabase()
        except RuntimeError:
            raise AppError(503, "Authentication is not configured on this server.", code="auth_not_configured") from None
        return SupabaseTokenVerifier(url, key)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        if db is None:
            _db.open()
        if (cfg.run_worker if run_worker is None else run_worker):
            worker.start()
        try:
            yield
        finally:
            worker.stop()
            if db is None:
                _db.close()

    app = FastAPI(title="SocratiQ API", version="1.0.0", lifespan=lifespan,
                  docs_url=None if cfg.is_production else "/docs", redoc_url=None, openapi_url=None if cfg.is_production else "/openapi.json",
                  description="Send `Authorization: Bearer <supabase access token>` on every endpoint except /health.")
    app.state.db, app.state.storage, app.state.pipeline, app.state.worker = _db, _storage, pipeline, worker
    app.state.token_verifier = token_verifier or _Lazy(make_verifier)
    app.state.ai = ai_adapter or _Lazy(make_ai)

    if cfg.is_production and "*" in cfg.cors_origins:
        raise RuntimeError("CORS_ORIGINS must list explicit origins in production")
    app.add_middleware(CORSMiddleware, allow_origins=cfg.cors_origins, allow_origin_regex=r"^https://.*\.trycloudflare\.com$",
                       allow_credentials=True, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                       allow_headers=["Authorization", "Content-Type", "X-Request-ID"], expose_headers=["X-Request-ID"])

    @app.middleware("http")
    async def guard(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = rid
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > (cfg.max_upload_mb + 1) * 1024 * 1024:   # refuse oversize bodies before they are spooled
            return _err(request, 413, "The request is too large.", "too_large")
        start = time.monotonic()
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        log.info("request id=%s %s %s -> %s (%.0fms)", rid, request.method, request.url.path, response.status_code, (time.monotonic() - start) * 1000)
        return response

    def _err(request: Request, status: int, message: str, code: Optional[str] = None, details: Any = None) -> JSONResponse:
        body = {"status": status, "message": message, "code": code, "request_id": getattr(request.state, "request_id", None)}
        if details:
            body["details"] = details
        return JSONResponse(status_code=status, content={"error": body})

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):
        return _err(request, exc.status_code, exc.message, exc.code)

    @app.exception_handler(FileRejected)
    async def _file_rejected(request: Request, exc: FileRejected):
        return _err(request, exc.status, exc.message, exc.code)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        return _err(request, 422, "The request is not valid.", "validation_error", [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()])

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.exception("unhandled error request_id=%s", getattr(request.state, "request_id", None))
        return _err(request, 500, "Something went wrong on our side.", "internal_error")     # never leak internals

    app.include_router(health.router)
    for r in (auth_users.router, files.router, student.router, verification.router, ai.router, teacher.router, smartboard.router):
        app.include_router(r, prefix="/api/v1")
    return app


def _default_app() -> FastAPI:  # `uvicorn backend.app.main:app`
    return create_app()


try:
    app = _default_app() if get_backend_config().database_url else None
except Exception:  # noqa: BLE001  (allows importing the module for tests without DATABASE_URL)
    log.exception("could not build the default app")
    app = None
