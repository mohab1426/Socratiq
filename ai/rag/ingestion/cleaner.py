"""
Deterministic text cleaning stage for parsed course documents.

Removes repeated headers, footers, standalone page number lines,
broken whitespace, and extraction noise while strictly preserving markdown
structure, headings, definitions, code fences, formulas, and tables.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Sequence

from ai.rag.ingestion.parser import ParsedDocument, ParsedPage

# Regex to match isolated page number indicators (e.g., "1", "Page 4", "4 / 12", "- 4 -")
_PAGE_NUMBER_RE = re.compile(
    r"^(?:page\s+)?-?\s*\d+\s*(?:(?:of|/)\s*\d+)?\s*-?$", re.IGNORECASE
)

# Regex for soft-hyphen line wraps: e.g. "algo-\nrithm" -> "algorithm"
_HYPHEN_WRAP_RE = re.compile(r"(\b\w+)-\n(\w+\b)")


class DocumentCleaner:
    """Cleans parsed document text deterministically without destroying structure."""

    def __init__(self, header_footer_frequency_threshold: float = 0.5) -> None:
        self.header_footer_threshold = header_footer_frequency_threshold

    def clean_document(self, doc: ParsedDocument) -> ParsedDocument:
        """Clean an entire ParsedDocument, identifying running headers/footers across pages."""
        if not doc.pages:
            return doc

        # Step 1: Detect recurring headers (first 2 non-empty lines) and footers (last 2 non-empty lines)
        header_candidates: Counter[str] = Counter()
        footer_candidates: Counter[str] = Counter()

        page_lines_map: list[list[str]] = []
        for page in doc.pages:
            lines = [line.strip() for line in page.text.splitlines()]
            non_empty = [l for l in lines if l]
            page_lines_map.append(lines)

            if len(non_empty) >= 3:
                # Check potential headers (skip markdown headings #)
                for h in non_empty[:2]:
                    if not h.startswith("#") and not h.startswith("```"):
                        header_candidates[h] += 1
                # Check potential footers
                for f in non_empty[-2:]:
                    if not f.startswith("#") and not f.startswith("```"):
                        footer_candidates[f] += 1

        total_pages = len(doc.pages)
        min_occurrences = max(2, int(total_pages * self.header_footer_threshold))

        recurring_headers = {
            text for text, count in header_candidates.items() if count >= min_occurrences
        }
        recurring_footers = {
            text for text, count in footer_candidates.items() if count >= min_occurrences
        }

        # Step 2: Clean each page
        cleaned_pages: list[ParsedPage] = []
        full_cleaned_parts: list[str] = []

        for page, lines in zip(doc.pages, page_lines_map):
            cleaned_text = self._clean_page_text(
                lines, recurring_headers, recurring_footers
            )
            cleaned_page = ParsedPage(
                page_number=page.page_number,
                text=cleaned_text,
                toc_items=page.toc_items,
                metadata=page.metadata,
            )
            cleaned_pages.append(cleaned_page)
            if cleaned_text.strip():
                full_cleaned_parts.append(cleaned_text)

        return ParsedDocument(
            title=doc.title,
            total_pages=doc.total_pages,
            pages=cleaned_pages,
            toc=doc.toc,
            raw_markdown="\n\n".join(full_cleaned_parts),
        )

    def _clean_page_text(
        self,
        lines: Sequence[str],
        recurring_headers: set[str],
        recurring_footers: set[str],
    ) -> str:
        cleaned_lines: list[str] = []
        in_code_block = False

        for raw_line in lines:
            line = raw_line.rstrip()
            stripped = line.strip()

            # Track code block fences
            if stripped.startswith("```"):
                in_code_block = not in_code_block
                cleaned_lines.append(line)
                continue

            if in_code_block:
                cleaned_lines.append(line)
                continue

            # Check if line is a recurring header or footer
            if stripped in recurring_headers or stripped in recurring_footers:
                continue

            # Check if line is a standalone page number
            if _PAGE_NUMBER_RE.match(stripped):
                continue

            cleaned_lines.append(line)

        raw_joined = "\n".join(cleaned_lines)

        # Fix hyphenated words broken across line breaks (e.g. "optimi-\nzation" -> "optimization")
        text = _HYPHEN_WRAP_RE.sub(r"\1\2", raw_joined)

        # Normalize excessive blank lines (more than 2 consecutive newlines -> 2)
        text = re.sub(r"\n{3,}", "\n\n", text)

        # Strip dangling whitespace
        return text.strip()
