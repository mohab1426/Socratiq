"""Error types for the file pipeline. Every rejection carries a stable machine code and an HTTP status so the API can
return a precise, user-presentable message (the UI must never learn about an unsupported file only after processing)."""
from __future__ import annotations


class FileRejected(Exception):
    """Upload refused during validation (nothing was stored)."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class ExtractionError(Exception):
    """A validated file could not be turned into text (corrupt content, limits exceeded, unreadable legacy file)."""

    def __init__(self, message: str, code: str = "extraction_failed"):
        super().__init__(message)
        self.code = code
