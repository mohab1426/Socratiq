"""Analytics audit unit tests:
- Verifies analytics calculations (division-by-zero protection, distinct verification counts)
- Verifies review_queue sorting and reason separation
- Verifies server-enforced whiteboard authorship (coach vs student)
- Verifies SmartBoard AI interaction telemetry recording
"""
import json
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from backend.app.analytics import _pct, review_queue, mastery_label
from backend.app.auth import CurrentUser
from backend.app.main import create_app
from backend.app.schemas import WhiteboardIn


def test_pct_helper_edge_cases():
    assert _pct(0, 0) == 0
    assert _pct(5, 0) == 0
    assert _pct(0, 10) == 0
    assert _pct(5, 10) == 50
    assert _pct(10, 10) == 100
    assert _pct(1, 3) == 33


def test_mastery_label():
    assert mastery_label(None) is None
    assert mastery_label(0.85) == "Strong"
    assert mastery_label(0.70) == "Moderate"
    assert mastery_label(0.40) == "Weak"


def test_review_queue_separation_and_order():
    students = [
        {"id": "st1", "name": "Alice", "mastery": "Weak"},
        {"id": "st2", "name": "Bob", "mastery": "Moderate"},
        {"id": "st3", "name": "Charlie", "mastery": "Strong"},
    ]
    risks = {
        "st1": {"level": "low", "level_label": "Low", "score": 20, "confidence_label": "High", "evidence_count": 1, "primary_reason": "Normal usage", "focus": "none"},
        "st2": {"level": "high", "level_label": "High", "score": 85, "confidence_label": "High", "evidence_count": 4, "primary_reason": "Copied solution detected", "focus": "external_ai"},
        "st3": {"level": "moderate", "level_label": "Moderate", "score": 60, "confidence_label": "Medium", "evidence_count": 2, "primary_reason": "High speed paste", "focus": "rapid_answers"},
    }
    last_seen = {}
    queue = review_queue(students, risks, last_seen)

    assert len(queue) == 3
    # High risk review first
    assert queue[0]["student_id"] == "st2"
    assert queue[0]["kind"] == "risk_review"
    assert queue[0]["level"] == "high"

    # Moderate risk review second
    assert queue[1]["student_id"] == "st3"
    assert queue[1]["kind"] == "risk_review"
    assert queue[1]["level"] == "moderate"

    # Learning support (weak mastery, low risk) third
    assert queue[2]["student_id"] == "st1"
    assert queue[2]["kind"] == "learning_support"
    assert queue[2]["focus"] == "learning_difficulty"


def test_whiteboard_authorship_server_enforcement():
    """Verify that server-side save_whiteboard enforces trusted server evidence for coach elements:
    - Elements with server-signed HMAC IDs tied to this attempt retain author: coach, original_author: coach
    - Adversarial student client claims using 'ai_', 'v_', 'sim_' or arbitrary IDs are rejected and coerced to author: student
    - Modifying existing coach content turns author into student while preserving original_author: coach and student_modified: True
    - Unchanged existing coach elements retain author: coach, original_author: coach
    - Cross-attempt replay attacks (ID signed for a different attempt) are rejected
    """
    from backend.app.board_auth import sign_coach_element_id

    db = MagicMock()
    conn = MagicMock()
    db.tx.return_value.__enter__.return_value = conn

    conn.execute.return_value = None
    mock_attempt = {
        "attempt_id": "att_123",
        "assignment_id": "asg_1",
        "status": "DRAFT",
        "whiteboard": {
            "steps": [],
            "strokes": [],
            "elements": [
                {"id": "ai_orig", "kind": "text", "author": "coach", "seq": 1, "text": "Coach hint", "x": 100, "y": 100, "w": 200, "h": 60},
                {"id": "st_orig", "kind": "text", "author": "student", "seq": 2, "text": "Student note", "x": 100, "y": 200, "w": 200, "h": 60},
            ],
            "next_seq": 3,
        },
    }

    def mock_one(c, sql, params=()):
        if "FROM attempts" in sql:
            return mock_attempt
        if "UPDATE attempts" in sql:
            return {"whiteboard_updated_at": datetime.now(timezone.utc)}
        return None

    user = CurrentUser(user_id="s1", auth_user_id="auth_s1", university_id="u1", role="STUDENT", email="s1@uni.edu", first_name="Student", last_name="1")

    # Generate valid signed element IDs for this attempt
    valid_signed_ai = sign_coach_element_id("att_123", "ai")
    valid_signed_v = f"{sign_coach_element_id('att_123', 'v')}_0"
    # Generate an ID signed for a DIFFERENT attempt (replay attack)
    foreign_signed_ai = sign_coach_element_id("att_999", "ai")

    incoming_elements = [
        {"id": "ai_orig", "kind": "text", "author": "coach", "seq": 1, "text": "Coach hint", "x": 100, "y": 100, "w": 200, "h": 60},
        {"id": "ai_mod", "kind": "text", "author": "coach", "seq": 2, "text": "Student changed this", "x": 100, "y": 100, "w": 200, "h": 60},
        {"id": valid_signed_ai, "kind": "equation", "author": "coach", "seq": 3, "latex": "E = mc^2", "x": 100, "y": 300, "w": 200, "h": 60},
        {"id": valid_signed_v, "kind": "circle", "author": "coach", "seq": 4, "shape": "circle", "x": 100, "y": 400, "w": 80, "h": 80},
        {"id": "ai_forged_hint", "kind": "text", "author": "coach", "seq": 5, "text": "Student forged hint", "x": 100, "y": 500, "w": 200, "h": 60},
        {"id": "v_forged_shape", "kind": "shape", "shape": "rect", "author": "coach", "seq": 6, "w": 200, "h": 60},
        {"id": foreign_signed_ai, "kind": "text", "author": "coach", "seq": 7, "text": "Replayed from other attempt", "x": 100, "y": 700, "w": 200, "h": 60},
    ]

    mock_attempt["whiteboard"]["elements"].append(
        {"id": "ai_mod", "kind": "text", "author": "coach", "seq": 2, "text": "Original coach text", "x": 100, "y": 100, "w": 200, "h": 60}
    )

    with patch("backend.app.routers.student.one", side_effect=mock_one), \
         patch("backend.app.routers.student._open_attempt_for", return_value=mock_attempt):
        from backend.app.routers.student import save_whiteboard
        body = WhiteboardIn(steps=[], strokes=[], elements=incoming_elements)
        res = save_whiteboard("asg_1", body, user=user, db=db)

        elements_by_id = {e["id"]: e for e in res["elements"]}
        # 1. Unchanged coach element retains coach author
        assert elements_by_id["ai_orig"]["author"] == "coach"
        assert elements_by_id["ai_orig"]["original_author"] == "coach"
        # 2. Modified coach element becomes student author, with provenance preserved
        assert elements_by_id["ai_mod"]["author"] == "student"
        assert elements_by_id["ai_mod"]["original_author"] == "coach"
        assert elements_by_id["ai_mod"]["student_modified"] is True
        # 3. Legitimate server-issued signed element IDs are accepted as coach
        assert elements_by_id[valid_signed_ai]["author"] == "coach"
        assert elements_by_id[valid_signed_ai]["original_author"] == "coach"
        assert elements_by_id[valid_signed_v]["author"] == "coach"
        assert elements_by_id[valid_signed_v]["original_author"] == "coach"
        # 4. Forged element IDs with ai_/v_ prefixes are coerced to student
        assert elements_by_id["ai_forged_hint"]["author"] == "student"
        assert elements_by_id["v_forged_shape"]["author"] == "student"
        # 5. Cross-attempt replay attacks are coerced to student
        assert elements_by_id[foreign_signed_ai]["author"] == "student"


def test_smartboard_chat_telemetry_recording():
    """Verify that when an authenticated student calls /smartboard/chat with an assignment_id:
    - Attempt is looked up
    - Session is resolved/created
    - AI interaction is persisted in ai_interactions
    - Messages are recorded
    - Learning event AI_INTERACTION is inserted
    - Turn count is incremented
    """
    db = MagicMock()
    conn = MagicMock()
    db.tx.return_value.__enter__.return_value = conn

    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    user = CurrentUser(user_id="st_123", auth_user_id="auth_st", university_id="uni_1", role="STUDENT", email="st@uni.edu", first_name="Student", last_name="Test")
    assignment = {
        "assignment_id": "asg_999",
        "course_id": "crs_1",
        "classroom_id": "cls_1",
        "title": "Kinematics Assignment",
        "instructions": "Solve for acceleration",
        "default_policy": "SOCRATIC",
    }
    attempt = {
        "attempt_id": "att_555",
        "assignment_id": "asg_999",
        "status": "IN_PROGRESS",
        "attempt_number": 1,
    }
    session = {
        "session_id": "ses_777",
        "attempt_id": "att_555",
        "status": "ACTIVE",
    }

    def mock_one(c, sql, params=()):
        if "FROM attempts" in sql:
            return attempt
        if "FROM ai_sessions" in sql:
            return session
        return None

    executed_sqls = []
    def record_execute(sql, params=None):
        executed_sqls.append(sql)

    conn.execute.side_effect = record_execute

    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"), \
         patch("backend.app.routers.smartboard._authenticate_request", return_value=user), \
         patch("backend.app.routers.smartboard.student_assignment", return_value=assignment), \
         patch("backend.app.routers.smartboard.allowed_document_ids", return_value=[]), \
         patch("backend.app.routers.smartboard.coach_application_context", return_value={}), \
         patch("backend.app.routers.smartboard.one", side_effect=mock_one), \
         patch("backend.app.routers.smartboard.insert_event") as mock_insert_event, \
         patch("httpx.AsyncClient.post") as mock_http_post:

        mock_http_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "candidates": [{
                    "content": {
                        "parts": [
                            {"text": "Consider the velocity formula: v = u + at."},
                            {"functionCall": {"name": "add_equation", "args": {"latex": "v = u + at"}}}
                        ]
                    }
                }]
            }
        )

        resp = client.post(
            "/api/v1/smartboard/chat",
            json={
                "messages": [{"role": "user", "text": "How do I calculate final velocity?"}],
                "assignment_id": "asg_999",
            },
            headers={"Authorization": "Bearer fake_token"}
        )

        assert resp.status_code == 200
        data = resp.json()
        assert "velocity formula" in data["text"]
        assert len(data["functionCalls"]) == 1

        # Check telemetry persistence
        ai_interaction_sql = any("INSERT INTO ai_interactions" in s for s in executed_sqls)
        assert ai_interaction_sql, "Expected INSERT INTO ai_interactions"

        turn_count_sql = any("UPDATE ai_sessions SET turn_count" in s for s in executed_sqls)
        assert turn_count_sql, "Expected UPDATE ai_sessions SET turn_count"

        # Check learning event emission
        mock_insert_event.assert_called_once()
        _, event_kwargs = mock_insert_event.call_args
        assert event_kwargs["event_type"] == "AI_INTERACTION"
        assert event_kwargs["assignment_id"] == "asg_999"
        assert event_kwargs["student_id"] == "st_123"
        assert event_kwargs["payload"]["mode"] == "smartboard"
        assert "add_equation" in event_kwargs["payload"]["tools_used"]
