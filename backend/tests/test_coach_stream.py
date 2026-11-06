"""POST /ai/coach/stream: same coaching pipeline and persistence as /ai/coach, delivered as Server-Sent Events.

Real Postgres + real routers/authorisation. `world` uses the FakeAI adapter; `real` (from test_ai_contract) runs the production
adapter and the real Coach graph with only the LLM faked, so the stage events there are the graph's actual node names."""
from __future__ import annotations

import json

from .helpers import API
from .test_ai_contract import real  # noqa: F401  (fixture re-export)

URL = f"{API}/ai/coach/stream"


def _events(resp) -> list[tuple[str, dict]]:
    out = []
    for block in resp.text.split("\n\n"):
        if not block.strip():
            continue
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def _post(w, msg="is my update right?", who="S1", asg="A1"):
    return w.client.post(URL, json={"assignment_id": asg, "message": msg}, headers=w.h(who))


def test_stream_emits_stages_then_one_final_turn(world):
    r = _post(world)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"].startswith("no-cache") and r.headers["x-accel-buffering"] == "no"
    ev = _events(r)
    names = [n for n, _ in ev]
    assert names[0] == "stage" and names[-1] == "final" and names.count("final") == 1 and "error" not in names
    stages = [d["stage"] for n, d in ev if n == "stage"]
    assert stages[0] == "start" and "generate_response" in stages and all(d["label"] for n, d in ev if n == "stage")
    final = ev[-1][1]
    assert final["message"]["role"] == "coach" and final["message"]["content"] == "What parameter controls the step size?" and final["turn"] == 1


def test_reply_text_is_only_sent_in_the_final_event(world):
    ev = _events(_post(world))
    assert all("What parameter" not in json.dumps(d) for n, d in ev if n != "final")      # no partial / unvalidated text


def test_stream_persists_exactly_like_the_plain_endpoint(world):
    assert _post(world, "stream turn").status_code == 200
    assert world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "plain turn"}, headers=world.h("S1")).status_code == 200
    rows = world.q("select sender, content from messages order by created_at, message_id")
    assert [(r["sender"], r["content"]) for r in rows] == [("STUDENT", "stream turn"), ("COACH", "What parameter controls the step size?"),
                                                           ("STUDENT", "plain turn"), ("COACH", "What parameter controls the step size?")]
    assert world.q("select count(*) n from ai_interactions")[0]["n"] == 2
    assert world.q("select turn_count from ai_sessions")[0]["turn_count"] == 2
    assert world.q("select count(*) n from learning_events where event_type='AI_INTERACTION'")[0]["n"] == 2
    assert world.q("select count(*) n from evidence_candidates where student_id='S1'")[0]["n"] >= 2


def test_ai_failure_is_an_error_event_and_nothing_is_persisted(world):
    world.ai.fail = True
    r = _post(world)
    assert r.status_code == 200
    ev = _events(r)
    assert ev[-1][0] == "error" and ev[-1][1]["code"] == "ai_unavailable" and "final" not in [n for n, _ in ev]
    assert "Traceback" not in r.text
    assert world.q("select count(*) n from messages")[0]["n"] == 0 and world.q("select count(*) n from ai_interactions")[0]["n"] == 0
    world.ai.fail = False
    assert _events(_post(world))[-1][0] == "final"           # and the session is not left locked


def test_unexpected_exception_is_a_generic_error_event(world, monkeypatch):
    def boom(**kw):
        raise RuntimeError("secret internal detail")
        yield  # pragma: no cover
    monkeypatch.setattr(world.ai, "coach_turn_stream", boom)
    r = _post(world)
    ev = _events(r)
    assert ev[-1][0] == "error" and ev[-1][1]["code"] == "internal_error" and "secret internal detail" not in r.text


def test_state_and_authorisation_errors_are_normal_http_errors_before_streaming(world):
    assert world.client.post(URL, json={"assignment_id": "A1", "message": "x"}).status_code == 401
    assert _post(world, who="P1").status_code == 403                                  # instructors cannot use the student coach
    assert _post(world, who="S2").status_code == 404                                  # not enrolled in this classroom: indistinguishable from missing
    assert _post(world, asg="NOPE").status_code == 404
    assert world.client.post(URL, json={"assignment_id": "A1", "message": ""}, headers=world.h("S1")).status_code == 422
    assert world.client.post(URL, json={"assignment_id": "A1", "message": "x", "policy": "OPEN"}, headers=world.h("S1")).status_code == 422   # client cannot pick the policy
    world.x("update attempts set status='SUBMITTED' where attempt_id='T1'")
    r = _post(world)
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_open_attempt"
    assert not [c for c in world.ai.calls if c[0] == "coach"]                          # the AI was never invoked


def test_second_turn_while_one_is_running_is_refused_then_released(world):
    from app.routers import ai as ai_router
    sid = None
    real_claim = ai_router._claim_turn

    def claim_and_hold(session_id):
        nonlocal sid
        sid = session_id
        real_claim(session_id)
    ai_router._claim_turn = claim_and_hold
    try:
        assert _events(_post(world))[-1][0] == "final"
    finally:
        ai_router._claim_turn = real_claim
    assert sid and sid not in ai_router._inflight                                     # released after the turn
    ai_router._inflight[sid] = __import__("time").monotonic()                         # simulate a turn still running
    try:
        r = _post(world)
        assert r.status_code == 409 and "turn_in_progress" in r.text
    finally:
        ai_router._inflight.pop(sid, None)
    ai_router._inflight[sid] = __import__("time").monotonic() - ai_router._INFLIGHT_TTL_SECONDS - 1   # a leaked entry expires
    assert _events(_post(world))[-1][0] == "final"


def test_stream_rate_limit_is_shared_with_the_plain_endpoint(world):
    from app.config import get_backend_config
    limit = get_backend_config().ai_rate_limit_per_minute
    codes = [_post(world, f"m{i}").status_code for i in range(limit + 1)]
    assert codes[-1] == 429


def test_real_graph_streams_its_actual_nodes_and_persists_the_validated_reply(real):  # noqa: F811
    ev = _events(_post(real))
    stages = [d["stage"] for n, d in ev if n == "stage"]
    for node in ("understand_context", "diagnose", "choose_intervention", "retrieve_context", "generate_response", "validate", "emit_interaction"):
        assert node in stages, stages
    assert stages.index("diagnose") < stages.index("generate_response") < stages.index("validate")
    final = ev[-1]
    assert final[0] == "final" and final[1]["message"]["content"] == "What scales the size of each step?"
    assert real.q("select content from messages where sender='COACH'")[0]["content"] == "What scales the size of each step?"
    assert "Course:" in real.state["prompts"][-1] and "CS101" in real.state["prompts"][-1]       # the application context reached the model
