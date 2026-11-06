"""
Unit tests for deterministic document cleaner.

Verifies:
- Repeated running headers and footers are cleanly removed
- Standalone page numbers are stripped
- Soft-hyphenated words across line breaks are normalized
- Meaningful markdown structure (headings, code blocks, tables) is strictly preserved
"""
from __future__ import annotations

import pytest

from ai.rag.ingestion.cleaner import DocumentCleaner
from ai.rag.ingestion.parser import ParsedDocument, ParsedPage


def test_cleaner_removes_repeated_headers_and_footers():
    cleaner = DocumentCleaner(header_footer_frequency_threshold=0.5)

    pages = [
        ParsedPage(
            page_number=1,
            text=(
                "CS101: Introduction to Machine Learning\n"
                "# Chapter 1: Introduction\n\n"
                "Machine learning allows computers to learn from data.\n\n"
                "Page 1 of 3\n"
                "Stanford University Fall 2026"
            ),
        ),
        ParsedPage(
            page_number=2,
            text=(
                "CS101: Introduction to Machine Learning\n"
                "## Supervised Learning\n\n"
                "In supervised learning, we are given labeled training examples.\n\n"
                "Page 2 of 3\n"
                "Stanford University Fall 2026"
            ),
        ),
        ParsedPage(
            page_number=3,
            text=(
                "CS101: Introduction to Machine Learning\n"
                "## Unsupervised Learning\n\n"
                "In unsupervised learning, data has no labels.\n\n"
                "Page 3 of 3\n"
                "Stanford University Fall 2026"
            ),
        ),
    ]

    doc = ParsedDocument(title="CS101 Notes", total_pages=3, pages=pages)
    cleaned = cleaner.clean_document(doc)

    assert len(cleaned.pages) == 3

    for p in cleaned.pages:
        # Recurring header and footer must be removed
        assert "CS101: Introduction to Machine Learning" not in p.text
        assert "Stanford University Fall 2026" not in p.text
        assert "Page 1 of 3" not in p.text
        assert "Page 2 of 3" not in p.text
        assert "Page 3 of 3" not in p.text

    # Core academic content and headings must be preserved
    assert "Chapter 1: Introduction" in cleaned.pages[0].text
    assert "Machine learning allows computers to learn" in cleaned.pages[0].text
    assert "Supervised Learning" in cleaned.pages[1].text
    assert "Unsupervised Learning" in cleaned.pages[2].text


def test_cleaner_preserves_code_blocks_and_tables():
    cleaner = DocumentCleaner()

    text = (
        "# Python Example\n\n"
        "Here is the gradient descent implementation:\n\n"
        "```python\n"
        "# Calculate gradient\n"
        "grad = compute_gradient(X, y, theta)\n"
        "theta = theta - alpha * grad\n"
        "```\n\n"
        "| Metric | Formula |\n"
        "|---|---|\n"
        "| MSE | 1/m * sum(err^2) |\n"
    )

    page = ParsedPage(page_number=1, text=text)
    doc = ParsedDocument(title="Code Doc", total_pages=1, pages=[page])

    cleaned = cleaner.clean_document(doc)
    p_text = cleaned.pages[0].text

    assert "```python" in p_text
    assert "theta = theta - alpha * grad" in p_text
    assert "| Metric | Formula |" in p_text
    assert "| MSE | 1/m * sum(err^2) |" in p_text


def test_cleaner_repairs_soft_hyphens():
    cleaner = DocumentCleaner()

    text = (
        "Linear regres-\nsion is a fundamen-\ntal algorithm in statis-\ntics."
    )
    page = ParsedPage(page_number=1, text=text)
    doc = ParsedDocument(title="Hyphen Doc", total_pages=1, pages=[page])

    cleaned = cleaner.clean_document(doc)
    res = cleaned.pages[0].text

    assert "regression" in res
    assert "fundamental" in res
    assert "statistics" in res
    assert "regres-\nsion" not in res
