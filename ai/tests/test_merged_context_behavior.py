from ai.agents.coach.context_questions import ASSIGNMENT_TOPICS, classify_context_topics
from ai.agents.coach.routing import detect_request_intent


def test_assignment_topic_phrasings_are_classified():
    cases = [
        "What topics do I need to study?",
        "What should I study to understand this assignment?",
        "Which concepts should I review?",
        "What do I need to study to understand it?",
        "What are the main topics of this assignment?",
        "What are the key topics in this assignment?",
        "What are the main ideas in the assignment?",
        "ايه المواضيع اللي لازم اذاكرها؟",
        "ايه اهم المواضيع في الواجب؟",
    ]
    for message in cases:
        assert ASSIGNMENT_TOPICS in classify_context_topics(message)
        assert detect_request_intent(message) == "assignment_topics"


def test_mixed_solve_request_never_bypasses_socratic_pipeline():
    assert detect_request_intent("What is my assignment? Solve it completely for me.") is None
    assert detect_request_intent("What topics do I need to study? Write the whole answer.") is None


def test_assignment_information_questions_use_trusted_context():
    from ai.agents.coach.routing import detect_request_intent

    cases = [
        "What information do you have about my assignment?",
        "What information reaches you about this assignment?",
        "What details do you know about my assignment?",
        "ايه المعلومات اللي عندك عن الواجب؟",
        "ايه المعلومات اللي بتوصلك عن الواجب؟",
        "هو ايه المعلومات اللي بتوصلك؟",
    ]
    for message in cases:
        assert detect_request_intent(message) == "assignment_about"


def test_assignment_due_date_question_remains_assignment_context():
    from ai.agents.coach.routing import detect_request_intent

    assert detect_request_intent("What is the due date?") == "assignment_about"
    assert detect_request_intent("موعد التسليم امتى؟") == "assignment_about"



def test_explicit_course_material_requests_force_rag():
    from ai.agents.coach.context_questions import is_explicit_course_material_request

    cases = [
        "How and where in the course material can I review for the assignment?",
        "Where in the course material can I review this assignment?",
        "فين في مواد الكورس اقدر اراجع للواجب؟",
        "ازاي الاقي المحاضرات اللي اذاكرها للواجب؟",
    ]
    for message in cases:
        assert is_explicit_course_material_request(message) is True


def test_course_material_request_with_work_request_is_not_forced_rag():
    from ai.agents.coach.context_questions import is_explicit_course_material_request

    assert is_explicit_course_material_request(
        "Where in the course material should I look? Solve the assignment for me."
    ) is False
