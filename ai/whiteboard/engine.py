"""Validation + semantic layout + application of board actions. Pure functions over a plain-dict board (the JSON stored in
`attempts.whiteboard`). The model proposes `BoardAction`s; this module decides what actually reaches the board.

Safety rules enforced here (not left to the prompt):
  * the model never chooses coordinates; positions come from the layout below
  * `clear`, erasing the STUDENT's own elements, and `organize` happen only on an explicit student request
  * the student's own elements are never rewritten (`update` is for coach-authored elements only)
  * GUIDED assistance refuses content the model itself flagged as writing the final answer
  * equations must pass the LaTeX allow-list; limits on element count and text size
"""
from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass, field
from typing import Optional

from pydantic import ValidationError

from . import intents
from .latex import check_latex
from .models import BOARD_H, BOARD_W, MAX_ELEMENTS, MAX_TEXT_CHARS, BoardAction, BoardElement

MARGIN, GAP = 60, 28
COL_X = (60, 1010)
COL_W = 940
BOTTOM, RIGHT = 1140, 1960
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


@dataclass
class ApplyResult:
    board: dict
    applied: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.applied)


def estimate_size(kind: str, text: Optional[str] = None, latex: Optional[str] = None) -> tuple[int, int]:
    """Deterministic box estimate (logical units). The frontend uses the same constants; exactness is not required, stability is."""
    if kind == "equation":
        s = latex or ""
        tall = any(t in s for t in ("\\frac", "\\sum", "\\int", "\\begin", "\\\\", "\\sqrt", "\\lim"))
        return min(COL_W, max(220, len(s) * 24)), 160 if tall else 100
    s = text or ""
    w = min(COL_W, max(160, len(s.split("\n")[0]) * 22 + 32))
    usable = max(1, w - 32)
    lines = sum(max(1, math.ceil(len(line) * 22 / usable)) for line in s.split("\n"))
    return w, lines * 56 + 20


def normalize_board(board: Optional[dict]) -> dict:
    b = copy.deepcopy(board) if isinstance(board, dict) else {}
    els = [e for e in (b.get("elements") or []) if isinstance(e, dict) and e.get("id") and e.get("kind")]
    b["steps"] = list(b.get("steps") or [])
    b["strokes"] = list(b.get("strokes") or [])
    b["elements"] = sorted(els, key=lambda e: e.get("seq", 0))
    b["next_seq"] = max([int(b.get("next_seq") or 0)] + [int(e.get("seq", 0)) + 1 for e in els])
    return b


# ------------------------------------------------------------------------------------------------------------------------ layout
def _flow(els: list[dict]) -> list[dict]:
    return [e for e in els if e["kind"] in ("text", "equation")]


def _hit(a: tuple[int, int, int, int], e: dict) -> bool:
    ax, ay, aw, ah = a
    return not (ax + aw <= e["x"] or e["x"] + e["w"] <= ax or ay + ah <= e["y"] or e["y"] + e["h"] <= ay)


def _place(els: list[dict], w: int, h: int, position: str, near: Optional[dict], side: str = "below") -> Optional[tuple[int, int]]:
    flow = _flow(els)
    last = flow[-1] if flow else None
    if near is not None:
        x, y = {"below": (near["x"], near["y"] + near["h"] + GAP), "right": (near["x"] + near["w"] + GAP, near["y"]),
                "above": (near["x"], near["y"] - h - GAP), "left": (near["x"] - w - GAP, near["y"])}[side]
    elif position == "right_of_previous" and last:
        x, y = last["x"] + last["w"] + GAP, last["y"]
    elif position == "top":
        x, y = (BOARD_W - w) // 2, MARGIN
    elif position == "center":
        x, y = (BOARD_W - w) // 2, (BOARD_H - h) // 2
    elif position == "bottom":
        x, y = (BOARD_W - w) // 2, BOTTOM - h
    elif position == "left":
        x, y = MARGIN, (BOARD_H - h) // 2
    elif position == "right":
        x, y = RIGHT - w, (BOARD_H - h) // 2
    elif last:
        x, y = last["x"], last["y"] + last["h"] + GAP          # auto / below_previous: keep writing downwards like a teacher
    else:
        x, y = MARGIN, MARGIN
    x = max(0, min(x, RIGHT - w))
    y = max(0, min(y, BOARD_H - h))
    moved_column = False
    for _ in range(80):
        hits = [e for e in flow if _hit((x, y, w, h), e)]
        if hits:
            y = max(e["y"] + e["h"] for e in hits) + GAP
        if y + h > BOTTOM:
            if moved_column or x >= COL_X[1]:
                return None
            x, y, moved_column = COL_X[1], MARGIN, True
            continue
        if not hits:
            return x, y
    return None


def _link_geometry(els: list[dict]) -> None:
    """Recompute arrows (from_id/to_id) and shapes (around) after anything moved, was edited or erased."""
    by_id = {e["id"]: e for e in els}
    for e in list(els):
        if e["kind"] == "arrow" and e.get("from_id") and e.get("to_id"):
            f, t = by_id.get(e["from_id"]), by_id.get(e["to_id"])
            if f is None or t is None:
                els.remove(e)
                continue
            fx, fy = f["x"] + f["w"] // 2, f["y"] + f["h"] // 2
            tx, ty = t["x"] + t["w"] // 2, t["y"] + t["h"] // 2
            e.update(x=max(0, min(fx, BOARD_W)), y=max(0, min(fy, BOARD_H)), w=max(-BOARD_W, min(tx - fx, BOARD_W)), h=max(-BOARD_H, min(ty - fy, BOARD_H)))
        elif e["kind"] == "shape" and e.get("around"):
            a = by_id.get(e["around"])
            if a is None:
                els.remove(e)
                continue
            pad = 18
            x, y = max(0, a["x"] - pad), max(0, a["y"] - pad)
            e.update(x=x, y=y, w=min(a["w"] + 2 * pad, BOARD_W - x), h=min(a["h"] + 2 * pad, BOARD_H - y))


# ------------------------------------------------------------------------------------------------------------------------ apply
def apply_actions(board: Optional[dict], actions: list[BoardAction], *, message: str = "", intent: Optional[str] = None, policy: str = "GUIDED",
                  max_elements: int = MAX_ELEMENTS) -> ApplyResult:
    b = normalize_board(board)
    els: list[dict] = b["elements"]
    res = ApplyResult(board=b)
    refs: dict[str, str] = {}

    def find(ref_or_id: Optional[str]) -> Optional[dict]:
        if not ref_or_id:
            return None
        rid = refs.get(ref_or_id, ref_or_id)
        return next((e for e in els if e["id"] == rid), None)

    def reject(a: BoardAction, why: str) -> None:
        res.rejected.append({"action": a.action, "reason": why})

    def new_element(a: BoardAction, kind: str, **fields) -> Optional[dict]:
        if len(els) >= max_elements:
            reject(a, "the board is full")
            return None
        seq = b["next_seq"]
        el = {"id": f"e{seq}", "kind": kind, "author": "coach", "seq": seq, **fields}
        try:
            BoardElement.model_validate(el)
        except ValidationError as exc:
            reject(a, "invalid element: " + exc.errors()[0].get("msg", "invalid")[:120])
            return None
        b["next_seq"] = seq + 1
        els.append(el)
        if a.ref:
            refs[a.ref] = el["id"]
        return el

    explicit_clear = intents.is_clear_command(message) or intent == "clear"
    explicit_erase = intents.is_erase_command(message)
    explicit_organize = intents.is_organize_command(message) or intent == "organize"

    for a in actions:
        try:
            if a.action in ("add_text", "add_equation", "update") and a.reveals_solution and policy == "GUIDED":
                reject(a, "guided mode: the final answer is not written for the student")
                continue

            if a.action in ("add_text", "add_equation"):
                near = find(a.near_id) if a.near_id else None
                if a.near_id and near is None:
                    reject(a, "near_id not found")
                    continue
                if a.action == "add_text":
                    text = _CTRL.sub("", (a.text or "")).strip()
                    if not text:
                        reject(a, "empty text")
                        continue
                    if len(text) > MAX_TEXT_CHARS:
                        reject(a, "text too long")
                        continue
                    kind, content = "text", {"text": text, "style": a.style or "plain"}
                else:
                    latex = (a.latex or "").strip()
                    why = check_latex(latex)
                    if why:
                        reject(a, "equation rejected: " + why)
                        continue
                    kind, content = "equation", {"latex": latex}
                w, h = estimate_size(kind, content.get("text"), content.get("latex"))
                pos = _place(els, w, h, a.position, near, a.side)
                if pos is None:
                    reject(a, "no room on the board")
                    continue
                el = new_element(a, kind, x=pos[0], y=pos[1], w=w, h=h, **content)
                if el:
                    res.applied.append({"action": a.action, "id": el["id"]})

            elif a.action in ("highlight", "unhighlight"):
                el = find(a.target_id)
                if el is None or el["kind"] not in ("text", "equation", "shape"):
                    reject(a, "target not found")
                    continue
                if a.action == "highlight":
                    el["highlight"] = a.color or "yellow"
                else:
                    el.pop("highlight", None)
                res.applied.append({"action": a.action, "id": el["id"]})

            elif a.action == "erase":
                if a.target_id:
                    el = find(a.target_id)
                else:
                    cands = [e for e in els if e["kind"] in ("text", "equation")] or [e for e in els if e["kind"] == "shape"]
                    el = cands[-1] if cands else None
                if el is None:
                    reject(a, "nothing to erase")
                    continue
                if el.get("author") == "student" and not explicit_erase:
                    reject(a, "the student's own work is erased only when they ask for it")
                    continue
                els.remove(el)
                for dep in [e for e in els if e.get("from_id") == el["id"] or e.get("to_id") == el["id"] or e.get("around") == el["id"]]:
                    els.remove(dep)
                res.applied.append({"action": "erase", "id": el["id"]})

            elif a.action == "clear":
                if not explicit_clear:
                    reject(a, "clearing the board needs an explicit request from the student")
                    continue
                els.clear()
                b["strokes"], b["steps"] = [], []
                res.applied.append({"action": "clear", "id": "*"})

            elif a.action == "update":
                el = find(a.target_id)
                if el is None or el["kind"] not in ("text", "equation"):
                    reject(a, "target not found")
                    continue
                if el.get("author") != "coach":
                    reject(a, "the student's own work is not rewritten; add a note next to it instead")
                    continue
                if el["kind"] == "text":
                    text = _CTRL.sub("", (a.text or "")).strip()
                    if not text or len(text) > MAX_TEXT_CHARS:
                        reject(a, "invalid text")
                        continue
                    el["text"] = text
                else:
                    why = check_latex((a.latex or "").strip())
                    if why:
                        reject(a, "equation rejected: " + why)
                        continue
                    el["latex"] = a.latex.strip()
                el["w"], el["h"] = estimate_size(el["kind"], el.get("text"), el.get("latex"))
                res.applied.append({"action": "update", "id": el["id"]})

            elif a.action == "add_arrow":
                f, t = find(a.from_id), find(a.to_id)
                if f is None or t is None or f is t or "arrow" in (f["kind"], t["kind"]):
                    reject(a, "arrow endpoints not found")
                    continue
                el = new_element(a, "arrow", x=0, y=0, w=1, h=0, from_id=f["id"], to_id=t["id"], color=a.color)
                if el:
                    _link_geometry(els)
                    res.applied.append({"action": "add_arrow", "id": el["id"]})

            elif a.action == "add_shape":
                around = find(a.around_id)
                if around is None or around["kind"] == "arrow":
                    reject(a, "shape target not found")
                    continue
                el = new_element(a, "shape", x=0, y=0, w=1, h=1, shape=a.shape or "rect", around=around["id"], color=a.color)
                if el:
                    _link_geometry(els)
                    res.applied.append({"action": "add_shape", "id": el["id"]})

            elif a.action == "organize":
                if not explicit_organize:
                    reject(a, "organizing the board needs an explicit request from the student")
                    continue
                placed: list[dict] = []
                for e in _flow(els):
                    pos = _place(placed, e["w"], e["h"], "auto", None)
                    if pos is not None:
                        e["x"], e["y"] = pos
                    placed.append(e)
                _link_geometry(els)
                res.applied.append({"action": "organize", "id": "*"})
        except Exception:  # noqa: BLE001  one bad action must never break the turn
            reject(a, "could not be applied")
    _link_geometry(els)
    return res
