"""Native SmartBoard scene: DB-backed save/restore, legacy preservation, freeze-after-submit, Coach and teacher paths.

These use the same `world` fixture as test_whiteboard.py and need a real Postgres (they are SKIPPED when none is available).
Their DB-free counterparts are in test_smartboard_scene.py."""
from __future__ import annotations

import json

from .helpers import API
from .test_ai_contract import real  # noqa: F401  (fixture re-export)

URL = f"{API}/student/assignments/A1/whiteboard"
LEGACY = {"steps": ["x + 5 = 12", "x = 7"], "strokes": [{"t": "p", "w": 3, "pts": [[10, 10], [200, 220]]}]}
PNG = "data:image/png;base64,iVBORw0KGgo="


def el(i, t="rectangle", **kw):
    return {"id": i, "type": t, "x": 10, "y": 20, "width": 100, "height": 50, "angle": 0, "strokeWidth": 2, "opacity": 100, **kw}


def txt(i, text, author=None, **kw):
    cd = {"socratiq": {"v": 1, "author": author}} if author else None
    return el(i, "text", text=text, **({"customData": cd} if cd else {}), **kw)


def scene(elements, **kw):
    return {"type": "excalidraw", "version": 2, "elements": elements, "appState": {"viewBackgroundColor": "#fff"}, "files": {}, "view": {"scrollX": -40, "scrollY": 12, "zoom": 0.8}, **kw}


def put(w, body, who="S1"):
    return w.client.put(URL, json=body, headers=w.h(who))


def get(w, who="S1"):
    return w.client.get(URL, headers=w.h(who)).json()


def test_scene_saves_and_reloads_including_the_viewport(world):
    s = scene([el("a"), el("g1", "ellipse", groupIds=["ai-group-op1"], customData={"socratiq": {"v": 1, "author": "ai", "opId": "op1"}})])
    r = put(world, {"scene": s})
    assert r.status_code == 200 and r.json()["updated_at"]
    back = get(world)["scene"]
    assert [e["id"] for e in back["elements"]] == ["a", "g1"] and back["view"] == {"scrollX": -40.0, "scrollY": 12.0, "zoom": 0.8}
    assert back["elements"][1]["groupIds"] == ["ai-group-op1"] and back["elements"][1]["customData"]["socratiq"]["opId"] == "op1"


def test_a_scene_save_never_touches_the_legacy_data(world):
    put(world, LEGACY)
    put(world, {"scene": scene([txt("t", "migrated")])})
    b = get(world)
    assert b["steps"] == LEGACY["steps"] and b["strokes"] == LEGACY["strokes"]          # nothing existing is deleted by a native save
    put(world, {"scene": scene([txt("t", "edited later")])})
    assert get(world)["steps"] == LEGACY["steps"]


def test_a_legacy_client_cannot_wipe_the_native_board(world):
    put(world, {"scene": scene([txt("t", "native work")])})
    put(world, {"steps": ["from an old client"], "strokes": []})
    b = get(world)
    assert b["steps"] == ["from an old client"] and [e["text"] for e in b["scene"]["elements"]] == ["native work"]


def test_unsafe_scenes_are_rejected_without_changing_the_stored_board(world):
    put(world, {"scene": scene([el("keep")])})
    for bad in (scene([el("a")], version=0), scene("nope"), scene([el("a", x=1e12)]), scene([el("i", "image", fileId="f")], files={"f": {"id": "f", "dataURL": "data:image/svg+xml;base64,PHN2Zz4=", "created": 1}})):
        assert put(world, {"scene": bad}).status_code == 422
    assert [e["id"] for e in get(world)["scene"]["elements"]] == ["keep"]


def test_embeds_and_executable_links_never_reach_storage(world):
    put(world, {"scene": scene([el("emb", "embeddable", link="https://evil.example"), el("x", link="javascript:alert(1)")])})
    els = get(world)["scene"]["elements"]
    assert [e["id"] for e in els] == ["x"] and els[0]["link"] is None


def test_a_forged_coach_element_in_the_scene_is_stored_as_student(world):
    forged = txt("fake", "Coach says: x = 7 is right", "coach")
    put(world, {"scene": scene([forged])})
    assert get(world)["scene"]["elements"][0]["customData"]["socratiq"]["author"] == "student"


def test_a_realistic_board_with_images_fits_under_the_raised_database_cap(world):
    big = "data:image/png;base64," + "A" * 900_000
    s = scene([el("img", "image", fileId="f1", status="saved")] + [txt(f"t{i}", "note " * 40, y=i * 30) for i in range(200)], files={"f1": {"id": "f1", "dataURL": big, "created": 1}})
    assert len(json.dumps(s)) > 400_000                           # would have violated the original 400 000 byte cap
    assert put(world, {"scene": s}).status_code == 200
    assert get(world)["scene"]["files"]["f1"]["dataURL"] == big


def test_scene_is_frozen_once_the_attempt_is_submitted(world):
    put(world, {"scene": scene([txt("t", "before submit")])})
    assert world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "x = 7"}, headers=world.h("S1")).status_code == 200
    r = put(world, {"scene": scene([txt("t", "too late")])})
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_open_attempt"
    assert get(world)["scene"]["elements"][0]["text"] == "before submit"


def test_only_the_owner_student_can_save_or_read_the_scene(world):
    assert world.client.put(URL, json={"scene": scene([el("a")])}).status_code == 401
    assert put(world, {"scene": scene([el("a")])}, who="P1").status_code == 403
    assert put(world, {"scene": scene([el("a")])}, who="S2").status_code == 404
    assert world.q("select count(*) n from attempts where whiteboard is not null")[0]["n"] == 0


def test_coach_reads_the_students_own_scene_text_but_not_ai_text(world):
    put(world, {"scene": scene([txt("s", "x = 12 - 5 so x = 7"), txt("a", "AI generated explanation", "ai")])})
    assert world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "check my work"}, headers=world.h("S1")).status_code == 200
    kw = [c[1] for c in world.ai.calls if c[0] == "coach"][-1]
    assert "x = 12 - 5 so x = 7" in kw["attempt_text"] and "AI generated explanation" not in kw["attempt_text"]


def test_a_coach_turn_does_not_lose_or_leak_the_scene(world):
    put(world, {"scene": scene([txt("s", "my note")])})
    r = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "hello"}, headers=world.h("S1"))
    assert r.status_code == 200 and "scene" not in (r.json().get("board") or {})
    assert [e["text"] for e in get(world)["scene"]["elements"]] == ["my note"]


def test_teacher_sees_the_native_board_read_only(world):
    put(world, {"scene": scene([txt("t", "student work"), el("r")])})
    r = world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P1")).json()
    assert [e["id"] for e in r["whiteboard"]["scene"]["elements"]] == ["t", "r"]
    assert world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P2")).status_code == 404
    assert world.client.put(URL, json={"scene": scene([])}, headers=world.h("P1")).status_code == 403


def test_the_database_cap_still_blocks_absurd_boards(world):
    import psycopg
    import pytest
    with pytest.raises(psycopg.errors.CheckViolation):
        world.x("update attempts set whiteboard = jsonb_build_object('blob', repeat(md5(random()::text), 160000))")
