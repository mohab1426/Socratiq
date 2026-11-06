"""End-to-end tests of the compiled Coach graph, with all LLM calls mocked."""
from __future__ import annotations

import itertools

from ai.agents.coach import nodes as nodes_mod
from ai.agents.coach.graph import Coach
from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision, ValidationResult
from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
from ai.tools.course_retrieval import CourseRetrievalTool
from ai.tools.student_history import StudentHistoryTool
from ai.tests.conftest import FakeStructuredLLM


def _mock_llm_pipeline(monkeypatch, *, diagnosis: DiagnosisResult, intervention: InterventionDecision, response: GeneratedResponse):
    """Route each ModelRole call to the right canned structured output."""

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(result=diagnosis)
        if schema is InterventionDecision:
            return FakeStructuredLLM(result=intervention)
        if schema is GeneratedResponse:
            return FakeStructuredLLM(result=response)
        raise AssertionError(f"Unexpected schema requested: {schema}")

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)


def _always_pass_validation(monkeypatch):
    monkeypatch.setattr(
        nodes_mod,
        "validate_response",
        lambda **kwargs: ValidationResult(passes=True, violations=[]),
    )


def test_guided_mode_does_not_reveal_final_answer(monkeypatch, task_context):
    _mock_llm_pipeline(
        monkeypatch,
        diagnosis=DiagnosisResult(
            category=DiagnosisCategory.MISCONCEPTION,
            concept="learning_rate",
            explanation="Student updates theta by the prediction instead of the gradient.",
            evidence="theta = theta - prediction",
            confidence=0.8,
        ),
        intervention=InterventionDecision(
            intervention_type=InterventionType.QUESTION,
            rationale="Guide the student to reconsider what should scale the update.",
        ),
        response=GeneratedResponse(
            response="What quantity should scale how much you adjust theta at each step?",
            referenced_concepts=["gradient_descent", "learning_rate"],
        ),
    )
    _always_pass_validation(monkeypatch)

    coach = Coach()
    result = coach.invoke(
        student_id="s1",
        assignment_id="asg_1",
        session_id="sess_1",
        task_context=task_context,
        attempt="theta = theta - prediction",
        message="Can you just give me the fixed formula?",
        policy=AssistancePolicy.GUIDED,
    )

    assert result.intervention.type == InterventionType.QUESTION
    assert "answer is" not in result.response.lower()
    assert result.learning_event.event_type.value == "AI_INTERACTION"


def test_correct_attempt_recognized_not_forced_into_misconception(monkeypatch, task_context):
    _mock_llm_pipeline(
        monkeypatch,
        diagnosis=DiagnosisResult(
            category=DiagnosisCategory.CORRECT_REASONING,
            concept=None,
            explanation="The gradient descent update rule is implemented correctly.",
            evidence="theta = theta - lr * gradient",
            confidence=0.9,
        ),
        intervention=InterventionDecision(
            intervention_type=InterventionType.ENCOURAGEMENT,
            rationale="Reinforce correct understanding.",
        ),
        response=GeneratedResponse(
            response="Nice work -- that update rule correctly uses the gradient and learning rate.",
            referenced_concepts=["gradient_descent"],
        ),
    )
    _always_pass_validation(monkeypatch)

    coach = Coach()
    result = coach.invoke(
        student_id="s1",
        assignment_id="asg_1",
        session_id="sess_1",
        task_context=task_context,
        attempt="theta = theta - lr * gradient",
        policy=AssistancePolicy.GUIDED,
    )
    assert result.diagnosis_summary.category == DiagnosisCategory.CORRECT_REASONING
    assert result.intervention.type == InterventionType.ENCOURAGEMENT


def test_revision_triggers_new_diagnosis_and_can_change_intervention(monkeypatch, task_context):
    diagnoses = iter(
        [
            DiagnosisResult(
                category=DiagnosisCategory.MISCONCEPTION,
                concept="learning_rate",
                explanation="Confuses learning rate with the gradient itself.",
                evidence="theta = theta - gradient (missing lr)",
                confidence=0.7,
            ),
            DiagnosisResult(
                category=DiagnosisCategory.MISCONCEPTION,
                concept="learning_rate_vs_gradient",
                explanation="Still conflates the two after revision.",
                evidence="theta = theta - lr (missing gradient)",
                confidence=0.75,
            ),
        ]
    )
    interventions = iter(
        [
            InterventionDecision(intervention_type=InterventionType.QUESTION, rationale="probe first"),
            InterventionDecision(intervention_type=InterventionType.EXPLANATION, rationale="explain directly since confusion persisted on revision"),
        ]
    )
    responses = iter(
        [
            GeneratedResponse(response="What role does the learning rate play versus the gradient?", referenced_concepts=["learning_rate"]),
            GeneratedResponse(response="The gradient gives the direction; the learning rate scales the step size.", referenced_concepts=["learning_rate", "gradient_descent"]),
        ]
    )

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(side_effect=lambda m: next(diagnoses))
        if schema is InterventionDecision:
            return FakeStructuredLLM(side_effect=lambda m: next(interventions))
        if schema is GeneratedResponse:
            return FakeStructuredLLM(side_effect=lambda m: next(responses))
        raise AssertionError(schema)

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    _always_pass_validation(monkeypatch)

    coach = Coach()
    result1 = coach.invoke(
        student_id="s1", assignment_id="asg_1", session_id="sess_1",
        task_context=task_context, attempt="theta = theta - gradient",
        policy=AssistancePolicy.GUIDED, turn_index=0,
    )
    result2 = coach.invoke(
        student_id="s1", assignment_id="asg_1", session_id="sess_1",
        task_context=task_context, attempt="theta = theta - lr",
        policy=AssistancePolicy.GUIDED, turn_index=1,
    )

    assert result1.diagnosis_summary.concept != result2.diagnosis_summary.concept
    assert result1.intervention.type != result2.intervention.type


def test_course_retrieval_failure_does_not_crash_graph(monkeypatch, task_context):
    _mock_llm_pipeline(
        monkeypatch,
        diagnosis=DiagnosisResult(
            category=DiagnosisCategory.CONCEPTUAL_GAP,
            concept="loss_function",
            explanation="Doesn't reference the loss function the course material defines.",
            evidence="no loss computation present",
            confidence=0.6,
        ),
        intervention=InterventionDecision(
            intervention_type=InterventionType.HINT,
            rationale="Point back to the course material on loss functions.",
            needs_course_material=True,
        ),
        response=GeneratedResponse(
            response="Take another look at how the loss function is defined in the lecture notes.",
            referenced_concepts=["loss_function"],
        ),
    )
    _always_pass_validation(monkeypatch)

    def broken_retriever(course_id, query, top_k=4):
        raise RuntimeError("vector store unavailable")

    coach = Coach(course_tool=CourseRetrievalTool(retriever=broken_retriever), history_tool=StudentHistoryTool())
    result = coach.invoke(
        student_id="s1", assignment_id="asg_1", session_id="sess_1",
        task_context=task_context, attempt="no loss computed",
        policy=AssistancePolicy.ASSISTED,
    )
    assert result.response
    assert any("retrieve_context" in e for e in result.metadata["errors"])


def test_repeated_validation_failure_falls_back_safely(monkeypatch, task_context):
    _mock_llm_pipeline(
        monkeypatch,
        diagnosis=DiagnosisResult(
            category=DiagnosisCategory.MISCONCEPTION,
            concept="learning_rate",
            explanation="e",
            evidence="ev",
            confidence=0.7,
        ),
        intervention=InterventionDecision(intervention_type=InterventionType.QUESTION, rationale="probe"),
        response=GeneratedResponse(response="The answer is theta = theta - lr * grad.", referenced_concepts=[]),
    )
    # Always fail validation with no safe revision available -> should hit
    # the retry loop and then the safe_fallback node instead of looping
    # forever or shipping the bad response.
    monkeypatch.setattr(
        nodes_mod,
        "validate_response",
        lambda **kwargs: ValidationResult(passes=False, violations=["reveals answer"], revised_response=None),
    )

    coach = Coach()
    result = coach.invoke(
        student_id="s1", assignment_id="asg_1", session_id="sess_1",
        task_context=task_context, attempt="theta = theta - prediction",
        policy=AssistancePolicy.GUIDED,
    )
    assert result.intervention.type == InterventionType.CLARIFICATION
    assert "answer is" not in result.response.lower()


def test_arabic_input_is_passed_through_unmodified(monkeypatch, task_context):
    """The Coach must not force-translate or reject Arabic/mixed input --
    verify the student's Arabic text reaches the diagnosis prompt intact."""
    captured = {}

    def fake_get_structured_llm(role, schema):
        if schema is DiagnosisResult:
            def capture(messages):
                captured["messages"] = messages
                return DiagnosisResult(
                    category=DiagnosisCategory.UNCERTAIN, concept=None,
                    explanation="need more info", evidence="", confidence=0.3,
                )
            return FakeStructuredLLM(side_effect=capture)
        if schema is InterventionDecision:
            return FakeStructuredLLM(result=InterventionDecision(intervention_type=InterventionType.CLARIFICATION, rationale="ask for more detail"))
        if schema is GeneratedResponse:
            return FakeStructuredLLM(result=GeneratedResponse(response="ممكن توضح أكتر إيه اللي حاولت تعمله؟", referenced_concepts=[]))
        raise AssertionError(schema)

    monkeypatch.setattr(nodes_mod, "get_structured_llm", fake_get_structured_llm)
    _always_pass_validation(monkeypatch)

    arabic_attempt = "مش فاهم ليه الكود مش شغال، ممكن تشرحلي؟"
    coach = Coach()
    result = coach.invoke(
        student_id="s1", assignment_id="asg_1", session_id="sess_1",
        task_context=task_context, attempt=arabic_attempt,
        policy=AssistancePolicy.GUIDED,
    )
    diagnosis_prompt_text = " ".join(str(m.content) for m in captured["messages"])
    assert arabic_attempt in diagnosis_prompt_text
    assert result.response  # Coach responded (in Arabic per the mocked LLM)


# ---------------------------------------------------------------- Coach.stream (SSE support)
def test_coach_stream_yields_real_node_stages_then_the_same_result_as_invoke(monkeypatch):
    from ai.agents.coach.graph import Coach
    from ai.agents.coach.schemas import DiagnosisResult, GeneratedResponse, InterventionDecision
    from ai.agents.coach.state import TaskContext
    from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
    from ai.tests.conftest import FakeStructuredLLM

    def fake(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(result=DiagnosisResult(category=DiagnosisCategory.MISCONCEPTION, concept="learning rate", explanation="e", evidence="x", confidence=0.8))
        if schema is InterventionDecision:
            return FakeStructuredLLM(result=InterventionDecision(intervention_type=InterventionType.QUESTION, rationale="r", needs_course_material=False, needs_student_history=False))
        if schema is GeneratedResponse:
            return FakeStructuredLLM(result=GeneratedResponse(response="What scales each step?", referenced_concepts=["learning rate"]))
        return FakeStructuredLLM(result={"passes": True, "violations": []})

    monkeypatch.setattr("ai.agents.coach.nodes.get_structured_llm", fake)
    ok = lambda **kw: type("V", (), {"passes": True, "violations": [], "revised_response": None})()  # noqa: E731
    monkeypatch.setattr("ai.agents.coach.nodes.validate_response", ok)
    task = TaskContext(assignment_id="A", course_id="C", title="GD", instructions="Implement gradient descent", university_id="U")
    kw = dict(student_id="s", assignment_id="A", session_id="ses", task_context=task, attempt="theta = theta - grad", policy=AssistancePolicy.GUIDED, message="ok?")
    coach = Coach()
    events = list(coach.stream(**kw))
    kinds = [k for k, _ in events]
    assert kinds[-1] == "result" and kinds.count("result") == 1
    stages = [v for k, v in events if k == "stage"]
    assert stages.index("diagnose") < stages.index("choose_intervention") < stages.index("generate_response") < stages.index("validate") <= stages.index("emit_interaction")
    assert events[-1][1].response == coach.invoke(**kw).response == "What scales each step?"


def test_closing_coach_stream_early_stops_the_graph_and_yields_no_result(monkeypatch):
    from ai.agents.coach.graph import Coach
    from ai.agents.coach.schemas import DiagnosisResult, InterventionDecision
    from ai.agents.coach.state import TaskContext
    from ai.models.schemas import AssistancePolicy, DiagnosisCategory, InterventionType
    from ai.tests.conftest import FakeStructuredLLM

    called = {"response": 0}

    def fake(role, schema):
        if schema is DiagnosisResult:
            return FakeStructuredLLM(result=DiagnosisResult(category=DiagnosisCategory.MISCONCEPTION, concept="c", explanation="e", evidence="x", confidence=0.8))
        if schema is InterventionDecision:
            return FakeStructuredLLM(result=InterventionDecision(intervention_type=InterventionType.QUESTION, rationale="r", needs_course_material=False, needs_student_history=False))

        def respond(messages):
            called["response"] += 1
            raise AssertionError("generate_response must not run after the stream was closed")
        return FakeStructuredLLM(side_effect=respond)

    monkeypatch.setattr("ai.agents.coach.nodes.get_structured_llm", fake)
    task = TaskContext(assignment_id="A", course_id="C", title="GD", instructions="i", university_id="U")
    gen = Coach().stream(student_id="s", assignment_id="A", session_id="ses", task_context=task, attempt="x = 1", policy=AssistancePolicy.GUIDED, message="m")
    first = next(gen)
    assert first[0] == "stage"
    gen.close()                                              # what happens when the HTTP client disconnects
    assert called["response"] == 0
