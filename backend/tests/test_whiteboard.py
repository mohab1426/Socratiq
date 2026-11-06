"""Whiteboard (thinking space): per-attempt typed steps + strokes; the Coach reads the typed steps; teachers see the board read-only."""
from __future__ import annotations

from .helpers import API
from .test_ai_contract import real  # noqa: F401  (fixture re-export)

URL = f"{API}/student/assignments/A1/whiteboard"
BOARD = {"steps": ["x + 5 = 12", "x = 12 - 5", "x = 7"], "strokes": [{"t": "p", "w": 3, "pts": [[10, 10], [200, 220], [400, 90]]}]}


def _put(w, body=BOARD, who="S1"):
    return w.client.put(URL, json=body, headers=w.h(who))


def test_empty_board_before_anything_is_saved(world):
    r = world.client.get(URL, headers=world.h("S1"))
    assert r.status_code == 200 and r.json()["steps"] == [] and r.json()["strokes"] == [] and r.json()["updated_at"] is None


def test_save_replaces_the_board_and_reload_returns_it(world):
    r = _put(world)
    assert r.status_code == 200 and r.json()["steps"] == BOARD["steps"] and r.json()["updated_at"]
    assert world.client.get(URL, headers=world.h("S1")).json()["strokes"] == BOARD["strokes"]
    _put(world, {"steps": ["only this"], "strokes": []})
    assert world.client.get(URL, headers=world.h("S1")).json()["steps"] == ["only this"]


def test_blank_steps_are_dropped_and_text_is_trimmed(world):
    r = _put(world, {"steps": ["  a  ", "", "   ", "b"], "strokes": []})
    assert r.json()["steps"] == ["a", "b"]


def test_invalid_boards_are_rejected(world):
    assert _put(world, {"steps": [], "strokes": [{"t": "p", "w": 3, "pts": [[5000, 1]]}]}).status_code == 422          # outside the board
    assert _put(world, {"steps": [], "strokes": [{"t": "x", "w": 3, "pts": [[1, 1]]}]}).status_code == 422             # unknown tool
    assert _put(world, {"steps": [], "strokes": [{"t": "p", "w": 3, "pts": []}]}).status_code == 422
    assert _put(world, {"steps": ["x" * 1001], "strokes": []}).status_code == 422
    assert _put(world, {"steps": ["s"] * 61, "strokes": []}).status_code == 422
    assert _put(world, {"steps": [], "strokes": [{"t": "p", "w": 3, "pts": [[1, 1]]}] * 601}).status_code == 422
    big = {"t": "p", "w": 3, "pts": [[1, 1]] * 4000}
    assert _put(world, {"steps": [], "strokes": [big] * 8}).status_code == 422                                          # > 30000 points in total
    assert _put(world, {**BOARD, "student_id": "S2"}).status_code == 422                                                # no forged fields
    assert world.q("select count(*) n from attempts where whiteboard is not null")[0]["n"] == 0


def test_database_enforces_a_size_cap_independently(world):
    import psycopg
    import pytest
    with pytest.raises(psycopg.errors.CheckViolation):
        world.x("update attempts set whiteboard = jsonb_build_object('blob', repeat(md5(random()::text), 40000))")


def test_only_the_owner_student_can_use_the_board(world):
    assert world.client.put(URL, json=BOARD).status_code == 401
    assert _put(world, who="P1").status_code == 403                                                                      # instructors have no student board
    assert _put(world, who="S2").status_code == 404                                                                      # not enrolled in this classroom
    assert world.client.get(URL, headers=world.h("S2")).status_code == 404
    assert world.q("select count(*) n from attempts where whiteboard is not null")[0]["n"] == 0


def test_board_is_frozen_once_the_attempt_is_submitted(world):
    _put(world)
    assert world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "x = 7"}, headers=world.h("S1")).status_code == 200
    r = _put(world, {"steps": ["too late"], "strokes": []})
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_open_attempt"
    assert world.client.get(URL, headers=world.h("S1")).json()["steps"] == BOARD["steps"]                                # still readable


def test_coach_receives_the_typed_steps_as_part_of_the_students_work(world):
    _put(world)
    assert world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "check my steps"}, headers=world.h("S1")).status_code == 200
    kw = [c[1] for c in world.ai.calls if c[0] == "coach"][-1]
    assert "x = 12 - 5" in kw["attempt_text"] and "thinking space" in kw["attempt_text"]
    assert world.q("select payload from learning_events where event_type='AI_INTERACTION'")[0]["payload"]["whiteboard_steps"] == 3


def test_coach_gets_nothing_extra_when_the_board_is_empty(world):
    assert world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "hi"}, headers=world.h("S1")).status_code == 200
    kw = [c[1] for c in world.ai.calls if c[0] == "coach"][-1]
    assert "whiteboard" not in kw["attempt_text"].lower()
    assert world.q("select payload from learning_events where event_type='AI_INTERACTION'")[0]["payload"]["whiteboard_steps"] == 0


def test_real_coach_prompt_contains_the_whiteboard_steps(real):  # noqa: F811
    real.client.put(URL, json=BOARD, headers=real.h("S1"))
    assert real.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "is my reasoning right?"}, headers=real.h("S1")).status_code == 200
    assert any("x = 12 - 5" in p for p in real.state["prompts"])


def test_teacher_sees_the_board_read_only_in_the_submission_review(world):
    _put(world)
    r = world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P1")).json()
    assert r["whiteboard"]["steps"] == BOARD["steps"] and r["whiteboard"]["strokes"] == BOARD["strokes"]
    assert world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P2")).status_code == 404       # other instructor
