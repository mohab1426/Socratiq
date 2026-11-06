"""Explicit board commands in Arabic (incl. Egyptian) and English.

Used for two things only: (1) destructive board actions (clear / erase / organize) are executed ONLY when the student explicitly asked
for them, never because the model felt like it; (2) a small safety net so "امسح البورد" / "clear the board" works even when the model
forgot to emit the action. Understanding everything else is the model's job.
"""
from __future__ import annotations

import re
import unicodedata

from .models import BoardAction

_AR_DIACRITICS = re.compile(r"[\u064B-\u0652\u0640]")


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = _AR_DIACRITICS.sub("", t)
    t = t.translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"}))
    return re.sub(r"\s+", " ", t).strip()


_BOARD_AR = r"(?:ال)?(?:بورد|لوح\w*|سبور\w*)"
_ERASE_AR = r"(?:امسح\w*|احذف\w*|نضف\w*|فضي\w*|شيل\w*|ازل\w*|اتخلص\w*)"
_EVERYTHING_AR = r"(?:كل\s*(?:شي\w*|حاج\w*)|الكل|كله|كلها|اللي\s+(?:علي|ع)\s+" + _BOARD_AR + ")"

CLEAR = [
    re.compile(r"\b(?:clear|wipe|reset|empty|clean(?:\s+up)?)\b.{0,25}\b(?:board|whiteboard|everything|all of it|it all)\b"),
    re.compile(r"\berase\b.{0,15}\b(?:everything|the board|the whole board|all)\b"),
    re.compile(_ERASE_AR + r"\s+(?:" + _BOARD_AR + r"|" + _EVERYTHING_AR + r")"),
    re.compile(r"\b(?:start over|start fresh|blank board)\b"),
]
ERASE_LAST = [
    re.compile(r"\b(?:erase|delete|remove|undo|scratch)\b.{0,25}\b(?:last|previous|latest|final)\b"),
    re.compile(r"\b(?:undo)\s+(?:that|it|this)\b"),
    re.compile(_ERASE_AR + r".{0,25}(?:اخر|اخير\w*)"),
    re.compile(_ERASE_AR + r"\s+(?:ده|دي|دا|هذا|هذه)\s*$"),
]
ERASE_ANY = [re.compile(r"\b(?:erase|delete|remove|wipe|undo|get rid of)\b"), re.compile(_ERASE_AR)]
ORGANIZE = [re.compile(r"\b(?:organi[sz]e|tidy|arrange|re-?order|clean up)\b"), re.compile(r"(?:نظم\w*|رتب\w*|نسق\w*)")]


def _any(patterns: list[re.Pattern], text: str) -> bool:
    return any(p.search(text) for p in patterns)


def is_clear_command(message: str) -> bool:
    return _any(CLEAR, normalize(message))


def is_erase_last_command(message: str) -> bool:
    return _any(ERASE_LAST, normalize(message))


def is_erase_command(message: str) -> bool:
    """The student explicitly asked to remove something (any wording). Required before the coach may erase STUDENT-written content."""
    return _any(ERASE_ANY, normalize(message))


def is_organize_command(message: str) -> bool:
    return _any(ORGANIZE, normalize(message))


def fallback_actions(message: str) -> list[BoardAction]:
    """Safety net when the model returned no board action for an unmistakable command. Order matters: clear > erase last > organize."""
    if is_clear_command(message):
        return [BoardAction(action="clear")]
    if is_erase_last_command(message):
        return [BoardAction(action="erase", target="last")]
    if is_organize_command(message):
        return [BoardAction(action="organize")]
    return []
