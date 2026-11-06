from __future__ import annotations

from ai.agents.coach.nodes import generate_response
from ai.agents.coach.state import InteractionMetadata, StudentContext, TaskContext
from ai.models.schemas import AssistancePolicy, Diagnosis, DiagnosisCategory, Intervention, InterventionType


def _state(**overrides):
    task = TaskContext(
        assignment_id="asg_1",
        course_id="course_1",
        title="Binary Search Trees",
        instructions="Implement insertion and deletion for a binary search tree.",
        subject_area="data_structures",
    )
    base = {
        "task_context": task,
        "student_context": StudentContext(display_name="Ahmed"),
        "policy": AssistancePolicy.GUIDED,
        "metadata": InteractionMetadata(student_id="student_123", assignment_id="asg_1", session_id="sess_1"),
        "diagnosis": Diagnosis(
            category=DiagnosisCategory.MISCONCEPTION,
            concept="tree deletion",
            explanation="The deletion case for a node with two children is unclear.",
            evidence="...",
            confidence=0.9,
        ),
        "intervention": Intervention(
            type=InterventionType.QUESTION,
            assistance_level=AssistancePolicy.GUIDED,
            rationale="Ask a guiding question.",
        ),
        "retrieved_context": [],
        "student_learning_context": [],
        "messages": [],
        "current_attempt": "I replace the node with its left child.",
        "validation_violations": [],
        "retry_count": 0,
    }
    base.update(overrides)
    return base


def test_response_prompt_receives_assignment_student_attempt_and_policy(monkeypatch):
    captured = {}

    class FakeLLM:
        def invoke(self, messages):
            captured["text"] = "\n".join(str(m.content) for m in messages)
            return type("R", (), {"response": "Which case should you handle first?", "referenced_concepts": ["tree deletion"]})()

    monkeypatch.setattr(
        "ai.agents.coach.nodes.get_structured_llm",
        lambda role, schema: FakeLLM(),
    )

    out = generate_response(_state())
    prompt = captured["text"]

    assert "Name: Ahmed" in prompt
    assert "Binary Search Trees" in prompt
    assert "Implement insertion and deletion for a binary search tree." in prompt
    assert "Policy: GUIDED" in prompt
    assert "Assignment topic derivation:" in prompt
    assert "assignment_concepts and assignment_materials are not required" in prompt
    assert "If the student explicitly asks for their name" in prompt
    assert "Current Attempt:" in prompt
    assert "I replace the node with its left child." in prompt
    assert "student_123" not in prompt
    assert "auth_user_id" not in prompt
    assert out["response"] == "Which case should you handle first?"


def test_student_history_is_separate_from_course_material():
    from ai.agents.coach.nodes import _format_course_material, _format_student_learning_context
    from ai.models.schemas import RetrievedContext

    history = [RetrievedContext(
        source="learning_history",
        content="Previously struggled with two-child deletion.",
        metadata={"assignment_id": "asg_1"},
    )]
    assert "Previously struggled" in _format_student_learning_context(history)
    assert "Previously struggled" not in _format_course_material(history)


def test_retrieval_query_uses_assignment_instructions_without_assignment_relationships():
    from ai.agents.coach.nodes import build_retrieval_query

    state = _state(
        messages=[],
        current_attempt="what topics should I study?",
        diagnosis=None,
    )
    query = build_retrieval_query(state)

    assert "Binary Search Trees" in query
    assert "Implement insertion and deletion for a binary search tree." in query
    assert "Subject area: data_structures" in query
    assert "what topics should I study?" in query
    # The retrieval query is intentionally independent of assignment_concepts
    # and assignment_materials relationship tables.
    assert "assignment_concepts" not in query
    assert "assignment_materials" not in query


def test_context_request_intents_are_routed_without_full_coach_pipeline():
    from ai.agents.coach.routing import detect_request_intent

    assert detect_request_intent("what is this assignment about?") == "assignment_about"
    assert detect_request_intent("what are the topics I need to study to understand it?") == "assignment_topics"
    assert detect_request_intent("what is my name?") == "student_name"
    assert detect_request_intent("help me understand binary search") is None


def test_assignment_context_prompt_gets_explicit_intent(monkeypatch):
    captured = {}

    class FakeLLM:
        def invoke(self, messages):
            captured["text"] = "\n".join(str(m.content) for m in messages)
            return type("R", (), {"response": "The assignment focuses on binary search trees.", "referenced_concepts": ["binary search trees"]})()

    monkeypatch.setattr("ai.agents.coach.nodes.get_structured_llm", lambda role, schema: FakeLLM())

    out = generate_response(_state(request_intent="assignment_topics"))
    assert "This is an assignment-topic request" in captured["text"]
    assert "Binary Search Trees" in captured["text"]
    assert "Implement insertion and deletion for a binary search tree." in captured["text"]
    assert out["response"] == "The assignment focuses on binary search trees."


def test_name_context_request_is_deterministic():
    from ai.agents.coach.nodes import prepare_context_response

    state = _state(request_intent="student_name")
    state["response"] = None
    out = prepare_context_response(state)
    assert out["response"] == "Ahmed"
    assert out["referenced_concepts"] == []
