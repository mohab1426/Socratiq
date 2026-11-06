"""Data-utilisation regression tests: data the platform COLLECTS must actually REACH the AI (and the teacher views).

They run the production adapter, the real Coach graph and the real database; only the LLM is faked (see `real` in
test_ai_contract.py). Each test asserts on the text of the prompt that would be sent to the response model, i.e. on what the AI
really sees, not merely on what was fetched."""
from __future__ import annotations

from .helpers import API, sample, upload
from .test_ai_contract import coach, real  # noqa: F401  (fixture re-export)


def test_course_classroom_and_material_catalogue_reach_the_prompt(real):
    up = upload(real, "P1", "sample.txt", sample("sample.txt"), title="Gradient Descent Notes")
    assert up.status_code == 202, up.text
    real.drain()
    assert coach(real).status_code == 200
    t = real.calls[-1]["task_context"]
    assert (t.university_name, t.course_code, t.course_title, t.classroom_name) == ("Uni One", "CS101", "Intro", "A")
    assert t.materials_total == 1 and t.materials[0].title == "Gradient Descent Notes" and t.materials[0].searchable is True
    prompt = real.state["prompts"][-1]
    assert "Gradient Descent Notes" in prompt and "CS101" in prompt and "Uni One" in prompt
    assert "none uploaded yet" not in prompt        # the pre-fix behaviour: the model was told there were no materials


def test_empty_catalogue_is_reported_as_empty(real):
    coach(real)
    t = real.calls[-1]["task_context"]
    assert t.materials_total == 0 and t.materials == [] and t.attachments == []


def test_material_catalogue_is_classroom_scoped(real):
    upload(real, "P2", "sample.txt", sample("sample.txt"), course="C2", title="Other Course Secret Notes")     # another course, same university
    real.drain()
    coach(real)
    prompt = real.state["prompts"][-1]
    assert "Other Course Secret Notes" not in prompt and real.calls[-1]["task_context"].materials_total == 0


def test_instructor_declared_concepts_reach_the_prompt(real):
    real.x("insert into concepts (concept_id, university_id, name) values ('11111111-1111-1111-1111-111111111111','U1','Backpropagation')")
    real.x("insert into assignment_concepts (assignment_id, concept_id, university_id) values ('A1','11111111-1111-1111-1111-111111111111','U1')")
    coach(real)
    assert real.calls[-1]["task_context"].concepts == ["Backpropagation"]
    assert "Backpropagation" in real.state["prompts"][-1]


def test_verified_concept_mastery_reaches_the_coach_and_only_for_this_student(real):
    real.x("insert into concepts (concept_id, university_id, name) values ('22222222-2222-2222-2222-222222222222','U1','learning rate')")
    real.x("insert into student_concept_state (student_id, concept_id, mastery_estimate, confidence, evidence_count, university_id) "
           "values ('S1','22222222-2222-2222-2222-222222222222',0.30,0.8,3,'U1'), ('S2','22222222-2222-2222-2222-222222222222',0.95,0.9,4,'U1')")
    assert coach(real).status_code == 200
    prompt = real.state["prompts"][-1]
    assert "Verified mastery of 'learning rate': Weak" in prompt and "0.30" in prompt
    assert "0.95" not in prompt                                    # another student's state must never leak


def test_latest_verification_feedback_reaches_the_coach(real):
    real.x("insert into concepts (concept_id, university_id, name) values ('33333333-3333-3333-3333-333333333333','U1','learning rate')")
    real.x("insert into verification_runs (verification_id, student_id, assignment_id, attempt_id, university_id, status) values ('VR1','S1','A1','T1','U1','COMPLETED')")
    real.x("insert into verification_questions (question_id, verification_id, challenge_id, display_order, verification_type, concept, question_text) "
           "values ('VQ1','VR1','VC1',0,'EXPLAIN','learning rate','why?')")
    real.x("insert into verification_results (result_id, question_id, outcome, score, confidence, feedback) values ('VX1','VQ1','PARTIAL',0.5,0.8,'Confused step size with epochs.')")
    coach(real)
    assert "Confused step size with epochs." in real.state["prompts"][-1]


def test_history_from_other_students_never_reaches_the_prompt(real):
    real.x("insert into evidence_candidates (evidence_id, student_id, assignment_id, evidence_type, strength, observation, university_id, concept) "
           "values ('VZ','S2','A2','MISCONCEPTION','STRONG','OTHER STUDENT SECRET','U1','learning rate')")
    coach(real)
    assert "OTHER STUDENT SECRET" not in real.state["prompts"][-1]


def test_coach_turn_is_persisted_and_visible_to_the_teacher(real):
    coach(real)
    assert real.q("select count(*) n from ai_interactions where student_id='S1' and assignment_id='A1'")[0]["n"] == 1
    r = real.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=real.h("P1"))
    assert r.status_code == 200 and r.json()["coach_interactions"] >= 1
