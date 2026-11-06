"""Instructor grading: ONE persisted grade on submissions, read identically by the teacher review, the student view and the dashboard."""
from __future__ import annotations

from .helpers import API
from .test_flows import _run_student_journey

GRADE = f"{API}/teacher/assignments/A1/students/S1/grade"


def _put(w, who="P1", **body):
    body = {"score": 8, "max_score": 10, "feedback": "Good reasoning on the update rule.", **body}
    return w.client.put(GRADE, json=body, headers=w.h(who))


def _student_view(w):
    return w.client.get(f"{API}/student/assignments/A1", headers=w.h("S1")).json()


def _review(w):
    return w.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=w.h("P1")).json()


def test_cannot_grade_before_submission(world):
    r = _put(world)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_submitted"
    assert world.q("select count(*) n from submissions where score is not null")[0]["n"] == 0


def test_grade_is_persisted_once_and_teacher_and_student_see_the_same_values(world):
    _run_student_journey(world)
    assert _student_view(world)["grade"] is None and _review(world)["grade"] is None            # no invented grades
    r = _put(world)
    assert r.status_code == 200, r.text
    g = r.json()["grade"]
    assert g["score"] == 8 and g["max_score"] == 10 and g["percentage"] == 80.0 and g["feedback"].startswith("Good reasoning") and g["graded_at"]
    row = world.q("select score, max_score, feedback, graded_by from submissions")[0]
    assert float(row["score"]) == 8 and float(row["max_score"]) == 10 and row["graded_by"] == "P1"
    assert _student_view(world)["grade"] == _review(world)["grade"] == g                          # one source of truth, one serialisation


def test_regrading_overwrites_and_clearing_removes_everything(world):
    _run_student_journey(world)
    _put(world)
    _put(world, score=10, max_score=10, feedback=None)
    assert _student_view(world)["grade"]["percentage"] == 100.0 and _student_view(world)["grade"]["feedback"] is None
    assert world.client.delete(GRADE, headers=world.h("P1")).json() == {"grade": None}
    row = world.q("select score, max_score, feedback, graded_at, graded_by from submissions")[0]
    assert all(v is None for v in row.values())
    assert _student_view(world)["grade"] is None


def test_invalid_grades_are_rejected_by_api_and_database(world):
    _run_student_journey(world)
    assert _put(world, score=11, max_score=10).status_code == 422
    assert _put(world, score=-1).status_code == 422
    assert _put(world, max_score=0).status_code == 422
    assert world.client.put(GRADE, json={"score": 5}, headers=world.h("P1")).status_code == 422
    assert world.client.put(GRADE, json={"score": 5, "max_score": 10, "graded_by": "P2"}, headers=world.h("P1")).status_code == 422   # client cannot choose the grader
    assert world.q("select count(*) n from submissions where score is not null")[0]["n"] == 0
    import psycopg
    import pytest
    with pytest.raises(psycopg.errors.CheckViolation):                                              # the database enforces it independently of the API
        world.x("update submissions set score=5")                                                    # a score without a scale
    with pytest.raises(psycopg.errors.CheckViolation):
        world.x("update submissions set score=11, max_score=10, graded_at=now()")


def test_only_the_classrooms_instructor_can_grade(world):
    _run_student_journey(world)
    assert world.client.put(GRADE, json={"score": 1, "max_score": 2}, headers=world.h("S1")).status_code == 403      # students cannot grade themselves
    assert world.client.put(GRADE, json={"score": 1, "max_score": 2}).status_code == 401
    for who in ("P2", "P3"):                                                                        # other instructor, other university
        assert _put(world, who=who).status_code == 404
        assert world.client.delete(GRADE, headers=world.h(who)).status_code == 404
    assert world.q("select count(*) n from submissions where score is not null")[0]["n"] == 0


def test_a_student_only_ever_sees_their_own_grade(world):
    _run_student_journey(world)
    _put(world)
    assert world.client.get(f"{API}/student/assignments/A1", headers=world.h("S2")).status_code == 404     # not enrolled in this classroom


def test_dashboard_average_is_the_mean_percentage_of_real_grades(world):
    d = world.client.get(f"{API}/teacher/courses/C1/dashboard", headers=world.h("P1")).json()
    assert d["metrics"]["average_grade"] is None                                                    # nothing graded: empty state, not 0
    _run_student_journey(world)
    _put(world, score=45, max_score=60)                                                             # 75 % on a 60-point scale
    d = world.client.get(f"{API}/teacher/courses/C1/dashboard", headers=world.h("P1")).json()
    assert d["metrics"]["average_grade"] == 75
    world.client.delete(GRADE, headers=world.h("P1"))
    assert world.client.get(f"{API}/teacher/courses/C1/dashboard", headers=world.h("P1")).json()["metrics"]["average_grade"] is None
