"""
Unit tests for PDF parsing with PyMuPDF4LLM.

Verifies:
- PDF extraction works
- Headings (#, ##) and markdown structure are preserved
- Page numbers and multi-page documents are tracked accurately
"""
from __future__ import annotations

import pymupdf
import pytest

from ai.rag.ingestion.parser import PyMuPDF4LLMParser


def _build_test_pdf() -> bytes:
    """Build a multi-page PDF in-memory with headings, paragraphs, and tables."""
    doc = pymupdf.open()

    # Page 1: Heading + Section + Definition
    p1 = doc.new_page()
    p1.insert_text(
        (50, 50),
        "# Machine Learning 101\n\n"
        "## Lecture 1: Linear Regression\n\n"
        "Linear regression models the relationship between a scalar response and explanatory variables.\n\n"
        "### Cost Function\n\n"
        "The mean squared error cost function is defined as J(w, b).\n",
    )

    # Page 2: Code block + Table
    p2 = doc.new_page()
    p2.insert_text(
        (50, 50),
        "## Implementation\n\n"
        "Here is the gradient calculation:\n\n"
        "```python\n"
        "def compute_gradient(X, y, w):\n"
        "    return (1/m) * (X.T @ (X @ w - y))\n"
        "```\n\n"
        "| Parameter | Description |\n"
        "|---|---|\n"
        "| learning_rate | Step size scaling |\n",
    )

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def test_pdf_parsing_extracts_all_pages():
    parser = PyMuPDF4LLMParser()
    pdf_bytes = _build_test_pdf()

    parsed = parser.parse(pdf_bytes, title="Test Course Material")

    assert parsed.title == "Test Course Material"
    assert parsed.total_pages == 2
    assert len(parsed.pages) == 2
    assert parsed.pages[0].page_number == 1
    assert parsed.pages[1].page_number == 2


def test_pdf_parsing_preserves_headings_and_structure():
    parser = PyMuPDF4LLMParser()
    pdf_bytes = _build_test_pdf()

    parsed = parser.parse(pdf_bytes, title="ML 101")

    p1_text = parsed.pages[0].text
    assert "Linear Regression" in p1_text
    assert "Cost Function" in p1_text

    p2_text = parsed.pages[1].text
    assert "Implementation" in p2_text
    assert "compute_gradient" in p2_text


def test_pdf_parsing_empty_document():
    doc = pymupdf.open()
    doc.new_page()  # Blank page
    pdf_bytes = doc.tobytes()
    doc.close()

    parser = PyMuPDF4LLMParser()
    parsed = parser.parse(pdf_bytes, title="Empty Doc")

    assert parsed.total_pages == 1
    assert len(parsed.pages) == 1
    assert parsed.pages[0].text.strip() == ""
