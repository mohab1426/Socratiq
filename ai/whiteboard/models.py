"""Board data model shared by the API, the Coach and the tests. The frontend mirrors it in `frontend/src/lib/whiteboard.ts`.

`BoardElement` is what is STORED (strict). `BoardAction` is what the model PROPOSES (lenient parse, then validated by the engine):
the model never supplies coordinates, only semantic positions ("below_previous", "near_id"), so it cannot place raw pixels.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .latex import check_latex

BOARD_W, BOARD_H = 2000, 1200
MAX_ELEMENTS = 200
MAX_ACTIONS_PER_TURN = 12
MAX_TEXT_CHARS = 1000

Kind = Literal["text", "equation", "shape", "arrow", "line", "circle", "triangle", "image", "simulation", "path"]
Author = Literal["student", "coach"]
TextStyle = Literal["plain", "title", "definition", "note", "step"]
Color = Literal["yellow", "green", "red", "blue", "black", "white", "slate", "purple", "pink"]
Position = Literal["auto", "below_previous", "right_of_previous", "top", "center", "bottom", "left", "right"]
ActionName = Literal["add_text", "add_equation", "highlight", "unhighlight", "erase", "clear", "update", "add_arrow", "add_shape", "organize"]


class BoardElement(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=64)
    kind: Kind
    author: Author = "student"
    seq: int = Field(default=0, ge=0, le=1_000_000)
    x: float = Field(default=0)
    y: float = Field(default=0)
    w: float = Field(default=0)
    h: float = Field(default=0)
    text: Optional[str] = Field(default=None, max_length=MAX_TEXT_CHARS)
    latex: Optional[str] = Field(default=None, max_length=400)
    style: Optional[TextStyle] = None
    color: Optional[str] = None
    highlight: Optional[str] = None
    from_id: Optional[str] = Field(default=None, max_length=64)
    to_id: Optional[str] = Field(default=None, max_length=64)
    shape: Optional[str] = None
    around: Optional[str] = Field(default=None, max_length=64)
    # SmartBoard properties
    rotation: Optional[float] = 0
    filled: Optional[bool] = False
    stroke_width: Optional[float] = Field(default=None, alias="strokeWidth")
    x2: Optional[float] = None
    y2: Optional[float] = None
    points: Optional[list[Any]] = None
    path_data: Optional[str] = Field(default=None, alias="pathData")
    src: Optional[str] = None
    code: Optional[str] = None
    title: Optional[str] = None
    font_size: Optional[float] = Field(default=None, alias="fontSize")
    is_loading: Optional[bool] = Field(default=False, alias="isLoading")
    original_author: Optional[str] = Field(default=None, alias="originalAuthor")
    student_modified: Optional[bool] = Field(default=None, alias="studentModified")

    @model_validator(mode="after")
    def _by_kind(self):
        if self.kind == "text" and not (self.text or "").strip():
            raise ValueError("text element needs text")
        if self.kind == "equation":
            why = check_latex(self.latex)
            if why:
                raise ValueError(f"equation rejected: {why}")
        if self.kind == "shape" and not self.shape:
            raise ValueError("shape element needs a shape")
        if self.kind == "arrow" and not ((self.from_id and self.to_id) or self.w or self.h):
            raise ValueError("arrow needs endpoints")
        return self


class BoardAction(BaseModel):
    """One proposed change. Unknown fields are ignored; everything is re-validated by the engine against the real board."""
    model_config = ConfigDict(extra="ignore")
    action: ActionName
    text: Optional[str] = Field(default=None, max_length=MAX_TEXT_CHARS)
    latex: Optional[str] = Field(default=None, max_length=400)
    style: Optional[TextStyle] = None
    position: Position = "auto"
    near_id: Optional[str] = Field(default=None, max_length=40)
    side: Literal["below", "right", "above", "left"] = "below"
    target_id: Optional[str] = Field(default=None, max_length=40)
    target: Optional[Literal["last"]] = None
    color: Optional[Color] = None
    ref: Optional[str] = Field(default=None, max_length=24)
    from_id: Optional[str] = Field(default=None, max_length=40)
    to_id: Optional[str] = Field(default=None, max_length=40)
    shape: Optional[Literal["rect", "ellipse"]] = None
    around_id: Optional[str] = Field(default=None, max_length=40)
    reveals_solution: bool = False                 # the model's own flag: "this writes the final answer"; GUIDED policy refuses those


def parse_actions(raw: Any) -> tuple[list[BoardAction], list[dict[str, str]]]:
    """Lenient parsing of model output. Never raises: malformed items are reported as rejected, the rest are kept."""
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [{"action": "?", "reason": "board_actions was not a list"}]
    ok: list[BoardAction] = []
    bad: list[dict[str, str]] = []
    for i, item in enumerate(raw):
        if len(ok) >= MAX_ACTIONS_PER_TURN:
            bad.append({"action": str(item.get("action", "?")) if isinstance(item, dict) else "?", "reason": f"more than {MAX_ACTIONS_PER_TURN} actions in one turn"})
            continue
        try:
            ok.append(BoardAction.model_validate(item))
        except (ValidationError, TypeError, ValueError):
            bad.append({"action": str(item.get("action", "?")) if isinstance(item, dict) else "?", "reason": "malformed action"})
    return ok, bad
