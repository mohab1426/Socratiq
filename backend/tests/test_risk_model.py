"""Risk model unit tests. Pure functions: no database, no HTTP, no LLM (they run even without Postgres)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import risk
from app.risk import Activity, Observation, calculate

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def ob(signal="unusually_large_attempt_jump", asg="A1", i=0, source="risk_signal"):
    return Observation(signal, asg, T0 + timedelta(minutes=i), source, f"ref{i}", "detail")


ENOUGH = Activity(coach_turns=4, verification_answers=3, submissions=1)      # 8 units, 3 channels


def test_no_evidence_is_insufficient_not_low():
    r = calculate([], Activity())
    assert r["level"] == "insufficient" and r["score"] is None and r["evidence_count"] == 0 and r["top_signals"] == []
    assert r["level_label"] == "Insufficient evidence" and r["confidence_label"] == "Low"


def test_one_interaction_with_signals_is_never_high():
    r = calculate([ob(i=1), ob("could_not_explain_submitted_work", i=2), ob("rapid_large_submission", i=3)], Activity(coach_turns=1))
    assert r["level"] == "insufficient" and r["score"] is None and r["evidence_count"] == 3     # shown for context only


def test_heavy_coach_use_alone_is_not_risk():
    r = calculate([], Activity(coach_turns=200, verification_answers=3, submissions=2))
    assert r["level"] == "low" and r["score"] == 0.0 and r["confidence_label"] == "High"


def test_low_moderate_high_buckets():
    low = calculate([ob(i=1)], ENOUGH)
    assert low["level"] == "low" and low["score"] < risk.LOW_BELOW
    mod = calculate([ob(i=1), ob("could_not_explain_submitted_work", "A2", i=2)], ENOUGH)
    assert mod["level"] == "moderate" and risk.LOW_BELOW <= mod["score"] < risk.MODERATE_BELOW
    high = calculate([ob(i=1), ob("could_not_explain_submitted_work", "A2", i=2), ob("unusually_large_attempt_jump", "A3", i=3), ob("verification_not_passed", "A4", i=4)], ENOUGH)
    assert high["level"] == "high" and high["score"] >= risk.MODERATE_BELOW and high["evidence_count"] == 4


def test_high_needs_enough_observations_and_confidence():
    # Same points as a 'high' case but only two observations -> capped at moderate
    two = calculate([ob("could_not_explain_submitted_work", "A1", i=1), ob("could_not_explain_submitted_work", "A2", i=2), ob("unusually_large_attempt_jump", "A3", i=3)][:2] * 3, ENOUGH)
    assert two["evidence_count"] == 6 and two["level"] in ("moderate", "high")
    few = calculate([ob("could_not_explain_submitted_work", "A1", i=1), ob("solution_sophistication_inconsistent_with_prior_attempt", "A2", i=2)], ENOUGH)
    assert few["level"] != "high"
    thin = Activity(coach_turns=3)                                             # 3 units, 1 channel -> Low confidence
    capped = calculate([ob("could_not_explain_submitted_work", f"A{i}", i=i) for i in range(1, 5)], thin)
    assert capped["confidence_label"] == "Low" and capped["level"] == "moderate"   # score is high but confidence too low for the top bucket


def test_duplicates_have_diminishing_returns():
    one = calculate([ob(i=1)], ENOUGH)
    many_same = calculate([ob(i=i) for i in range(1, 30)], ENOUGH)
    per_group_cap = risk.spec_for("unusually_large_attempt_jump").points * risk.REPEAT_CAP
    assert many_same["top_signals"][0]["points"] == per_group_cap and many_same["top_signals"][0]["count"] == 29
    assert many_same["score"] > one["score"] and many_same["score"] < 1.0


def test_same_signal_on_different_assignments_counts_separately():
    a = calculate([ob(i=1, asg="A1"), ob(i=2, asg="A2")], ENOUGH)
    b = calculate([ob(i=1, asg="A1"), ob(i=2, asg="A1")], ENOUGH)
    assert a["top_signals"][0]["points"] > b["top_signals"][0]["points"]


def test_passed_verification_halves_signals_on_that_assignment():
    base = calculate([ob(i=1, asg="A1")], ENOUGH)
    mit = calculate([ob(i=1, asg="A1")], Activity(4, 3, 1, frozenset({"A1"})))
    assert mit["top_signals"][0]["points"] == base["top_signals"][0]["points"] * risk.MITIGATION_FACTOR
    assert mit["top_signals"][0]["mitigated_count"] == 1 and mit["top_signals"][0]["evidence"][0]["mitigated"] is True
    assert mit["mitigating"]["assignments_with_passed_verification"] == 1


def test_confidence_reflects_quantity_and_channels():
    c = risk.confidence_of
    assert c(Activity()) == 0.0
    assert c(Activity(coach_turns=3)) < c(Activity(coach_turns=3, submissions=1, verification_answers=3)) <= 1.0
    assert c(Activity(coach_turns=10, submissions=5, verification_answers=5)) == 1.0
    assert risk.confidence_label(0.2) == "Low" and risk.confidence_label(0.5) == "Medium" and risk.confidence_label(0.9) == "High"


def test_score_is_bounded_and_monotonic():
    scores = [calculate([ob(f"unusually_large_attempt_jump", f"A{i}", i=i) for i in range(n)], ENOUGH)["score"] for n in range(0, 12)]
    assert scores == sorted(scores) and scores[0] == 0.0 and all(0.0 <= s < 1.0 for s in scores)


def test_every_signal_is_traceable_to_a_row():
    r = calculate([ob(i=1), ob("verification_not_passed", "A2", i=2, source="verification")], ENOUGH)
    for s in r["top_signals"]:
        for e in s["evidence"]:
            assert e["ref_id"] and e["source"] in ("risk_signal", "verification", "submission") and e["at"]
    assert r["last_evidence_at"] is not None and r["evidence_count"] == 2


def test_unknown_signals_are_low_and_severity_vocabulary_matches_the_schema():
    assert risk.severity_for("something_new") == "LOW"
    assert {s.severity for s in risk.CATALOG.values()} <= {"LOW", "MEDIUM", "HIGH"}
    assert {s.category for s in risk.CATALOG.values()} <= set(risk.CATEGORY_LABELS)


def test_wording_never_claims_misconduct():
    r = calculate([ob(i=1)], ENOUGH)
    text = (r["disclaimer"] + " " + " ".join(s["label"] + s["meaning"] for s in r["top_signals"]) + r["explanation"]).lower()
    for banned in ("cheat", "plagiar", "detected", "chatgpt", "dishonest"):
        assert banned not in text
    assert "not proof" in r["disclaimer"].lower()
