"""Bounded, streaming read of an uploaded file: never holds more than limit+1 bytes in memory."""
from __future__ import annotations

from fastapi import UploadFile

from .files.errors import FileRejected

CHUNK = 1024 * 1024


async def read_upload(file: UploadFile, max_bytes: int) -> bytes:
    if file is None or not file.filename:
        raise FileRejected("no_file", "no file was uploaded", 400)
    buf = bytearray()
    while True:
        chunk = await file.read(CHUNK)
        if not chunk:
            break
        buf += chunk
        if len(buf) > max_bytes:
            raise FileRejected("too_large", f"the file is larger than the {max_bytes // (1024 * 1024)} MB upload limit", 413)
    return bytes(buf)
