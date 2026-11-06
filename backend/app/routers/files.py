from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

from ..access import visible_file
from ..auth import CurrentUser, get_current_user, get_db
from ..config import get_backend_config
from ..db import Database
from ..errors import AppError
from ..files import registry as R
from ..files.storage import LocalObjectStorage

router = APIRouter(tags=["files"])


@router.get("/files/capabilities")
def capabilities(purpose: str = Query("MATERIAL"), role: str | None = Query(None), _: CurrentUser = Depends(get_current_user)):
    """What can be uploaded for this purpose, and what happens to each format. The frontend builds its file picker and
    helper text from this, so it can never advertise a format the backend will not process."""
    purpose = purpose.upper()
    if purpose not in R.PURPOSES:
        raise AppError(422, f"purpose must be one of {', '.join(R.PURPOSES)}")
    return R.describe(purpose, role.upper() if role else None)


@router.post("/files/{file_id}/download-link")
def download_link(file_id: str, request: Request, user: CurrentUser = Depends(get_current_user), db: Database = Depends(get_db)):
    """Authorises on EVERY call, then returns a short-lived link. Nothing about the storage location is guessable."""
    with db.tx() as c:
        f = visible_file(c, user, file_id)
    if f["status"] == "QUEUED" or f["status"] == "PROCESSING":
        pass      # the original bytes exist from upload time; allowing download while indexing is fine
    ttl = get_backend_config().file_link_ttl_seconds
    url = request.app.state.storage.signed_url(f["storage_path"], ttl, f["original_filename"])
    return {"url": url, "expires_in": ttl, "filename": f["original_filename"], "mime_type": f["mime_type"]}


@router.get("/files/dl/{token}", include_in_schema=False)
def local_download(token: str, request: Request):
    """Only meaningful for LocalObjectStorage (dev/tests). Token = HMAC(path, name, expiry); no session needed."""
    storage = request.app.state.storage
    if not isinstance(storage, LocalObjectStorage):
        raise HTTPException(404)
    data = storage.verify_token(token)
    if data is None:
        raise HTTPException(403, "link expired or invalid")
    from ..files.storage import content_disposition
    try:
        body = storage.get(data["p"])
    except FileNotFoundError:
        raise HTTPException(404) from None
    return Response(body, media_type="application/octet-stream", headers={
        "Content-Disposition": content_disposition(data["n"]), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox"})
