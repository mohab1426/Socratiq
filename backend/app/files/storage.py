"""Object storage for uploaded files. Private by construction: objects are addressed by opaque server-generated keys
(never by filename), and every download goes through an authorised, expiring link (Supabase signed URL, or an
HMAC-signed backend URL for local dev/tests)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Optional, Protocol
from urllib.parse import quote


class ObjectStorage(Protocol):
    bucket: str

    def put(self, path: str, data: bytes, content_type: str) -> None: ...
    def get(self, path: str) -> bytes: ...
    def delete(self, path: str) -> None: ...
    def signed_url(self, path: str, expires_in: int, download_name: str) -> str: ...


def object_key(university_id: str, course_id: str, purpose: str, file_id: str) -> str:
    """Opaque key. No filename, no extension: a guessable/hostile filename can never influence where bytes land."""
    return f"{university_id}/{course_id}/{purpose.lower()}/{file_id}"


def _safe_join(root: Path, key: str) -> Path:
    p = (root / key).resolve()
    if root.resolve() not in p.parents:
        raise ValueError("path escapes storage root")
    return p


class LocalObjectStorage:
    """Filesystem storage for development and tests."""

    def __init__(self, root: Path, bucket: str = "local", secret: Optional[str] = None, base_url: str = "/api/v1/files/dl"):
        self.root, self.bucket, self._secret, self._base = Path(root), bucket, secret or "dev", base_url
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, path, data, content_type):
        p = _safe_join(self.root, path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)                                    # atomic

    def get(self, path):
        return _safe_join(self.root, path).read_bytes()

    def delete(self, path):
        try:
            _safe_join(self.root, path).unlink()
        except FileNotFoundError:
            pass

    def signed_url(self, path, expires_in, download_name):
        payload = base64.urlsafe_b64encode(json.dumps({"p": path, "n": download_name, "e": int(time.time()) + expires_in}).encode()).decode()
        sig = hmac.new(self._secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return f"{self._base}/{payload}.{sig}"

    def verify_token(self, token: str) -> Optional[dict]:
        try:
            payload, sig = token.rsplit(".", 1)
            good = hmac.new(self._secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, good):
                return None
            data = json.loads(base64.urlsafe_b64decode(payload.encode()))
            return data if data["e"] >= time.time() else None
        except Exception:  # noqa: BLE001
            return None


class SupabaseObjectStorage:
    def __init__(self, url: str, service_key: str, bucket: str):
        from supabase import create_client
        self._client = create_client(url, service_key)
        self.bucket = bucket

    def _b(self):
        return self._client.storage.from_(self.bucket)

    def put(self, path, data, content_type):
        self._b().upload(path, data, {"content-type": content_type, "upsert": "false"})

    def get(self, path):
        return self._b().download(path)

    def delete(self, path):
        self._b().remove([path])

    def signed_url(self, path, expires_in, download_name):
        res = self._b().create_signed_url(path, expires_in, {"download": download_name})
        url = res.get("signedURL") or res.get("signedUrl") or ""
        if url.startswith("/"):
            url = f"{self._client.supabase_url.rstrip('/')}/storage/v1{url}"
        return url


def content_disposition(filename: str) -> str:
    """RFC 6266 attachment header that is safe for any Unicode name."""
    ascii_name = filename.encode("ascii", "replace").decode().replace("?", "_").replace('"', "'")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def build_storage(cfg) -> ObjectStorage:
    if cfg.storage_backend == "supabase":
        url, key = cfg.require_supabase()
        return SupabaseObjectStorage(url, key, cfg.storage_bucket)
    return LocalObjectStorage(cfg.local_storage_dir, bucket=cfg.storage_bucket, secret=cfg.link_secret())
