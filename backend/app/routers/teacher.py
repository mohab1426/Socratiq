from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from psycopg import errors as pgerr

from .. import analytics, risk
from ..access import (default_classroom, teacher_assignment, teacher_classroom, teacher_classrooms, teacher_course, teacher_student)
from ..auth import CurrentUser, get_db, require_professor
from ..config import get_backend_config
from ..db import Database, many, new_id, one
from ..errors import AppError, conflict, not_found
from ..files import registry as R
from ..files.errors import ExtractionError
from ..files.validation import validate_upload
from ..ratelimit import upload_rate_limit
from ..records import mastery_label
from ..schemas import AssignmentIn, AssignmentPatch, CourseIn, CoursePatch, EnrollmentPatch, GradeIn
from ..uploads import read_upload
from ..views import assignment_view, attachments_for, course_view, file_view, grade_view, iso, material_view, whiteboard_view

router = APIRouter(prefix="/teacher", tags=["teacher"])
MAX_PROMPT_CHARS = 50_000


def _limit() -> int:
    return get_backend_config().max_upload_mb * 1024 * 1024


def _parse_dt(v: Optional[str]) -> Optional[datetime]:
    if not v or not v.strip():
        return None
    try:
        return datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        raise AppError(422, "due_at must be an ISO date/time, e.g. 2026-10-01T23:59:00Z") from None


def _bool(v: Optional[str]) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


# ================================================================== courses
_TEACHER_COURSES = """
SELECT c.*, (SELECT count(*) FROM materials m JOIN classrooms k ON k.classroom_id = m.classroom_id WHERE k.course_id = c.course_id)::int AS material_count,
  (SELECT count(*) FROM assignments a WHERE a.course_id = c.course_id AND a.status <> 'ARCHIVED')::int AS assignment_count,
  (SELECT count(DISTINCT e.student_id) FROM enrollments e WHERE e.course_id = c.course_id AND e.status = 'active')::int AS student_count
FROM courses c WHERE c.university_id = %s AND {scope} ORDER BY c.title"""
_SCOPE = "(c.instructor_id = %s OR EXISTS (SELECT 1 FROM classrooms k WHERE k.course_id = c.course_id AND k.professor_id = %s))"


def _card(r, user: CurrentUser, rooms: Optional[list] = None) -> dict:
    first = rooms[0] if rooms else None
    return course_view(r, teacher_name=user.name, material_count=r["material_count"], assignment_count=r["assignment_count"], student_count=r["student_count"],
                       classroom_id=first["classroom_id"] if first and len(rooms) == 1 else None, join_code=first["join_code"] if first and len(rooms) == 1 else None)


@router.get("/courses")
def list_courses(user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        rows = many(c, _TEACHER_COURSES.format(scope=_SCOPE), (user.university_id, user.user_id, user.user_id))
        rooms = many(c, "SELECT * FROM classrooms WHERE course_id = ANY(%s) ORDER BY created_at", ([r["course_id"] for r in rows],)) if rows else []
        by = {}
        for k in rooms:
            by.setdefault(k["course_id"], []).append(k)
        return {"courses": [_card(r, user, by.get(r["course_id"])) for r in rows]}


@router.post("/courses", status_code=201)
def create_course(body: CourseIn, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """A course plus its first classroom (which owns the random invite code students join with)."""
    cid, kid = new_id("crs"), new_id("cls")
    try:
        with db.tx() as c:
            c.execute("INSERT INTO courses (course_id, university_id, instructor_id, code, title, description, color) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                      (cid, user.university_id, user.user_id, body.code, body.title, body.description, body.color))
            c.execute("INSERT INTO classrooms (classroom_id, course_id, professor_id, name, university_id) VALUES (%s,%s,%s,%s,%s)", (kid, cid, user.user_id, body.section_name, user.university_id))
            row = one(c, _TEACHER_COURSES.format(scope="c.course_id = %s"), (user.university_id, cid))
            return _card(row, user, many(c, "SELECT * FROM classrooms WHERE course_id=%s", (cid,)))
    except pgerr.UniqueViolation:
        raise conflict(f"You already have a course with the code {body.code}.", "course_code_taken") from None


@router.get("/courses/{course_id}")
def course_detail(course_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_course(c, user, course_id)
        row = one(c, _TEACHER_COURSES.format(scope="c.course_id = %s"), (user.university_id, course_id))
        rooms = teacher_classrooms(c, user, course_id)
        mats = many(c, "SELECT m.* FROM materials m JOIN classrooms k ON k.classroom_id = m.classroom_id WHERE k.course_id = %s ORDER BY m.created_at DESC", (course_id,))
        files = {f["file_id"]: f for f in many(c, "SELECT * FROM stored_files WHERE file_id = ANY(%s)", ([m["file_id"] for m in mats if m["file_id"]],))} if mats else {}
        asgs = many(c, """SELECT a.*, (SELECT count(DISTINCT t.student_id) FROM attempts t WHERE t.assignment_id = a.assignment_id AND t.status='SUBMITTED')::int AS submitted
                            FROM assignments a WHERE a.course_id=%s ORDER BY a.due_at NULLS LAST, a.created_at DESC""", (course_id,))
        return {"course": _card(row, user, rooms),
                "classrooms": [{"id": k["classroom_id"], "name": k["name"], "join_code": k["join_code"], "join_enabled": k["join_enabled"]} for k in rooms],
                "materials": [material_view(m, files.get(m["file_id"])) for m in mats],
                "assignments": [{**assignment_view(a), "submitted_count": a["submitted"], "student_count": row["student_count"]} for a in asgs]}


@router.patch("/courses/{course_id}")
def patch_course(course_id: str, body: CoursePatch, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    data = body.model_dump(exclude_none=True)
    with db.tx() as c:
        teacher_course(c, user, course_id, lock=True)
        if data:
            sets = ", ".join(f"{k} = %({k})s" for k in data)
            c.execute(f"UPDATE courses SET {sets} WHERE course_id = %(cid)s", {**data, "cid": course_id})
        row = one(c, _TEACHER_COURSES.format(scope="c.course_id = %s"), (user.university_id, course_id))
        return _card(row, user, teacher_classrooms(c, user, course_id))


@router.post("/classrooms/{classroom_id}/join-code/rotate")
def rotate_join_code(classroom_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Invalidate the old invite code immediately (already-enrolled students are unaffected)."""
    with db.tx() as c:
        teacher_classroom(c, user, classroom_id)
        row = one(c, "UPDATE classrooms SET join_code = public.gen_join_code() WHERE classroom_id=%s RETURNING classroom_id, join_code, join_enabled", (classroom_id,))
        return {"id": row["classroom_id"], "join_code": row["join_code"], "join_enabled": row["join_enabled"]}


@router.patch("/classrooms/{classroom_id}")
def set_join_enabled(classroom_id: str, enabled: bool, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_classroom(c, user, classroom_id)
        row = one(c, "UPDATE classrooms SET join_enabled=%s WHERE classroom_id=%s RETURNING classroom_id, join_code, join_enabled", (enabled, classroom_id))
        return {"id": row["classroom_id"], "join_code": row["join_code"], "join_enabled": row["join_enabled"]}


# ================================================================== roster
@router.get("/courses/{course_id}/students")
def roster(course_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_course(c, user, course_id)
        enr = many(c, """SELECT e.enrollment_id, e.status, e.classroom_id, e.created_at, u.user_id FROM enrollments e JOIN users u ON u.user_id = e.student_id
                          WHERE e.course_id=%s AND e.university_id=%s ORDER BY e.created_at""", (course_id, user.university_id))
        stats = {s["id"]: s for s in analytics.course_students(c, course_id, user.university_id)}
        return {"students": [{"enrollment_id": e["enrollment_id"], "status": e["status"], "classroom_id": e["classroom_id"], "joined_at": iso(e["created_at"]),
                              **{k: v for k, v in (stats.get(e["user_id"]) or {}).items() if not k.startswith("_")}} for e in enr]}


@router.patch("/enrollments/{enrollment_id}")
def set_enrollment(enrollment_id: str, body: EnrollmentPatch, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Remove (inactive) or restore (active) a student. History is kept; only access changes."""
    with db.tx() as c:
        e = one(c, "SELECT * FROM enrollments WHERE enrollment_id=%s AND university_id=%s FOR UPDATE", (enrollment_id, user.university_id))
        if e is None or e["classroom_id"] is None:
            raise not_found("Enrollment not found")
        teacher_classroom(c, user, e["classroom_id"])
        row = one(c, "UPDATE enrollments SET status=%s WHERE enrollment_id=%s RETURNING enrollment_id, status", (body.status, enrollment_id))
        return {"enrollment_id": row["enrollment_id"], "status": row["status"]}


# ================================================================== analytics
@router.get("/courses/{course_id}/dashboard")
def dashboard(course_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_course(c, user, course_id)
        row = one(c, _TEACHER_COURSES.format(scope="c.course_id = %s"), (user.university_id, course_id))
        return {"course": _card(row, user, teacher_classrooms(c, user, course_id)), **analytics.course_dashboard(c, user, course_id)}


@router.get("/students/{student_id}")
def student_detail(student_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_student(c, user, student_id)
        return analytics.student_detail(c, user, student_id)


# ================================================================== materials (course knowledge base)
@router.post("/courses/{course_id}/materials", status_code=202, dependencies=[Depends(upload_rate_limit)])
async def upload_material(course_id: str, request: Request, file: UploadFile = File(...), title: Optional[str] = Form(None),
                          classroom_id: Optional[str] = Form(None), user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Validate -> store -> record -> (queue for extraction/indexing). Returns 202 immediately; poll GET /teacher/materials/{id}."""
    data = await read_upload(file, _limit())
    return await run_in_threadpool(_upload_material_sync, request, db, user, course_id, classroom_id, title, file.filename, file.content_type, data)


def _upload_material_sync(request, db, user, course_id, classroom_id, title, filename, ctype, data):
    pipeline = request.app.state.pipeline
    with db.tx() as c:
        room = default_classroom(c, user, course_id, classroom_id)
    vf = validate_upload(filename, ctype, data, R.MATERIAL)
    for attempt in (1, 2):
        key = None
        try:
            with db.tx() as c:
                row, key = pipeline.save(c, vf, data, purpose=R.MATERIAL, uploader_id=user.user_id, university_id=user.university_id,
                                         course_id=course_id, classroom_id=room["classroom_id"])
                mat = one(c, "INSERT INTO materials (material_id, classroom_id, document_id, title, university_id, course_id, file_id) VALUES (%s,%s,NULL,%s,%s,%s,%s) RETURNING *",
                          (new_id("mat"), room["classroom_id"], (title or vf.original_filename.rsplit(".", 1)[0])[:200], user.university_id, course_id, row["file_id"]))
            if row["status"] == "QUEUED":
                request.app.state.worker.kick()
            return material_view(mat, row)
        except pgerr.UniqueViolation as exc:
            if key:
                pipeline.rollback_object(key)
            existing = _duplicate_of(db, user, course_id, vf.sha256)
            if existing and existing["status"] == "FAILED" and attempt == 1:
                pipeline.delete_file(existing["file_id"])            # a failed earlier upload must not block a fresh one
                continue
            raise conflict(f"This exact file is already in the course as “{existing['original_filename'] if existing else 'another file'}”.", "duplicate_file") from exc
        except Exception:
            if key:
                pipeline.rollback_object(key)
            raise
    raise conflict("Could not store the file; please retry.", "upload_race")


def _duplicate_of(db, user, course_id, sha):
    with db.tx() as c:
        return one(c, "SELECT * FROM stored_files WHERE university_id=%s AND course_id=%s AND sha256=%s AND index_mode='RAG'", (user.university_id, course_id, sha))


def _material(c, user, material_id):
    m = one(c, "SELECT * FROM materials WHERE material_id=%s AND university_id=%s", (material_id, user.university_id))
    if m is None:
        raise not_found("Material not found")
    teacher_classroom(c, user, m["classroom_id"])
    f = one(c, "SELECT * FROM stored_files WHERE file_id=%s", (m["file_id"],)) if m["file_id"] else None
    return m, f


@router.get("/courses/{course_id}/materials")
def list_materials(course_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_course(c, user, course_id)
        mats = many(c, "SELECT m.* FROM materials m JOIN classrooms k ON k.classroom_id=m.classroom_id WHERE k.course_id=%s ORDER BY m.created_at DESC", (course_id,))
        files = {f["file_id"]: f for f in many(c, "SELECT * FROM stored_files WHERE file_id = ANY(%s)", ([m["file_id"] for m in mats if m["file_id"]],))} if mats else {}
        return {"materials": [material_view(m, files.get(m["file_id"])) for m in mats]}


@router.get("/materials/{material_id}")
def material_status(material_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        return material_view(*_material(c, user, material_id))


@router.post("/materials/{material_id}/retry", status_code=202)
def retry_material(material_id: str, request: Request, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        m, f = _material(c, user, material_id)
        if f is None or f["index_mode"] != "RAG":
            raise AppError(400, "This file is stored as-is and is not indexed, so there is nothing to retry.", code="not_retryable")
        if f["status"] == "PROCESSING":
            raise conflict("This file is being processed right now.", "processing")
        f = one(c, "UPDATE stored_files SET status='QUEUED', attempts=0, processing_error=NULL, processing_note=NULL WHERE file_id=%s RETURNING *", (f["file_id"],))
    request.app.state.worker.kick()
    return material_view(m, f)


@router.delete("/materials/{material_id}", status_code=204)
def delete_material(material_id: str, request: Request, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        m, f = _material(c, user, material_id)
        if f is None:
            c.execute("DELETE FROM assignment_materials WHERE document_id=%s", (m["document_id"],)) if m["document_id"] else None
            c.execute("DELETE FROM materials WHERE material_id=%s", (material_id,))
    if f is not None:
        request.app.state.pipeline.delete_file(f["file_id"])


# ================================================================== assignments
def _set_links(c, user, a, material_ids: Optional[list[str]], concepts: Optional[list[str]]) -> None:
    if material_ids is not None:
        c.execute("DELETE FROM assignment_materials WHERE assignment_id=%s", (a["assignment_id"],))
        for mid in dict.fromkeys(material_ids):
            m = one(c, "SELECT document_id FROM materials WHERE material_id=%s AND course_id=%s AND university_id=%s", (mid, a["course_id"], user.university_id))
            if m is None:
                raise AppError(422, f"Material {mid} is not part of this course.", code="bad_material")
            if not m["document_id"]:
                raise AppError(422, "A selected material is still being processed; link it once it is ready.", code="material_not_ready")
            c.execute("INSERT INTO assignment_materials (assignment_id, document_id, university_id, course_id) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                      (a["assignment_id"], m["document_id"], user.university_id, a["course_id"]))
    if concepts is not None:
        c.execute("DELETE FROM assignment_concepts WHERE assignment_id=%s", (a["assignment_id"],))
        for name in dict.fromkeys(n.strip() for n in concepts if n.strip()):
            k = one(c, "INSERT INTO concepts (university_id, name) VALUES (%s,%s) ON CONFLICT (university_id, normalized_name) DO UPDATE SET name = concepts.name RETURNING concept_id", (user.university_id, name[:200]))
            c.execute("INSERT INTO assignment_concepts (assignment_id, concept_id, university_id) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", (a["assignment_id"], k["concept_id"], user.university_id))


def _insert_assignment(c, user, course_id, room, *, title, topic, prompt, due_at, is_programming, publish) -> dict:
    return one(c, """INSERT INTO assignments (assignment_id, course_id, classroom_id, title, instructions, subject_area, is_programming, default_policy, university_id, due_at, status, created_by)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,'GUIDED',%s,%s,%s,%s) RETURNING *""",
               (new_id("asg"), course_id, room["classroom_id"], title, prompt, topic, is_programming, user.university_id, due_at, "PUBLISHED" if publish else "DRAFT", user.user_id))


@router.post("/courses/{course_id}/assignments", status_code=201)
def create_assignment(course_id: str, body: AssignmentIn, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """AI assistance policy is not a client choice: new assignments start GUIDED (the platform default)."""
    with db.tx() as c:
        room = default_classroom(c, user, course_id, body.classroom_id)
        a = _insert_assignment(c, user, course_id, room, title=body.title, topic=body.topic, prompt=body.prompt, due_at=body.due_at, is_programming=body.is_programming, publish=body.publish)
        _set_links(c, user, a, body.material_ids, body.concepts)
        return assignment_view(a, attachments=[])


@router.post("/courses/{course_id}/assignments/upload", status_code=201, dependencies=[Depends(upload_rate_limit)])
async def create_assignment_from_file(course_id: str, request: Request, file: UploadFile = File(...), title: str = Form(...), topic: Optional[str] = Form(None),
                                      due_at: Optional[str] = Form(None), publish: Optional[str] = Form(None), classroom_id: Optional[str] = Form(None),
                                      user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """The uploaded file's text becomes the prompt students see; the original file stays attached and downloadable."""
    data = await read_upload(file, _limit())
    return await run_in_threadpool(_assignment_from_file_sync, request, db, user, course_id, classroom_id, title.strip(), topic, _parse_dt(due_at), _bool(publish), file.filename, file.content_type, data)


def _assignment_from_file_sync(request, db, user, course_id, classroom_id, title, topic, due_at, publish, filename, ctype, data):
    if not title or len(title) > 200:
        raise AppError(422, "title is required (max 200 characters)")
    pipeline = request.app.state.pipeline
    with db.tx() as c:
        room = default_classroom(c, user, course_id, classroom_id)
    vf = validate_upload(filename, ctype, data, R.ATTACHMENT, role="PROMPT")
    mode, _ = R.mode_for(vf.spec, R.ATTACHMENT, "PROMPT")
    if mode != R.EXTRACT_ONLY:
        raise AppError(422, "Text can't be read from this file type here. Paste the prompt instead, or upload a PDF, Word, text or Markdown file.", code="no_prompt_text")
    try:
        ex = pipeline.extract_now(vf, data)
    except ExtractionError as exc:
        raise AppError(422, f"We couldn't read this file: {exc}", code=exc.code) from exc
    text = ex.text.strip()
    if not text:
        raise AppError(422, "No text could be read from this file (is it a scanned image?). Paste the prompt instead.", code="no_prompt_text")
    if len(text) > MAX_PROMPT_CHARS:
        raise AppError(422, f"The prompt is longer than {MAX_PROMPT_CHARS:,} characters. Upload a shorter file or attach it as supporting material.", code="prompt_too_long")
    key = None
    try:
        with db.tx() as c:
            a = _insert_assignment(c, user, course_id, room, title=title, topic=(topic or None), prompt=text, due_at=due_at, is_programming=False, publish=publish)
            row, key = pipeline.save(c, vf, data, purpose=R.ATTACHMENT, uploader_id=user.user_id, university_id=user.university_id, course_id=course_id,
                                     classroom_id=room["classroom_id"], role="PROMPT")
            row = pipeline.mark_done(c, row["file_id"], ex)
            c.execute("INSERT INTO assignment_attachments (attachment_id, assignment_id, university_id, course_id, file_id, role) VALUES (%s,%s,%s,%s,%s,'PROMPT')",
                      (new_id("att"), a["assignment_id"], user.university_id, course_id, row["file_id"]))
            return assignment_view(a, attachments=attachments_for(c, a["assignment_id"], include_pending=True))
    except Exception:
        if key:
            pipeline.rollback_object(key)
        raise


def _detail(c, user, a) -> dict:
    """Teacher view of one assignment: content, attachments, links, and one row per enrolled student."""
    aid = a["assignment_id"]
    rows = many(c, """
        SELECT u.user_id, u.first_name, u.last_name, u.email,
               (SELECT t.status FROM attempts t WHERE t.student_id = u.user_id AND t.assignment_id = %(a)s ORDER BY t.attempt_number DESC LIMIT 1) AS attempt_status,
               (SELECT s.submitted_at FROM submissions s WHERE s.student_id = u.user_id AND s.assignment_id = %(a)s ORDER BY s.submitted_at DESC LIMIT 1) AS submitted_at,
               (SELECT count(*) FROM verification_runs v WHERE v.student_id = u.user_id AND v.assignment_id = %(a)s AND v.status = 'COMPLETED')::int AS verified,
               (SELECT avg(res.score)::float FROM verification_results res JOIN verification_questions q ON q.question_id = res.question_id JOIN verification_runs v ON v.verification_id = q.verification_id
                 WHERE v.student_id = u.user_id AND v.assignment_id = %(a)s AND res.outcome <> 'INSUFFICIENT_EVIDENCE') AS mastery_score
          FROM enrollments e JOIN users u ON u.user_id = e.student_id WHERE e.classroom_id = %(k)s AND e.status = 'active' ORDER BY u.last_name NULLS LAST, u.first_name NULLS LAST""",
                {"a": aid, "k": a["classroom_id"]})

    def status(r):
        if r["attempt_status"] == "SUBMITTED":
            return "verified" if r["verified"] else "submitted"
        return "in_progress" if r["attempt_status"] in ("DRAFT", "IN_PROGRESS") else "not_started"
    subs = [{"student_id": r["user_id"], "student_name": analytics._name(r), "status": status(r), "mastery": mastery_label(r["mastery_score"]), "submitted_at": iso(r["submitted_at"])} for r in rows]
    mats = many(c, "SELECT m.material_id, m.title FROM assignment_materials am JOIN materials m ON m.document_id = am.document_id AND m.course_id = am.course_id WHERE am.assignment_id=%s", (aid,))
    cons = many(c, "SELECT k.name FROM assignment_concepts ac JOIN concepts k ON k.concept_id = ac.concept_id WHERE ac.assignment_id=%s ORDER BY k.name", (aid,))
    return {**assignment_view(a, attachments=attachments_for(c, aid, include_pending=True)), "submissions": subs,
            "linked_materials": [{"id": m["material_id"], "title": m["title"]} for m in mats], "concepts": [k["name"] for k in cons],
            "counts": {"students": len(subs), "submitted": sum(s["status"] in ("submitted", "verified") for s in subs), "verified": sum(s["status"] == "verified" for s in subs)}}


@router.get("/assignments/{assignment_id}")
def assignment_detail(assignment_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        return _detail(c, user, teacher_assignment(c, user, assignment_id))


@router.patch("/assignments/{assignment_id}")
def patch_assignment(assignment_id: str, body: AssignmentPatch, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Edits bump the assignment version (DB trigger); attempts keep pointing at the version they were started on."""
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id, lock=True)
        cols = {"title": body.title, "subject_area": body.topic, "instructions": body.prompt, "is_programming": body.is_programming, "due_at": body.due_at}
        cols = {k: v for k, v in cols.items() if v is not None}
        if body.clear_due_at:
            cols["due_at"] = None
        if cols:
            c.execute(f"UPDATE assignments SET {', '.join(f'{k} = %({k})s' for k in cols)} WHERE assignment_id = %(aid)s", {**cols, "aid": assignment_id})
        a = one(c, "SELECT * FROM assignments WHERE assignment_id=%s", (assignment_id,))
        _set_links(c, user, a, body.material_ids, body.concepts)
        return _detail(c, user, a)


def _transition(db, user, assignment_id: str, to: str):
    try:
        with db.tx() as c:
            teacher_assignment(c, user, assignment_id, lock=True)
            c.execute("UPDATE assignments SET status=%s WHERE assignment_id=%s", (to, assignment_id))
            return _detail(c, user, one(c, "SELECT * FROM assignments WHERE assignment_id=%s", (assignment_id,)))
    except pgerr.CheckViolation as exc:
        raise conflict(str(exc).split("\n")[0].replace("invalid assignment status transition", "You can't change the status from").replace(" -> ", " to "), "invalid_transition") from None


@router.post("/assignments/{assignment_id}/publish")
def publish(assignment_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    return _transition(db, user, assignment_id, "PUBLISHED")


@router.post("/assignments/{assignment_id}/unpublish")
def unpublish(assignment_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    return _transition(db, user, assignment_id, "DRAFT")


@router.post("/assignments/{assignment_id}/archive")
def archive(assignment_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    return _transition(db, user, assignment_id, "ARCHIVED")


# ---- supporting attachments (datasets, starter code, reference sheets), indexed for the Coach only for THIS assignment
@router.post("/assignments/{assignment_id}/attachments", status_code=202, dependencies=[Depends(upload_rate_limit)])
async def add_attachment(assignment_id: str, request: Request, file: UploadFile = File(...), user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    data = await read_upload(file, _limit())
    return await run_in_threadpool(_add_attachment_sync, request, db, user, assignment_id, file.filename, file.content_type, data)


def _add_attachment_sync(request, db, user, assignment_id, filename, ctype, data):
    pipeline = request.app.state.pipeline
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
    vf = validate_upload(filename, ctype, data, R.ATTACHMENT, role="SUPPORTING")
    key = None
    try:
        with db.tx() as c:
            row, key = pipeline.save(c, vf, data, purpose=R.ATTACHMENT, uploader_id=user.user_id, university_id=user.university_id, course_id=a["course_id"],
                                     classroom_id=a["classroom_id"], role="SUPPORTING")
            att = one(c, "INSERT INTO assignment_attachments (attachment_id, assignment_id, university_id, course_id, file_id, role) VALUES (%s,%s,%s,%s,%s,'SUPPORTING') RETURNING attachment_id",
                      (new_id("att"), assignment_id, user.university_id, a["course_id"], row["file_id"]))
        if row["status"] == "QUEUED":
            request.app.state.worker.kick()
        return {**file_view(row), "attachment_id": att["attachment_id"], "role": "SUPPORTING"}
    except pgerr.UniqueViolation as exc:
        if key:
            pipeline.rollback_object(key)
        raise conflict("This exact file is already in the course, so it can't be attached again. Link the existing material to the assignment instead.", "duplicate_file") from exc
    except Exception:
        if key:
            pipeline.rollback_object(key)
        raise


@router.delete("/assignments/{assignment_id}/attachments/{attachment_id}", status_code=204)
def remove_attachment(assignment_id: str, attachment_id: str, request: Request, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        teacher_assignment(c, user, assignment_id)
        att = one(c, "SELECT * FROM assignment_attachments WHERE attachment_id=%s AND assignment_id=%s", (attachment_id, assignment_id))
        if att is None:
            raise not_found("Attachment not found")
        if att["role"] == "PROMPT":
            raise AppError(400, "The prompt file can't be removed; edit the prompt text instead.", code="prompt_attachment")
    request.app.state.pipeline.delete_file(att["file_id"])


# ---- submission review (learning evidence for one student on one assignment)
@router.get("/assignments/{assignment_id}/students/{student_id}")
def submission_review(assignment_id: str, student_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        st = teacher_student(c, user, student_id)
        if not one(c, "SELECT 1 AS x FROM enrollments WHERE student_id=%s AND classroom_id=%s", (student_id, a["classroom_id"])):
            raise not_found("Student not found")
        att = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s ORDER BY attempt_number DESC LIMIT 1", (student_id, assignment_id))
        sub = one(c, "SELECT s.*, gu.first_name AS g_first, gu.last_name AS g_last FROM submissions s LEFT JOIN users gu ON gu.user_id=s.graded_by WHERE s.attempt_id=%s", (att["attempt_id"],)) if att else None
        f = one(c, "SELECT * FROM stored_files WHERE file_id=%s", (sub["file_id"],)) if sub and sub["file_id"] else None
        run = one(c, "SELECT * FROM verification_runs WHERE attempt_id=%s ORDER BY created_at DESC LIMIT 1", (att["attempt_id"],)) if att else None
        entries = many(c, """SELECT q.verification_type, q.question_text, r.response_text, res.outcome, res.feedback FROM verification_questions q
                               LEFT JOIN verification_responses r ON r.question_id = q.question_id LEFT JOIN verification_results res ON res.question_id = q.question_id
                              WHERE q.verification_id = %s ORDER BY q.display_order""", (run["verification_id"],)) if run else []
        sigs = many(c, "SELECT signal, observation, created_at FROM risk_signals WHERE student_id=%s AND assignment_id=%s ORDER BY created_at DESC LIMIT 10", (student_id, assignment_id))
        coach = one(c, "SELECT count(*)::int AS n FROM ai_interactions WHERE student_id=%s AND assignment_id=%s", (student_id, assignment_id))["n"]
        text = (sub or {}).get("submission_text") or ""
        return {"assignment": {"id": a["assignment_id"], "title": a["title"], "version": a["version"]},
                "student": {"id": st["user_id"], "name": analytics._name(st), "email": st["email"]},
                "attempt": None if not att else {"id": att["attempt_id"], "number": att["attempt_number"], "status": att["status"], "assignment_version": att["assignment_version"]},
                "submission": None if not sub else {"id": sub["submission_id"], "type": sub["submission_type"], "submitted_at": iso(sub["submitted_at"]), "text_preview": text[:4000],
                                                    "text_truncated": len(text) > 4000, "file": file_view(f) if f else None},
                "grade": grade_view(sub),
                "whiteboard": whiteboard_view(att["whiteboard"], include_scene=True) if att else None,
                "verification": None if not run else {"id": run["verification_id"], "status": run["status"], "outcome": run["overall_outcome"], "entries": [
                    {"label": e["verification_type"].capitalize(), "prompt": e["question_text"], "answer": e["response_text"], "outcome": e["outcome"], "feedback": e["feedback"]} for e in entries]},
                "coach_interactions": coach,
                "signals": [{"label": s["signal"].replace("_", " ").capitalize(), "detail": s["observation"] or "Observed by the AI Coach during a conversation.", "tone": "watch", "at": iso(s["created_at"])} for s in sigs],
                "signals_note": "Observed patterns only, not a determination of intent.",
                "risk": risk.assess_one(c, user.university_id, student_id, [assignment_id])}


def _gradable_submission(c, user: CurrentUser, assignment_id: str, student_id: str):
    """The student's latest submission for this assignment, after the same authorisation the review page uses."""
    a = teacher_assignment(c, user, assignment_id)
    teacher_student(c, user, student_id)
    if not one(c, "SELECT 1 AS x FROM enrollments WHERE student_id=%s AND classroom_id=%s", (student_id, a["classroom_id"])):
        raise not_found("Student not found")
    sub = one(c, """SELECT s.* FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id
                     WHERE t.student_id=%s AND t.assignment_id=%s ORDER BY t.attempt_number DESC LIMIT 1 FOR UPDATE OF s""", (student_id, assignment_id))
    if not sub:
        raise conflict("This student has not submitted work for this assignment yet.", "not_submitted")
    return sub


@router.put("/assignments/{assignment_id}/students/{student_id}/grade")
def set_grade(assignment_id: str, student_id: str, body: GradeIn, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    if body.score > body.max_score:
        raise AppError(422, "The score cannot be higher than the maximum score.", "invalid_grade")
    with db.tx() as c:
        sub = _gradable_submission(c, user, assignment_id, student_id)
        c.execute("UPDATE submissions SET score=%s, max_score=%s, feedback=%s, graded_at=now(), graded_by=%s WHERE submission_id=%s",
                  (body.score, body.max_score, body.feedback or None, user.user_id, sub["submission_id"]))
        row = one(c, "SELECT s.*, gu.first_name AS g_first, gu.last_name AS g_last FROM submissions s LEFT JOIN users gu ON gu.user_id=s.graded_by WHERE s.submission_id=%s", (sub["submission_id"],))
        return {"grade": grade_view(row)}


@router.delete("/assignments/{assignment_id}/students/{student_id}/grade")
def clear_grade(assignment_id: str, student_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        sub = _gradable_submission(c, user, assignment_id, student_id)
        c.execute("UPDATE submissions SET score=NULL, max_score=NULL, feedback=NULL, graded_at=NULL, graded_by=NULL WHERE submission_id=%s", (sub["submission_id"],))
        return {"grade": None}
