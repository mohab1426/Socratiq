"""
File pipeline:  upload -> validate -> store -> document record -> [extract -> normalise -> chunk -> embed -> index]

Synchronous part (request):  validate, put object in storage, insert `stored_files` (+ the owning row) in ONE DB
transaction (object deleted again if the transaction fails).
Asynchronous part (worker):  claim a QUEUED file atomically (FOR UPDATE SKIP LOCKED), read the object, run the AI's
RAGService with the format-aware parser, then reconcile `documents` / `stored_files` / `materials` in one transaction.
Files that are not indexed (EXTRACT_ONLY / STORAGE_ONLY) never touch RAG.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, Optional

import psycopg
from psycopg import errors as pgerr

from ..db import Database, many, new_id, one
from . import registry as R
from .errors import ExtractionError, FileRejected
from .extractors import Extracted, extract
from .rag_bridge import FileHint, use_hint
from .storage import ObjectStorage, object_key
from .validation import ValidatedFile

log = logging.getLogger("socratiq.files")
NON_RETRYABLE = (ExtractionError, FileRejected)


def _err_text(exc: Exception) -> str:
    if isinstance(exc, (ExtractionError, FileRejected)):
        return str(exc)[:500]
    name = type(exc).__name__
    if name == "IngestionError":
        return str(exc)[:500]
    return "Processing failed unexpectedly. It will be retried automatically or you can retry it."


class FilePipeline:
    def __init__(self, db: Database, storage: ObjectStorage, rag_factory: Callable[[], Any], max_attempts: int = 3):
        self.db, self.storage, self._rag_factory, self.max_attempts = db, storage, rag_factory, max_attempts
        self._rag = None

    @property
    def rag(self):
        if self._rag is None:
            self._rag = self._rag_factory()
        return self._rag

    # ------------------------------------------------------------ request side
    def save(self, conn: psycopg.Connection, vf: ValidatedFile, data: bytes, *, purpose: str, uploader_id: str,
             university_id: str, course_id: str, classroom_id: Optional[str], role: Optional[str] = None,
             extra_meta: Optional[dict] = None) -> tuple[dict, str]:
        """Put the object in storage and insert the stored_files row inside the caller's transaction.
        Returns (row, storage_key). The CALLER must delete `storage_key` if its transaction later fails (see `rollback_object`)."""
        mode, note = R.mode_for(vf.spec, purpose, role)
        file_id = new_id("file")
        key = object_key(university_id, course_id, purpose, file_id)
        self.storage.put(key, data, vf.mime_type)
        status = "STORED_ONLY" if mode == R.STORAGE_ONLY else ("QUEUED" if mode == R.RAG else "PROCESSING")
        try:
            row = one(conn, """
                INSERT INTO stored_files (file_id, university_id, course_id, classroom_id, uploader_id, purpose, original_filename,
                  extension, mime_type, declared_mime_type, kind, size_bytes, sha256, storage_bucket, storage_path, index_mode,
                  status, processing_note, page_count, extraction_meta)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb) RETURNING *""",
                (file_id, university_id, course_id, classroom_id, uploader_id, purpose, vf.original_filename, vf.extension,
                 vf.mime_type, vf.declared_mime_type, vf.spec.kind, vf.size_bytes, vf.sha256, self.storage.bucket, key, mode,
                 "QUEUED" if status == "PROCESSING" else status, note, vf.page_count,
                 json.dumps({"warnings": vf.warnings, **(extra_meta or {})})))
        except Exception:
            self.rollback_object(key)
            raise
        return row, key

    def rollback_object(self, key: str) -> None:
        try:
            self.storage.delete(key)
        except Exception:  # noqa: BLE001
            log.warning("could not remove orphan object %s", key)

    @staticmethod
    def extract_now(vf: ValidatedFile, data: bytes) -> Extracted:
        """EXTRACT_ONLY path (assignment prompt files, student submissions): synchronous, never indexed."""
        return extract(vf.spec, data)

    @staticmethod
    def mark_done(conn: psycopg.Connection, file_id: str, ex: Extracted) -> dict:
        """Finish an EXTRACT_ONLY file: READY when text was extracted, otherwise STORED_ONLY with an honest note."""
        chars = sum(len(t) for _, t in ex.pages)
        conn.execute("UPDATE stored_files SET status='PROCESSING' WHERE file_id=%s AND status='QUEUED'", (file_id,))
        if ex.pages:
            return one(conn, "UPDATE stored_files SET status='READY', extracted_chars=%s, page_count=%s, extraction_meta = extraction_meta || %s::jsonb WHERE file_id=%s RETURNING *",
                       (chars, len(ex.pages), json.dumps({"warnings": ex.warnings, **ex.metadata}), file_id))
        return one(conn, "UPDATE stored_files SET status='STORED_ONLY', processing_note=%s, extraction_meta = extraction_meta || %s::jsonb WHERE file_id=%s RETURNING *",
                   ("Stored, but no text could be extracted (" + ", ".join(ex.warnings or ["empty"]) + ").",
                    json.dumps({"warnings": ex.warnings, **ex.metadata}), file_id))

    # ------------------------------------------------------------ worker side
    def claim_next(self) -> Optional[dict]:
        with self.db.tx() as c:
            return one(c, """
                UPDATE stored_files SET status='PROCESSING'
                 WHERE file_id = (SELECT file_id FROM stored_files WHERE status='QUEUED' AND index_mode='RAG'
                                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
             RETURNING *""")

    def claim(self, file_id: str) -> Optional[dict]:
        with self.db.tx() as c:
            return one(c, "UPDATE stored_files SET status='PROCESSING' WHERE file_id=%s AND status='QUEUED' AND index_mode='RAG' RETURNING *", (file_id,))

    def requeue_stale(self, minutes: int) -> int:
        with self.db.tx() as c:
            return c.execute("UPDATE stored_files SET status='QUEUED' WHERE status='PROCESSING' AND locked_at < now() - make_interval(mins => %s)",
                             (minutes,)).rowcount

    def process(self, file_id: Optional[str] = None, row: Optional[dict] = None) -> Optional[str]:
        """Process one claimed file. Returns the final status, or None if nothing was claimed."""
        row = row or (self.claim(file_id) if file_id else self.claim_next())
        if row is None:
            return None
        fid = row["file_id"]
        try:
            self._index(row)
            return "READY"
        except Exception as exc:  # noqa: BLE001
            retry = not isinstance(exc, NON_RETRYABLE) and type(exc).__name__ != "IngestionError" and row["attempts"] < self.max_attempts
            log.warning("file %s failed (attempt %s, retry=%s): %s", fid, row["attempts"], retry, exc, exc_info=not isinstance(exc, NON_RETRYABLE))
            with self.db.tx() as c:
                if retry:
                    c.execute("UPDATE stored_files SET status='QUEUED', processing_note=%s WHERE file_id=%s", ("Retrying after a temporary error.", fid))
                    return "QUEUED"
                c.execute("UPDATE stored_files SET status='FAILED', processing_error=%s WHERE file_id=%s", (_err_text(exc), fid))
                c.execute("UPDATE documents SET processing_status='failed', processing_error=%s WHERE document_id=(SELECT document_id FROM stored_files WHERE file_id=%s)",
                          (_err_text(exc), fid))
            return "FAILED"

    def _index(self, row: dict) -> None:
        import hashlib
        spec = R.get_spec(row["extension"])
        data = self.storage.get(row["storage_path"])
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ExtractionError("stored object does not match its recorded hash (corrupted upload)", code="integrity")
        assignment_ids = None
        if row["purpose"] == R.ATTACHMENT:
            with self.db.tx() as c:
                assignment_ids = [r["assignment_id"] for r in many(c, "SELECT assignment_id FROM assignment_attachments WHERE file_id=%s", (row["file_id"],))] or None
        hint = FileHint(spec, row["original_filename"], row["storage_bucket"], row["storage_path"])
        with use_hint(hint):
            md = self.rag.ingest_document(data, university_id=row["university_id"], course_id=row["course_id"],
                                          classroom_id=row["classroom_id"], uploader_id=row["uploader_id"],
                                          filename=row["original_filename"], assignment_ids=assignment_ids)
        self._reconcile(row, md, spec)

    def _reconcile(self, row: dict, md, spec: R.FormatSpec) -> None:
        """The AI persists its `documents` row while status is still 'embedding' and never updates it, and never fills
        content_hash. The backend owns the truth about the outcome, so it records it here, in one transaction."""
        with self.db.tx() as c:
            doc = one(c, "SELECT document_id, university_id, course_id FROM documents WHERE document_id=%s", (md.document_id,))
            if doc is None or doc["university_id"] != row["university_id"] or doc["course_id"] != row["course_id"]:
                raise RuntimeError("RAG produced a document outside the file's tenant scope; refusing to link it")
            c.execute("""UPDATE documents SET processing_status='stored', processing_error=NULL, content_hash=%s, file_type=%s, mime_type=%s,
                           extension=%s, size_bytes=%s, document_kind=%s, processed_at=now() WHERE document_id=%s""",
                      (row["sha256"], row["mime_type"], row["mime_type"], row["extension"], row["size_bytes"], row["kind"], md.document_id))
            if md.total_chunks and md.total_chunks > 0:
                c.execute("UPDATE stored_files SET status='READY', document_id=%s, page_count=%s, processing_note=NULL, processing_error=NULL, extraction_meta = extraction_meta || %s::jsonb WHERE file_id=%s",
                          (md.document_id, md.total_pages, json.dumps({"chunks": md.total_chunks}), row["file_id"]))
            else:
                c.execute("UPDATE stored_files SET status='STORED_ONLY', document_id=%s, processing_note=%s WHERE file_id=%s",
                          (md.document_id, "Stored, but no indexable text was found.", row["file_id"]))
            c.execute("UPDATE materials SET document_id=%s WHERE file_id=%s", (md.document_id, row["file_id"]))

    # ------------------------------------------------------------ deletion
    def delete_file(self, file_id: str) -> None:
        """Remove a file everywhere: retrieval index, link rows, DB record, then the stored object."""
        with self.db.tx() as c:
            row = one(c, "SELECT * FROM stored_files WHERE file_id=%s FOR UPDATE", (file_id,))
            if row is None:
                return
            if row["document_id"]:
                c.execute("DELETE FROM assignment_materials WHERE document_id=%s", (row["document_id"],))
            c.execute("DELETE FROM materials WHERE file_id=%s", (file_id,))
            c.execute("DELETE FROM stored_files WHERE file_id=%s", (file_id,))
        if row["document_id"]:
            try:
                self.rag.vector_store.delete_document(row["document_id"])
            except Exception:  # noqa: BLE001  (orphan chunks are unreachable: retrieval is whitelisted by live rows)
                log.warning("could not delete indexed document %s", row["document_id"])
        try:
            self.storage.delete(row["storage_path"])
        except Exception:  # noqa: BLE001
            log.warning("could not delete object %s", row["storage_path"])
