"""
Document storage layer providing isolated storage for uploaded course files.

Supports Local filesystem storage and Supabase Storage backend.
Never mixes files across universities, courses, or classrooms.
Provides canonical byte-normalization to prevent multi-consumer EOF stream issues.
"""
from __future__ import annotations

import io
import logging
import os
from pathlib import Path
from typing import BinaryIO, Optional, Protocol, Tuple, Union, runtime_checkable

from ai.rag.config import get_rag_config
from ai.rag.models import DocumentMetadata, ProviderError

logger = logging.getLogger(__name__)


def normalize_file_input(
    file_input: Union[str, Path, bytes, BinaryIO],
    default_filename: Optional[str] = None,
) -> Tuple[bytes, str]:
    """Canonical input normalizer converting any valid file input into immutable bytes.

    Prevents stream exhaustion bugs where one component reads a file-like stream
    and passes an empty stream to subsequent parsers or storage engines.
    """
    if isinstance(file_input, (str, Path)):
        p = Path(file_input)
        if not p.is_file():
            raise FileNotFoundError(f"Source file not found: {file_input}")
        return p.read_bytes(), default_filename or p.name

    if isinstance(file_input, bytes):
        return file_input, default_filename or "document.pdf"

    if hasattr(file_input, "read"):
        filename = getattr(file_input, "name", None) or default_filename or "document.pdf"
        pos = file_input.tell() if hasattr(file_input, "tell") else None
        content = file_input.read()
        if isinstance(content, str):
            content = content.encode("utf-8")
        # Attempt to rewind for caller politeness
        if pos is not None and hasattr(file_input, "seek"):
            try:
                file_input.seek(pos)
            except Exception:
                pass
        return content, Path(filename).name

    raise ValueError(f"Unsupported file_input type: {type(file_input)}")


@runtime_checkable
class DocumentStorage(Protocol):
    """Abstract interface for document file storage."""

    def save(
        self,
        metadata: DocumentMetadata,
        file_content: Union[bytes, BinaryIO],
    ) -> str:
        """Save file content and return storage path."""
        ...

    def load(self, storage_path: str) -> bytes:
        """Load stored file content as bytes."""
        ...

    def delete(self, storage_path: str) -> bool:
        """Delete stored file."""
        ...


class LocalFileStorage:
    """Stores documents on local disk using an isolated directory tree:

    {base_dir}/{university_id}/{course_id}/{classroom_id}/{document_id}_{filename}
    """

    def __init__(
        self,
        base_dir: Optional[str] = None,
        base_path: Optional[str] = None,
    ) -> None:
        cfg = get_rag_config()
        self.base_dir = Path(base_dir or base_path or cfg.local_storage_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _get_target_path(self, metadata: DocumentMetadata) -> Path:
        classroom_folder = metadata.classroom_id or "all_classrooms"
        target_dir = (
            self.base_dir
            / metadata.university_id
            / metadata.course_id
            / classroom_folder
        )
        target_dir.mkdir(parents=True, exist_ok=True)
        safe_filename = f"{metadata.document_id}_{Path(metadata.filename).name}"
        return target_dir / safe_filename

    def save(
        self,
        metadata: DocumentMetadata,
        file_content: Union[bytes, BinaryIO],
    ) -> str:
        target_file = self._get_target_path(metadata)
        content_bytes, _ = normalize_file_input(file_content, default_filename=metadata.filename)
        target_file.write_bytes(content_bytes)
        return str(target_file)

    def load(self, storage_path: str) -> bytes:
        p = Path(storage_path)
        if not p.is_file():
            raise FileNotFoundError(f"Stored document not found: {storage_path}")
        return p.read_bytes()

    def delete(self, storage_path: str) -> bool:
        p = Path(storage_path)
        if p.is_file():
            p.unlink()
            return True
        return False


LocalStorage = LocalFileStorage


class SupabaseStorage:
    """Supabase Storage client using isolated bucket folders.

    Path format: {university_id}/{course_id}/{classroom_id}/{document_id}_{filename}
    Fallback to local disk is governed strictly by configuration (disabled in production).
    """

    def __init__(
        self,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        bucket_name: Optional[str] = None,
        cfg: Optional[RAGConfig] = None,
    ) -> None:
        self.cfg = cfg or get_rag_config()
        self.supabase_url = supabase_url if supabase_url is not None else self.cfg.supabase_url
        self.supabase_key = supabase_key if supabase_key is not None else self.cfg.supabase_key
        self.bucket_name = bucket_name or self.cfg.supabase_bucket
        self._fallback = LocalFileStorage(base_dir=self.cfg.local_storage_dir)

    def is_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_key)

    def save(
        self,
        metadata: DocumentMetadata,
        file_content: Union[bytes, BinaryIO],
    ) -> str:
        content_bytes, _ = normalize_file_input(file_content, default_filename=metadata.filename)

        if not self.is_configured():
            if self.cfg.storage_fallback_on_error:
                logger.warning("Supabase storage not configured; using local storage fallback.")
                return self._fallback.save(metadata, content_bytes)
            raise ProviderError("SupabaseStorage is not configured and storage fallback is disabled.")

        classroom_folder = metadata.classroom_id or "all_classrooms"
        storage_key = (
            f"{metadata.university_id}/{metadata.course_id}/{classroom_folder}/"
            f"{metadata.document_id}_{Path(metadata.filename).name}"
        )

        try:
            import httpx

            url = f"{self.supabase_url}/storage/v1/object/{self.bucket_name}/{storage_key}"
            headers = {
                "Authorization": f"Bearer {self.supabase_key}",
                "apikey": self.supabase_key,
                "Content-Type": "application/pdf",
            }
            resp = httpx.post(url, content=content_bytes, headers=headers, timeout=30.0)
            resp.raise_for_status()
            return f"supabase://{self.bucket_name}/{storage_key}"
        except Exception as exc:
            if self.cfg.storage_fallback_on_error:
                logger.warning("Supabase storage upload failed; using local storage fallback: %s", exc)
                return self._fallback.save(metadata, content_bytes)
            logger.exception("Supabase storage upload failed: %s", exc)
            raise ProviderError(f"SupabaseStorage save failed: {exc}") from exc

    def load(self, storage_path: str) -> bytes:
        if storage_path.startswith("supabase://") and self.is_configured():
            try:
                import httpx

                key = storage_path.replace(f"supabase://{self.bucket_name}/", "")
                url = f"{self.supabase_url}/storage/v1/object/authenticated/{self.bucket_name}/{key}"
                headers = {
                    "Authorization": f"Bearer {self.supabase_key}",
                    "apikey": self.supabase_key,
                }
                resp = httpx.get(url, headers=headers, timeout=30.0)
                resp.raise_for_status()
                return resp.content
            except Exception as exc:
                if self.cfg.storage_fallback_on_error:
                    logger.warning("Supabase storage download failed; falling back to local: %s", exc)
                    return self._fallback.load(storage_path)
                logger.exception("Supabase storage download failed: %s", exc)
                raise ProviderError(f"SupabaseStorage load failed: {exc}") from exc

        return self._fallback.load(storage_path)

    def delete(self, storage_path: str) -> bool:
        if storage_path.startswith("supabase://") and self.is_configured():
            try:
                import httpx

                key = storage_path.replace(f"supabase://{self.bucket_name}/", "")
                url = f"{self.supabase_url}/storage/v1/object/{self.bucket_name}/{key}"
                headers = {
                    "Authorization": f"Bearer {self.supabase_key}",
                    "apikey": self.supabase_key,
                }
                resp = httpx.delete(url, headers=headers, timeout=10.0)
                return resp.status_code in (200, 204)
            except Exception:
                return False

        return self._fallback.delete(storage_path)


# Backward-compatibility alias
SupabaseDocumentStorage = SupabaseStorage


def get_document_storage() -> DocumentStorage:
    """Factory returning configured storage engine."""
    cfg = get_rag_config()
    if cfg.storage_backend == "supabase":
        storage = SupabaseStorage()
        if storage.is_configured() or not cfg.storage_fallback_on_error:
            return storage
    return LocalFileStorage()
