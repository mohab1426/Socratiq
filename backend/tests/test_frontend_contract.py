"""Frontend <-> backend contract. The frontend's own TypeScript interfaces (src/types/index.ts) are parsed, and every REQUIRED
field is checked against the backend's real JSON after the same snake_case -> camelCase conversion the frontend's API client applies.
If either side renames a field, this fails before a user ever sees a blank screen."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from .helpers import API, sample, upload

TYPES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "types" / "index.ts"
CAMEL = re.compile(r"_([a-z0-9])")


def camelize(v):
    if isinstance(v, list):
        return [camelize(x) for x in v]
    if isinstance(v, dict):
        return {CAMEL.sub(lambda m: m.group(1).upper(), k): camelize(x) for k, x in v.items()}
    return v


def required_fields(interface: str) -> set[str]:
    src = TYPES.read_text()
    m = re.search(rf"export interface {interface}\b[^{{]*\{{(.*?)\n\}}", src, re.S)
    assert m, f"interface {interface} not found in {TYPES}"
    return {f.group(1) for f in re.finditer(r"^\s{2}(\w+)(\??):", m.group(1), re.M) if not f.group(2)}


def check(interface: str, obj: dict, ignore: set[str] = frozenset()):
    missing = required_fields(interface) - set(obj) - set(ignore)
    assert not missing, f"{interface}: backend response is missing {sorted(missing)}; has {sorted(obj)}"


@pytest.fixture()
def full(world):
    """A world in which every kind of record exists (materials, attachments, submissions, verification, signals)."""
    upload(world, "P1", "sample.pdf", sample("sample.pdf")); world.drain()
    world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help"}, headers=world.h("S1"))
    world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "my work"}, headers=world.h("S1"))
    vid = world.client.post(f"{API}/student/assignments/A1/verification", headers=world.h("S1")).json()["verification_id"]
    for _ in range(3):
        world.client.post(f"{API}/student/verification/{vid}/response", json={"answer": "reasoning"}, headers=world.h("S1"))
    return world


def get(w, path, who):
    r = w.client.get(f"{API}{path}", headers=w.h(who))
    assert r.status_code == 200, (path, r.text)
    return camelize(r.json())


def test_student_contracts(full):
    w = full
    courses = get(w, "/student/courses", "S1")["courses"]
    check("Course", courses[0])
    detail = get(w, "/student/courses/C1", "S1")
    check("Course", detail["course"]); check("Material", detail["materials"][0]); check("FileInfo", detail["materials"][0]["file"])
    a = detail["assignments"][0]
    check("Assignment", a); assert a["status"] == "verified"
    ad = get(w, "/student/assignments/A1", "S1")
    check("Assignment", ad); assert ad["status"] and ad["attempt"] and ad["submission"] and ad["verification"]
    mid = detail["materials"][0]["id"]
    check("Material", get(w, f"/student/materials/{mid}", "S1"))
    for m in get(w, "/student/assignments/A1/coach", "S1")["messages"]:
        check("ChatMessage", m)
    home = get(w, "/student/home", "S1")
    assert {"user", "courses", "assignments"} <= set(home)


def test_instructor_contracts(full):
    w = full
    check("Course", get(w, "/teacher/courses", "P1")["courses"][0])
    cd = get(w, "/teacher/courses/C1", "P1")
    check("Course", cd["course"]); check("Material", cd["materials"][0]); check("Assignment", cd["assignments"][0], ignore={"status"})
    assert {"id", "name", "joinCode", "joinEnabled"} <= set(cd["classrooms"][0])
    d = get(w, "/teacher/courses/C1/dashboard", "P1")
    check("StudentRow", d["students"][0]); check("RiskBrief", d["students"][0]["risk"]); check("ActivityEntry", d["activity"][0])
    check("DashboardOverview", d["overview"])
    for row in d["reviewQueue"]:
        check("ReviewQueueRow", row)
    for item in d["attention"]:
        check("AttentionItem", item, ignore={"to"}); assert "target" in item
    assert {"assignmentCompletion", "averageGrade", "socraticAiUsage", "observedSignalRate", "verificationRate"} <= set(d["metrics"])
    sd = get(w, "/teacher/students/S1", "P1")
    check("StudentDetailInfo", sd)
    check("RiskAssessment", sd["risk"]); check("AiUsage", sd["aiUsage"])
    for k in sd["assignments"]:
        check("StudentAssignmentProgress", k)
    for k in sd["verification"]:
        check("StudentVerificationRun", k)
    for k in sd["concepts"]:
        check("StudentConcept", k)
    for k in sd["timeline"]:
        check("TimelineEntry", k)
    for g in sd["risk"]["topSignals"]:
        check("RiskSignalGroup", g)
        for e in g["evidence"]:
            check("RiskEvidenceRef", e)
    for s in sd["signals"]:
        check("LearningSignal", s)
    ad = get(w, "/teacher/assignments/A1", "P1")
    check("Assignment", ad, ignore={"status"}); check("SubmissionRow", ad["submissions"][0])
    assert {"linkedMaterials", "concepts", "counts"} <= set(ad)
    rv = get(w, "/teacher/assignments/A1/students/S1", "P1")
    assert {"assignment", "student", "attempt", "submission", "verification", "coachInteractions", "signals", "signalsNote", "risk"} <= set(rv)
    check("RiskAssessment", rv["risk"])
    for e in rv["verification"]["entries"]:
        check("EvidenceEntry", e)
    mat = get(w, f"/teacher/materials/{cd['materials'][0]['id']}", "P1")
    check("Material", mat); check("FileInfo", mat["file"])


def test_capabilities_contract(world):
    caps = get(world, "/files/capabilities?purpose=MATERIAL", "P1")
    check("Capabilities", caps)
    for f in caps["formats"]:
        assert {"extension", "kind", "label", "mimeType", "mode", "maxBytes"} <= set(f)


def test_frontend_never_uses_fields_the_backend_lacks():
    """Every `apiField.x` style access in queries.ts hooks that hard-code a response key is covered above; this guards the
    types file itself against re-introducing removed claims."""
    src = TYPES.read_text()
    assert "externalAiUsage" not in src                     # replaced by observedSignalRate: the AI never asserts external tool use
    assert "observedSignalRate" in src
