"""
Lightweight language-signal helpers for retrieval.

This module deliberately does NOT attempt real Arabic linguistic
processing (stemming, root extraction, etc.) -- PostgreSQL's built-in text
search configurations do not offer genuine Arabic morphological support,
and inventing a fake one would be worse than admitting the gap (see
docs/RAG.md / the RAG audit, section "Arabic / mixed-language retrieval").

Instead this module gives the retrieval pipeline just enough of a signal to:
1. Detect when a query is Arabic-dominant, so `HybridRetriever` can treat
   PostgreSQL FTS (configured with the `english` text-search config, which
   provides no Arabic stemming) as unreliable for that query and lean on
   dense/semantic retrieval instead -- which the configured multilingual
   embedding model (`nvidia/nv-embedqa-e5-v5`) genuinely does support.
2. Strip diacritics/tatweel and normalize alef/yaa variants before a query
   reaches the embedding model or any exact-match path, so the same
   underlying question typed with or without tashkeel produces a consistent
   query string.

English queries (and English content) are completely unaffected -- FTS
remains the reliable path there.
"""
from __future__ import annotations

import re

# Unicode ranges covering Arabic, Arabic Supplement, Arabic Extended-A,
# Arabic Presentation Forms A/B.
_ARABIC_CHAR_PATTERN = re.compile(
    r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]"
)

# Arabic diacritics (tashkeel) + tatweel (kashida) -- purely cosmetic marks
# that don't change meaning but do change token identity, so they hurt both
# exact-match FTS and naive tokenization if left in.
_ARABIC_DIACRITICS_PATTERN = re.compile(
    r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0640]"
)

# Common alef/yaa/taa-marbuta presentation variants normalized to their base
# form so "أ", "إ", "آ" all match queries/documents written with plain "ا".
_ARABIC_NORMALIZATION_MAP = {
    "\u0623": "\u0627",  # ARABIC LETTER ALEF WITH HAMZA ABOVE -> ALEF
    "\u0625": "\u0627",  # ARABIC LETTER ALEF WITH HAMZA BELOW -> ALEF
    "\u0622": "\u0627",  # ARABIC LETTER ALEF WITH MADDA ABOVE -> ALEF
    "\u0671": "\u0627",  # ARABIC LETTER ALEF WASLA -> ALEF
    "\u0649": "\u064A",  # ARABIC LETTER ALEF MAKSURA -> YEH
    "\u0629": "\u0647",  # ARABIC LETTER TEH MARBUTA -> HEH
}

DEFAULT_ARABIC_DOMINANCE_THRESHOLD = 0.3


def arabic_char_ratio(text: str) -> float:
    """Fraction of alphabetic characters in `text` that are Arabic-script.

    Returns 0.0 for empty/whitespace-only text or text with no letters at
    all (e.g. pure code/numbers), which is the correct "not Arabic" answer
    for those inputs.
    """
    if not text:
        return 0.0
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    arabic_letters = sum(1 for c in letters if _ARABIC_CHAR_PATTERN.match(c))
    return arabic_letters / len(letters)


def is_arabic_dominant(text: str, threshold: float = DEFAULT_ARABIC_DOMINANCE_THRESHOLD) -> bool:
    """True when `text` is predominantly Arabic script.

    Used to decide retrieval strategy (favor dense over FTS), not to gate
    any authorization/scope decision.
    """
    return arabic_char_ratio(text) >= threshold


def normalize_arabic_text(text: str) -> str:
    """Strip Arabic diacritics/tatweel and normalize common letter variants.

    Safe to call on mixed Arabic/English or pure-English text -- it only
    touches Arabic-range characters, so English content passes through
    unchanged.
    """
    if not text:
        return text
    normalized = _ARABIC_DIACRITICS_PATTERN.sub("", text)
    for src, dst in _ARABIC_NORMALIZATION_MAP.items():
        normalized = normalized.replace(src, dst)
    return normalized
