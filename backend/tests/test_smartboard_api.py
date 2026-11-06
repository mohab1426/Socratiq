from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from backend.app.main import create_app


def test_smartboard_config():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    r = client.get("/api/v1/smartboard/config")
    assert r.status_code == 200
    assert "status" in r.json()


def test_smartboard_missing_key_returns_503():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value=None):
        r_sim = client.post("/api/v1/smartboard/generate-simulation", json={"prompt": "test"})
        assert r_sim.status_code == 503
        r_vec = client.post("/api/v1/smartboard/generate-vector", json={"prompt": "test"})
        assert r_vec.status_code == 503
        r_chat = client.post("/api/v1/smartboard/chat", json={"messages": [{"role": "user", "text": "hi"}]})
        assert r_chat.status_code == 503
        r_img = client.post("/api/v1/smartboard/generate-image", json={"prompt": "test"})
        assert r_img.status_code == 503


def test_smartboard_generate_vector_mocked():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        with patch("httpx.AsyncClient.post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                json=lambda: {"candidates": [{"content": {"parts": [{"text": '{"elements": [{"type": "circle", "x": 10, "y": 10, "radius": 5}]}'}]}}]}
            )
            r = client.post("/api/v1/smartboard/generate-vector", json={"prompt": "circle"})
            assert r.status_code == 200
            data = r.json()
            assert "elements" in data
            assert len(data["elements"]) == 1
            assert data["elements"][0]["type"] == "circle"


def test_smartboard_generate_simulation_mocked():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        with patch("httpx.AsyncClient.post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                json=lambda: {"candidates": [{"content": {"parts": [{"text": "```html<div>simulation</div>```"}]}}]}
            )
            r = client.post("/api/v1/smartboard/generate-simulation", json={"prompt": "simulation"})
            assert r.status_code == 200
            assert r.json()["code"] == "<div>simulation</div>"


def test_smartboard_chat_mocked():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        with patch("httpx.AsyncClient.post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                json=lambda: {
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {"text": "I drew a rectangle."},
                                    {"functionCall": {"name": "draw_rectangle", "args": {"x": 10, "y": 20, "width": 100, "height": 50, "color": "#000"}}}
                                ]
                            }
                        }
                    ]
                }
            )
            r = client.post("/api/v1/smartboard/chat", json={"messages": [{"role": "user", "text": "draw a rect"}]})
            assert r.status_code == 200
            res = r.json()
            assert res["text"] == "I drew a rectangle."
            assert len(res["functionCalls"]) == 1
            assert res["functionCalls"][0]["functionCall"]["name"] == "draw_rectangle"


def test_smartboard_chat_with_audio_payload():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        with patch("httpx.AsyncClient.post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                json=lambda: {
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {"text": "I heard your voice note and answered your question."}
                                ]
                            }
                        }
                    ]
                }
            )
            r = client.post("/api/v1/smartboard/chat", json={
                "messages": [{
                    "role": "user",
                    "text": "Voice Note",
                    "audio": "UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                    "mime_type": "audio/wav"
                }]
            })
            assert r.status_code == 200
            res = r.json()
            assert res["text"] == "I heard your voice note and answered your question."
            # Verify call payload had inlineData
            called_payload = mock_post.call_args[1]["json"]
            user_parts = called_payload["contents"][0]["parts"]
            assert any("inlineData" in p and p["inlineData"]["mimeType"] == "audio/wav" for p in user_parts)


def test_smartboard_chat_malformed_audio_returns_400():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        r = client.post("/api/v1/smartboard/chat", json={
            "messages": [{
                "role": "user",
                "text": "Voice Note",
                "audio": "this_is_not_valid_base64!@#$%",
                "mime_type": "audio/wav"
            }]
        })
        assert r.status_code == 400
        assert "Invalid audio base64 payload" in r.json()["detail"]


def test_smartboard_chat_oversized_audio_returns_413():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        oversized = "A" * (11 * 1024 * 1024)
        r = client.post("/api/v1/smartboard/chat", json={
            "messages": [{
                "role": "user",
                "text": "Big Audio",
                "audio": oversized,
                "mime_type": "audio/wav"
            }]
        })
        assert r.status_code == 413
        assert "Audio payload too large" in r.json()["detail"]


def test_smartboard_chat_timeout_returns_504():
    import httpx
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        with patch("httpx.AsyncClient.post", side_effect=httpx.TimeoutException("timeout")):
            r = client.post("/api/v1/smartboard/chat", json={
                "messages": [{"role": "user", "text": "slow query"}]
            })
            assert r.status_code == 504
            assert "timed out" in r.json()["detail"]


def test_save_whiteboard_oversized_payload_returns_413():
    from backend.app.auth import CurrentUser, get_current_user
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    student = CurrentUser(
        user_id="s1",
        auth_user_id="auth_s1",
        university_id="u1",
        role="STUDENT",
        email="student@test.com",
        first_name="Jane",
        last_name="Doe",
    )
    app.dependency_overrides[get_current_user] = lambda: student
    client = TestClient(app)

    # Create payload totalling > 380,000 bytes within allowed element limits
    body = {
        "steps": [],
        "strokes": [],
        "elements": [
            {
                "id": "img1",
                "kind": "image",
                "author": "student",
                "src": "data:image/png;base64," + ("A" * 385000),
            }
        ],
    }
    with patch("backend.app.routers.student._open_attempt_for", return_value={"attempt_id": "att1", "whiteboard": None}):
        r = client.put(
            "/api/v1/student/assignments/A1/whiteboard",
            json=body,
            headers={"Authorization": "Bearer fake_token"}
        )
        assert r.status_code == 413
        assert r.json()["error"]["code"] == "board_too_large"


def test_smartboard_context_unauthenticated():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)
    r = client.get("/api/v1/smartboard/context?assignment_id=A1")
    assert r.status_code == 401
    assert "Authentication required" in r.json()["detail"]


def test_smartboard_context_authenticated_student():
    from backend.app.auth import CurrentUser
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    student = CurrentUser(
        user_id="s1",
        auth_user_id="auth_s1",
        university_id="u1",
        role="STUDENT",
        email="student@test.com",
        first_name="Jane",
        last_name="Doe",
    )
    with patch("backend.app.routers.smartboard._authenticate_request", return_value=student):
        with patch("backend.app.routers.smartboard.student_assignment", return_value={
            "assignment_id": "A1",
            "course_id": "C1",
            "title": "Quantum Mechanics Problem Set",
            "instructions": "Solve Schrödinger equation for 1D infinite well",
            "subject_area": "Physics",
            "is_programming": False,
        }):
            with patch("backend.app.routers.smartboard.allowed_document_ids", return_value=["doc1", "doc2"]):
                with patch("backend.app.routers.smartboard.coach_application_context", return_value={
                    "course_title": "Modern Physics",
                    "course_code": "PHYS201",
                    "concepts": ["Wavefunction", "Infinite Well"],
                    "attachments": [{"filename": "ps1.pdf", "role": "PROBLEM_SET"}],
                    "materials": [{"title": "Lecture 3 Notes", "file_type": "pdf", "searchable": True}],
                }):
                    client = TestClient(app)
                    r = client.get(
                        "/api/v1/smartboard/context?assignment_id=A1",
                        headers={"Authorization": "Bearer valid_token"}
                    )
                    assert r.status_code == 200
                    data = r.json()
                    assert data["assignment"]["title"] == "Quantum Mechanics Problem Set"
                    assert data["assignment"]["instructions"] == "Solve Schrödinger equation for 1D infinite well"
                    assert "Wavefunction" in data["assignment"]["concepts"]
                    assert data["course"]["code"] == "PHYS201"
                    assert data["allowed_documents_count"] == 2


def test_smartboard_context_cross_student_access_denied():
    from backend.app.auth import CurrentUser
    from backend.app.errors import not_found
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    student = CurrentUser(
        user_id="s1",
        auth_user_id="auth_s1",
        university_id="u1",
        role="STUDENT",
        email="student@test.com",
        first_name="Jane",
        last_name="Doe",
    )
    with patch("backend.app.routers.smartboard._authenticate_request", return_value=student):
        with patch("backend.app.routers.smartboard.student_assignment", side_effect=not_found("Assignment not found")):
            client = TestClient(app)
            r = client.get(
                "/api/v1/smartboard/context?assignment_id=OTHER_STUDENT_ASSIGNMENT",
                headers={"Authorization": "Bearer valid_token"}
            )
            assert r.status_code == 404


def test_smartboard_retrieve_scoped_materials():
    from backend.app.auth import CurrentUser
    from ai.models.schemas import RetrievedContext
    db = MagicMock()
    mock_rag = MagicMock()
    mock_rag.retrieve_course_material.return_value = [
        RetrievedContext(
            source="lecture_notes_ch2.pdf",
            content="The boundary condition requires psi(0) = 0 and psi(L) = 0.",
            metadata={"document_title": "Chapter 2: Quantum Wells", "page_number": 14, "score": 0.92}
        )
    ]
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=mock_rag, run_worker=False)
    student = CurrentUser(
        user_id="s1",
        auth_user_id="auth_s1",
        university_id="u1",
        role="STUDENT",
        email="student@test.com",
        first_name="Jane",
        last_name="Doe",
    )
    with patch("backend.app.routers.smartboard._authenticate_request", return_value=student):
        with patch("backend.app.routers.smartboard.student_assignment", return_value={
            "assignment_id": "A1",
            "course_id": "C1",
            "classroom_id": "K1",
            "title": "Quantum Mechanics",
        }):
            with patch("backend.app.routers.smartboard.allowed_document_ids", return_value=["doc1"]):
                client = TestClient(app)
                r = client.post(
                    "/api/v1/smartboard/retrieve",
                    json={"query": "boundary conditions", "assignment_id": "A1", "top_k": 3},
                    headers={"Authorization": "Bearer valid_token"}
                )
                assert r.status_code == 200
                res = r.json()["results"]
                assert len(res) == 1
                assert res[0]["document_title"] == "Chapter 2: Quantum Wells"
                assert res[0]["page_number"] == 14
                assert "psi(0) = 0" in res[0]["content"]

                # Verify RAG was called with scoped allowed_document_ids
                call_args = mock_rag.retrieve_course_material.call_args
                assert call_args[1]["course_id"] == "C1"
                assert call_args[1]["query"] == "boundary conditions"
                scope = call_args[1]["scope"]
                assert scope.university_id == "u1"
                assert scope.allowed_document_ids == ("doc1",)


def test_smartboard_chat_educational_grounding_and_sources():
    from backend.app.auth import CurrentUser
    from ai.models.schemas import RetrievedContext
    db = MagicMock()
    mock_rag = MagicMock()
    mock_rag.retrieve_course_material.return_value = [
        RetrievedContext(
            source="lecture_waves.pdf",
            content="Nodes occur where the amplitude of the standing wave is zero.",
            metadata={"document_title": "Lecture Notes: Wave Mechanics", "page_number": 8, "score": 0.88}
        )
    ]
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=mock_rag, run_worker=False)
    student = CurrentUser(
        user_id="s1",
        auth_user_id="auth_s1",
        university_id="u1",
        role="STUDENT",
        email="student@test.com",
        first_name="Jane",
        last_name="Doe",
    )
    with patch("backend.app.routers.smartboard._get_gemini_key", return_value="fake_key"):
        with patch("backend.app.routers.smartboard._authenticate_request", return_value=student):
            with patch("backend.app.routers.smartboard.student_assignment", return_value={
                "assignment_id": "A1",
                "course_id": "C1",
                "classroom_id": "K1",
                "title": "Quantum Waves",
                "instructions": "Explain wave nodes",
            }):
                with patch("backend.app.routers.smartboard.allowed_document_ids", return_value=["doc1"]):
                    with patch("backend.app.routers.smartboard.coach_application_context", return_value={
                        "course_title": "Physics 2",
                        "course_code": "PHYS202",
                        "concepts": ["Standing Waves", "Nodes"],
                        "attachments": [],
                        "materials": [],
                    }):
                        with patch("httpx.AsyncClient.post") as mock_post:
                            mock_post.return_value = MagicMock(
                                status_code=200,
                                json=lambda: {
                                    "candidates": [
                                        {
                                            "content": {
                                                "parts": [{"text": "As explained in Lecture Notes: Wave Mechanics (Page 8), nodes are points of zero amplitude."}]
                                            }
                                        }
                                    ]
                                }
                            )
                            client = TestClient(app)
                            r = client.post(
                                "/api/v1/smartboard/chat",
                                json={
                                    "messages": [{"role": "user", "text": "What is a node in a standing wave?"}],
                                    "assignment_id": "A1",
                                    "board": {
                                        "elements": [
                                            {"id": "el1", "kind": "text", "text": "Wave nodes", "x": 100, "y": 100, "w": 200, "h": 50}
                                        ]
                                    }
                                },
                                headers={"Authorization": "Bearer valid_token"}
                            )
                            assert r.status_code == 200
                            data = r.json()
                            assert "Lecture Notes: Wave Mechanics" in data["text"]
                            assert len(data["sources"]) == 1
                            assert data["sources"][0]["title"] == "Lecture Notes: Wave Mechanics"
                            assert data["sources"][0]["page"] == 8

                            # Verify that enriched systemInstruction was sent to Gemini with English directive & course context
                            called_payload = mock_post.call_args[1]["json"]
                            sys_text = called_payload["systemInstruction"]["parts"][0]["text"]
                            assert "LANGUAGE DIRECTIVE" in sys_text
                            assert "Default strictly to speaking and writing in English" in sys_text
                            assert "ASSIGNMENT CONTEXT" in sys_text
                            assert "Quantum Waves" in sys_text
                            assert "RELEVANT COURSE MATERIALS & LECTURE NOTES" in sys_text
                            assert "STUDENT'S CURRENT SMARTBOARD WORK" in sys_text


def test_smartboard_simulation_model_fallback():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    responses = [
        # First attempt: primary model fails with 503 high demand
        MagicMock(status_code=503, text='{"error": "high demand"}'),
        # Second attempt: fallback model succeeds with 200
        MagicMock(
            status_code=200,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": "```html<div>fallback simulation</div>```"}]}}]}
        ),
    ]

    with patch("backend.app.routers.smartboard._get_gemini_keys", return_value=["key1"]):
        with patch("backend.app.routers.smartboard._get_smartboard_models", return_value=["model_primary", "model_fallback"]):
            with patch("httpx.AsyncClient.post", side_effect=responses) as mock_post:
                r = client.post("/api/v1/smartboard/generate-simulation", json={"prompt": "wave simulation"})
                assert r.status_code == 200
                assert r.json()["code"] == "<div>fallback simulation</div>"
                assert mock_post.call_count == 2
                assert "model_primary" in mock_post.call_args_list[0][0][0]
                assert "model_fallback" in mock_post.call_args_list[1][0][0]


def test_smartboard_simulation_key_rotation():
    db = MagicMock()
    app = create_app(db=db, storage=MagicMock(), token_verifier=MagicMock(), ai_adapter=MagicMock(), rag=MagicMock(), run_worker=False)
    client = TestClient(app)

    responses = [
        # First key returns 429 rate limit
        MagicMock(status_code=429, text='{"error": "rate limit"}'),
        # Second key returns 200 OK
        MagicMock(
            status_code=200,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": "```html<div>rotated key sim</div>```"}]}}]}
        ),
    ]

    with patch("backend.app.routers.smartboard._get_gemini_keys", return_value=["key_a", "key_b"]):
        with patch("backend.app.routers.smartboard._get_smartboard_models", return_value=["test_model"]):
            with patch("httpx.AsyncClient.post", side_effect=responses) as mock_post:
                r = client.post("/api/v1/smartboard/generate-simulation", json={"prompt": "pendulum"})
                assert r.status_code == 200
                assert r.json()["code"] == "<div>rotated key sim</div>"
                assert mock_post.call_count == 2
                assert "key=key_a" in mock_post.call_args_list[0][0][0]
                assert "key=key_b" in mock_post.call_args_list[1][0][0]



