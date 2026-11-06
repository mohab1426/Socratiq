"""What changed on the board since the Coach last replied ("Object X changed from A to B").

The Coach already READS the whole board each turn (`digest.render_board_for_llm`). This module adds the missing piece: a compact, semantic
DELTA so the tutor can react to what the student just did instead of re-diagnosing the whole board. Design rules:

  * no pointer events, no pixels: only meaningful changes (added / removed / edited / highlighted / moved / strokes)
  * baseline = a small snapshot stored in the AI_INTERACTION event payload after each turn (jsonb, no schema change). It is taken AFTER the
    Coach's own actions were applied, so the Coach's writing is never reported back to it as a "student change" (no AI -> board -> AI loop)
  * the first turn, or a legacy event with no snapshot, has no baseline: no delta (the full board listing still covers it)
  * pure functions over plain dicts; imports nothing heavy so it is trivial to test
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

CONTENT_CHARS = 80          # enough to show "from A to B" for a typical equation, small enough to keep the snapshot cheap
MOVE_THRESHOLD = 40         # board units; smaller drags are jitter, not a meaningful change
MAX_LINES = 12              # lines rendered for the model; the rest is summarised as "+N more"
SNAPSHOT_VERSION = 1

_WS = re.compile(r"\s+")
_CTRL = re.compile(r"[\x00-\x1f]")


def _clip(s: Any, n: int = CONTENT_CHARS) -> str:
    s = _WS.sub(" ", _CTRL.sub(" ", str(s or ""))).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _int(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _content(e: dict) -> str:
    return _clip(e.get("latex") if e.get("kind") == "equation" else e.get("text"))


def snapshot(board: Optional[dict]) -> dict:
    """Compact, JSON-safe fingerprint of a board: id -> kind, author, clipped content, position, highlight, seq. Strokes are only counted."""
    b = board if isinstance(board, dict) else {}
    els = [e for e in (b.get("elements") or []) if isinstance(e, dict) and e.get("id") and e.get("kind")]
    return {
        "v": SNAPSHOT_VERSION,
        "els": {str(e["id"]): {"k": e["kind"], "a": e.get("author") or "student", "c": _content(e), "x": _int(e.get("x")), "y": _int(e.get("y")),
                               "h": e.get("highlight"), "s": _int(e.get("seq"))} for e in els},
        "strokes": len(b.get("strokes") or []),
    }


def student_changes(before: Optional[dict], board: Optional[dict]) -> list[dict]:
    """Meaningful differences between a stored baseline snapshot and the board as it is now. [] when there is no usable baseline."""
    if not isinstance(before, dict) or not isinstance(before.get("els"), dict):
        return []
    old, new = before["els"], snapshot(board)
    cur = new["els"]
    out: list[dict] = []

    for eid, e in sorted(old.items(), key=lambda kv: _int(kv[1].get("s"))):
        if eid not in cur:
            out.append({"kind": "removed", "id": eid, "element": e.get("k"), "author": e.get("a"), "before": e.get("c") or None})
    for eid, e in sorted(cur.items(), key=lambda kv: kv[1]["s"]):
        o = old.get(eid)
        if o is None:
            out.append({"kind": "added", "id": eid, "element": e["k"], "author": e["a"], "after": e["c"] or None})
            continue
        if e["k"] in ("text", "equation") and (o.get("c") or "") != e["c"]:
            out.append({"kind": "edited", "id": eid, "element": e["k"], "author": e["a"], "before": o.get("c") or "", "after": e["c"]})
        if (o.get("h") or None) != (e["h"] or None):
            out.append({"kind": "highlighted" if e["h"] else "unhighlighted", "id": eid, "element": e["k"], "author": e["a"], "color": e["h"]})
        if e["k"] in ("text", "equation") and max(abs(_int(o.get("x")) - e["x"]), abs(_int(o.get("y")) - e["y"])) >= MOVE_THRESHOLD:
            out.append({"kind": "moved", "id": eid, "element": e["k"], "author": e["a"]})

    delta = new["strokes"] - _int(before.get("strokes"))
    if delta:
        out.append({"kind": "strokes", "n": delta})
    return out


def _q(s: Optional[str]) -> str:
    return json.dumps(s or "", ensure_ascii=False)      # quoted + escaped: student text can never break out of the line


def render_changes(changes: list[dict], max_lines: int = MAX_LINES) -> list[str]:
    """One short English sentence per change (the model answers in the student's language itself)."""
    lines: list[str] = []
    for c in changes:
        k, who, what = c["kind"], c.get("author") or "student", f"{c.get('element')} {c.get('id')}"
        if k == "added":
            lines.append(f"{who} added {what}" + (f": {_q(c.get('after'))}" if c.get("after") else ""))
        elif k == "removed":
            lines.append(f"{who} removed {what}" + (f" (it said {_q(c.get('before'))})" if c.get("before") else ""))
        elif k == "edited":
            lines.append(f"{who} edited {what} from {_q(c.get('before'))} to {_q(c.get('after'))}")
        elif k == "highlighted":
            lines.append(f"{what} was highlighted {c.get('color')}")
        elif k == "unhighlighted":
            lines.append(f"highlight removed from {what}")
        elif k == "moved":
            lines.append(f"{what} was moved")
        elif k == "strokes":
            n = c["n"]
            lines.append(f"{abs(n)} freehand stroke{'s' if abs(n) != 1 else ''} {'added (drawing or erasing)' if n > 0 else 'removed'}")
    if len(lines) > max_lines:
        extra = len(lines) - max_lines
        lines = lines[:max_lines] + [f"(+{extra} more change{'s' if extra != 1 else ''})"]
    return lines


def count_by_kind(changes: list[dict]) -> dict[str, int]:
    """Tiny summary for the learning-event payload (counts only, never board content)."""
    out: dict[str, int] = {}
    for c in changes:
        out[c["kind"]] = out.get(c["kind"], 0) + 1
    return out
