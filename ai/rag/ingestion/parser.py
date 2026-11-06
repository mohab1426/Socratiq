"""
Document parser abstraction and PyMuPDF4LLM implementation with Docling fallback.

Preserves markdown structure, headings (#, ##), lists, tables, and page metadata
without collapsing documents into flat text blobs.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO, Optional, Protocol, Union, runtime_checkable

import pymupdf
import pymupdf4llm

from ai.rag.ingestion.storage import normalize_file_input


@dataclass
class ParsedPage:
    """A single parsed page with structured text and page-level metadata."""

    page_number: int
    text: str
    toc_items: list[Any] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedDocument:
    """A fully parsed document containing ordered structured pages."""

    title: str
    total_pages: int
    pages: list[ParsedPage]
    toc: list[Any] = field(default_factory=list)
    raw_markdown: str = ""


@runtime_checkable
class DocumentParser(Protocol):
    """Abstract protocol for document parsers."""

    def parse(
        self,
        file_input: Union[str, Path, bytes, BinaryIO],
        title: Optional[str] = None,
    ) -> ParsedDocument:
        ...


class DoclingParser:
    """Fallback document parser utilizing Docling for complex or degraded PDFs.

    Excels at intricate tables, complex mathematical formulas, and scanned or
    multi-column layouts where standard PDF extractors degrade.
    """

    def __init__(self, converter: Optional[Any] = None) -> None:
        self._converter = converter

    def _get_converter(self) -> Any:
        if self._converter is None:
            try:
                from docling.document_converter import DocumentConverter

                self._converter = DocumentConverter()
            except ImportError as exc:
                raise ImportError(
                    "Docling is not installed. To use DoclingParser, install 'docling' "
                    "via pip: pip install docling"
                ) from exc
        return self._converter

    def parse(
        self,
        file_input: Union[str, Path, bytes, BinaryIO],
        title: Optional[str] = None,
    ) -> ParsedDocument:
        import tempfile

        converter = self._get_converter()
        content_bytes, resolved_filename = normalize_file_input(
            file_input, default_filename=title
        )
        resolved_title = title or Path(resolved_filename).stem.replace("_", " ").title()

        temp_file = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        try:
            temp_file.write(content_bytes)
            temp_file.flush()
            temp_file.close()

            result = converter.convert(str(temp_file.name))
            raw_markdown = (
                result.document.export_to_markdown()
                if hasattr(result.document, "export_to_markdown")
                else str(result)
            )

            pages_list: list[ParsedPage] = []
            doc_pages = getattr(result.document, "pages", None)
            if doc_pages and len(doc_pages) > 0:
                total_pages = len(doc_pages)
                page_parts = raw_markdown.split("<!-- pagebreak -->")
                for p_num in range(1, total_pages + 1):
                    p_text = (
                        page_parts[p_num - 1]
                        if p_num <= len(page_parts)
                        else raw_markdown
                    )
                    pages_list.append(ParsedPage(page_number=p_num, text=p_text))
            else:
                total_pages = 1
                pages_list.append(ParsedPage(page_number=1, text=raw_markdown))

            return ParsedDocument(
                title=resolved_title,
                total_pages=total_pages,
                pages=pages_list,
                raw_markdown=raw_markdown,
            )
        finally:
            try:
                Path(temp_file.name).unlink(missing_ok=True)
            except Exception:
                pass


class PyMuPDF4LLMParser:
    """Primary PDF parser preserving markdown structure via PyMuPDF4LLM.

    Extracts headings, code fences, markdown tables, and page references
    while avoiding naive get_text() flattening.
    """

    def parse(
        self,
        file_input: Union[str, Path, bytes, BinaryIO],
        title: Optional[str] = None,
    ) -> ParsedDocument:
        doc: Optional[pymupdf.Document] = None
        try:
            content_bytes, resolved_filename = normalize_file_input(
                file_input, default_filename=title
            )
            resolved_title = title or Path(resolved_filename).stem.replace("_", " ").title()

            doc = pymupdf.open(stream=content_bytes, filetype="pdf")

            total_pages = doc.page_count
            if total_pages == 0:
                return ParsedDocument(
                    title=resolved_title,
                    total_pages=0,
                    pages=[],
                    toc=[],
                    raw_markdown="",
                )

            # PyMuPDF4LLM extraction with page chunks
            page_data = pymupdf4llm.to_markdown(doc, page_chunks=True)
            toc = doc.get_toc() or []

            parsed_pages: list[ParsedPage] = []
            full_markdown_parts: list[str] = []

            for idx, p in enumerate(page_data):
                p_text = p.get("text", "")
                p_meta = p.get("metadata", {})
                page_num = p_meta.get("page_number", idx + 1)

                parsed_pages.append(
                    ParsedPage(
                        page_number=page_num,
                        text=p_text,
                        toc_items=p.get("toc_items", []),
                        metadata=p_meta,
                    )
                )
                full_markdown_parts.append(p_text)

            return ParsedDocument(
                title=resolved_title,
                total_pages=total_pages,
                pages=parsed_pages,
                toc=toc,
                raw_markdown="\n\n".join(full_markdown_parts),
            )
        finally:
            if doc is not None:
                doc.close()
