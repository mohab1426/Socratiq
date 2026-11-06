"""Single source of truth for which formats are supported, for which purpose, and HOW they are processed.

The upload API, the validators, the processing pipeline AND the frontend's accepted-file list (via
GET /files/capabilities) are all derived from this table, so the UI can never advertise a format the backend
cannot really process. If a format cannot be processed reliably in this deployment (e.g. OCR engine missing) the
registry downgrades it to STORAGE_ONLY and says so; it never pretends.
"""
from __future__ import annotations

import functools
import importlib.util
from dataclasses import dataclass
from typing import Optional

MB = 1024 * 1024

# purposes (stored_files.purpose)
MATERIAL, ATTACHMENT, SUBMISSION = "MATERIAL", "ASSIGNMENT_ATTACHMENT", "SUBMISSION"
PURPOSES = (MATERIAL, ATTACHMENT, SUBMISSION)
# index modes (stored_files.index_mode)
RAG, EXTRACT_ONLY, STORAGE_ONLY = "RAG", "EXTRACT_ONLY", "STORAGE_ONLY"
# kinds (stored_files.kind)
DOCUMENT, PRESENTATION, SPREADSHEET, TEXT, CODE, IMAGE = "DOCUMENT", "PRESENTATION", "SPREADSHEET", "TEXT", "CODE", "IMAGE"

GENERIC_MIMES = frozenset({"", "application/octet-stream", "binary/octet-stream", "application/x-unknown-content-type",
                           "application/download", "application/force-download"})
_TEXTUAL_APP_MIMES = frozenset({"application/json", "application/xml", "application/javascript", "application/x-javascript",
                                "application/x-yaml", "application/yaml", "application/x-python-code", "application/x-python",
                                "application/sql", "application/x-tex", "application/x-latex", "application/x-ipynb+json",
                                "application/x-httpd-php", "application/x-sh"})

# extensions we refuse by name, with a helpful reason (anything unknown is refused too; this only improves the message)
BLOCKED = {
    **{e: "executable or script that could be run on a user's machine" for e in
       ("exe", "dll", "bat", "cmd", "com", "scr", "msi", "jar", "apk", "app", "sh", "bash", "ps1", "vbs", "wsf", "lnk", "iso", "dmg")},
    **{e: "macro-enabled Office file (macros are never accepted)" for e in ("docm", "xlsm", "pptm", "dotm", "xltm", "potm", "xlsb")},
    **{e: "archive (not opened for safety); upload the individual files" for e in ("zip", "rar", "7z", "tar", "gz", "tgz", "bz2")},
    "svg": "SVG can carry scripts; upload a PNG or JPG instead",
    "rtf": "RTF is not supported; save the file as .docx or .pdf",
    "odt": "OpenDocument is not supported; save the file as .docx or .pdf",
    "pages": "Apple Pages is not supported; export as .pdf or .docx",
}


@dataclass(frozen=True)
class FormatSpec:
    ext: str
    kind: str
    label: str
    mime: str                       # canonical MIME we store and serve (never the client's claim)
    validator: str                  # key in validation.VALIDATORS
    extractor: Optional[str]        # key in extractors.EXTRACTORS; None => storage-only
    max_bytes: int
    accepted_mimes: frozenset = frozenset()
    requires: Optional[str] = None  # runtime capability needed to extract ("ocr")
    language: Optional[str] = None  # code-fence language for CODE

    def declared_mime_ok(self, declared: str) -> bool:
        d = (declared or "").split(";")[0].strip().lower()
        if d in GENERIC_MIMES or d == self.mime or d in self.accepted_mimes:
            return True
        if self.kind in (TEXT, CODE) and (d.startswith("text/") or d in _TEXTUAL_APP_MIMES):
            return True
        return False


def _s(ext, kind, label, mime, validator, extractor, mb, accepted=(), requires=None, language=None):
    return FormatSpec(ext, kind, label, mime, validator, extractor, int(mb * MB), frozenset(accepted), requires, language)


_OOXML = "application/vnd.openxmlformats-officedocument."
_SPECS = [
    _s("pdf", DOCUMENT, "PDF", "application/pdf", "pdf", "pdf", 40, ["application/x-pdf"]),
    _s("docx", DOCUMENT, "Word document", _OOXML + "wordprocessingml.document", "ooxml_word", "docx", 25),
    _s("doc", DOCUMENT, "Word 97-2003 document", "application/msword", "ole_word", "doc", 25),
    _s("pptx", PRESENTATION, "PowerPoint presentation", _OOXML + "presentationml.presentation", "ooxml_ppt", "pptx", 50),
    _s("ppt", PRESENTATION, "PowerPoint 97-2003 presentation", "application/vnd.ms-powerpoint", "ole_ppt", "ppt", 50),
    _s("xlsx", SPREADSHEET, "Excel workbook", _OOXML + "spreadsheetml.sheet", "ooxml_xl", "xlsx", 15),
    _s("xls", SPREADSHEET, "Excel 97-2003 workbook", "application/vnd.ms-excel", "ole_xl", "xls", 15),
    _s("csv", SPREADSHEET, "CSV table", "text/csv", "text", "csv", 10, ["application/csv", "application/vnd.ms-excel"]),
    _s("tsv", SPREADSHEET, "TSV table", "text/tab-separated-values", "text", "csv", 10),
    _s("txt", TEXT, "Plain text", "text/plain", "text", "text", 5),
    _s("md", TEXT, "Markdown", "text/markdown", "text", "markdown", 5, ["text/x-markdown"]),
    _s("png", IMAGE, "PNG image", "image/png", "png", "image_ocr", 10, requires="ocr"),
    _s("jpg", IMAGE, "JPEG image", "image/jpeg", "jpeg", "image_ocr", 10, ["image/jpg", "image/pjpeg"], requires="ocr"),
    _s("jpeg", IMAGE, "JPEG image", "image/jpeg", "jpeg", "image_ocr", 10, ["image/jpg", "image/pjpeg"], requires="ocr"),
    _s("ipynb", CODE, "Jupyter notebook", "application/x-ipynb+json", "ipynb", "ipynb", 10, language="python"),
]
_CODE = {  # ext -> (label, fence language)
    "py": ("Python", "python"), "js": ("JavaScript", "javascript"), "ts": ("TypeScript", "typescript"),
    "jsx": ("React JSX", "jsx"), "tsx": ("React TSX", "tsx"), "java": ("Java", "java"), "c": ("C", "c"),
    "cpp": ("C++", "cpp"), "h": ("C/C++ header", "c"), "hpp": ("C++ header", "cpp"), "cs": ("C#", "csharp"),
    "go": ("Go", "go"), "rs": ("Rust", "rust"), "rb": ("Ruby", "ruby"), "php": ("PHP", "php"), "sql": ("SQL", "sql"),
    "r": ("R", "r"), "kt": ("Kotlin", "kotlin"), "swift": ("Swift", "swift"), "scala": ("Scala", "scala"),
    "html": ("HTML", "html"), "css": ("CSS", "css"), "json": ("JSON", "json"), "yaml": ("YAML", "yaml"),
    "yml": ("YAML", "yaml"), "xml": ("XML", "xml"), "tex": ("LaTeX", "latex"),
}
_SPECS += [_s(e, CODE, f"{lbl} source", "text/plain", "text", "code", 2, language=lang) for e, (lbl, lang) in _CODE.items()]

REGISTRY: dict[str, FormatSpec] = {s.ext: s for s in _SPECS}


@functools.lru_cache(maxsize=1)
def capabilities() -> dict[str, bool]:
    """Runtime feature detection: what this deployment can genuinely do."""
    def has(mod: str) -> bool:
        try:
            return importlib.util.find_spec(mod) is not None
        except (ImportError, ValueError):
            return False
    return {"ocr": has("rapidocr_onnxruntime") and has("PIL"), "docling": has("docling")}


def reset_capabilities_cache() -> None:  # used by tests
    capabilities.cache_clear()


def get_spec(ext: str) -> Optional[FormatSpec]:
    return REGISTRY.get(ext.lower().lstrip("."))


def mode_for(spec: FormatSpec, purpose: str, role: Optional[str] = None, caps: Optional[dict] = None) -> tuple[str, Optional[str]]:
    """(index_mode, note). Note explains a downgrade to STORAGE_ONLY."""
    caps = capabilities() if caps is None else caps
    if spec.extractor is None:
        return STORAGE_ONLY, "Stored and downloadable; text is not extracted for this format."
    if spec.requires and not caps.get(spec.requires):
        return STORAGE_ONLY, f"Stored and downloadable; text is not extracted because the {spec.requires.upper()} engine is not installed."
    if purpose == MATERIAL:
        return RAG, None
    if purpose == ATTACHMENT:
        return (EXTRACT_ONLY, None) if role == "PROMPT" else (RAG, None)
    if purpose == SUBMISSION:
        return EXTRACT_ONLY, None
    raise ValueError(f"unknown purpose {purpose!r}")


def describe(purpose: str, role: Optional[str] = None, caps: Optional[dict] = None) -> dict:
    """Payload for GET /files/capabilities; the frontend builds its <input accept> and helper text from this."""
    caps = capabilities() if caps is None else caps
    formats = []
    for spec in REGISTRY.values():
        mode, note = mode_for(spec, purpose, role, caps)
        formats.append({"extension": spec.ext, "kind": spec.kind, "label": spec.label, "mime_type": spec.mime,
                        "mode": mode, "max_bytes": spec.max_bytes, "note": note})
    exts = [f["extension"] for f in formats]
    return {"purpose": purpose, "formats": formats, "extensions": exts,
            "accept": ",".join("." + e for e in exts), "max_bytes": max(f["max_bytes"] for f in formats),
            "capabilities": caps}
