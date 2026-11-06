"""Text helpers shared by extractors: safe decoding, normalisation, Markdown tables."""
from __future__ import annotations

import re
import unicodedata

import chardet

from .errors import ExtractionError, FileRejected

MAX_EXTRACTED_CHARS = 3_000_000
_BOMS = ((b"\xef\xbb\xbf", "utf-8-sig"), (b"\xff\xfe\x00\x00", "utf-32"), (b"\x00\x00\xfe\xff", "utf-32"),
         (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16"))
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BIDI = re.compile("[\u202a-\u202e\u2066-\u2069]")


def decode_text(data: bytes) -> tuple[str, str]:
    """Decode text bytes safely. Returns (text, encoding). Raises FileRejected if the content is binary."""
    enc = None
    for bom, name in _BOMS:
        if data.startswith(bom):
            enc = name
            break
    if enc is None:
        try:
            text, enc = data.decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            guess = chardet.detect(data[:200_000])
            enc = guess["encoding"] if guess["encoding"] and (guess["confidence"] or 0) >= 0.6 else "cp1252"
            try:
                text = data.decode(enc)
            except (UnicodeDecodeError, LookupError):
                text, enc = data.decode("latin-1"), "latin-1"
    else:
        try:
            text = data.decode(enc)
        except UnicodeDecodeError as exc:
            raise FileRejected("not_text", "file is declared as text but cannot be decoded", 415) from exc
    if "\x00" in text:
        raise FileRejected("not_text", "file contains binary data; it is not a text file", 415)
    ctrl = len(_CTRL.findall(text[:100_000]))
    if ctrl > max(8, len(text[:100_000]) // 200):
        raise FileRejected("not_text", "file contains too many control characters to be a text file", 415)
    return text, enc


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = _BIDI.sub("", _CTRL.sub("", text))
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def check_size(text: str, what: str = "document") -> str:
    if len(text) > MAX_EXTRACTED_CHARS:
        raise ExtractionError(f"{what} contains more than {MAX_EXTRACTED_CHARS:,} characters of text; split it into smaller files",
                              code="too_large")
    return text


def _cell(v) -> str:
    s = "" if v is None else str(v)
    return re.sub(r"\s*\n\s*", " ", s).replace("|", "\\|").strip()


def md_table(rows: list[list], block_rows: int = 40) -> list[str]:
    """Render rows (first row = header) as Markdown table blocks of at most `block_rows` data rows; the header is repeated
    in every block so each retrieved chunk is self-describing."""
    rows = [r for r in rows if any(str(c).strip() for c in r if c is not None)]
    if not rows:
        return []
    width = max(len(r) for r in rows)
    norm = [[_cell(c) for c in (list(r) + [""] * (width - len(r)))] for r in rows]
    header = [c or f"col{i + 1}" for i, c in enumerate(norm[0])]
    body = norm[1:] or []
    head = "| " + " | ".join(header) + " |\n|" + " --- |" * width
    if not body:
        return [head]
    return [head + "\n" + "\n".join("| " + " | ".join(r) + " |" for r in body[i:i + block_rows])
            for i in range(0, len(body), block_rows)]
