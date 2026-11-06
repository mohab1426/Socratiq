"""
FastAPI integration contracts and DTOs for the AI Coach and Learning Verification.

These models lock the HTTP contract between Backend <-> AI Package, making
the REST API layer trivial to implement in the next phase without touching
the AI Core.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from pydantic import BaseModel, Field

from ai.agents.coach.graph import Coach, get_default_coach
from ai.agents.coach.state import TaskContext
from ai.models.schemas import (
    AssistancePolicy,
    CoachResult,
    Diagnosis,
    ExternalAIRiskSignal,
    Intervention,
    LearningEvent,
    LearningEvidenceCandidate,
)
from ai.verification.models import (
    CriterionEvaluation,
    VerificationChallenge,
    VerificationChallengeRequest,
    VerificationOutcome,
    VerificationRequest,
    VerificationResult,
    VerificationType,
)
from ai.verification.service import VerificationService, get_default_verification_service


class ChatMessageDto(BaseModel):
    """Normalized chat message for API requests."""

    role: Literal["student", "coach", "human", "ai"]
    content: str


class CoachApiRequest(BaseModel):
    """Payload for POST /api/ai/coach."""

    student_id: str = Field(..., description="Unique student identifier.")
    assignment_id: str = Field(..., description="Unique assignment identifier.")
    session_id: str = Field(..., description="Unique session / thread identifier.")
    course_id: str = Field(..., description="Unique course identifier for RAG isolation.")
    attempt: str = Field(..., description="The student's current solution or work.")
    policy: AssistancePolicy = Field(
        default=AssistancePolicy.GUIDED, description="Pedagogical assistance policy."
    )
    message: Optional[str] = Field(
        default=None, description="Optional conversational message alongside the attempt."
    )
    assignment_title: Optional[str] = Field(
        default="", description="Title of the assignment."
    )
    assignment_instructions: Optional[str] = Field(
        default="", description="Detailed instructions of the assignment."
    )
    is_programming: bool = Field(
        default=False, description="Whether the assignment is programming-focused."
    )
    turn_index: int = Field(
        default=0, description="0-indexed turn number within this session."
    )
    conversation: list[ChatMessageDto] = Field(
        default_factory=list, description="Prior windowed turns for this session."
    )
    prior_diagnosis: Optional[Diagnosis] = Field(
        default=None,
        description=(
            "The `diagnosis` from the previous CoachApiResponse for this "
            "session, if any -- lets diagnosis/intervention selection adapt "
            "to what was already found. Optional; the Coach remains "
            "stateless and never fetches this itself."
        ),
    )
    prior_intervention: Optional[Intervention] = Field(
        default=None,
        description=(
            "The `intervention` from the previous CoachApiResponse for "
            "this session, if any."
        ),
    )


class CoachApiResponse(BaseModel):
    """Response payload for POST /api/ai/coach."""

    response: str = Field(description="Student-facing response message.")
    intervention: Intervention
    diagnosis: Diagnosis
    referenced_concepts: list[str] = Field(default_factory=list)
    tools_used: list[str] = Field(default_factory=list)
    learning_event: LearningEvent
    evidence_candidates: list[LearningEvidenceCandidate] = Field(default_factory=list)
    risk_signals: list[ExternalAIRiskSignal] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


def run_coach_turn(
    request: CoachApiRequest, coach: Optional[Coach] = None
) -> CoachApiResponse:
    """Adapter function executing a single Coach turn from an API request."""
    coach_instance = coach or get_default_coach()

    # Convert conversation DTOs to LangChain messages
    messages: list[BaseMessage] = []
    for msg in request.conversation:
        if msg.role in ("student", "human"):
            messages.append(HumanMessage(content=msg.content))
        else:
            messages.append(AIMessage(content=msg.content))

    task_context = TaskContext(
        assignment_id=request.assignment_id,
        course_id=request.course_id,
        title=request.assignment_title or request.assignment_id,
        instructions=request.assignment_instructions or "",
        is_programming=request.is_programming,
    )

    result: CoachResult = coach_instance.invoke(
        student_id=request.student_id,
        assignment_id=request.assignment_id,
        session_id=request.session_id,
        task_context=task_context,
        attempt=request.attempt,
        policy=request.policy,
        message=request.message,
        conversation=messages,
        turn_index=request.turn_index,
        prior_diagnosis=request.prior_diagnosis,
        prior_intervention=request.prior_intervention,
    )

    return CoachApiResponse(
        response=result.response,
        intervention=result.intervention,
        diagnosis=result.diagnosis_summary,
        referenced_concepts=result.referenced_concepts,
        tools_used=result.tools_used,
        learning_event=result.learning_event,
        evidence_candidates=result.evidence_candidates,
        risk_signals=result.risk_signals,
        metadata=result.metadata,
    )


class VerificationChallengeApiRequest(BaseModel):
    """Payload for POST /api/ai/verify/challenge."""

    assignment_id: str
    concept: str
    verification_type: VerificationType = VerificationType.EXPLAIN
    student_work: str
    course_context: Optional[str] = None


class VerificationChallengeApiResponse(BaseModel):
    """Response payload for POST /api/ai/verify/challenge."""

    challenge_id: str
    verification_type: VerificationType
    concept: str
    question: str
    criteria: list[str] = Field(default_factory=list)


class VerificationEvaluateApiRequest(BaseModel):
    """Payload for POST /api/ai/verify/evaluate."""

    student_id: str
    assignment_id: str
    concept: str
    verification_type: VerificationType = VerificationType.EXPLAIN
    challenge_question: str
    student_response: str
    criteria: list[str] = Field(default_factory=list)
    original_attempt: Optional[str] = None


class VerificationEvaluateApiResponse(BaseModel):
    """Response payload for POST /api/ai/verify/evaluate."""

    verification_id: str
    student_id: str
    assignment_id: str
    concept: str
    verification_type: VerificationType
    outcome: VerificationOutcome
    score: float
    confidence: float
    feedback: str
    criteria_evaluations: list[CriterionEvaluation] = Field(default_factory=list)
    evidence_candidate: Optional[LearningEvidenceCandidate] = None
