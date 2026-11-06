"""
Bridge between the multi-format file layer and the AI package's RAG service, WITHOUT modifying `ai/`.

RAGService already accepts injectable `parser`, `fallback_parser` and `storage`. We supply:
  * MultiFormatParser    - dispatches by the validated format (carried in a ContextVar) to our extractors; PDFs are
                           delegated unchanged to the AI's own layout-aware PyMuPDF4LLM parser.
  * FormatAwareFallback  - the AI's Docling OCR fallback is PDF-only, so it must not be tried on other formats.
  * ReferenceStorage     - RAG would otherwise save a SECOND copy of the file; the backend already stored the canonical
                           object, so RAG just records that path.
"""
from __future__ import annotations

import contextlib
import contextvars
from dataclasses import dataclass
from typing import Optional

from . import registry as R
from .errors import ExtractionError
from .extractors import extract


@dataclass(frozen=True)
class FileHint:
    spec: R.FormatSpec
    filename: str
    storage_bucket: str
    storage_path: str


_current: contextvars.ContextVar[Optional[FileHint]] = contextvars.ContextVar("rag_file_hint", default=None)


@contextlib.contextmanager
def use_hint(hint: FileHint):
    token = _current.set(hint)
    try:
        yield
    finally:
        _current.reset(token)


class MultiFormatParser:
    def __init__(self, pdf_parser=None):
        self._pdf = pdf_parser

    def _pdf_parser(self):
        if self._pdf is None:
            from ai.rag.ingestion.parser import PyMuPDF4LLMParser
            self._pdf = PyMuPDF4LLMParser()
        return self._pdf

    def parse(self, file_input, title: Optional[str] = None):
        from ai.rag.ingestion.parser import ParsedDocument, ParsedPage
        from ai.rag.ingestion.storage import normalize_file_input
        hint = _current.get()
        data, _ = normalize_file_input(file_input)
        if hint is None or hint.spec.extractor == "pdf":
            return self._pdf_parser().parse(data, title=title)          # existing AI behaviour, untouched
        ex = extract(hint.spec, data)
        if not ex.pages:
            raise ExtractionError("no extractable text found in this file", code="no_text")
        pages = [ParsedPage(page_number=n, text=t, metadata={"source_format": hint.spec.ext}) for n, t in ex.pages]
        return ParsedDocument(title=title or ex.title or hint.filename, total_pages=len(pages), pages=pages, toc=[],
                              raw_markdown="\n\n".join(t for _, t in ex.pages))


class FormatAwareFallback:
    def parse(self, file_input, title: Optional[str] = None):
        hint = _current.get()
        if hint is not None and hint.spec.extractor != "pdf":
            raise ExtractionError("OCR fallback applies to PDFs only", code="skip")
        from ai.rag.ingestion.parser import DoclingParser
        return DoclingParser().parse(file_input, title=title)


class ReferenceStorage:
    """DocumentStorage that records the backend-owned object instead of saving another copy."""

    def save(self, metadata, file_content) -> str:
        hint = _current.get()
        if hint is None:
            raise RuntimeError("ReferenceStorage used outside a file context")
        return f"{hint.storage_bucket}/{hint.storage_path}"

    def load(self, storage_path: str) -> bytes:  # pragma: no cover - not used by RAG retrieval
        raise NotImplementedError("files are read through the backend ObjectStorage")

    def delete(self, storage_path: str) -> bool:
        return False                              # the backend owns object lifecycle


def build_rag_service(**overrides):
    """Production wiring; tests pass fake embedding_provider / vector_store / reranker through `overrides`."""
    from ai.rag.service import RAGService
    kwargs = dict(parser=MultiFormatParser(), fallback_parser=FormatAwareFallback(), storage=ReferenceStorage())
    kwargs.update(overrides)
    return RAGService(**kwargs)
