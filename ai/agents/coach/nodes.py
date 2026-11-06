"""
LangGraph node implementations for the AI Coach.

Each node reads/writes ai.agents.coach.state.CoachState. LLM calls use the
model factory (ai.models.llm) and structured schemas
(ai.agents.coach.schemas); nothing here talks to a concrete provider SDK.
"""
from __future__ import annotations

import logging
from typing import Optional

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision
from ai.agents.coach.context_questions import (
    ASSIGNMENT,
    ASSIGNMENT_TOPICS,
    is_explicit_course_material_request,
)
from ai.agents.coach.context import render_application_context, verify_assignment_response
from ai.agents.coach.state import CoachState
from ai.guardrails.coach_validator import final_answer_enforcement, validate_response
from ai.models.llm import ModelRole, get_structured_llm
from ai.models.schemas import (
    AssistancePolicy,
    Diagnosis,
    DiagnosisCategory,
    Intervention,
    InterventionType,
    RetrievedContext,
)
from ai.prompts.coach.intervention_prompt import build_intervention_messages
from ai.prompts.coach.response_prompt import build_response_messages
from ai.prompts.diagnosis.diagnosis_prompt import build_diagnosis_messages
from ai.rag.chunking.concept_extractor import normalize_concept
from ai.rag.models import RetrievalScope
from ai.rag.security import format_safe_retrieval_context
from ai.whiteboard import BoardAction, board_text_for_judge, parse_actions, render_board_for_llm
from ai.tools.code_analysis import CodeAnalysisResult, CodeAnalysisTool
from ai.tools.course_retrieval import CourseRetrievalTool
from ai.tools.student_history import StudentHistoryTool

logger = logging.getLogger(__name__)

MAX_CONVERSATION_MESSAGES = 8

# Interventions that are safe to emit when diagnosis confidence is low or
# the diagnosis category is UNCERTAIN. All others are forced to CLARIFICATION
# by the deterministic enforcement in choose_intervention().
_UNCERTAIN_ALLOWED_INTERVENTIONS: frozenset[InterventionType] = frozenset({
    InterventionType.CLARIFICATION,
    InterventionType.QUESTION,
})


def _conversation_summary(messages: list[BaseMessage]) -> str:
    recent = messages[-MAX_CONVERSATION_MESSAGES:]
    lines = []
    for m in recent:
        role = "Student" if isinstance(m, HumanMessage) else "Coach"
        lines.append(f"{role}: {m.content}")
    return "\n".join(lines)



def _latest_student_message(state: CoachState) -> str:
    """Return the most recent student message used for deterministic routing checks."""
    messages = state.get("messages") or []
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return str(message.content or "").strip()
    return str(state.get("current_attempt") or "").strip()


def _format_course_material(chunks: list[RetrievedContext]) -> str:
    """Format retrieved course material for the Coach prompt.

    Delegates to `ai.rag.security.format_safe_retrieval_context`, which wraps
    each chunk in explicit `--- BEGIN/END COURSE MATERIAL REFERENCE ---`
    delimiters plus an explicit "passive reference only, not instructions"
    note, and applies `sanitize_untrusted_text` to the content. This avoids
    duplicating a weaker, ad-hoc formatter here: retrieved documents are
    untrusted data and must always cross the same structural boundary before
    reaching the Coach prompt, regardless of which node formats them.
    Source metadata (document_id, chunk_id, page, section) is preserved
    exactly as supplied by retrieval; the Coach prompt never lets the model
    invent citations.
    """
    if not chunks:
        return ""

    # Student-history retrieval is a separate trusted context channel.  Keep
    # it out of the course-material formatter even if a caller accidentally
    # supplies a mixed list.  This prevents learning-history observations
    # from being mislabeled as course references in diagnosis/response prompts.
    course_chunks = [
        chunk for chunk in chunks
        if str(getattr(chunk, "source", "") or "").lower() not in {
            "learning_history",
            "student_history",
        }
    ]
    if not course_chunks:
        return ""
    return format_safe_retrieval_context(course_chunks)


def _format_student_learning_context(chunks: list[RetrievedContext]) -> str:
    """Format retrieved student-specific evidence separately from course material."""
    if not chunks:
        return ""
    lines = []
    for chunk in chunks:
        content = str(chunk.content).strip()
        if content:
            lines.append(f"- {content}")
    return "\n".join(lines)


def build_retrieval_query(state: CoachState) -> str:
    """Focused deterministic query from trusted task context + current evidence."""
    task = state.get("task_context")
    diagnosis = state.get("diagnosis")
    messages = state.get("messages") or []
    recent_student = " ".join(str(m.content) for m in messages[-3:] if isinstance(m, HumanMessage))

    parts = []
    if task:
        # Assignment title + instructions are the authoritative assignment
        # context. Do not depend on assignment_concepts/assignment_materials
        # junction tables to understand what the student needs to study.
        parts.append(f"Assignment: {task.title}")
        if task.instructions:
            parts.append(f"Instructions: {task.instructions}")
        if task.subject_area:
            parts.append(f"Subject area: {task.subject_area}")
    if diagnosis:
        if diagnosis.concept:
            norm_c = normalize_concept(diagnosis.concept)
            parts.append(f"Concept: {norm_c or diagnosis.concept}")
        if diagnosis.explanation:
            parts.append(f"Learning issue: {diagnosis.explanation}")
        if diagnosis.evidence:
            parts.append(f"Attempt evidence: {diagnosis.evidence}")
    if recent_student:
        parts.append(f"Student question/attempt: {recent_student}")
    elif state.get("current_attempt"):
        parts.append(f"Student question/attempt: {state['current_attempt'][:200]}")

    return "\n".join(parts) if parts else "Course material"


def build_student_context_adapter(state: CoachState) -> dict:
    """Build the retrieval-context adapter passed to QueryUnderstander (P1 #9).

    This is the sole seam through which student-supplied text reaches query
    construction. It deliberately carries ONLY query-construction inputs
    (message/attempt/assignment context/diagnosis) -- never university_id,
    course_id, classroom_id, or allowed_document_ids, which come exclusively
    from the trusted `TaskContext`/`RetrievalScope` built in
    `make_retrieve_context_node`. QueryUnderstander may use this to decide
    `needs_retrieval` and construct a richer retrieval query/content, but it
    can never expand or redirect the trusted scope.
    """
    task = state.get("task_context")
    diagnosis = state.get("diagnosis")
    messages = state.get("messages") or []
    recent_student = " ".join(str(m.content) for m in messages[-3:] if isinstance(m, HumanMessage))

    return {
        "message": recent_student or None,
        "attempt": state.get("current_attempt") or "",
        "assignment_title": task.title if task else None,
        "assignment_instructions": task.instructions if task else None,
        "prior_diagnosis": diagnosis,
        "is_programming": bool(task.is_programming) if task else False,
        # P1 fix: `query` passed alongside this adapter is already the rich,
        # fully-formed retrieval query built by `build_retrieval_query()`
        # (assignment title/instructions + diagnosed concept/explanation/
        # evidence + recent turns). QueryUnderstander must not silently
        # replace it with its own (weaker, deterministic-mode) query just
        # because student_context is present -- see
        # `RAGService.retrieve_course_material`, which checks this flag.
        # QueryUnderstander may still run to decide `needs_retrieval`.
        "query_is_final": True,
    }


def _format_code_analysis(result: Optional[CodeAnalysisResult]) -> str:
    if not result:
        return ""
    if not result.is_supported_language:
        return f"Code analysis ({result.language}): {result.syntax_error}"
    lines = [f"Valid Python syntax: {result.is_valid_syntax}"]
    if not result.is_valid_syntax and result.syntax_error:
        lines.append(f"Syntax error: {result.syntax_error}")
    if result.defined_functions:
        lines.append(f"Defined functions: {', '.join(result.defined_functions)}")
    if result.defined_variables:
        lines.append(f"Defined variables: {', '.join(result.defined_variables)}")
    if result.loops > 0:
        lines.append(f"Loop constructs count: {result.loops}")
    lines.append(f"Line count: {result.line_count}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Node: understand_context
# ---------------------------------------------------------------------------

def understand_context(state: CoachState) -> dict:
    """Normalizes incoming state, resets per-turn working fields, and
    records the student's current attempt in the conversation history."""
    errors = list(state.get("errors") or [])
    metadata = state["metadata"]
    metadata.turn_index = (metadata.turn_index or 0) + 1
    attempt_message = HumanMessage(content=state["current_attempt"])

    return {
        "messages": [attempt_message],
        "metadata": metadata,
        "code_analysis": None,
        "evidence_candidates": [],
        "risk_signals": [],
        "retrieved_context": [],
        "student_learning_context": [],
        "tools_used": [],
        "needs_course_material": False,
        "needs_student_history": False,
        "validation_violations": [],
        "validation_passed": None,
        "retry_count": 0,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Node: analyze_code
# ---------------------------------------------------------------------------

def make_analyze_code_node(code_tool: CodeAnalysisTool):
    def analyze_code(state: CoachState) -> dict:
        attempt = state.get("current_attempt") or ""
        tools_used = list(state.get("tools_used") or [])
        errors = list(state.get("errors") or [])
        try:
            result = code_tool.analyze(attempt)
            tools_used.append(code_tool.name)
            return {"code_analysis": result, "tools_used": tools_used}
        except Exception as exc:
            logger.warning("Code analysis failed, continuing without it: %s", exc)
            errors.append(f"analyze_code: {exc}")
            return {"code_analysis": None, "tools_used": tools_used, "errors": errors}

    return analyze_code


# ---------------------------------------------------------------------------
# Node: trusted context response
# ---------------------------------------------------------------------------

def prepare_context_response(state: CoachState) -> dict:
    """Prepare narrow assignment/student context requests without diagnosis/RAG.

    Assignment summary/topic requests still use the existing response-generation
    LLM once, but skip diagnosis, intervention selection, retrieval, and validation.
    The name request is answered directly from trusted authenticated context.
    """
    intent = state.get("request_intent")
    task = state["task_context"]
    policy = state["policy"]
    student = state.get("student_context")

    diagnosis = Diagnosis(
        category=DiagnosisCategory.UNCERTAIN,
        concept=None,
        explanation="No learning diagnosis was performed for this trusted-context request.",
        evidence="The request asks for assignment or authenticated student context.",
        confidence=0.0,
    )
    intervention = Intervention(
        type=InterventionType.EXPLANATION,
        assistance_level=policy,
        rationale="Provide trusted assignment/student context without running the full coaching pipeline.",
    )

    if intent == "student_name":
        name = (student.display_name if student else None) or "I don't have your name available in the current account context."
        return {
            "diagnosis": diagnosis,
            "intervention": intervention,
            "response": name,
            "referenced_concepts": [],
            "tools_used": [],
            "needs_course_material": False,
            "needs_student_history": False,
            "validation_passed": True,
        }

    if intent not in {"assignment_about", "assignment_topics"}:
        return {"diagnosis": diagnosis, "intervention": intervention}

    # The actual wording is produced by the existing response generator, with
    # assignment title/instructions explicitly supplied by build_response_messages.
    return {
        "diagnosis": diagnosis,
        "intervention": intervention,
        "tools_used": [],
        "needs_course_material": False,
        "needs_student_history": False,
        "validation_passed": None,
    }


# ---------------------------------------------------------------------------
# Node: diagnose
# ---------------------------------------------------------------------------

def _diagnose_core(state: CoachState) -> dict:
    task = state["task_context"]
    policy = state["policy"]
    messages = state.get("messages") or []
    is_revision = state["metadata"].turn_index > 1
    prior = state.get("diagnosis")
    prior_summary = f"{prior.category.value} (concept: {prior.concept or 'n/a'})" if prior else ""
    code_summary = _format_code_analysis(state.get("code_analysis"))

    prompt_messages = build_diagnosis_messages(
        assignment_title=task.title,
        assignment_instructions=task.instructions,
        policy=policy.value,
        is_revision=is_revision,
        course_material=_format_course_material(state.get("retrieved_context") or []),
        prior_diagnosis_summary=prior_summary,
        conversation_summary=_conversation_summary(messages),
        current_attempt=state["current_attempt"],
        code_analysis_summary=code_summary,
        application_context=render_application_context(task, state.get("student_context").display_name if state.get("student_context") else None),
    )

    try:
        llm = get_structured_llm(ModelRole.REASONING, DiagnosisResult)
        result: DiagnosisResult = llm.invoke(prompt_messages)
        if result is None:
            raise RuntimeError(
                "Diagnosis structured LLM returned None. "
                "The configured model/provider did not produce a valid structured response."
            )
        diagnosis = Diagnosis(
            category=result.category,
            concept=result.concept,
            explanation=result.explanation,
            evidence=result.evidence,
            confidence=result.confidence,
        )
        return {"diagnosis": diagnosis}
    except Exception as exc:
        logger.exception("Diagnosis LLM call failed.")
        diagnosis = Diagnosis(
            category=DiagnosisCategory.UNCERTAIN,
            concept=None,
            explanation="Diagnosis could not be completed due to an internal error.",
            evidence="",
            confidence=0.0,
        )
        errors = list(state.get("errors") or [])
        errors.append(f"diagnose: {exc}")
        return {"diagnosis": diagnosis, "errors": errors}


_NOT_A_DIFFICULTY = {DiagnosisCategory.CORRECT_REASONING, DiagnosisCategory.UNCERTAIN}


def _same_idea(a: str, b: str) -> bool:
    return bool(a and b) and a.strip().lower() == b.strip().lower()


def diagnose(state: CoachState) -> dict:
    """Diagnose, then record whether this is the same unresolved difficulty as the previous turn (drives adaptive support)."""
    prior = state.get("diagnosis")
    update = _diagnose_core(state)
    new = update.get("diagnosis")
    update["repeated_difficulty"] = bool(
        prior and new
        and prior.category not in _NOT_A_DIFFICULTY and new.category not in _NOT_A_DIFFICULTY
        and (prior.category == new.category or _same_idea(prior.concept or "", new.concept or ""))
    )
    return update


# ---------------------------------------------------------------------------
# Node: choose_intervention
# ---------------------------------------------------------------------------

_ESCALATION = {
    InterventionType.QUESTION: InterventionType.HINT,
    InterventionType.CLARIFICATION: InterventionType.HINT,
    InterventionType.HINT: InterventionType.EXPLANATION,
}
_CODE_LIKE = {DiagnosisCategory.CODE_ERROR, DiagnosisCategory.LOGICAL_ERROR, DiagnosisCategory.PROCEDURAL_ERROR}


def choose_intervention(state: CoachState) -> dict:
    diagnosis = state["diagnosis"]
    policy = state["policy"]
    prior_intervention = state.get("intervention")
    is_revision = state["metadata"].turn_index > 1

    # Explicit requests to locate/review course material must use RAG.
    # Assignment understanding remains grounded in the trusted assignment record.
    force_course_material = is_explicit_course_material_request(
        _latest_student_message(state)
    )

    prompt_messages = build_intervention_messages(
        policy=policy.value,
        diagnosis_category=diagnosis.category.value,
        diagnosis_concept=diagnosis.concept or "",
        diagnosis_explanation=diagnosis.explanation,
        diagnosis_confidence=diagnosis.confidence,
        is_revision=is_revision,
        previous_intervention=prior_intervention.type.value if prior_intervention else "",
        turn_index=state["metadata"].turn_index,
        repeated_difficulty=bool(state.get("repeated_difficulty")),
    )

    try:
        llm = get_structured_llm(ModelRole.LIGHTWEIGHT, InterventionDecision)
        decision: InterventionDecision = llm.invoke(prompt_messages)
        if decision is None:
            raise RuntimeError(
                "Intervention structured LLM returned None. "
                "The configured model/provider did not produce a valid structured response."
            )
        intervention_type = decision.intervention_type
        rationale = decision.rationale
        needs_course_material = bool(decision.needs_course_material or force_course_material)
        needs_student_history = decision.needs_student_history
    except Exception as exc:
        logger.exception("Intervention-selection LLM call failed.")
        # Safe deterministic fallback: encouragement for correct reasoning,
        # otherwise a guiding question.
        intervention_type = (
            InterventionType.ENCOURAGEMENT
            if diagnosis.category == DiagnosisCategory.CORRECT_REASONING
            else InterventionType.QUESTION
        )
        rationale = "Fallback selection after an internal error."
        needs_course_material = force_course_material
        needs_student_history = False
        errors = list(state.get("errors") or [])
        errors.append(f"choose_intervention: {exc}")
        intervention = Intervention(type=intervention_type, assistance_level=policy, rationale=rationale)
        return {
            "intervention": intervention,
            "needs_course_material": needs_course_material,
            "needs_student_history": needs_student_history,
            "errors": errors,
        }

    # ── Deterministic enforcement 1: UNCERTAIN category ──────────
    if diagnosis.category == DiagnosisCategory.UNCERTAIN:
        intervention_type = InterventionType.CLARIFICATION
        rationale += (
            " (forced to CLARIFICATION: diagnosis category is UNCERTAIN.)"
        )

    # ── Deterministic enforcement 2: low-confidence diagnosis ────
    elif diagnosis.is_uncertain and intervention_type not in _UNCERTAIN_ALLOWED_INTERVENTIONS:
        intervention_type = InterventionType.CLARIFICATION
        rationale += (
            " (forced to CLARIFICATION: diagnosis confidence is below the "
            "uncertainty threshold — committing to a more directive intervention "
            "would risk acting on an unreliable diagnosis.)"
        )

    # ── Deterministic enforcement 3: GUIDED policy on first attempt ───────
    if (
        policy == AssistancePolicy.GUIDED
        and intervention_type == InterventionType.EXPLANATION
        and diagnosis.category != DiagnosisCategory.CORRECT_REASONING
        and not is_revision
    ):
        intervention_type = InterventionType.QUESTION
        rationale += (
            " (downgraded from EXPLANATION to QUESTION to respect GUIDED policy on a first attempt.)"
        )

    # ── Deterministic enforcement 4: repeated difficulty must not get the same help again ──
    previous = prior_intervention.type if prior_intervention else None
    if state.get("repeated_difficulty") and previous is not None and intervention_type == previous and intervention_type in _ESCALATION:
        escalated = _ESCALATION[intervention_type]
        if escalated == InterventionType.EXPLANATION and diagnosis.category in _CODE_LIKE:
            escalated = InterventionType.GUIDED_DEBUGGING
        rationale += f" (escalated from {intervention_type.value} to {escalated.value}: the same difficulty persisted after that help.)"
        intervention_type = escalated

    # ── Deterministic enforcement 5: shown understanding -> acknowledge it, don't keep teaching it ──
    if (
        diagnosis.category == DiagnosisCategory.CORRECT_REASONING
        and not diagnosis.is_uncertain
        and diagnosis.confidence >= 0.6
        and intervention_type in (InterventionType.HINT, InterventionType.GUIDED_DEBUGGING)      # EXPLANATION stays allowed (existing invariant)
    ):
        rationale += f" (changed from {intervention_type.value} to FEEDBACK: the student's reasoning is correct; move on to applying it.)"
        intervention_type = InterventionType.FEEDBACK

    intervention = Intervention(type=intervention_type, assistance_level=policy, rationale=rationale)
    return {
        "intervention": intervention,
        "needs_course_material": needs_course_material,
        "needs_student_history": needs_student_history,
    }


# ---------------------------------------------------------------------------
# Node: retrieve_context
# ---------------------------------------------------------------------------

def make_retrieve_context_node(course_tool: CourseRetrievalTool, history_tool: StudentHistoryTool):
    def retrieve_context(state: CoachState) -> dict:
        task = state["task_context"]
        metadata = state["metadata"]
        diagnosis = state["diagnosis"]
        retrieved: list[RetrievedContext] = []
        student_learning_context: list[RetrievedContext] = []
        tools_used = list(state.get("tools_used") or [])
        errors = list(state.get("errors") or [])

        if state.get("needs_course_material"):
            try:
                query = build_retrieval_query(state)
                student_ctx = build_student_context_adapter(state)
                # University/classroom identity comes solely from trusted
                # TaskContext. If absent, retain legacy course-only behavior.
                if task.university_id:
                    scope = RetrievalScope(
                        university_id=task.university_id,
                        course_id=task.course_id,
                        classroom_id=task.classroom_id,
                        assignment_id=task.assignment_id,
                        allowed_document_ids=tuple(task.allowed_document_ids),
                    )
                    retrieved.extend(
                        course_tool.retrieve_scoped(scope, query, student_context=student_ctx)
                    )
                else:
                    logger.warning("RAG trusted university scope unavailable; using course-only fallback")
                    retrieved.extend(
                        course_tool.retrieve(task.course_id, query, student_context=student_ctx)
                    )
                tools_used.append(course_tool.name)
            except Exception as exc:
                logger.warning("Course retrieval failed, continuing without it: %s", exc)
                errors.append(f"retrieve_context/course: {exc}")

        if state.get("needs_student_history"):
            try:
                student_learning_context.extend(
                    history_tool.retrieve(metadata.student_id, metadata.assignment_id, diagnosis.concept)
                )
                tools_used.append(history_tool.name)
            except Exception as exc:
                logger.warning("Student history retrieval failed, continuing without it: %s", exc)
                errors.append(f"retrieve_context/history: {exc}")

        return {
            "retrieved_context": retrieved,
            "student_learning_context": student_learning_context,
            "tools_used": tools_used,
            "errors": errors,
        }

    return retrieve_context


# ---------------------------------------------------------------------------
# Node: generate_response
# ---------------------------------------------------------------------------

def generate_response(state: CoachState) -> dict:
    policy = state["policy"]
    diagnosis = state["diagnosis"]
    intervention = state["intervention"]
    messages = state.get("messages") or []

    # Validation-aware retry (P1 #8): if this is a regeneration after a
    # validation failure, tell the generator concisely why its previous
    # draft was rejected so it doesn't repeat the same mistake blindly.
    # This is generation-pipeline-internal guidance only; it is never
    # surfaced to the student (see the retry note wording in
    # build_response_messages, which explicitly instructs the model not to
    # mention it).
    previous_violations = (
        state.get("validation_violations") if state.get("retry_count", 0) > 0 else None
    )

    prompt_messages = build_response_messages(
        policy=policy.value,
        intervention_type=intervention.type.value,
        diagnosis_category=diagnosis.category.value,
        diagnosis_concept=diagnosis.concept,
        student_name=(state.get("student_context").display_name if state.get("student_context") else None),
        assignment_title=state["task_context"].title,
        assignment_instructions=state["task_context"].instructions,
        assignment_policy=policy.value,
        application_context=render_application_context(
            state["task_context"],
            state.get("student_context").display_name if state.get("student_context") else None),
        subject_area=state["task_context"].subject_area,
        course_material=_format_course_material(state.get("retrieved_context") or []),
        student_learning_context=_format_student_learning_context(state.get("student_learning_context") or []),
        conversation_summary=_conversation_summary(messages),
        current_attempt=state["current_attempt"],
        previous_violations=previous_violations,
        context_intent=state.get("request_intent"),
        board_context=(render_board_for_llm(state.get("board"), state.get("board_selected_id")) if state.get("board_enabled") else None),
        board_mode=state.get("board_mode") or "chat",
        board_intent=state.get("board_intent"),
    )

    try:
        llm = get_structured_llm(ModelRole.COACH, GeneratedResponse)
        result: GeneratedResponse = llm.invoke(prompt_messages)

        if result is None:
            raise RuntimeError(
                "Coach structured LLM returned None. "
                "The configured model/provider did not produce a valid structured response."
            )

        update = {
            "response": result.response,
            "referenced_concepts": result.referenced_concepts,
            "board_actions": [],
        }
        if state.get("board_enabled"):
            proposed, malformed = parse_actions(result.board_actions)
            if malformed:
                logger.warning("Dropped %d malformed whiteboard action(s) from the model", len(malformed))
            update["board_actions"] = [a.model_dump(exclude_none=True) for a in proposed]
        # Assignment-understanding/topic requests use a deterministic grounding check instead
        # of another LLM validation pass. This keeps the trusted-context path cheap while
        # preventing unsupported dates, numbers, links, filenames, empty answers, and answers
        # that show no visible grounding in the assignment text.
        if state.get("request_intent") in {"assignment_about", "assignment_topics"}:
            intent = ASSIGNMENT_TOPICS if state.get("request_intent") == "assignment_topics" else ASSIGNMENT
            violations = verify_assignment_response(
                result.response,
                task=state["task_context"],
                student_name=(state.get("student_context").display_name if state.get("student_context") else None),
                intent=intent,
            )
            if violations:
                errors = list(state.get("errors") or [])
                errors.append("assignment_context_grounding: " + "; ".join(violations))
                return {
                    **update,
                    "validation_passed": False,
                    "validation_violations": violations,
                    "retry_count": state.get("retry_count", 0) + 1,
                    "errors": errors,
                }
            update["validation_passed"] = True
            update["validation_violations"] = []
        return update
    except Exception as exc:
        logger.exception("Response-generation LLM call failed.")
        errors = list(state.get("errors") or [])
        errors.append(f"generate_response: {exc}")
        fallback = (
            "I ran into an issue putting together a response. Could you try rephrasing your "
            "question, or ask again in a moment?"
        )
        return {"response": fallback, "referenced_concepts": [], "errors": errors}


# ---------------------------------------------------------------------------
# Node: validate
# ---------------------------------------------------------------------------

def validate(state: CoachState) -> dict:
    policy = state["policy"]
    diagnosis = state["diagnosis"]
    intervention = state["intervention"]
    draft = state.get("response") or ""
    course_material = _format_course_material(state.get("retrieved_context") or [])
    is_programming = state["task_context"].is_programming

    # Whiteboard writing is teaching content too: the SAME validator and deterministic answer-enforcement judge the reply together with
    # everything the model wants to write on the board, so the board cannot be used to get around the pedagogy rules.
    board_actions = state.get("board_actions") or []
    board_text = board_text_for_judge([BoardAction.model_validate(a) for a in board_actions]) if board_actions else ""
    if board_text:
        draft = f"{draft}\n\n[Text the coach will also write on the whiteboard]\n{board_text}"

    result = validate_response(
        policy=policy,
        diagnosis_category=diagnosis.category.value,
        diagnosis_confidence=diagnosis.confidence,
        intervention_type=intervention.type.value,
        course_material=course_material,
        draft_response=draft,
        is_programming=is_programming,
    )

    update: dict = {"validation_passed": result.passes, "validation_violations": list(result.violations)}

    if result.passes:
        # Validation passed — but run deterministic enforcement as final check.
        is_safe, enforced = final_answer_enforcement(
            draft, policy=policy, is_programming=is_programming
        )
        if not is_safe:
            update["board_actions"] = []                       # blocked content: nothing from this draft reaches the board
            update["response"] = enforced
            update["validation_violations"] = list(result.violations) + [
                "Deterministic enforcement blocked the response after LLM validation passed."
            ]
            # Still mark as passed since we replaced with a safe fallback.
            update["validation_passed"] = True
    elif result.revised_response:
        # LLM proposed a rewrite. Run deterministic enforcement on it.
        is_safe, enforced = final_answer_enforcement(
            result.revised_response, policy=policy, is_programming=is_programming
        )
        if is_safe:
            update["board_actions"] = []                       # the reply was rewritten: the board writing belonged to the rejected draft
            update["response"] = enforced
            update["validation_passed"] = True
        else:
            # The rewrite itself is unsafe — discard it, trigger retry.
            logger.warning(
                "LLM revised_response failed final_answer_enforcement; discarding."
            )
            update["retry_count"] = state.get("retry_count", 0) + 1
    else:
        update["retry_count"] = state.get("retry_count", 0) + 1
    return update


def safe_fallback_response(state: CoachState) -> dict:
    """Used when validation fails repeatedly -- respond safely instead of
    looping forever or shipping a bad response."""
    policy = state["policy"]
    intent = state.get("request_intent")
    if intent == "assignment_about":
        task = state["task_context"]
        instructions = (task.instructions or "").strip()
        excerpt = instructions[:500].rstrip() + ("…" if len(instructions) > 500 else "")
        fallback = (
            f'Your assignment is "{task.title}". ' +
            (f"The instructions say: {excerpt}" if excerpt else "I can see the assignment title, but no instructions are currently available.") +
            " I can help you work through the requirements without completing the assignment for you."
        )
    elif intent == "assignment_topics":
        fallback = (
            "I want to keep the study topics grounded in your actual assignment instructions. "
            "Please open the assignment instructions or paste the relevant requirements here, and I can help you identify the concepts and skills to review without solving the assignment."
        )
    elif policy == AssistancePolicy.GUIDED:
        fallback = (
            "Let's slow down for a second. Can you walk me through how you got to your current "
            "answer, step by step? That'll help me point you in the right direction."
        )
    else:
        fallback = (
            "I want to make sure I give you accurate guidance here -- could you share a bit more "
            "detail about where you're stuck?"
        )
    return {
        "response": fallback,
        "referenced_concepts": [],
        "board_actions": [],
        "validation_passed": True,
        "intervention": Intervention(
            type=InterventionType.CLARIFICATION,
            assistance_level=policy,
            rationale="Safe fallback after repeated validation failures.",
        ),
    }


# ---------------------------------------------------------------------------
# Node: emit_interaction
# ---------------------------------------------------------------------------

def emit_interaction(state: CoachState) -> dict:
    response = state.get("response") or ""
    policy = state["policy"]
    is_programming = state["task_context"].is_programming

    # Absolute last-line defense: deterministic enforcement before the
    # response reaches the student. This catches anything that slipped
    # through validation + LLM rewrite.
    is_safe, enforced_response = final_answer_enforcement(
        response, policy=policy, is_programming=is_programming
    )
    if not is_safe:
        logger.warning("emit_interaction: final_answer_enforcement replaced the response.")

    # IMPORTANT: `response` must be updated here too, not just the emitted
    # AIMessage. Coach._to_result() reads state["response"] (not the
    # message content) to build CoachResult/AIInteraction, so if this node
    # ever actually replaces an unsafe response, that replacement must be
    # reflected in the returned state or the API-facing response and the
    # persisted AIInteraction would still carry the original unsafe text.
    return {
        "response": enforced_response,
        "messages": [AIMessage(content=enforced_response)],
    }
