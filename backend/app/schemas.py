"""Typed request bodies. Identity, role, university and policy are NEVER accepted from the client: they come from the
authenticated profile and the database. (Extra fields are rejected so a forged `student_id`/`policy` is a 422, not ignored.)"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Optional

from ai.whiteboard.models import BoardElement
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProfileIn(Strict):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    role: Literal["STUDENT", "PROFESSOR"]
    university_id: str = Field(min_length=1, max_length=80)


COLORS = ("plum", "slate", "teal", "clay")


class CourseIn(Strict):
    code: str = Field(min_length=1, max_length=30)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    color: Literal["plum", "slate", "teal", "clay"] = "plum"
    section_name: str = Field(default="Main", min_length=1, max_length=80)


class CoursePatch(Strict):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    color: Optional[Literal["plum", "slate", "teal", "clay"]] = None
    status: Optional[Literal["ACTIVE", "ARCHIVED"]] = None


class AssignmentIn(Strict):
    title: str = Field(min_length=1, max_length=200)
    topic: Optional[str] = Field(default=None, max_length=120)
    prompt: str = Field(min_length=1, max_length=50000)
    due_at: Optional[datetime] = None
    is_programming: bool = False
    publish: bool = False
    classroom_id: Optional[str] = None
    material_ids: list[str] = Field(default_factory=list, max_length=50)
    concepts: list[str] = Field(default_factory=list, max_length=20)


class AssignmentPatch(Strict):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    topic: Optional[str] = Field(default=None, max_length=120)
    prompt: Optional[str] = Field(default=None, min_length=1, max_length=50000)
    due_at: Optional[datetime] = None
    clear_due_at: bool = False
    is_programming: Optional[bool] = None
    material_ids: Optional[list[str]] = Field(default=None, max_length=50)
    concepts: Optional[list[str]] = Field(default=None, max_length=20)


class JoinIn(Strict):
    code: str = Field(min_length=4, max_length=20)

    @field_validator("code")
    @classmethod
    def norm(cls, v: str) -> str:
        v = "".join(ch for ch in v.upper() if ch.isalnum())
        if len(v) != 8:
            raise ValueError("invite codes have 8 letters/digits, e.g. K7M4-9QXA")
        return f"{v[:4]}-{v[4:]}"


class AttemptPatch(Strict):
    draft_text: str = Field(max_length=100000)


class Stroke(Strict):
    """One freehand stroke on the board: `p` pen / `e` eraser, width, and points in board units (0..2000)."""
    t: Literal["p", "e", "h"]            # pen / eraser / highlighter
    w: int = Field(ge=1, le=40)
    pts: list[tuple[int, int]] = Field(min_length=1, max_length=4000)
    color: Optional[str] = Field(default=None, max_length=40)

    @field_validator("pts")
    @classmethod
    def _in_board(cls, v):
        if any(not (0 <= x <= 2000 and 0 <= y <= 2000) for x, y in v):
            raise ValueError("stroke point outside the board")
        return v


class WhiteboardIn(Strict):
    steps: list[Annotated[str, StringConstraints(max_length=1000, strip_whitespace=True)]] = Field(default_factory=list, max_length=60)      # legacy typed steps
    strokes: list[Stroke] = Field(default_factory=list, max_length=600)
    elements: list[BoardElement] = Field(default_factory=list, max_length=200)      # smart-board elements (text, equations, arrows, shapes)
    next_seq: int = Field(default=0, ge=0, le=1_000_000)
    # Native (Excalidraw) scene. When present it is the ONLY thing a save changes: the legacy fields above are kept as stored.
    scene: Optional[dict[str, Any]] = None

    @field_validator("scene")
    @classmethod
    def _scene(cls, v):
        if v is None:
            return v
        from ai.whiteboard.scene import SceneError, sanitize_scene
        try:
            return sanitize_scene(v)
        except SceneError as e:
            raise ValueError(str(e))

    @model_validator(mode="after")
    def _bounded(self):
        if sum(len(s.pts) for s in self.strokes) > 30000:
            raise ValueError("the drawing is too large")
        ids = [e.id for e in self.elements]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate element ids")
        known = set(ids)
        for e in self.elements:
            if any(ref and ref not in known for ref in (e.from_id, e.to_id, e.around)):
                raise ValueError("an element refers to an element that does not exist")
        self.steps = [x for x in self.steps if x]
        return self


class SubmitTextIn(Strict):
    text: str = Field(min_length=1, max_length=100000)


class GradeIn(Strict):
    score: float = Field(ge=0, le=100000)
    max_score: float = Field(gt=0, le=100000)
    feedback: Optional[str] = Field(default=None, max_length=4000)


class CoachIn(Strict):
    assignment_id: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=4000)
    # Whiteboard context supplied by the UI. These only describe what the student is looking at / pressed; they never grant permissions:
    mode: Literal["chat", "board"] = "chat"
    selected_id: Optional[str] = Field(default=None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    board_intent: Optional[Literal["explain", "continue", "correct", "summarize", "organize", "highlight_key", "steps"]] = None


class VerificationAnswerIn(Strict):
    answer: str = Field(min_length=1, max_length=8000)


class EnrollmentPatch(Strict):
    status: Literal["active", "inactive"]
