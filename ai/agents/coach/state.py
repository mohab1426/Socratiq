"""
Coach working state.

This represents the *current learning interaction*, not the student's full
persistent profile. Long-term analytics fields (mastery/dependency scores,
etc.) must never live here -- see docs/AI_SPEC.md section on boundaries.
"""
from __future__ import annotations

from typing import Annotated, Any, Optional

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field
from typing_extensions import TypedDict

from ai.models.schemas import (
    AssistancePolicy,
    Diagnosis,
    ExternalAIRiskSignal,
    Intervention,
    LearningEvidenceCandidate,
    RetrievedContext,
)
from ai.tools.code_analysis import CodeAnalysisResult


class MaterialInfo(BaseModel):
    """One course-material catalog entry. This is metadata only; content comes from RAG."""
    title: str
    file_type: Optional[str] = None
    searchable: bool = True


class AttachmentInfo(BaseModel):
    """Assignment attachment metadata supplied by trusted application data."""
    filename: str
    role: str = "SUPPORTING"


class TaskContext(BaseModel):
    """Static context about the assignment the student is working on.

    Tenant scoping fields (university_id, classroom_id, allowed_document_ids)
    are populated exclusively by trusted backend session authorization.
    """

    assignment_id: str
    course_id: str
    title: str
    instructions: str
    subject_area: Optional[str] = None
    # Optional richer application context. These are populated when available, but the MVP
    # assignment-understanding path requires only title/instructions/subject_area.
    university_name: Optional[str] = None
    course_code: Optional[str] = None
    course_title: Optional[str] = None
    classroom_name: Optional[str] = None
    due_at: Optional[str] = None
    attachments: list[AttachmentInfo | dict[str, Any]] = Field(default_factory=list)
    materials: list[MaterialInfo | dict[str, Any]] = Field(default_factory=list)
    materials_total: int = 0
    # Concepts the instructor attached to the assignment (optional enrichment; never required to understand the assignment).
    concepts: list[str] = Field(default_factory=list)
    is_programming: bool = False
    # Supplied by trusted backend/session authorization, never student text.
    university_id: Optional[str] = None
    classroom_id: Optional[str] = None
    allowed_document_ids: list[str] = Field(default_factory=list)


class StudentContext(BaseModel):
    """Safe student-facing context. Never contains auth or database identifiers."""
    display_name: Optional[str] = None


class InteractionMetadata(BaseModel):
    student_id: str
    assignment_id: str
    session_id: str
    turn_index: int = 0


class CoachState(TypedDict, total=False):
    """LangGraph state dict for a single Coach graph execution."""

    # --- input / static context ---
    task_context: TaskContext
    policy: AssistancePolicy
    metadata: InteractionMetadata
    student_context: StudentContext

    # --- conversation ---
    messages: Annotated[list[BaseMessage], add_messages]
    current_attempt: str
    # Deterministic classification for low-cost trusted-context requests.
    request_intent: Optional[str]

    # --- working products of the graph ---
    code_analysis: Optional[CodeAnalysisResult]
    diagnosis: Optional[Diagnosis]
    repeated_difficulty: bool   # same non-correct diagnosis on consecutive turns: the support level should adapt
    intervention: Optional[Intervention]
    retrieved_context: list[RetrievedContext]
    student_learning_context: list[RetrievedContext]
    tools_used: list[str]
    needs_course_material: bool
    needs_student_history: bool
    response: Optional[str]
    referenced_concepts: list[str]
    evidence_candidates: list[LearningEvidenceCandidate]
    risk_signals: list[ExternalAIRiskSignal]

    # --- validation / control flow ---
    validation_passed: Optional[bool]
    validation_violations: list[str]
    retry_count: int
    errors: list[str]

    # --- whiteboard (optional capability; absent for turns without a board) ---
    board_enabled: bool
    board: Optional[dict]
    board_mode: str
    board_selected_id: Optional[str]
    board_intent: Optional[str]
    board_actions: list[dict]
