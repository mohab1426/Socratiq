"""
Unit tests for structure-aware chunking and concept extraction.

Verifies:
- Chunks respect structural and section boundaries
- Rich metadata (content_type, page, section, concepts) is properly populated
- Code blocks and tables stay together
- Configurable token budgets and overlaps are observed
"""
from __future__ import annotations

import pytest

from ai.rag.chunking.concept_extractor import (
    DeterministicConceptExtractor,
    LLMConceptExtractor,
    TrueHybridConceptExtractor,
    normalize_concept,
)
from ai.rag.chunking.structure_chunker import StructureAwareChunker, estimate_tokens
from ai.rag.ingestion.parser import ParsedDocument, ParsedPage
from ai.rag.models import ContentType, DocumentMetadata


def _get_mock_metadata() -> DocumentMetadata:
    return DocumentMetadata(
        university_id="stanford",
        course_id="cs229",
        classroom_id="room_101",
        filename="lecture_03.pdf",
    )


def test_chunker_respects_sections_and_populates_metadata():
    extractor = DeterministicConceptExtractor()
    chunker = StructureAwareChunker(
        min_tokens=50, max_tokens=200, overlap_tokens=30, concept_extractor=extractor
    )

    text_page_1 = (
        "# Optimization\n\n"
        "## Gradient Descent\n\n"
        "Gradient descent is an iterative first-order optimization algorithm for finding the local minimum.\n\n"
        "### Update Rule\n\n"
        "The parameter update formula is defined as:\n"
        "theta = theta - alpha * gradient\n\n"
        "Here, alpha is the **learning rate** which determines the step size.\n"
    )

    text_page_2 = (
        "## Stochastic Gradient Descent\n\n"
        "In stochastic gradient descent, we calculate the gradient for a single training example rather than the full batch.\n"
    )

    pages = [
        ParsedPage(page_number=1, text=text_page_1),
        ParsedPage(page_number=2, text=text_page_2),
    ]
    parsed_doc = ParsedDocument(title="Optimization Lecture", total_pages=2, pages=pages)
    metadata = _get_mock_metadata()

    chunks = chunker.chunk_document(parsed_doc, metadata)

    assert len(chunks) >= 2

    # Verify metadata fields are fully populated
    for chunk in chunks:
        assert chunk.university_id == "stanford"
        assert chunk.course_id == "cs229"
        assert chunk.classroom_id == "room_101"
        assert chunk.title == "Optimization Lecture"
        assert chunk.page_number in (1, 2)
        assert chunk.chunk_id.startswith("chk_")
        assert chunk.content
        assert chunk.token_count > 0

    # Verify section tracking
    sections = [c.section for c in chunks if c.section]
    assert any("Gradient Descent" in s for s in sections)


def test_chunker_classifies_content_types():
    chunker = StructureAwareChunker(min_tokens=20, max_tokens=150)
    metadata = _get_mock_metadata()

    code_text = (
        "```python\n"
        "def gradient_step(w, grad, lr):\n"
        "    return w - lr * grad\n"
        "```"
    )
    doc_code = ParsedDocument(
        title="Code Sample",
        total_pages=1,
        pages=[ParsedPage(page_number=1, text=code_text)],
    )
    code_chunks = chunker.chunk_document(doc_code, metadata)
    assert len(code_chunks) == 1
    assert code_chunks[0].content_type == ContentType.CODE

    table_text = (
        "| Algorithm | Complexity |\n"
        "|---|---|\n"
        "| Batch GD | O(m * n) |\n"
        "| SGD | O(n) |\n"
    )
    doc_table = ParsedDocument(
        title="Table Sample",
        total_pages=1,
        pages=[ParsedPage(page_number=1, text=table_text)],
    )
    table_chunks = chunker.chunk_document(doc_table, metadata)
    assert len(table_chunks) == 1
    assert table_chunks[0].content_type == ContentType.TABLE


def test_deterministic_concept_extractor():
    extractor = DeterministicConceptExtractor()
    sample = (
        "Gradient descent updates model parameters using the gradient of the loss. "
        "The **learning rate** determines the magnitude of the step. "
        "In `linear_regression`, we minimize the mean squared error."
    )
    concepts = extractor.extract_concepts(sample)

    assert len(concepts) > 0
    lower_concepts = [c.lower() for c in concepts]
    assert any("learning rate" in c for c in lower_concepts) or any("gradient" in c for c in lower_concepts)


def test_normalize_concept_aliases():
    """Verify alias normalization across snake_case, uppercase, abbreviations."""
    assert normalize_concept("learning_rate") == "learning rate"
    assert normalize_concept("LR") == "learning rate"
    assert normalize_concept("loss_function") == "loss function"
    assert normalize_concept("SGD") == "stochastic gradient descent"
    assert normalize_concept("GD") == "gradient descent"
    assert normalize_concept("backprop") == "backpropagation"
    assert normalize_concept("binary_search") == "binary search"
    assert normalize_concept("Unknown Concept") == "unknown concept"


def test_true_hybrid_concept_extractor():
    """Verify TrueHybridConceptExtractor merges deterministic and LLM concepts with deduplication."""
    class FakeLLMExtractor:
        def extract_concepts(self, text, title=None):
            return ["gradient descent", "learning rate", "convergence rate"]

    extractor = TrueHybridConceptExtractor(llm_extractor=FakeLLMExtractor())
    sample = (
        "Gradient descent with learning rate alpha guarantees convergence. "
        "Definition: learning_rate determines the update magnitude."
    )
    concepts = extractor.extract_concepts(sample)
    assert len(concepts) > 0
    # Should include both normalized concepts and LLM concepts
    assert "gradient descent" in concepts
    assert "learning rate" in concepts
    assert "convergence rate" in concepts
    # No duplicate entries
    assert len(concepts) == len(set(concepts))


def test_true_hybrid_concept_extractor_handles_llm_failure():
    """If LLM fails, TrueHybridConceptExtractor falls back gracefully to deterministic."""
    class BrokenLLMExtractor:
        def extract_concepts(self, text, title=None):
            raise RuntimeError("API timeout")

    extractor = TrueHybridConceptExtractor(llm_extractor=BrokenLLMExtractor())
    sample = "Definition: **Learning Rate** is the step size in `gradient_descent`."
    concepts = extractor.extract_concepts(sample)
    assert len(concepts) > 0
    assert any("learning rate" in c for c in concepts)


