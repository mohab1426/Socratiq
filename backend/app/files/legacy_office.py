"""Pure-Python readers for legacy binary Office files (.doc, .ppt). No subprocess, no shell, no external converter.

Both formats are OLE2 compound files. We read only the text-bearing structures:
  * .doc  -> WordDocument FIB + Table stream Clx/PlcPcd piece table  ([MS-DOC] 2.4.1 "Retrieving Text")
  * .ppt  -> "PowerPoint Document" stream record tree (TextCharsAtom / TextBytesAtom inside SlideContainer) ([MS-PPT])
Anything unexpected raises ExtractionError with an actionable message instead of returning partial garbage.
"""
from __future__ import annotations

import io
import struct

import olefile

from .errors import ExtractionError

MAX_STREAM = 64 * 1024 * 1024


def _ole(data: bytes) -> olefile.OleFileIO:
    if not olefile.isOleFile(data):
        raise ExtractionError("not a legacy Office (OLE2) file")
    try:
        return olefile.OleFileIO(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(f"corrupt legacy Office file: {exc}") from exc


def _stream(ole: olefile.OleFileIO, name: str) -> bytes:
    if not ole.exists(name):
        raise ExtractionError(f"missing stream {name!r}")
    if ole.get_size(name) > MAX_STREAM:
        raise ExtractionError("legacy Office stream too large", code="too_large")
    return ole.openstream(name).read()


# ------------------------------------------------------------------ .doc
def word_is_encrypted(data: bytes) -> bool:
    with _ole(data) as ole:
        wd = _stream(ole, "WordDocument")
        return bool(struct.unpack_from("<H", wd, 0x0A)[0] & 0x0100)


def read_doc(data: bytes) -> str:
    with _ole(data) as ole:
        wd = _stream(ole, "WordDocument")
        if len(wd) < 0x01AA or struct.unpack_from("<H", wd, 0)[0] != 0xA5EC:
            raise ExtractionError("not a Word 97-2003 document (bad FIB signature); save it as .docx")
        flags = struct.unpack_from("<H", wd, 0x0A)[0]
        if flags & 0x0100:
            raise ExtractionError("password-protected Word file", code="encrypted")
        table_name = "1Table" if flags & 0x0200 else "0Table"
        ccp_text = struct.unpack_from("<I", wd, 0x004C)[0]                 # characters in the main document story
        fc_clx, lcb_clx = struct.unpack_from("<II", wd, 0x01A2)
        table = _stream(ole, table_name)
    if lcb_clx == 0 or fc_clx + lcb_clx > len(table):
        raise ExtractionError("Word file has no readable text table; save it as .docx")

    clx = table[fc_clx:fc_clx + lcb_clx]
    pos = 0
    while pos < len(clx) and clx[pos] == 0x01:                             # skip Prc (formatting) entries
        pos += 3 + struct.unpack_from("<H", clx, pos + 1)[0]
    if pos >= len(clx) or clx[pos] != 0x02:
        raise ExtractionError("Word text table (Pcdt) not found")
    lcb = struct.unpack_from("<I", clx, pos + 1)[0]
    plc = clx[pos + 5:pos + 5 + lcb]
    n = (lcb - 4) // 12
    if n <= 0:
        raise ExtractionError("Word file contains no text pieces")
    cps = struct.unpack_from(f"<{n + 1}I", plc, 0)
    out: list[str] = []
    for i in range(n):
        start, end = cps[i], min(cps[i + 1], ccp_text)
        if start >= end:
            continue
        fc = struct.unpack_from("<I", plc, (n + 1) * 4 + i * 8 + 2)[0]
        count = end - start
        if fc & 0x40000000:                                                 # compressed: 1 byte / char, cp1252
            off = (fc & 0x3FFFFFFF) // 2
            out.append(wd[off:off + count].decode("cp1252", errors="replace"))
        else:                                                               # UTF-16LE
            out.append(wd[fc:fc + count * 2].decode("utf-16-le", errors="replace"))
    return _clean_word_text("".join(out))


def _clean_word_text(raw: str) -> str:
    """Resolve field codes (0x13 instr 0x14 result 0x15) and control characters into plain paragraphs;
    table cell marks (0x07) become Markdown table rows."""
    res: list[str] = []
    in_instr = 0
    for ch in raw:
        if ch == "\x13":
            in_instr += 1                                    # field instruction: drop until the result marker
        elif ch == "\x14":
            in_instr = max(0, in_instr - 1)
        elif ch == "\x15":
            pass
        elif in_instr:
            continue
        elif ch == "\x07":
            res.append("\x1f")                               # cell / row terminator (row end = two in a row)
        elif ch in ("\r", "\x0b"):
            res.append("\n")
        elif ch == "\x0c":
            res.append("\n\n")
        elif ch < " " and ch != "\t":
            continue
        else:
            res.append(ch)
    text = "".join(res).replace("\x1f\x1f", "\x1f\n")       # row end -> newline after the last cell mark
    out: list[str] = []
    table_open = False
    for line in text.split("\n"):
        if "\x1f" in line:
            cells = [c.strip().replace("|", "\\|") for c in line.split("\x1f")]
            if cells and cells[-1] == "":
                cells.pop()
            out.append("| " + " | ".join(cells) + " |")
            if not table_open:
                out.append("|" + " --- |" * len(cells))
                table_open = True
        else:
            table_open = False
            out.append(line.rstrip())
    return "\n".join(out).strip()


# ------------------------------------------------------------------ .ppt
_SLIDE_CONTAINER, _TEXT_CHARS, _TEXT_BYTES, _TEXT_HEADER = 0x03EE, 0x0FA0, 0x0FA8, 0x0F9F


def _walk(buf: bytes, start: int, end: int, depth: int = 0):
    """Yield (rec_type, instance, payload_start, payload_end, is_container) for every record in [start, end)."""
    pos = 0 if False else start
    while pos + 8 <= end:
        ver_inst, rtype, rlen = struct.unpack_from("<HHI", buf, pos)
        ver, inst = ver_inst & 0x000F, ver_inst >> 4
        p0, p1 = pos + 8, pos + 8 + rlen
        if p1 > end:
            return
        yield rtype, inst, p0, p1, ver == 0x0F
        pos = p1


def read_ppt(data: bytes) -> list[tuple[int, str]]:
    """Return [(slide_number, text)] in presentation order."""
    with _ole(data) as ole:
        if ole.exists("EncryptedSummary"):
            raise ExtractionError("password-protected PowerPoint file", code="encrypted")
        stream = _stream(ole, "PowerPoint Document")

    slides: list[list[str]] = []

    def texts_in(p0: int, p1: int, depth: int = 0) -> list[str]:
        found: list[str] = []
        if depth > 24:
            return found
        for rtype, _inst, a, b, is_container in _walk(stream, p0, p1):
            if is_container:
                found += texts_in(a, b, depth + 1)
            elif rtype == _TEXT_CHARS:
                found.append(stream[a:b].decode("utf-16-le", errors="replace"))
            elif rtype == _TEXT_BYTES:
                found.append(stream[a:b].decode("cp1252", errors="replace"))
        return found

    def find_slides(p0: int, p1: int, depth: int = 0) -> None:
        if depth > 24:
            return
        for rtype, _inst, a, b, is_container in _walk(stream, p0, p1):
            if rtype == _SLIDE_CONTAINER:
                slides.append(texts_in(a, b))
            elif is_container:
                find_slides(a, b, depth + 1)

    try:
        find_slides(0, len(stream))
    except struct.error as exc:
        raise ExtractionError(f"corrupt PowerPoint file: {exc}") from exc

    out: list[tuple[int, str]] = []
    for i, texts in enumerate(slides, start=1):
        cleaned = [t.replace("\r", "\n").replace("\x0b", "\n").replace("\x00", "").strip() for t in texts]
        cleaned = [t for t in cleaned if t]
        if cleaned:
            out.append((i, "\n\n".join(cleaned)))
    if not out:
        raise ExtractionError("no text found in PowerPoint file (image-only deck?)", code="no_text")
    return out
