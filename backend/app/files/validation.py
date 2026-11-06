"""Upload validation: everything that can be decided BEFORE anything is stored.

Order: filename -> extension supported for this purpose -> size -> declared MIME coherence -> CONTENT check
(magic bytes + structural checks). The client-declared MIME and the extension are never trusted on their own; the
stored MIME is the registry's canonical type for the content we verified.

Nothing here executes uploaded content: no eval/exec, no subprocess, no shell. Parsers used are in-process libraries
(PyMuPDF, python-docx/pptx, openpyxl, xlrd, olefile, Pillow) with size / page / member limits applied first.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field
from typing import Optional

import olefile

from . import registry as R
from .errors import FileRejected
from .textutil import decode_text

MAX_ZIP_MEMBERS = 5_000
MAX_ZIP_UNCOMPRESSED = 250 * R.MB
MAX_ZIP_RATIO = 200
MAX_PDF_PAGES = 500
MAX_IMAGE_PIXELS = 50_000_000
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
_BAD_CHARS = re.compile(r'[<>:"|?*\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\u200b-\u200f]')


@dataclass
class ValidatedFile:
    original_filename: str          # sanitised display name (never used as a storage path)
    extension: str
    spec: R.FormatSpec
    mime_type: str                  # canonical, server-determined
    declared_mime_type: Optional[str]
    size_bytes: int
    sha256: str
    page_count: Optional[int] = None
    warnings: list[str] = field(default_factory=list)


def sanitize_filename(raw: str, max_len: int = 120) -> str:
    """Safe display filename: no path parts, no control/bidi characters, no reserved names. Unicode letters (e.g. Arabic)
    are preserved. The result is only ever shown or sent in Content-Disposition; storage keys never contain it."""
    name = unicodedata.normalize("NFKC", raw or "")
    name = name.replace("\\", "/").split("/")[-1]
    name = _BAD_CHARS.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    name = re.sub(r"^\.+", "", name)
    if not name:
        return "file"
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.lower() in _RESERVED:
        stem = "_" + stem
    room = max_len - (len(ext) + 1 if ext else 0)
    stem = stem[:max(1, room)].rstrip(" .") or "file"
    return f"{stem}.{ext}" if ext else stem


def split_extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


# ------------------------------------------------------------------ content validators
def _zip_safety(data: bytes, required: str, what: str) -> None:
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise FileRejected("content_mismatch", f"file is not a valid {what}. It may be corrupt, password-protected or renamed from another type", 415)
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        infos = z.infolist()
    except zipfile.BadZipFile as exc:
        raise FileRejected("corrupt", f"the {what} is corrupt: {exc}", 400) from exc
    if len(infos) > MAX_ZIP_MEMBERS:
        raise FileRejected("archive_too_complex", f"the {what} has too many internal parts", 400)
    total = 0
    names = set()
    for i in infos:
        n = i.filename
        if n.startswith("/") or ".." in n.split("/") or "\\" in n:
            raise FileRejected("unsafe_archive", f"the {what} contains unsafe internal paths", 400)
        if i.flag_bits & 0x1:
            raise FileRejected("encrypted", f"the {what} is encrypted", 400)
        total += i.file_size
        if i.compress_size and i.file_size > R.MB and i.file_size / i.compress_size > MAX_ZIP_RATIO:
            raise FileRejected("archive_bomb", f"the {what} has a suspicious compression ratio", 400)
        names.add(n)
        if n.lower().endswith("vbaproject.bin"):
            raise FileRejected("macros", f"the {what} contains macros, which are not accepted", 415)
    if total > MAX_ZIP_UNCOMPRESSED:
        raise FileRejected("archive_bomb", f"the {what} expands to more than {MAX_ZIP_UNCOMPRESSED // R.MB} MB", 400)
    if "[Content_Types].xml" not in names or required not in names:
        raise FileRejected("content_mismatch", f"file does not look like a real {what}", 415)
    ct = z.read("[Content_Types].xml")[:200_000].lower()
    if b"macroenabled" in ct:
        raise FileRejected("macros", f"the {what} is macro-enabled, which is not accepted", 415)


def _v_pdf(data, vf, ctx):
    if b"%PDF-" not in data[:1024]:
        raise FileRejected("content_mismatch", "file is not a valid PDF (missing %PDF header)", 415)
    if b"/Launch" in data:
        raise FileRejected("active_content", "PDF contains a launch action, which is not accepted", 415)
    import pymupdf
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise FileRejected("corrupt", f"PDF cannot be opened: {exc}", 400) from exc
    try:
        if doc.needs_pass or doc.is_encrypted:
            raise FileRejected("encrypted", "PDF is password-protected", 400)
        if doc.page_count < 1:
            raise FileRejected("empty", "PDF has no pages", 400)
        if doc.page_count > MAX_PDF_PAGES:
            raise FileRejected("too_many_pages", f"PDF has {doc.page_count} pages (limit {MAX_PDF_PAGES}); split it", 413)
        vf.page_count = doc.page_count
    finally:
        doc.close()
    if b"/JavaScript" in data or b"/JS" in data:
        vf.warnings.append("pdf_contains_javascript")     # never executed by us; served as a download only


def _ooxml(required, what):
    def check(data, vf, ctx):
        _zip_safety(data, required, what)
    return check


def _ole(stream_names, what, encrypted_marker=None):
    def check(data, vf, ctx):
        if not olefile.isOleFile(data):
            raise FileRejected("content_mismatch", f"file is not a real {what} (it may be a renamed file or an encrypted OOXML package)", 415)
        try:
            with olefile.OleFileIO(io.BytesIO(data)) as ole:
                if not any(ole.exists(s) for s in stream_names):
                    raise FileRejected("content_mismatch", f"file is not a {what}", 415)
                if any(ole.exists(m) for m in ("Macros", "_VBA_PROJECT_CUR", "VBA")):
                    raise FileRejected("macros", f"the {what} contains macros, which are not accepted", 415)
                if encrypted_marker and ole.exists(encrypted_marker):
                    raise FileRejected("encrypted", f"the {what} is password-protected", 400)
        except FileRejected:
            raise
        except Exception as exc:  # noqa: BLE001
            raise FileRejected("corrupt", f"the {what} is corrupt: {exc}", 400) from exc
    return check


def _v_doc(data, vf, ctx):
    _ole(("WordDocument",), "Word 97-2003 document")(data, vf, ctx)
    from .legacy_office import word_is_encrypted
    if word_is_encrypted(data):
        raise FileRejected("encrypted", "the Word document is password-protected", 400)


def _v_xls(data, vf, ctx):
    _ole(("Workbook", "Book"), "Excel 97-2003 workbook")(data, vf, ctx)
    import xlrd
    try:
        xlrd.open_workbook(file_contents=data, on_demand=True).release_resources()
    except xlrd.biffh.XLRDError as exc:
        raise FileRejected("encrypted" if "crypt" in str(exc).lower() else "corrupt", f"Excel file cannot be read: {exc}", 400) from exc


def _image(fmt_name):
    def check(data, vf, ctx):
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        try:
            img = Image.open(io.BytesIO(data))
            fmt, (w, h) = img.format, img.size
            img.verify()
        except Image.DecompressionBombError as exc:
            raise FileRejected("image_too_large", "image dimensions are too large", 413) from exc
        except Exception as exc:  # noqa: BLE001
            raise FileRejected("content_mismatch", f"file is not a valid {fmt_name} image: {exc}", 415) from exc
        if fmt != fmt_name:
            raise FileRejected("content_mismatch", f"file content is {fmt}, not {fmt_name}", 415)
        if w * h > MAX_IMAGE_PIXELS:
            raise FileRejected("image_too_large", f"image is {w}x{h}; the limit is {MAX_IMAGE_PIXELS // 1_000_000} megapixels", 413)
    return check


def _v_text(data, vf, ctx):
    decode_text(data)


def _v_ipynb(data, vf, ctx):
    text, _ = decode_text(data)
    try:
        nb = json.loads(text)
    except ValueError as exc:
        raise FileRejected("content_mismatch", f"not a valid Jupyter notebook (invalid JSON): {exc}", 415) from exc
    if not isinstance(nb, dict) or not isinstance(nb.get("cells"), list):
        raise FileRejected("content_mismatch", "not a Jupyter notebook (no cells)", 415)


VALIDATORS = {
    "pdf": _v_pdf,
    "ooxml_word": _ooxml("word/document.xml", "Word (.docx) document"),
    "ooxml_ppt": _ooxml("ppt/presentation.xml", "PowerPoint (.pptx) presentation"),
    "ooxml_xl": _ooxml("xl/workbook.xml", "Excel (.xlsx) workbook"),
    "ole_word": _v_doc,
    "ole_ppt": _ole(("PowerPoint Document",), "PowerPoint 97-2003 presentation", "EncryptedSummary"),
    "ole_xl": _v_xls,
    "png": _image("PNG"),
    "jpeg": _image("JPEG"),
    "text": _v_text,
    "ipynb": _v_ipynb,
}


# ------------------------------------------------------------------ entry point
def validate_upload(filename: str, declared_mime: Optional[str], data: bytes, purpose: str,
                    role: Optional[str] = None, caps: Optional[dict] = None, max_bytes_override: Optional[int] = None) -> ValidatedFile:
    if purpose not in R.PURPOSES:
        raise ValueError(f"unknown purpose {purpose!r}")
    safe = sanitize_filename(filename)
    ext = split_extension(safe)
    if not ext:
        raise FileRejected("no_extension", "the file needs an extension such as .pdf or .docx", 415)
    spec = R.get_spec(ext)
    if spec is None:
        why = R.BLOCKED.get(ext)
        raise FileRejected("unsupported_type", f".{ext} files are not accepted" + (f": {why}" if why else ""), 415)
    size = len(data)
    if size == 0:
        raise FileRejected("empty", "the file is empty", 400)
    limit = min(spec.max_bytes, max_bytes_override) if max_bytes_override else spec.max_bytes
    if size > limit:
        raise FileRejected("too_large", f".{ext} files can be at most {limit // R.MB} MB (this one is {size / R.MB:.1f} MB)", 413)
    if not spec.declared_mime_ok(declared_mime or ""):
        raise FileRejected("mime_mismatch", f"the file is labelled {declared_mime!r} but its extension is .{ext}", 415)

    vf = ValidatedFile(original_filename=safe, extension=ext, spec=spec, mime_type=spec.mime,
                       declared_mime_type=(declared_mime or None), size_bytes=size,
                       sha256=hashlib.sha256(data).hexdigest())
    VALIDATORS[spec.validator](data, vf, {"purpose": purpose, "role": role})
    mode, note = R.mode_for(spec, purpose, role, caps)
    if note:
        vf.warnings.append(note)
    return vf
