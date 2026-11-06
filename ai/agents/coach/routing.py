"""Conditional routing functions for the Coach graph (section 9)."""
from __future__ import annotations

import ast
import re

from ai.agents.coach.state import CoachState
from ai.agents.coach.context_questions import ASSIGNMENT_TOPICS, ASSIGNMENT, IDENTITY, classify_context_topics

MAX_VALIDATION_RETRIES = 1

_CODE_KEYWORD_PATTERN = re.compile(
    r"\b(def|class|import|from|return|for|while|if|elif|else|try|except|finally|with|lambda|yield)\b"
)
_ASSIGNMENT_PATTERN = re.compile(r"\b\w+\s*=[^=]")


def is_code_attempt(attempt: str) -> bool:
    """Check if the student's submission contains code constructs."""
    if not attempt or not attempt.strip():
        return False

    # Explicit markdown code fences
    if "```" in attempt:
        return True

    # Common programming keywords
    if _CODE_KEYWORD_PATTERN.search(attempt):
        return True

    # Variable assignment (e.g. theta = theta - lr * grad)
    if _ASSIGNMENT_PATTERN.search(attempt):
        return True

    # Try parsing as Python AST and check for substantive code nodes
    try:
        tree = ast.parse(attempt)
        for node in ast.walk(tree):
            if isinstance(
                node,
                (
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                    ast.ClassDef,
                    ast.Assign,
                    ast.AugAssign,
                    ast.For,
                    ast.While,
                    ast.If,
                    ast.Call,
                ),
            ):
                return True
    except SyntaxError:
        # If syntax error but has code-like symbols and operators
        if re.search(r"[:\(\)\[\]\{\}]", attempt) and any(c in attempt for c in "=+-*/"):
            return True

    return False


def should_analyze_code(state: CoachState) -> bool:
    """Determine whether static code analysis should be executed for this turn."""
    task = state.get("task_context")
    if not task or not task.is_programming:
        return False

    attempt = state.get("current_attempt") or ""
    return is_code_attempt(attempt)


def detect_request_intent(message: str | None) -> str | None:
    """Detect narrow trusted-context requests using the shared multilingual classifier.

    The classifier is intentionally conservative: combined requests that also ask the Coach
    to do the student's work remain on the normal Socratic pipeline.
    """
    topics = classify_context_topics(message)
    if not topics:
        return None
    # Preserve the stable intent vocabulary used by prompts/tests.
    if IDENTITY in topics:
        return "student_name"
    if ASSIGNMENT_TOPICS in topics:
        return "assignment_topics"
    if ASSIGNMENT in topics:
        return "assignment_about"
    return None


def route_after_understand_context(state: CoachState) -> str:
    """Route trusted-context questions away from the expensive full Coach pipeline."""
    intent = state.get("request_intent")
    if intent:
        return "context_response"
    if should_analyze_code(state):
        return "analyze_code"
    return "diagnose"


def route_after_context_response(state: CoachState) -> str:
    """Only assignment-summary/topic requests need one response-generation LLM call.

    A name request is answered directly from authenticated context.
    """
    return "generate_response" if state.get("request_intent") in {"assignment_about", "assignment_topics"} else "emit_interaction"


def route_after_intervention(state: CoachState) -> str:
    if state.get("needs_course_material") or state.get("needs_student_history"):
        return "retrieve_context"
    return "generate_response"


def route_after_response_generation(state: CoachState) -> str:
    """Context-only responses skip the expensive validation LLM.

    They are generated solely from trusted assignment context and are not
    diagnostic coaching responses. All normal Coach responses remain validated.
    """
    if state.get("request_intent") in {"assignment_about", "assignment_topics"}:
        # These responses are grounded by a deterministic application-context check in
        # generate_response. They do not need a second LLM validator.
        if state.get("validation_violations"):
            if state.get("retry_count", 0) > MAX_VALIDATION_RETRIES:
                return "safe_fallback"
            return "generate_response"
        return "emit_interaction"
    return "validate"


def route_after_validation(state: CoachState) -> str:
    if state.get("validation_passed"):
        return "emit_interaction"
    if state.get("retry_count", 0) > MAX_VALIDATION_RETRIES:
        return "safe_fallback"
    return "generate_response"
