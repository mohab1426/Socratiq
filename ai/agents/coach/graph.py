"""
Coach LangGraph assembly + public entry point.

Backend integration should only need `Coach.invoke(...)` (or the module-
level `get_default_coach()` helper) -- it does not need to know about
LangGraph internals. See docs/AI_SPEC.md for the full integration contract.
"""
from __future__ import annotations

import logging
from typing import Optional

from langchain_core.messages import BaseMessage
from langgraph.graph import END, StateGraph

from ai.agents.coach.evidence import extract_evidence_candidates, extract_risk_signals
from ai.agents.coach.nodes import (
    choose_intervention,
    diagnose,
    emit_interaction,
    generate_response,
    make_analyze_code_node,
    make_retrieve_context_node,
    prepare_context_response,
    safe_fallback_response,
    understand_context,
    validate,
)
from ai.agents.coach.routing import (
    detect_request_intent,
    route_after_context_response,
    route_after_response_generation,
    route_after_intervention,
    route_after_understand_context,
    route_after_validation,
)
from ai.agents.coach.state import CoachState, InteractionMetadata, StudentContext, TaskContext
from ai.models.schemas import (
    AIInteraction,
    AssistancePolicy,
    CoachResult,
    CoachSourceReference,
    Diagnosis,
    Intervention,
    LearningEvent,
    LearningEventType,
)
from ai.tools.code_analysis import CodeAnalysisTool
from ai.tools.course_retrieval import CourseRetrievalTool
from ai.tools.student_history import StudentHistoryTool

logger = logging.getLogger(__name__)


def build_coach_graph(
    course_tool: Optional[CourseRetrievalTool] = None,
    history_tool: Optional[StudentHistoryTool] = None,
    code_tool: Optional[CodeAnalysisTool] = None,
) -> StateGraph:
    """Builds (but does not compile) the Coach StateGraph. Split out from
    `Coach` so tests can inspect/compile it with injected tools."""

    course_tool = course_tool or CourseRetrievalTool()
    history_tool = history_tool or StudentHistoryTool()
    code_tool = code_tool or CodeAnalysisTool()

    retrieve_context = make_retrieve_context_node(course_tool, history_tool)
    analyze_code = make_analyze_code_node(code_tool)

    graph = StateGraph(CoachState)
    graph.add_node("understand_context", understand_context)
    graph.add_node("context_response", prepare_context_response)
    graph.add_node("analyze_code", analyze_code)
    graph.add_node("diagnose", diagnose)
    graph.add_node("choose_intervention", choose_intervention)
    graph.add_node("retrieve_context", retrieve_context)
    graph.add_node("generate_response", generate_response)
    graph.add_node("validate", validate)
    graph.add_node("safe_fallback", safe_fallback_response)
    graph.add_node("emit_interaction", emit_interaction)

    graph.set_entry_point("understand_context")
    graph.add_conditional_edges(
        "understand_context",
        route_after_understand_context,
        {"analyze_code": "analyze_code", "diagnose": "diagnose", "context_response": "context_response"},
    )
    graph.add_conditional_edges(
        "context_response",
        route_after_context_response,
        {"generate_response": "generate_response", "emit_interaction": "emit_interaction"},
    )
    graph.add_edge("analyze_code", "diagnose")
    graph.add_edge("diagnose", "choose_intervention")
    graph.add_conditional_edges(
        "choose_intervention",
        route_after_intervention,
        {"retrieve_context": "retrieve_context", "generate_response": "generate_response"},
    )
    graph.add_edge("retrieve_context", "generate_response")
    graph.add_conditional_edges(
        "generate_response",
        route_after_response_generation,
        {"validate": "validate", "emit_interaction": "emit_interaction"},
    )
    graph.add_conditional_edges(
        "validate",
        route_after_validation,
        {
            "emit_interaction": "emit_interaction",
            "generate_response": "generate_response",
            "safe_fallback": "safe_fallback",
        },
    )
    graph.add_edge("safe_fallback", "emit_interaction")
    graph.add_edge("emit_interaction", END)

    return graph


class Coach:
    """Public entry point the backend integrates against."""

    def __init__(
        self,
        course_tool: Optional[CourseRetrievalTool] = None,
        history_tool: Optional[StudentHistoryTool] = None,
        code_tool: Optional[CodeAnalysisTool] = None,
    ):
        self._graph = build_coach_graph(course_tool, history_tool, code_tool).compile()

    def invoke(
        self,
        *,
        student_id: str,
        assignment_id: str,
        session_id: str,
        task_context: TaskContext,
        attempt: str,
        policy: AssistancePolicy,
        message: Optional[str] = None,
        conversation: Optional[list[BaseMessage]] = None,
        turn_index: int = 0,
        student_name: Optional[str] = None,
        prior_diagnosis: Optional[Diagnosis] = None,
        prior_intervention: Optional[Intervention] = None,
        board_enabled: bool = False,
        board: Optional[dict] = None,
        board_mode: str = "chat",
        board_selected_id: Optional[str] = None,
        board_intent: Optional[str] = None,
    ) -> CoachResult:
        """Run one Coach turn.

        `attempt` is the student's current work (code/answer/explanation).
        `message` is an optional free-text message alongside the attempt
        (e.g. "can you check this?"); if provided it's appended to the
        attempt text so diagnosis/response see the full picture.
        `conversation` is prior turns for this session, already trimmed by
        the caller to a reasonable window -- the Coach does not load full
        history itself (section 10).

        `prior_diagnosis` / `prior_intervention` are the `diagnosis_summary`
        / `intervention` from the *previous* CoachResult for this session,
        if the caller has one. The Coach is stateless across calls (no
        checkpointer, no DB access -- see docs/AI_SPEC.md), so it never
        looks these up itself; if the caller passes them, `diagnose()` and
        `choose_intervention()` use them to adapt (e.g. "was the same
        misconception flagged last turn?", "did we already give a HINT?").
        If omitted, the Coach behaves exactly as before: it only knows
        whether this is a revision turn (`turn_index > 1`), not the prior
        diagnosis/intervention specifics.
        """
        initial_state = self._build_state(
            student_id=student_id, assignment_id=assignment_id, session_id=session_id, task_context=task_context,
            attempt=attempt, policy=policy, message=message, conversation=conversation, turn_index=turn_index,
            student_name=student_name, prior_diagnosis=prior_diagnosis, prior_intervention=prior_intervention,
            board_enabled=board_enabled, board=board, board_mode=board_mode, board_selected_id=board_selected_id, board_intent=board_intent,
        )
        final_state = self._graph.invoke(initial_state)
        return self._to_result(final_state)

    def stream(self, **kwargs):
        """Same arguments as `invoke`. Yields `("stage", node_name)` as each graph node finishes and finally
        `("result", CoachResult)`. The response text is released only in the final event: it must pass the validator
        node first, so partial text is never shown to the student. Closing the generator cancels the turn."""
        initial_state = self._build_state(**kwargs)
        last_state = None
        for mode, data in self._graph.stream(initial_state, stream_mode=["updates", "values"]):
            if mode == "updates":
                for node in data:
                    yield ("stage", node)
            else:
                last_state = data
        if last_state is None:
            raise RuntimeError("Coach graph produced no state")
        yield ("result", self._to_result(last_state))

    @staticmethod
    def _build_state(
        *,
        student_id: str,
        assignment_id: str,
        session_id: str,
        task_context: TaskContext,
        attempt: str,
        policy: AssistancePolicy,
        message: Optional[str] = None,
        conversation: Optional[list[BaseMessage]] = None,
        turn_index: int = 0,
        student_name: Optional[str] = None,
        prior_diagnosis: Optional[Diagnosis] = None,
        prior_intervention: Optional[Intervention] = None,
        board_enabled: bool = False,
        board: Optional[dict] = None,
        board_mode: str = "chat",
        board_selected_id: Optional[str] = None,
        board_intent: Optional[str] = None,
    ) -> CoachState:
        current_attempt = attempt if not message else f"{attempt}\n\nStudent message: {message}"

        initial_state: CoachState = {
            "task_context": task_context,
            "policy": policy,
            "metadata": InteractionMetadata(
                student_id=student_id,
                assignment_id=assignment_id,
                session_id=session_id,
                turn_index=turn_index,
            ),
            # Display name is optional and safe for the LLM; raw student/auth IDs
            # remain in InteractionMetadata for trusted internal bookkeeping.
            "student_context": StudentContext(display_name=(student_name or "").strip() or None),
            "messages": list(conversation or []),
            "current_attempt": current_attempt,
            "request_intent": detect_request_intent(message),
            "code_analysis": None,
            "diagnosis": prior_diagnosis,
            "intervention": prior_intervention,
            "evidence_candidates": [],
            "risk_signals": [],
            "retrieved_context": [],
            "student_learning_context": [],
            "tools_used": [],
            "needs_course_material": False,
            "needs_student_history": False,
            "response": None,
            "referenced_concepts": [],
            "validation_passed": None,
            "validation_violations": [],
            "retry_count": 0,
            "errors": [],
            "board_enabled": bool(board_enabled),
            "board": board,
            "board_mode": board_mode if board_mode in ("chat", "board") else "chat",
            "board_selected_id": board_selected_id,
            "board_intent": board_intent,
            "board_actions": [],
        }

        return initial_state

    @staticmethod
    def _extract_sources(state: CoachState) -> list[CoachSourceReference]:
        """Build trustworthy source citations from retrieval metadata only.

        Deliberately reads `RetrievedContext.metadata` (populated upstream by
        RAGService/CourseRetrievalTool from actual retrieval results) and
        never touches LLM output, so the Coach can never surface a citation
        the model invented. Deduplicates by (document_id, chunk_id).
        """
        sources: list[CoachSourceReference] = []
        seen: set[tuple[Optional[str], Optional[str]]] = set()
        for ctx in state.get("retrieved_context") or []:
            meta = ctx.metadata if isinstance(ctx.metadata, dict) else {}
            source_ref = meta.get("source_reference")
            if isinstance(source_ref, dict):
                document_id = source_ref.get("document_id")
                chunk_id = source_ref.get("chunk_id")
                key = (document_id, chunk_id)
                if key in seen:
                    continue
                seen.add(key)
                sources.append(
                    CoachSourceReference(
                        document_id=document_id,
                        document_title=source_ref.get("document_title"),
                        chunk_id=chunk_id,
                        page_number=source_ref.get("page_number"),
                        section=source_ref.get("section"),
                        score=source_ref.get("score"),
                    )
                )
            elif meta.get("document_id") or meta.get("chunk_id"):
                # Retrieval didn't attach a full source_reference (e.g. a
                # simpler test double or adapter) but still tagged basic
                # provenance metadata -- surface what's actually there,
                # still never anything derived from LLM text.
                document_id = meta.get("document_id")
                chunk_id = meta.get("chunk_id")
                key = (document_id, chunk_id)
                if key in seen:
                    continue
                seen.add(key)
                sources.append(
                    CoachSourceReference(
                        document_id=document_id,
                        document_title=meta.get("title"),
                        chunk_id=chunk_id,
                        page_number=meta.get("page_number"),
                        section=meta.get("section"),
                        score=meta.get("score"),
                    )
                )
        return sources

    @staticmethod
    def _to_result(state: CoachState) -> CoachResult:
        diagnosis = state["diagnosis"]
        intervention = state["intervention"]
        metadata = state["metadata"]

        interaction = AIInteraction(
            session_id=metadata.session_id,
            student_id=metadata.student_id,
            assignment_id=metadata.assignment_id,
            intervention_type=intervention.type,
            assistance_level=intervention.assistance_level,
            diagnosis=diagnosis,
            response=state.get("response") or "",
            referenced_concepts=state.get("referenced_concepts") or [],
            tools_used=state.get("tools_used") or [],
        )
        learning_event = LearningEvent(
            student_id=metadata.student_id,
            assignment_id=metadata.assignment_id,
            session_id=metadata.session_id,
            event_type=LearningEventType.AI_INTERACTION,
            payload=interaction.model_dump(mode="json"),
        )

        # Extract evidence candidates linked to the durable learning_event ID
        evidence_candidates = extract_evidence_candidates(state, source_event_id=learning_event.id)
        risk_signals = extract_risk_signals(state)

        # Enrich learning event payload with serialized evidence candidates and risk signals
        payload = dict(learning_event.payload)
        payload["evidence_candidates"] = [c.model_dump(mode="json") for c in evidence_candidates]
        payload["risk_signals"] = [s.model_dump(mode="json") for s in risk_signals]
        learning_event.payload = payload

        return CoachResult(
            response=state.get("response") or "",
            intervention=intervention,
            diagnosis_summary=diagnosis,
            referenced_concepts=state.get("referenced_concepts") or [],
            tools_used=state.get("tools_used") or [],
            learning_event=learning_event,
            evidence_candidates=evidence_candidates,
            risk_signals=risk_signals,
            sources=Coach._extract_sources(state),
            board_actions=list(state.get("board_actions") or []),
            metadata={
                "turn_index": metadata.turn_index,
                "errors": state.get("errors") or [],
                "validation_violations": state.get("validation_violations") or [],
            },
        )


_default_coach: Optional[Coach] = None


def get_default_coach() -> Coach:
    """Lazily-built shared Coach instance using default (no-op) tools --
    convenient for the backend to import without constructing one itself."""
    global _default_coach
    if _default_coach is None:
        _default_coach = Coach()
    return _default_coach
