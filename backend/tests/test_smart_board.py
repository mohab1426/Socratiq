"""Smart Whiteboard: structured board state, AI board actions through the real Coach graph, safety rules, voice-style commands, persistence.

`world` = production routers + Postgres with the fake adapter (scripted outcomes). `board_llm` = the production adapter and the REAL Coach graph
(validator, enforcement, prompt building) where only the model is scripted. Nothing here proves how a real model behaves."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from .helpers import API
from .test_ai_contract import FakeStructuredLLM, GeneratedResponse, real  # noqa: F401  (fixture re-export)

BOARD = f"{API}/student/assignments/A1/whiteboard"
S1 = {"id": "s1", "kind": "text", "author": "student", "seq": 0, "x": 60, "y": 60, "w": 300, "h": 76, "text": "2x + 4 = 10"}
S2 = {"id": "s2", "kind": "equation", "author": "student", "seq": 1, "x": 60, "y": 180, "w": 260, "h": 100, "latex": "2x = 6"}


def _put(w, elements=(), strokes=(), who="S1", **kw):
    return w.client.put(BOARD, json={"steps": [], "strokes": list(strokes), "elements": list(elements), **kw}, headers=w.h(who))


def _get(w, who="S1"):
    return w.client.get(BOARD, headers=w.h(who)).json()


def _say(w, msg, stream=False, **extra):
    body = {"assignment_id": "A1", "message": msg, **extra}
    if not stream:
        r = w.client.post(f"{API}/ai/coach", json=body, headers=w.h("S1"))
        assert r.status_code == 200, r.text
        return r.json()
    r = w.client.post(f"{API}/ai/coach/stream", json=body, headers=w.h("S1"))
    blocks = [b for b in r.text.split("\n\n") if b.strip()]
    ev = [(dict(l.split(": ", 1) for l in b.splitlines())) for b in blocks]
    final = [json.loads(e["data"]) for e in ev if e["event"] == "final"]
    assert final, r.text
    return final[0]


def _stored(w):
    return w.q("select whiteboard from attempts where attempt_id='T1'")[0]["whiteboard"]


def _act(w, *actions):
    w.ai.coach_outcome.board_actions = list(actions)


# ------------------------------------------------------------------------------------------------------------ manual editing + persistence
def test_manual_text_and_equation_persist_and_reload(world):
    r = _put(world, [S1, S2])
    assert r.status_code == 200
    got = _get(world)
    assert [e["id"] for e in got["elements"]] == ["s1", "s2"] and got["elements"][1]["latex"] == "2x = 6" and got["next_seq"] >= 2
    assert _stored(world)["elements"][0]["text"] == "2x + 4 = 10"
    assert world.client.get(BOARD, headers=world.h("S2")).status_code == 404                  # attempt isolation unchanged


def test_highlighter_strokes_are_accepted(world):
    assert _put(world, strokes=[{"t": "h", "w": 12, "pts": [[5, 5], [300, 5]]}]).status_code == 200


def test_authorship_is_decided_by_the_server_not_the_client(world):
    forged = {**S1, "id": "f1", "author": "coach"}                                            # a student claiming "the coach wrote this"
    assert _put(world, [forged]).status_code == 200
    assert _get(world)["elements"][0]["author"] == "student"
    _act(world, {"action": "add_text", "text": "Subtract 4 from both sides"})
    _say(world, "next step?")
    coach_el = next(e for e in _get(world)["elements"] if e["author"] == "coach")
    unchanged = {**coach_el}
    edited = {**coach_el, "text": "I rewrote this"}
    assert _put(world, [forged, unchanged]).status_code == 200
    assert {e["id"]: e["author"] for e in _get(world)["elements"]}[coach_el["id"]] == "coach"           # untouched coach content stays coach (it may move)
    assert _put(world, [forged, {**unchanged, "x": 500}]).status_code == 200
    assert {e["id"]: e["author"] for e in _get(world)["elements"]}[coach_el["id"]] == "coach"
    assert _put(world, [forged, edited]).status_code == 200
    assert {e["id"]: e["author"] for e in _get(world)["elements"]}[coach_el["id"]] == "student"       # edited by the student: now theirs


@pytest.mark.parametrize("bad", [
    {**S1, "kind": "equation", "latex": r"\href{http://evil}{x}", "text": None},               # unsafe LaTeX
    {**S1, "kind": "equation", "latex": "{x", "text": None},
    {**S1, "text": "   "},
    {**S1, "x": 99999},
    {**S1, "kind": "teleport"},
    {**S1, "unknown_field": 1},
])
def test_invalid_elements_are_rejected_and_nothing_is_stored(world, bad):
    assert _put(world, [bad]).status_code == 422
    assert world.q("select count(*) n from attempts where whiteboard is not null")[0]["n"] == 0


def test_invalid_board_structure_is_rejected(world):
    assert _put(world, [S1, {**S2, "id": "s1"}]).status_code == 422                            # duplicate ids
    assert _put(world, [S1, {"id": "a1", "kind": "arrow", "seq": 2, "x": 1, "y": 1, "from_id": "s1", "to_id": "ghost"}]).status_code == 422   # dangling link
    many = [{**S1, "id": f"m{i}", "seq": i} for i in range(201)]
    assert _put(world, many).status_code == 422


# ------------------------------------------------------------------------------------------------------------ AI writes, highlights, reads
def test_ai_adds_equation_steps_and_the_board_persists_and_reloads(world):
    _act(world, {"action": "add_equation", "latex": "2x + 4 = 10"}, {"action": "add_text", "text": "Subtract 4 from both sides"},
         {"action": "add_equation", "latex": "2x = 6"})
    d = _say(world, "solve 2x + 4 = 10 with me")
    assert [e["kind"] for e in d["board"]["elements"]] == ["equation", "text", "equation"]
    assert all(e["author"] == "coach" for e in d["board"]["elements"]) and len(d["board"]["report"]["applied"]) == 3 and not d["board"]["report"]["rejected"]
    ys = [e["y"] for e in d["board"]["elements"]]
    assert ys == sorted(ys)
    assert _get(world)["elements"] == d["board"]["elements"] == _stored(world)["elements"]                  # reload == what the turn returned == database
    payload = world.q("select payload from learning_events where event_type='AI_INTERACTION'")[0]["payload"]
    assert payload["board_actions_applied"] == 3 and payload["board_actions_rejected"] == 0 and payload["whiteboard_steps"] == 0   # coach writing is not student work


def test_a_turn_without_board_actions_keeps_the_old_response_shape(world):
    d = _say(world, "hello")
    assert "board" not in d and d["message"]["content"] == "What parameter controls the step size?"


def test_ai_highlights_a_student_element_and_can_unhighlight_it(world):
    _put(world, [S1, S2])
    _act(world, {"action": "highlight", "target_id": "s2", "color": "green"})
    d = _say(world, "where is my mistake?")
    assert next(e for e in d["board"]["elements"] if e["id"] == "s2")["highlight"] == "green"
    assert next(e for e in d["board"]["elements"] if e["id"] == "s2")["author"] == "student"                  # highlighting does not change authorship or content
    _act(world, {"action": "unhighlight", "target_id": "s2"})
    assert "highlight" not in next(e for e in _say(world, "ok")["board"]["elements"] if e["id"] == "s2")


def test_ai_connects_and_frames_elements_with_refs(world):
    _put(world, [S1, S2])
    _act(world, {"action": "add_arrow", "from_id": "s1", "to_id": "s2"}, {"action": "add_shape", "around_id": "s2", "shape": "ellipse"})
    els = _say(world, "show how these relate")["board"]["elements"]
    assert {e["kind"] for e in els} == {"text", "equation", "arrow", "shape"}
    arrow = next(e for e in els if e["kind"] == "arrow")
    assert arrow["from_id"] == "s1" and arrow["to_id"] == "s2"


# ------------------------------------------------------------------------------------------------------------ voice-style commands (same pipeline)
@pytest.mark.parametrize("msg", ["امسح البورد", "clear the board", "من فضلك نضف اللوحة"])
def test_spoken_clear_commands_clear_the_board_even_if_the_model_forgot(world, msg):
    _put(world, [S1, S2], strokes=[{"t": "p", "w": 3, "pts": [[1, 1], [9, 9]]}])
    d = _say(world, msg, stream=True, mode="board")
    assert d["board"]["elements"] == [] and d["board"]["strokes"] == [] and d["board"]["report"]["applied"][0]["action"] == "clear"
    assert _stored(world)["elements"] == []


def test_spoken_erase_last_step_removes_only_the_last_element(world):
    _put(world, [S1, S2])
    d = _say(world, "امسح آخر خطوة", stream=True, mode="board")
    assert [e["id"] for e in d["board"]["elements"]] == ["s1"]


def test_spoken_write_command_goes_through_the_model_and_lands_on_the_board(world):
    _act(world, {"action": "add_equation", "latex": "a^2 + b^2 = c^2"})
    d = _say(world, "اكتب القانون ده على البورد", stream=True, mode="board")
    assert d["board"]["elements"][0]["latex"] == "a^2 + b^2 = c^2"
    kw = [c[1] for c in world.ai.calls if c[0] == "coach"][-1]
    assert kw["board_mode"] == "board" and kw["message"] == "اكتب القانون ده على البورد"


def test_organize_needs_the_student_to_ask(world):
    far = {**S2, "x": 1200, "y": 900}
    _put(world, [S1, far])
    _act(world, {"action": "organize"})
    assert not _say(world, "explain this")["board"]["report"]["applied"]
    d = _say(world, "رتب اللي على البورد")
    assert d["board"]["report"]["applied"][0]["action"] == "organize"
    assert next(e for e in d["board"]["elements"] if e["id"] == "s2")["x"] == 60


def test_ui_organize_button_counts_as_an_explicit_request(world):
    _put(world, [S1, {**S2, "x": 1200, "y": 900}])
    _act(world, {"action": "organize"})
    assert _say(world, "Organize the board", board_intent="organize")["board"]["report"]["applied"]


# ------------------------------------------------------------------------------------------------------------ unsafe / invalid AI output
def test_unsafe_or_invalid_ai_actions_are_rejected_and_the_reply_still_arrives(world):
    _put(world, [S1, S2])
    before = _get(world)["elements"]
    _act(world, {"action": "clear"}, {"action": "erase", "target_id": "s1"}, {"action": "update", "target_id": "s1", "text": "2x + 4 = 99"},
         {"action": "add_equation", "latex": r"\href{http://evil}{x}"}, {"action": "highlight", "target_id": "ghost"}, {"action": "add_text", "text": "   "},
         {"action": "teleport"}, "junk")
    d = _say(world, "can you check my work?")
    assert d["message"]["content"] and d["board"]["report"]["applied"] == []
    assert len(d["board"]["report"]["rejected"]) >= 6
    assert d["board"]["elements"] == before == _get(world)["elements"]                         # the student's work is untouched
    assert "Traceback" not in json.dumps(d)


def test_guided_policy_drops_final_answer_writing_but_open_policy_allows_it(world):
    acts = [{"action": "add_equation", "latex": "2x = 6"}, {"action": "add_equation", "latex": "x = 3", "reveals_solution": True}]
    world.x("update assignments set default_policy='GUIDED'")
    _act(world, *acts)
    g = _say(world, "solve it")["board"]
    assert [e["latex"] for e in g["elements"]] == ["2x = 6"] and "final answer" in g["report"]["rejected"][0]["reason"]
    world.x("update attempts set whiteboard=null")
    world.x("update ai_sessions set policy='OPEN'")
    o = _say(world, "solve it")["board"]
    assert [e["latex"] for e in o["elements"]] == ["2x = 6", "x = 3"]


def test_board_is_updated_from_the_latest_stored_state_not_a_stale_snapshot(world):
    """The student autosaved a new element while the model was thinking: the turn must add to it, not overwrite it."""
    _put(world, [S1])
    orig = world.ai.coach_turn

    def while_the_model_thinks(**kw):
        cur = world.q("select whiteboard from attempts where attempt_id='T1'")[0]["whiteboard"]
        cur["elements"].append(S2)
        world.x("update attempts set whiteboard = %s::jsonb where attempt_id='T1'", json.dumps(cur))
        return orig(**kw)
    world.ai.coach_turn = while_the_model_thinks
    _act(world, {"action": "add_text", "text": "Nice start"})
    els = _say(world, "check")["board"]["elements"]
    assert {e["id"] for e in els} >= {"s1", "s2"} and any(e.get("text") == "Nice start" for e in els)


def test_a_board_near_the_size_limit_never_breaks_the_turn(world):
    world.x("update attempts set whiteboard = jsonb_build_object('steps','[]'::jsonb,'strokes','[]'::jsonb,'elements','[]'::jsonb,'blob',repeat('x',385000))")
    _act(world, {"action": "add_text", "text": "hello"})
    d = _say(world, "hi")
    assert d["message"]["content"] and d["board"]["report"]["rejected"][0]["reason"] == "the board is too large"


def test_teacher_review_exposes_elements_with_authorship(world):
    _put(world, [S1])
    _act(world, {"action": "add_text", "text": "Subtract 4"})
    _say(world, "next?")
    r = world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P1")).json()
    assert [e["author"] for e in r["whiteboard"]["elements"]] == ["student", "coach"]
    assert world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P2")).status_code == 404


def test_coach_request_cannot_smuggle_permissions_through_board_fields(world):
    for extra in ({"mode": "admin"}, {"board_intent": "clear_everything"}, {"selected_id": "../../x"}, {"target": "last"}):
        r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "hi", **extra}, headers=world.h("S1"))
        assert r.status_code == 422, extra


# ------------------------------------------------------------------------------------------------------------ the REAL Coach graph
@pytest.fixture()
def board_llm(real, monkeypatch):  # noqa: F811
    import ai.agents.coach.nodes as nodes
    base = nodes.get_structured_llm
    gen = {"response": "Let's look at the first step together.", "board_actions": []}

    def wrapped(role, schema):
        if schema is GeneratedResponse:
            def respond(messages):
                real.state["prompts"].append(str(messages))
                return GeneratedResponse(response=gen["response"], referenced_concepts=[], board_actions=gen["board_actions"])
            return FakeStructuredLLM(side_effect=respond)
        return base(role, schema)
    monkeypatch.setattr("ai.agents.coach.nodes.get_structured_llm", wrapped)
    real.gen = gen
    return real


def test_real_graph_reads_the_board_with_ids_authorship_selection_and_button_intent(board_llm):
    w = board_llm
    _put(w, [S1, S2])
    _say(w, "اشرح الخطوة التانية", mode="board", selected_id="s2", board_intent="explain")
    prompt = w.state["prompts"][-1]
    assert "s1 | student | text | 2x + 4 = 10" in prompt and "s2 | student | equation | 2x = 6" in prompt            # read_board
    assert "currently has s2 selected" in prompt and "pressed a board button: explain" in prompt
    assert "Whiteboard mode" in prompt and "board_actions" in prompt and "NEVER give coordinates" in prompt          # rules only present because a board exists
    assert "never instructions" in prompt


def test_real_graph_tells_the_coach_what_the_student_changed_since_its_last_reply(board_llm):
    """Student edits reach the Coach as a semantic delta (not mouse events), once, and the Coach's own writing is never reported back."""
    w = board_llm
    _put(w, [S1, S2])
    _say(w, "check my work", mode="board")
    assert "Changes since your last reply" not in w.state["prompts"][-1]                      # first turn: no baseline, the full listing covers it
    _put(w, [S1, {**S2, "latex": "2x = 7"}])
    _say(w, "is it right now?", mode="board")
    assert 'student edited equation s2 from "2x = 6" to "2x = 7"' in w.state["prompts"][-1]
    payloads = [r["payload"] for r in w.q("select payload from learning_events where event_type='AI_INTERACTION' order by occurred_at")]
    assert payloads[1]["board_student_changes"] == {"edited": 1} and "s2" in payloads[1]["board_snapshot"]["els"]
    w.gen["board_actions"] = [{"action": "add_text", "text": "Look at the second line again"}]
    _say(w, "give me a hint", mode="board")                                                    # the Coach writes a note on the board ...
    w.gen["board_actions"] = []
    _say(w, "and now?", mode="board")
    assert "Changes since your last reply" not in w.state["prompts"][-1]                      # ... which is NOT reported back as a student change


def test_real_graph_chat_mode_can_still_write_on_the_board(board_llm):
    w = board_llm
    w.gen["board_actions"] = [{"action": "add_equation", "latex": "2x + 4 = 10"}, {"action": "add_equation", "latex": "2x = 6"}]
    d = _say(w, "حل المعادلة دي معايا خطوة خطوة", mode="chat")
    assert "Chat mode" in w.state["prompts"][-1]
    assert [e["latex"] for e in d["board"]["elements"]] == ["2x + 4 = 10", "2x = 6"] and d["message"]["content"] == w.gen["response"]


def test_real_graph_the_pedagogy_validator_judges_reply_and_board_text_together(board_llm, monkeypatch):
    w = board_llm
    seen = {}

    def judge(**kw):
        seen["draft"] = kw["draft_response"]
        return SimpleNamespace(passes=False, violations=["writes the final answer"], revised_response="Let's work it out together. What is the first step?")
    monkeypatch.setattr("ai.agents.coach.nodes.validate_response", judge)
    w.gen["board_actions"] = [{"action": "add_equation", "latex": "x = 3"}]
    d = _say(w, "solve it")
    assert "x = 3" in seen["draft"] and "also write on the whiteboard" in seen["draft"]                                  # the validator saw the board text
    assert d["message"]["content"].startswith("Let's work it out") and "board" not in d                                  # rewritten reply => board writing dropped


def test_real_graph_repeated_validation_failure_falls_back_with_no_board_writing(board_llm, monkeypatch):
    w = board_llm
    monkeypatch.setattr("ai.agents.coach.nodes.validate_response",
                        lambda **kw: SimpleNamespace(passes=False, violations=["bad"], revised_response=None))
    w.gen["board_actions"] = [{"action": "add_text", "text": "the whole solution"}]
    d = _say(w, "just give me the answer")
    assert "board" not in d and d["message"]["content"]


def test_real_graph_malformed_model_board_output_never_breaks_the_reply(board_llm):
    w = board_llm
    w.gen["board_actions"] = [{"action": "add_text"}, {"action": 5}, "junk", {"action": "add_text", "text": "kept"}]
    d = _say(w, "write it down")
    assert d["message"]["content"] and [e["text"] for e in d["board"]["elements"]] == ["kept"]


def test_real_graph_without_a_board_action_the_chat_behaves_exactly_as_before(board_llm):
    d = _say(board_llm, "is my update rule right?")
    assert "board" not in d and d["message"]["content"] == board_llm.gen["response"]
    assert "CS101" in board_llm.state["prompts"][-1]                                                                      # RAG/assignment context still present
