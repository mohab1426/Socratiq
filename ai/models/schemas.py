"""
Core domain schemas shared across the AI Coach: assistance policy, diagnosis
categories, intervention types, learning events, and evidence.

These are the "contracts" other subsystems (backend, analytics) rely on.
Keep this file free of LangChain/LangGraph-specific concerns; those live in
ai/agents/coach/state.py and ai/agents/coach/schemas.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AssistancePolicy(str, Enum):
    GUIDED = "GUIDED"
    ASSISTED = "ASSISTED"
    OPEN = "OPEN"


class DiagnosisCategory(str, Enum):
    MISCONCEPTION = "MISCONCEPTION"
    CONCEPTUAL_GAP = "CONCEPTUAL_GAP"
    PROCEDURAL_ERROR = "PROCEDURAL_ERROR"
    LOGICAL_ERROR = "LOGICAL_ERROR"
    CODE_ERROR = "CODE_ERROR"
    INCOMPLETE_REASONING = "INCOMPLETE_REASONING"
    CORRECT_REASONING = "CORRECT_REASONING"
    UNCERTAIN = "UNCERTAIN"


class InterventionType(str, Enum):
    QUESTION = "QUESTION"
    HINT = "HINT"
    EXPLANATION = "EXPLANATION"
    GUIDED_DEBUGGING = "GUIDED_DEBUGGING"
    FEEDBACK = "FEEDBACK"
    CLARIFICATION = "CLARIFICATION"
    ENCOURAGEMENT = "ENCOURAGEMENT"


class EvidenceType(str, Enum):
    UNDERSTANDING = "UNDERSTANDING"
    MISCONCEPTION = "MISCONCEPTION"
    REVISION = "REVISION"
    INDEPENDENCE = "INDEPENDENCE"
    EXPLANATION = "EXPLANATION"
    TRANSFER = "TRANSFER"


class EvidenceStrength(str, Enum):
    WEAK = "WEAK"
    MODERATE = "MODERATE"
    STRONG = "STRONG"


class LearningEventType(str, Enum):
    ATTEMPT = "ATTEMPT"
    AI_INTERACTION = "AI_INTERACTION"
    REVISION = "REVISION"
    SUBMISSION = "SUBMISSION"
    VERIFICATION = "VERIFICATION"


class Diagnosis(BaseModel):
    """Structured diagnosis of the student's current learning state."""

    category: DiagnosisCategory
    concept: Optional[str] = Field(default=None, description="Primary concept implicated, if any.")
    explanation: str = Field(description="Short explanation of the reasoning behind the diagnosis.")
    evidence: str = Field(description="What in the student's attempt supports this diagnosis.")
    confidence: float = Field(ge=0.0, le=1.0, description="Model's confidence in this diagnosis.")

    @property
    def is_uncertain(self) -> bool:
        return self.category == DiagnosisCategory.UNCERTAIN or self.confidence < 0.4


class Intervention(BaseModel):
    """The chosen pedagogical intervention for this turn."""

    type: InterventionType
    assistance_level: AssistancePolicy
    rationale: str = Field(description="Why this intervention was chosen given the diagnosis and policy.")


class RetrievedContext(BaseModel):
    """A single piece of retrieved context (course material, history, etc.)."""

    source: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class AIInteraction(BaseModel):
    """Structured record of one Coach turn. Persisted by the backend."""

    interaction_id: str = Field(default_factory=lambda: _new_id("int"))
    session_id: str
    student_id: str
    assignment_id: str
    intervention_type: InterventionType
    assistance_level: AssistancePolicy
    diagnosis: Diagnosis
    response: str
    referenced_concepts: list[str] = Field(default_factory=list)
    tools_used: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)


class LearningEvidenceCandidate(BaseModel):
    """
    Evidence *candidate* emitted by the Coach. Downstream analytics decides
    whether/how to turn this into a durable indicator. The Coach never
    computes mastery/dependency scores.
    """

    id: str = Field(default_factory=lambda: _new_id("ev"))
    student_id: str
    assignment_id: str
    concept: Optional[str] = None
    evidence_type: EvidenceType
    strength: EvidenceStrength
    observation: str
    source_event_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)


class LearningEvent(BaseModel):
    """Generic envelope the Coach can emit for the backend to persist."""

    id: str = Field(default_factory=lambda: _new_id("evt"))
    student_id: str
    assignment_id: str
    session_id: str
    event_type: LearningEventType
    timestamp: datetime = Field(default_factory=_utcnow)
    payload: dict[str, Any] = Field(default_factory=dict)


class ExternalAIRiskSignal(BaseModel):
    """
    A single *observable* signal the Coach can expose for a future, separate
    risk-assessment component. The Coach never asserts that a student used
    an external AI tool -- it only reports what it observed.
    """

    signal: str
    observation: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoachSourceReference(BaseModel):
    """Trustworthy citation for one piece of retrieved course material used
    in a Coach turn. Populated exclusively from retrieval metadata
    (`RetrievedContext.metadata`) in `Coach._to_result` -- never from
    LLM-generated text -- so the Coach can never invent a citation."""

    document_id: Optional[str] = None
    document_title: Optional[str] = None
    chunk_id: Optional[str] = None
    page_number: Optional[int] = None
    section: Optional[str] = None
    score: Optional[float] = None


class CoachResult(BaseModel):
    """Public output contract returned by `coach.invoke(...)`."""

    response: str
    intervention: Intervention
    diagnosis_summary: Diagnosis
    referenced_concepts: list[str] = Field(default_factory=list)
    tools_used: list[str] = Field(default_factory=list)
    learning_event: LearningEvent
    evidence_candidates: list[LearningEvidenceCandidate] = Field(default_factory=list)
    risk_signals: list[ExternalAIRiskSignal] = Field(default_factory=list)
    sources: list[CoachSourceReference] = Field(
        default_factory=list,
        description=(
            "Course-material citations actually used this turn, derived solely "
            "from retrieval metadata -- never from LLM-generated text."
        ),
    )
    board_actions: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Whiteboard actions that passed the pedagogy validator (the backend re-validates them against the stored board).",
    )
    metadata: dict[str, Any] = Field(default_factory=dict)
