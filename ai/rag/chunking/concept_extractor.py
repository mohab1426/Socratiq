"""
Domain concept extraction and normalization module.

Extracts domain concepts (e.g., 'gradient descent', 'learning rate') to support:
- course-material retrieval
- misconception detection
- mastery tracking
- learning verification

Supports true hybrid extraction (deterministic regex + LLM extraction + alias normalization),
as well as dedicated deterministic and LLM modes.
"""
from __future__ import annotations

import logging
import re
from typing import Optional, Protocol

from pydantic import BaseModel, Field

from ai.config import ModelRole
from ai.models.llm import get_structured_llm

logger = logging.getLogger(__name__)

# Stopwords to filter out trivial common words
_STOPWORDS = frozenset({
    "a", "an", "the", "in", "on", "at", "by", "for", "with", "about", "against", "between",
    "into", "through", "during", "before", "after", "above", "below", "to", "from", "up",
    "down", "of", "off", "over", "under", "again", "further", "then", "once", "here",
    "there", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more",
    "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so",
    "than", "too", "very", "s", "t", "can", "will", "just", "don", "should", "now",
    "this", "that", "these", "those", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "we", "you", "they", "it", "he", "she",
    "what", "which", "who", "whom", "example", "section", "chapter", "page", "note",
    "implementation", "solution", "approach", "problem", "exercise", "question",
})

# Canonical educational concept aliases
_ALIASES: dict[str, str] = {
    "learning_rate": "learning rate",
    "step size": "learning rate",
    "learning rate parameter": "learning rate",
    "lr": "learning rate",
    "gradient_descent": "gradient descent",
    "steepest descent": "gradient descent",
    "gd": "gradient descent",
    "sgd": "stochastic gradient descent",
    "stochastic gradient descent": "stochastic gradient descent",
    "cost_function": "cost function",
    "loss_function": "loss function",
    "objective_function": "loss function",
    "error function": "cost function",
    "linear_regression": "linear regression",
    "logistic_regression": "logistic regression",
    "binary_search": "binary search",
    "depth_first_search": "depth first search",
    "breadth_first_search": "breadth first search",
    "dfs": "depth first search",
    "bfs": "breadth first search",
    "time_complexity": "time complexity",
    "space_complexity": "space complexity",
    "big o notation": "time complexity",
    "partial_derivative": "partial derivative",
    "partial derivatives": "partial derivative",
    "backprop": "backpropagation",
    "back propagation": "backpropagation",
}

# Patterns indicative of concept definitions or key terms
_DEF_PATTERNS = [
    re.compile(r"\*\*([A-Za-z0-9_\-\s]{3,35})\*\*", re.IGNORECASE),  # **bold concept**
    re.compile(r"(?:definition|define|defined as):\s*([A-Za-z0-9_\-\s]{3,35})", re.IGNORECASE),
    re.compile(r"([A-Za-z0-9_\-\s]{3,30})\s+(?:is|are)\s+defined\s+as\b", re.IGNORECASE),
    re.compile(r"([A-Za-z0-9_\-\s]{3,30})\s+(?:refers to|represents|measures)\b", re.IGNORECASE),
    re.compile(r"`([a-zA-Z_][a-zA-Z0-9_]{2,30})`"),  # code tokens e.g. `gradient_descent`
]


def normalize_concept(concept: Optional[str]) -> Optional[str]:
    """Normalize a domain concept string into its canonical lowercase representation.

    Applies whitespace cleanup, punctuation removal, and canonical aliasing
    (e.g., 'step size' -> 'learning rate').
    """
    if not concept:
        return None
    cleaned = " ".join(concept.replace("_", " ").lower().split())
    cleaned = re.sub(r"[^\w\s-]", "", cleaned).strip()
    if not cleaned or cleaned in _STOPWORDS:
        return None
    return _ALIASES.get(cleaned, cleaned)


class ExtractedConcepts(BaseModel):
    """Structured Pydantic container for LLM concept extraction."""

    concepts: list[str] = Field(
        default_factory=list,
        description="2 to 6 primary domain concepts or technical terms present in the text.",
    )


class ConceptExtractor(Protocol):
    """Protocol for concept extraction implementations."""

    def extract_concepts(self, text: str, title: Optional[str] = None) -> list[str]:
        ...


class DeterministicConceptExtractor:
    """Extracts domain concepts using deterministic heuristics, regex, and capitalization rules.

    Zero latency, runs offline without API keys or external LLM dependencies.
    """

    def extract_concepts(self, text: str, title: Optional[str] = None) -> list[str]:
        if not text or not text.strip():
            return []

        candidates: set[str] = set()

        # Check explicit definition patterns & bold terms
        for pat in _DEF_PATTERNS:
            for match in pat.findall(text):
                norm = normalize_concept(match)
                if norm and len(norm) >= 3 and len(norm.split()) <= 4:
                    candidates.add(norm)

        # Check capitalized multi-word phrases (e.g. "Gradient Descent", "Linear Regression")
        cap_phrases = re.findall(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b", text)
        for phrase in cap_phrases:
            norm = normalize_concept(phrase)
            if norm and len(norm) >= 4:
                candidates.add(norm)

        # Common programming or math identifiers with underscores (e.g. learning_rate, cross_entropy)
        code_ids = re.findall(r"\b([a-z]+_[a-z0-9_]+)\b", text)
        for cid in code_ids:
            norm = normalize_concept(cid)
            if norm and len(norm) >= 4:
                candidates.add(norm)

        # Sort by specificity: multi-word phrases first, then length
        filtered = list(candidates)
        filtered.sort(key=lambda x: (len(x.split()), len(x)), reverse=True)
        return filtered[:6]


class LLMConceptExtractor:
    """Extracts concepts using structured LLM output (ModelRole.LIGHTWEIGHT).

    Falls back to DeterministicConceptExtractor on any failure.
    """

    def __init__(self, fallback: Optional[ConceptExtractor] = None) -> None:
        self.fallback = fallback or DeterministicConceptExtractor()

    def extract_concepts(self, text: str, title: Optional[str] = None) -> list[str]:
        if not text or not text.strip():
            return []

        sample = text[:1500]
        prompt = (
            "Extract 2 to 6 key technical/domain concepts from the following course text.\n"
            "Focus on concepts a student must understand (e.g. 'gradient descent', 'learning rate', 'loss function').\n"
            "Do NOT include generic words like 'code', 'function', 'page', 'lecture'.\n\n"
            f"Context: {title or 'Course Material'}\n"
            f"Text:\n{sample}"
        )

        try:
            llm = get_structured_llm(ModelRole.LIGHTWEIGHT, ExtractedConcepts)
            result: ExtractedConcepts = llm.invoke(prompt)
            normalized: list[str] = []
            for c in result.concepts:
                norm = normalize_concept(c)
                if norm and norm not in normalized:
                    normalized.append(norm)
            if normalized:
                return normalized[:6]
        except Exception as exc:
            logger.debug("LLM concept extraction failed, using deterministic fallback: %s", exc)

        return self.fallback.extract_concepts(text, title)


class TrueHybridConceptExtractor:
    """True Hybrid Concept Extractor combining deterministic heuristic signals with LLM insights.

    1. Gathers deterministic concepts (definitions, bold terms, code identifiers).
    2. Gathers LLM-extracted concepts (higher-level semantic abstractions).
    3. Normalizes and deduplicates both sets into a unified concept list.
    4. Falls back gracefully to deterministic concepts if LLM is unavailable.
    """

    def __init__(
        self,
        deterministic: Optional[ConceptExtractor] = None,
        llm_extractor: Optional[ConceptExtractor] = None,
    ) -> None:
        self.deterministic = deterministic or DeterministicConceptExtractor()
        self.llm_extractor = llm_extractor or LLMConceptExtractor(fallback=self.deterministic)

    def extract_concepts(self, text: str, title: Optional[str] = None) -> list[str]:
        det_concepts = self.deterministic.extract_concepts(text, title)

        try:
            llm_concepts = self.llm_extractor.extract_concepts(text, title)
        except Exception as exc:
            logger.debug("LLM stage of hybrid concept extraction failed: %s", exc)
            llm_concepts = []

        # Merge, deduplicate, and normalize
        combined: list[str] = []
        for c in det_concepts + llm_concepts:
            norm = normalize_concept(c)
            if norm and norm not in combined:
                combined.append(norm)

        # Sort by specificity (multi-word first, then length)
        combined.sort(key=lambda x: (len(x.split()), len(x)), reverse=True)
        return combined[:8]


def get_concept_extractor(mode: str = "hybrid") -> ConceptExtractor:
    """Factory returning concept extractor according to configured mode.

    Modes:
    - 'deterministic': Pure offline heuristics, zero latency.
    - 'hybrid': True hybrid combining deterministic + LLM with normalization.
    - 'llm': LLM-first with deterministic fallback.
    """
    cleaned_mode = mode.lower().strip()
    if cleaned_mode == "deterministic":
        return DeterministicConceptExtractor()
    if cleaned_mode == "llm":
        return LLMConceptExtractor()
    return TrueHybridConceptExtractor()
