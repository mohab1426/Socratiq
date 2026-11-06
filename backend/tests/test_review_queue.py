"""Needs Review rows must say WHO, WHY, how much evidence, and WHERE to look (the assignment behind the strongest signal)."""
from __future__ import annotations

from app.analytics import _top_signal_assignment, review_queue


def _risk(level, *, signals=(), score=0.6):
    return {"level": level, "level_label": level.title(), "score": score, "confidence_label": "Medium", "evidence_count": sum(len(s["evidence"]) for s in signals),
            "primary_reason": signals[0]["label"] if signals else None, "focus": "work_pattern" if signals else None, "top_signals": list(signals)}


def _sig(label, *evidence_assignments):
    return {"label": label, "evidence": [{"assignment_id": a} for a in evidence_assignments]}


STUDENTS = [{"id": "s1", "name": "Ada", "mastery": "Strong"}, {"id": "s2", "name": "Ben", "mastery": "Weak"}, {"id": "s3", "name": "Cy", "mastery": "Strong"}]


def test_risk_rows_carry_the_assignment_behind_the_strongest_signal_and_its_title():
    risks = {"s1": _risk("moderate", signals=[_sig("Unusually large attempt jump", None, "A2", "A1")]), "s2": _risk("insufficient"), "s3": _risk("low")}
    rows = review_queue(STUDENTS, risks, {}, {"A1": "Gradient descent", "A2": "Backprop"})
    risk_row = next(r for r in rows if r["kind"] == "risk_review")
    assert risk_row["student_id"] == "s1" and risk_row["assignment_id"] == "A2" and risk_row["assignment_title"] == "Backprop"        # newest evidence WITH an assignment
    assert risk_row["primary_reason"] and risk_row["evidence_count"] == 3


def test_learning_support_rows_are_separate_and_make_no_ai_claim():
    risks = {"s1": _risk("low"), "s2": _risk("insufficient"), "s3": _risk("low")}
    rows = review_queue(STUDENTS, risks, {}, {})
    assert [(r["student_id"], r["kind"]) for r in rows] == [("s2", "learning_support")]
    assert rows[0]["assignment_id"] is None and "AI" not in rows[0]["primary_reason"]


def test_unknown_assignment_title_degrades_to_none_not_a_crash():
    risks = {"s1": _risk("high", signals=[_sig("x", "GONE")]), "s2": _risk("low"), "s3": _risk("low")}
    row = review_queue(STUDENTS, risks, {}, {})[0]
    assert row["assignment_id"] == "GONE" and row["assignment_title"] is None
    assert _top_signal_assignment(_risk("low")) is None
