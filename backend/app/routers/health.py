from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(tags=["health"])


@router.get("/health")
def health():
    """Liveness only: no dependencies, no secrets, safe for public probes."""
    return {"status": "ok"}


@router.get("/health/ready")
def ready(request: Request):
    ok = request.app.state.db.ping()
    return JSONResponse(status_code=200 if ok else 503, content={"status": "ready" if ok else "database_unavailable"})
