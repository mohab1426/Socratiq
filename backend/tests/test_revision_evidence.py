"""REVISION evidence: one event per Coach turn, only when the student materially changed the work the Coach replied to."""
from __future__ import annotations

from .helpers import API

DRAFT1 = "theta = theta - grad"
DRAFT2 = "theta = theta - learning_rate * gradient  # scale the step so it cannot overshoot the minimum"


def _save(w, text, who="S1"):
    r = w.client.patch(f"{API}/student/attempts/T1", json={"draft_text": text}, headers=w.h(who))
    assert r.status_code == 200, r.text


def _coach(w, msg="is this right?"):
    assert w.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": msg}, headers=w.h("S1")).status_code == 200


def _revisions(w):
    return w.q("select interaction_id, payload from learning_events where event_type='REVISION' order by occurred_at")


def test_no_revision_without_a_prior_coach_turn(world):
    _save(world, DRAFT1)
    _save(world, DRAFT2)
    assert _revisions(world) == []                                        # drafting alone is not evidence of learning from feedback


def test_tiny_edits_are_not_revisions(world):
    _save(world, DRAFT2)
    _coach(world)
    _save(world, DRAFT2 + " ")
    _save(world, DRAFT2.replace("minimum", "minima"))                      # a few characters
    assert _revisions(world) == []


def test_material_change_after_a_coach_turn_records_exactly_one_revision_tied_to_that_turn(world):
    _save(world, DRAFT1)
    _coach(world)
    iid = world.q("select interaction_id from ai_interactions")[0]["interaction_id"]
    _save(world, DRAFT2)
    _save(world, DRAFT2 + "\n# and a comment")                             # further autosaves for the same turn add nothing
    rows = _revisions(world)
    assert len(rows) == 1 and rows[0]["interaction_id"] == iid
    p = rows[0]["payload"]
    assert p["after_intervention"] and 0 <= p["similarity"] < 0.95 and p["chars_before"] == len(DRAFT1) and p["chars_after"] == len(DRAFT2)
    assert world.q("select count(*) n from learning_events where event_type='REVISION' and student_id='S1' and assignment_id='A1' and attempt_id='T1'")[0]["n"] == 1


def test_each_coach_turn_can_prompt_its_own_revision(world):
    _save(world, DRAFT1); _coach(world); _save(world, DRAFT2)
    _coach(world, "and now?")
    _save(world, "def step(theta, grad, lr):\n    return theta - lr * grad   # extracted into a function after the second hint")
    assert len(_revisions(world)) == 2
    assert len({r["interaction_id"] for r in _revisions(world)}) == 2


def test_teacher_sees_the_revision_in_the_students_evidence_timeline(world):
    _save(world, DRAFT1); _coach(world); _save(world, DRAFT2)
    sd = world.client.get(f"{API}/teacher/students/S1", headers=world.h("P1")).json()
    assert any(t["kind"] == "revision" and t["label"] == "Revised work" for t in sd["timeline"])


def test_students_cannot_write_revisions_for_each_other(world):
    _save(world, DRAFT1); _coach(world)
    r = world.client.patch(f"{API}/student/attempts/T1", json={"draft_text": DRAFT2}, headers=world.h("S2"))
    assert r.status_code == 404 and _revisions(world) == []
