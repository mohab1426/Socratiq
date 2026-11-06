"""End-to-end product flows on the real stack: course -> invite -> assignment lifecycle -> attempts -> submissions -> evidence -> review."""
from __future__ import annotations

from pathlib import Path

import pytest

from .helpers import API, FX, retrieve, sample, upload  # noqa: F401


def new_course(w, who="P1", code="NEW101"):
    r = w.client.post(f"{API}/teacher/courses", json={"code": code, "title": "New course", "description": "d", "color": "teal"}, headers=w.h(who))
    assert r.status_code == 201, r.text
    return r.json()


# ================================================================== courses & invite codes
def test_course_creation_makes_a_classroom_with_a_random_invite_code(world):
    c = new_course(world)
    assert c["status"] == "Active" and c["color"] == "teal" and c["student_count"] == 0 and c["classroom_id"]
    import re
    assert re.fullmatch(r"[A-Z2-9]{4}-[A-Z2-9]{4}", c["join_code"]) and c["join_code"] != "NEW1-01"
    assert world.q("select instructor_id, university_id from courses where course_id=%s", c["id"])[0] == {"instructor_id": "P1", "university_id": "U1"}
    r = world.client.post(f"{API}/teacher/courses", json={"code": "NEW101", "title": "dup"}, headers=world.h("P1"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "course_code_taken"
    assert world.client.post(f"{API}/teacher/courses", json={"code": "X", "title": "t", "instructor_id": "P2"}, headers=world.h("P1")).status_code == 422


def test_join_by_invite_code_rules(world):
    c = new_course(world)
    code = c["join_code"]
    r = world.client.post(f"{API}/student/courses/join", json={"code": code.lower().replace("-", " ")}, headers=world.h("S2"))   # forgiving format
    assert r.status_code == 201 and r.json()["id"] == c["id"] and r.json()["teacher"]
    assert world.client.post(f"{API}/student/courses/join", json={"code": code}, headers=world.h("S2")).status_code == 201          # idempotent
    assert world.q("select count(*) n from enrollments where student_id='S2' and course_id=%s", c["id"])[0]["n"] == 1
    assert world.client.post(f"{API}/student/courses/join", json={"code": code}, headers=world.h("S3")).status_code == 404          # other university
    assert world.client.post(f"{API}/student/courses/join", json={"code": "ABCD-EFGH"}, headers=world.h("S2")).status_code == 404   # unknown
    assert world.client.post(f"{API}/student/courses/join", json={"code": "PHYS 111"}, headers=world.h("S2")).status_code == 422    # course codes aren't invite codes
    assert world.client.post(f"{API}/student/courses/join", json={"code": code}, headers=world.h("P1")).status_code == 403          # instructors don't join
    assert c["id"] in [x["id"] for x in world.client.get(f"{API}/student/courses", headers=world.h("S2")).json()["courses"]]


def test_invite_code_guessing_is_rate_limited(world):
    codes = [f"AAAA-{i:04d}".replace("0", "2").replace("1", "3") for i in range(12)]
    statuses = [world.client.post(f"{API}/student/courses/join", json={"code": c}, headers=world.h("S2")).status_code for c in codes]
    assert statuses[:10] == [404] * 10 and 429 in statuses[10:]


def test_rotated_or_disabled_codes_stop_working_and_removed_students_cannot_rejoin(world):
    c = new_course(world)
    world.client.post(f"{API}/student/courses/join", json={"code": c["join_code"]}, headers=world.h("S1"))
    rot = world.client.post(f"{API}/teacher/classrooms/{c['classroom_id']}/join-code/rotate", headers=world.h("P1")).json()
    assert rot["join_code"] != c["join_code"]
    assert world.client.post(f"{API}/student/courses/join", json={"code": c["join_code"]}, headers=world.h("S2")).status_code == 404   # old code dead
    assert world.client.post(f"{API}/student/courses/join", json={"code": rot["join_code"]}, headers=world.h("S2")).status_code == 201
    assert world.client.post(f"{API}/teacher/classrooms/{c['classroom_id']}/join-code/rotate", headers=world.h("P2")).status_code == 404
    world.client.patch(f"{API}/teacher/classrooms/{c['classroom_id']}?enabled=false", headers=world.h("P1"))
    assert world.client.post(f"{API}/student/courses/join", json={"code": rot["join_code"]}, headers=world.h("S3")).status_code == 404
    roster = world.client.get(f"{API}/teacher/courses/{c['id']}/students", headers=world.h("P1")).json()["students"]
    e = next(s for s in roster if s["id"] == "S2")
    assert world.client.patch(f"{API}/teacher/enrollments/{e['enrollment_id']}", json={"status": "inactive"}, headers=world.h("P1")).status_code == 200
    assert world.client.get(f"{API}/student/courses/{c['id']}", headers=world.h("S2")).status_code == 404           # access gone
    world.client.patch(f"{API}/teacher/classrooms/{c['classroom_id']}?enabled=true", headers=world.h("P1"))
    r = world.client.post(f"{API}/student/courses/join", json={"code": rot["join_code"]}, headers=world.h("S2"))
    assert r.status_code == 403 and r.json()["error"]["code"] == "removed"                                          # can't self-rejoin
    assert world.client.patch(f"{API}/teacher/enrollments/{e['enrollment_id']}", json={"status": "inactive"}, headers=world.h("P2")).status_code == 404


# ================================================================== assignment lifecycle
def test_assignment_lifecycle_visibility_and_versioning(world):
    r = world.client.post(f"{API}/teacher/courses/C1/assignments", json={"title": "Lab 2", "prompt": "Implement SGD", "topic": "Optimisation", "concepts": ["SGD", "learning rate"]},
                          headers=world.h("P1"))
    assert r.status_code == 201
    a = r.json()
    assert a["lifecycle"] == "DRAFT" and a["ai_mode"] == "guided" and a["version"] == 1                                       # policy is not a client choice
    aid = a["id"]
    assert aid not in [x["id"] for x in world.client.get(f"{API}/student/courses/C1", headers=world.h("S1")).json()["assignments"]]
    assert world.client.get(f"{API}/student/assignments/{aid}", headers=world.h("S1")).status_code == 404
    assert world.client.post(f"{API}/teacher/assignments/{aid}/publish", headers=world.h("P2")).status_code == 404
    pub = world.client.post(f"{API}/teacher/assignments/{aid}/publish", headers=world.h("P1")).json()
    assert pub["lifecycle"] == "PUBLISHED" and pub["published_at"] and pub["concepts"] == ["learning rate", "SGD"] or pub["concepts"] == sorted(["SGD", "learning rate"])
    assert world.client.get(f"{API}/student/assignments/{aid}", headers=world.h("S1")).json()["status"] == "not_started"
    att = world.client.post(f"{API}/student/assignments/{aid}/attempts", headers=world.h("S1")).json()
    assert att["assignment_version"] == 1
    edit = world.client.patch(f"{API}/teacher/assignments/{aid}", json={"prompt": "Implement mini-batch SGD", "due_at": "2030-01-01T00:00:00Z"}, headers=world.h("P1")).json()
    assert edit["version"] == 2 and edit["prompt"].startswith("Implement mini-batch") and edit["due_date"].startswith("2030-01-01")
    assert world.q("select assignment_version from attempts where attempt_id=%s", att["id"])[0]["assignment_version"] == 1     # evidence stays tied to what they saw
    assert [v["version"] for v in world.q("select version from assignment_versions where assignment_id=%s order by version", aid)] == [1, 2]
    r = world.client.post(f"{API}/teacher/assignments/{aid}/unpublish", headers=world.h("P1"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_transition"                                         # students already started
    assert world.client.post(f"{API}/teacher/assignments/{aid}/archive", headers=world.h("P1")).json()["lifecycle"] == "ARCHIVED"
    assert world.client.get(f"{API}/student/assignments/{aid}", headers=world.h("S1")).status_code == 404
    assert world.q("select count(*) n from attempts where assignment_id=%s", aid)[0]["n"] == 1                                 # history preserved
    assert world.client.patch(f"{API}/teacher/assignments/A2", json={"title": "x"}, headers=world.h("P1")).status_code == 404


def test_assignment_linking_rules(world):
    m = upload(world, "P1", "sample.txt", sample("sample.txt")).json()
    body = {"title": "t", "prompt": "p", "material_ids": [m["id"]]}
    assert world.client.post(f"{API}/teacher/courses/C1/assignments", json=body, headers=world.h("P1")).status_code == 422       # still processing
    world.drain()
    assert world.client.post(f"{API}/teacher/courses/C1/assignments", json=body, headers=world.h("P1")).status_code == 201
    other = upload(world, "P2", "sample.md", sample("sample.md"), course="C2").json()
    world.drain()
    r = world.client.post(f"{API}/teacher/courses/C1/assignments", json={**body, "material_ids": [other["id"]]}, headers=world.h("P1"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_material"                                               # another course's material
    assert world.client.post(f"{API}/teacher/courses/C2/assignments", json={"title": "t", "prompt": "p"}, headers=world.h("P1")).status_code == 404


def test_assignment_from_file_uses_its_text_as_the_prompt(world):
    def up(name, data, **form):
        return world.client.post(f"{API}/teacher/courses/C1/assignments/upload", files={"file": (name, data, "application/octet-stream")},
                                 data={"title": "From file", "publish": "true", **form}, headers=world.h("P1"))
    r = up("brief.docx", sample("sample.docx"), topic="Optimisation", due_at="2031-05-01T12:00:00Z")
    assert r.status_code == 201, r.text
    a = r.json()
    assert "Gradient descent minimises" in a["prompt"] and a["lifecycle"] == "PUBLISHED" and a["topic"] == "Optimisation" and a["due_date"].startswith("2031-05-01")
    assert [(x["role"], x["status"], x["index_mode"]) for x in a["attachments"]] == [("PROMPT", "READY", "EXTRACT_ONLY")]
    assert world.client.get(f"{API}/student/assignments/{a['id']}", headers=world.h("S1")).json()["attachments"][0]["filename"] == "brief.docx"
    for name, data in [("t.txt", sample("sample.txt")), ("t.md", sample("sample.md")), ("t.pdf", sample("sample.pdf")), ("t.doc", sample("sample.doc")),
                       ("t.xlsx", sample("sample.xlsx")), ("t.pptx", sample("sample.pptx")), ("t.png", sample("sample.png")), ("t.ipynb", sample("sample.ipynb"))]:
        rr = up(name, data)
        assert rr.status_code == 201 and rr.json()["prompt"].strip(), name
    assert up("blank.pdf", __import__("pymupdf").open().tobytes() if False else _blank_pdf()).status_code == 422
    assert up("x.exe", b"MZ").status_code == 415
    assert world.client.delete(f"{API}/teacher/assignments/{a['id']}/attachments/{a['attachments'][0]['attachment_id']}", headers=world.h("P1")).status_code == 400
    assert world.q("select count(*) n from documents")[0]["n"] == 0                                                            # prompt files are not indexed


def _blank_pdf():
    import pymupdf
    d = pymupdf.open(); d.new_page(); return d.tobytes()


def test_supporting_attachments_are_indexed_for_that_assignment_only(world):
    world.x("update assignments set status='PUBLISHED' where assignment_id='A1d'")
    r = world.client.post(f"{API}/teacher/assignments/A1/attachments", files={"file": ("data.csv", sample("sample.csv"), "text/csv")}, headers=world.h("P1"))
    assert r.status_code == 202 and r.json()["role"] == "SUPPORTING" and r.json()["status"] == "QUEUED"
    assert world.client.get(f"{API}/student/assignments/A1", headers=world.h("S1")).json()["attachments"] == []              # not visible until ready
    world.drain()
    att = world.client.get(f"{API}/student/assignments/A1", headers=world.h("S1")).json()["attachments"]
    assert [a["filename"] for a in att] == ["data.csv"]
    doc = world.q("select document_id from stored_files")[0]["document_id"]
    assert world.q("select chunk_id from document_chunks where document_id=%s and assignment_ids ? 'A1'", doc)                 # scoped to A1 inside the index
    assert [h.content for h in retrieve(world, "mohab", asg="A1", allowed=[doc])]
    assert retrieve(world, "mohab", asg="A1d", allowed=[doc]) == []                                                           # a different assignment never sees it
    from app.access import allowed_document_ids
    with world.db.tx() as c:
        assert allowed_document_ids(c, world.q("select * from assignments where assignment_id='A1'")[0]) == [doc]
        assert allowed_document_ids(c, world.q("select * from assignments where assignment_id='A1d'")[0]) == []
    fid = att[0]["file_id"]
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S1")).status_code == 200
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S2")).status_code == 404
    dup = world.client.post(f"{API}/teacher/assignments/A1/attachments", files={"file": ("again.csv", sample("sample.csv"), "text/csv")}, headers=world.h("P1"))
    assert dup.status_code == 409
    world.x("update assignments set status='ARCHIVED' where assignment_id='A1'")
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S1")).status_code == 404                    # archived: gone for students
    assert world.client.delete(f"{API}/teacher/assignments/A1/attachments/{r.json()['attachment_id']}", headers=world.h("P1")).status_code == 204
    assert world.q("select count(*) n from documents")[0]["n"] == 0


# ================================================================== student file submissions
def submit_file(w, who, attempt, name, data, ctype="application/octet-stream"):
    return w.client.post(f"{API}/student/attempts/{attempt}/submit-file", files={"file": (name, data, ctype)}, headers=w.h(who))


@pytest.mark.parametrize("name,word", [("sample.docx", "gradient descent"), ("sample.doc", "gradient descent"), ("sample.pdf", "momentum"), ("sample.txt", "regularisation"),
                                       ("sample.py", "def predict"), ("sample.csv", "mohab"), ("sample.xlsx", "stu3"), ("sample.pptx", "backpropagation"),
                                       ("sample.png", "backpropagation"), ("sample.ipynb", "print(1+1)")])
def test_file_submission_stores_extracts_and_never_indexes(world, name, word):
    r = submit_file(world, "S1", "T1", name, sample(name))
    assert r.status_code == 200, r.text
    assert r.json()["text_extracted"] is True and r.json()["file"]["index_mode"] == "EXTRACT_ONLY" and r.json()["file"]["status"] == "READY"
    sub = world.q("select submission_text, submission_type, file_id from submissions")[0]
    assert sub["submission_type"] == "file" and word in sub["submission_text"].lower()
    f = world.q("select purpose, uploader_id, classroom_id, document_id from stored_files")[0]
    assert f == {"purpose": "SUBMISSION", "uploader_id": "S1", "classroom_id": "K1", "document_id": None}
    assert world.q("select count(*) n from documents")[0]["n"] == 0 and world.q("select count(*) n from document_chunks")[0]["n"] == 0   # private work never enters retrieval
    assert world.q("select status from attempts where attempt_id='T1'")[0]["status"] == "SUBMITTED"
    fid = sub["file_id"]
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("S1")).status_code == 200
    assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h("P1")).status_code == 200                                 # their instructor
    for who in ("S2", "S3", "P2", "P3"):
        assert world.client.post(f"{API}/files/{fid}/download-link", headers=world.h(who)).status_code == 404, who


def test_bad_submission_files_change_nothing(world):
    def untouched():
        assert world.q("select status from attempts where attempt_id='T1'")[0]["status"] == "IN_PROGRESS"
        assert world.q("select count(*) n from submissions")[0]["n"] == 0 and world.q("select count(*) n from stored_files")[0]["n"] == 0
        assert not [p for p in Path(world.storage.root).rglob("*") if p.is_file()]
    assert submit_file(world, "S1", "T1", "x.docx", b"PK\x03\x04 broken").status_code == 415; untouched()
    assert submit_file(world, "S1", "T1", "x.exe", b"MZ").status_code == 415; untouched()
    assert submit_file(world, "S1", "T1", "x.txt", b"a\x00b" * 50).status_code == 415; untouched()
    assert submit_file(world, "S2", "T1", "x.txt", b"words").status_code == 404; untouched()                   # someone else's attempt
    assert submit_file(world, "S1", "T2", "x.txt", b"words").status_code == 404; untouched()


def test_second_submission_is_rejected_and_leaves_no_orphan_object(world):
    assert submit_file(world, "S1", "T1", "a.txt", b"first version of my answer").status_code == 200
    before = sorted(p.name for p in Path(world.storage.root).rglob("*") if p.is_file())
    r = submit_file(world, "S1", "T1", "b.txt", b"second version")
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_submitted"
    assert sorted(p.name for p in Path(world.storage.root).rglob("*") if p.is_file()) == before
    assert world.q("select count(*) n from stored_files")[0]["n"] == 1


def test_unreadable_file_is_accepted_with_an_honest_warning(world):
    r = submit_file(world, "S1", "T1", "scan.pdf", _blank_pdf())
    assert r.status_code == 200 and r.json()["text_extracted"] is False and "couldn't read text" in r.json()["warning"]
    assert world.q("select status, processing_note from stored_files")[0]["status"] == "STORED_ONLY"


# ================================================================== instructor evidence views
def _run_student_journey(w):
    h = w.h("S1")
    assert w.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help me"}, headers=h).status_code == 200
    assert w.client.post(f"{API}/student/attempts/T1/submit", json={"text": "theta = theta - lr * grad"}, headers=h).status_code == 200
    vid = w.client.post(f"{API}/student/assignments/A1/verification", headers=h).json()["verification_id"]
    for _ in range(3):
        assert w.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "because the gradient points uphill"}, headers=h).status_code == 200


def test_dashboard_metrics_are_derived_from_real_evidence(world):
    empty = world.client.get(f"{API}/teacher/courses/C1/dashboard", headers=world.h("P1")).json()
    assert empty["metrics"]["assignment_completion"] == 0 and empty["students"][0]["mastery"] is None       # no evidence -> no claim
    _run_student_journey(world)
    d = world.client.get(f"{API}/teacher/courses/C1/dashboard", headers=world.h("P1")).json()
    s = d["students"][0]
    assert s["id"] == "S1" and s["task_submission"] == 100 and s["socratic_ai_usage"] == 100 and s["mastery"] == "Strong"
    assert s["observed_signal_rate"] == 100 and s["observed_signal_count"] == 2          # seeded signal + this journey's
    assert d["metrics"]["verification_rate"] == 100 and d["metrics"]["average_grade"] is None                  # no grading feature: never invented
    kinds = {a["kind"] for a in d["activity"]}
    assert {"submission", "verification", "coach_session"} <= kinds
    sig = next(a for a in d["attention"] if a["kind"] == "signal")
    assert "not a determination of intent" in sig["description"] and sig["target"] == {"type": "student", "student_id": "S1"}


def test_student_detail_and_submission_review(world):
    _run_student_journey(world)
    d = world.client.get(f"{API}/teacher/students/S1", headers=world.h("P1")).json()
    assert d["name"] and d["course_ids"] == ["C1"] and d["mastery"] == "Strong" and d["attempts"] >= 1
    assert any(s["tone"] == "watch" and "long structured answer" in s["detail"] for s in d["signals"])
    rv = world.client.get(f"{API}/teacher/assignments/A1/students/S1", headers=world.h("P1")).json()
    assert rv["submission"]["text_preview"].startswith("theta") and rv["coach_interactions"] == 1
    assert [e["label"] for e in rv["verification"]["entries"]] == ["Explain", "Modify", "Transfer"] and rv["verification"]["entries"][0]["answer"]
    assert rv["signals_note"].startswith("Observed patterns only")
    asg = world.client.get(f"{API}/teacher/assignments/A1", headers=world.h("P1")).json()
    assert asg["counts"] == {"students": 1, "submitted": 1, "verified": 1} and asg["submissions"][0]["status"] == "verified"


def test_evidence_views_are_authorised(world):
    _run_student_journey(world)
    for path in ("/teacher/students/S1", "/teacher/assignments/A1/students/S1", "/teacher/assignments/A1", "/teacher/courses/C1/dashboard"):
        assert world.client.get(f"{API}{path}", headers=world.h("P2")).status_code == 404, path            # another instructor, same university
        assert world.client.get(f"{API}{path}", headers=world.h("P3")).status_code == 404, path            # another university
        assert world.client.get(f"{API}{path}", headers=world.h("S1")).status_code == 403, path            # students never see instructor evidence
        assert world.client.get(f"{API}{path}", headers=world.h("S2")).status_code == 403, path
    assert world.client.get(f"{API}/teacher/assignments/A1/students/S2", headers=world.h("P1")).status_code == 404   # not in P1's class
    assert "risk" not in world.client.get(f"{API}/student/assignments/A1", headers=world.h("S1")).text.lower()
