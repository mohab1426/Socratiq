from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from psycopg import errors as pgerr

from ..access import student_assignment, student_attempt, student_course
from ..auth import CurrentUser, get_db, require_student
from ..board_auth import is_registered_coach_element, verify_coach_element_id
from ..config import get_backend_config
from ..db import Database, many, new_id, one
from ..errors import AppError, conflict, not_found
from ..files import registry as R
from ..files.errors import ExtractionError
from ..files.validation import validate_upload
from ..ratelimit import join_rate_limit, upload_rate_limit
from ..records import insert_event, record_revision_if_any
from ..schemas import AttemptPatch, JoinIn, SubmitTextIn, WhiteboardIn
from ..uploads import read_upload
from ai.whiteboard.scene import SCENE_MAX_BYTES, enforce_scene_authorship
from ..views import assignment_view, attachments_for, course_view, file_view, grade_view, iso, material_view, student_status, whiteboard_view

router = APIRouter(prefix="/student", tags=["student"])
OPEN = ("DRAFT", "IN_PROGRESS")

_COURSE_SQL = """
SELECT c.*, e.classroom_id, COALESCE(NULLIF(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), 'Instructor') AS teacher_name,
  (SELECT count(*) FROM materials m LEFT JOIN stored_files f ON f.file_id = m.file_id
    WHERE m.classroom_id = e.classroom_id AND (f.file_id IS NULL OR f.status IN ('READY','STORED_ONLY')))::int AS material_count,
  (SELECT count(*) FROM assignments a WHERE a.classroom_id = e.classroom_id AND a.status = 'PUBLISHED')::int AS assignment_count
FROM enrollments e JOIN courses c ON c.course_id = e.course_id LEFT JOIN users p ON p.user_id = c.instructor_id
WHERE e.student_id = %s AND e.university_id = %s AND e.status = 'active' {extra} ORDER BY c.title"""


def _card(r) -> dict:
    return course_view(r, teacher_name=r["teacher_name"], material_count=r["material_count"], assignment_count=r["assignment_count"], classroom_id=r["classroom_id"])


@router.get("/courses")
def list_courses(user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        return {"courses": [_card(r) for r in many(c, _COURSE_SQL.format(extra=""), (user.user_id, user.university_id))]}


@router.get("/home")
def home(user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        courses = many(c, _COURSE_SQL.format(extra=""), (user.user_id, user.university_id))
        rooms = [r["classroom_id"] for r in courses]
        asgs = many(c, "SELECT * FROM assignments WHERE classroom_id = ANY(%s) AND status='PUBLISHED' ORDER BY due_at NULLS LAST, created_at", (rooms,)) if rooms else []
        return {"user": {"id": user.user_id, "name": user.name}, "courses": [_card(r) for r in courses],
                "assignments": [assignment_view(a, status=student_status(c, user.user_id, a["assignment_id"])) for a in asgs]}


@router.post("/courses/join", status_code=201, dependencies=[Depends(join_rate_limit)])
def join_course(body: JoinIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Join by the classroom's random invite code. Same-university only; a student an instructor removed cannot re-join themselves."""
    with db.tx() as c:
        room = one(c, """SELECT k.classroom_id, k.course_id, k.university_id, k.join_enabled, co.status AS course_status FROM classrooms k JOIN courses co ON co.course_id = k.course_id
                          WHERE k.join_code = %s""", (body.code,))
        # identical message for unknown / other-university / disabled so codes cannot be probed across tenants
        if room is None or room["university_id"] != user.university_id or not room["join_enabled"] or room["course_status"] != "ACTIVE":
            raise AppError(404, "That invite code isn't valid. Check it with your instructor.", code="invalid_code")
        existing = one(c, "SELECT enrollment_id, status FROM enrollments WHERE student_id=%s AND classroom_id=%s", (user.user_id, room["classroom_id"]))
        if existing and existing["status"] == "inactive":
            raise AppError(403, "You were removed from this class. Ask your instructor to add you back.", code="removed")
        if not existing:
            c.execute("INSERT INTO enrollments (enrollment_id, student_id, course_id, classroom_id, university_id, status) VALUES (%s,%s,%s,%s,%s,'active') ON CONFLICT (student_id, classroom_id) DO NOTHING",
                      (new_id("enr"), user.user_id, room["course_id"], room["classroom_id"], user.university_id))
        row = one(c, _COURSE_SQL.format(extra="AND c.course_id = %s"), (user.user_id, user.university_id, room["course_id"]))
        return _card(row)


@router.get("/courses/{course_id}")
def course_detail(course_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        student_course(c, user, course_id)
        row = one(c, _COURSE_SQL.format(extra="AND c.course_id = %s"), (user.user_id, user.university_id, course_id))
        room = row["classroom_id"]
        mats = many(c, """SELECT m.*, f.file_id AS f_file_id FROM materials m LEFT JOIN stored_files f ON f.file_id = m.file_id
                           WHERE m.classroom_id = %s AND (f.file_id IS NULL OR f.status IN ('READY','STORED_ONLY')) ORDER BY m.created_at DESC""", (room,))
        files = {f["file_id"]: f for f in many(c, "SELECT * FROM stored_files WHERE file_id = ANY(%s)", ([m["file_id"] for m in mats if m["file_id"]],))} if mats else {}
        asgs = many(c, "SELECT * FROM assignments WHERE classroom_id=%s AND status='PUBLISHED' ORDER BY due_at NULLS LAST, created_at", (room,))
        return {"course": _card(row), "materials": [material_view(m, files.get(m["file_id"])) for m in mats],
                "assignments": [assignment_view(a, status=student_status(c, user.user_id, a["assignment_id"])) for a in asgs]}


@router.get("/materials/{material_id}")
def material_detail(material_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        m = one(c, "SELECT * FROM materials WHERE material_id=%s AND university_id=%s", (material_id, user.university_id))
        if m is None or not one(c, "SELECT 1 AS x FROM enrollments WHERE student_id=%s AND classroom_id=%s AND status='active'", (user.user_id, m["classroom_id"])):
            raise not_found("Material not found")
        f = one(c, "SELECT * FROM stored_files WHERE file_id=%s", (m["file_id"],)) if m["file_id"] else None
        if f and f["status"] not in ("READY", "STORED_ONLY"):
            raise not_found("Material not found")
        return material_view(m, f)


# ------------------------------------------------------------------ assignments / attempts
def _attempt_view(a) -> dict:
    return {"id": a["attempt_id"], "attempt_number": a["attempt_number"], "status": a["status"], "started_at": iso(a["started_at"]),
            "ended_at": iso(a["ended_at"]), "draft_text": a.get("draft_text"), "assignment_version": a["assignment_version"]}


@router.get("/assignments/{assignment_id}")
def assignment_detail(assignment_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        a = student_assignment(c, user, assignment_id)
        att = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s ORDER BY attempt_number DESC LIMIT 1", (user.user_id, assignment_id))
        sub = one(c, "SELECT s.submission_id, s.submission_type, s.submitted_at, s.score, s.max_score, s.feedback, s.graded_at, f.original_filename, gu.first_name AS g_first, gu.last_name AS g_last FROM submissions s LEFT JOIN stored_files f ON f.file_id=s.file_id LEFT JOIN users gu ON gu.user_id=s.graded_by WHERE s.attempt_id=%s", (att["attempt_id"],)) if att else None
        ver = one(c, "SELECT verification_id, status, overall_outcome FROM verification_runs WHERE attempt_id=%s ORDER BY created_at DESC LIMIT 1", (att["attempt_id"],)) if att else None
        out = assignment_view(a, status=student_status(c, user.user_id, assignment_id), attachments=attachments_for(c, assignment_id, include_pending=False))
        out.update({"attempt": _attempt_view(att) if att else None,
                    "submission": None if not sub else {"id": sub["submission_id"], "type": sub["submission_type"], "submitted_at": iso(sub["submitted_at"]), "filename": sub["original_filename"]},
                    "grade": grade_view(sub),
                    "verification": None if not ver else {"id": ver["verification_id"], "status": ver["status"], "outcome": ver["overall_outcome"]}})
        return out


@router.post("/assignments/{assignment_id}/attempts")
def start_attempt(assignment_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Idempotent: returns the open attempt if there is one. Safe under double-clicks/parallel tabs (partial unique index)."""
    for _ in range(3):
        with db.tx() as c:
            student_assignment(c, user, assignment_id)
            existing = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s AND status IN ('DRAFT','IN_PROGRESS')", (user.user_id, assignment_id))
            if existing:
                return _attempt_view(existing)
            row = one(c, """INSERT INTO attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status)
                            SELECT %s,%s,%s,%s, COALESCE(max(attempt_number),0)+1, 'IN_PROGRESS' FROM attempts WHERE student_id=%s AND assignment_id=%s
                            ON CONFLICT DO NOTHING RETURNING *""", (new_id("att"), user.user_id, assignment_id, user.university_id, user.user_id, assignment_id))
            if row:
                insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="ATTEMPT", assignment_id=assignment_id,
                             attempt_id=row["attempt_id"], payload={"attempt_number": row["attempt_number"]})
                return _attempt_view(row)
    raise conflict("Could not start an attempt; please retry.", "attempt_race")


@router.patch("/attempts/{attempt_id}")
def save_draft(attempt_id: str, body: AttemptPatch, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        att = student_attempt(c, user, attempt_id, lock=True)
        if att["status"] not in OPEN:
            raise conflict("This attempt is already submitted.", "attempt_closed")
        row = one(c, "UPDATE attempts SET draft_text=%s WHERE attempt_id=%s RETURNING *", (body.draft_text, attempt_id))
        record_revision_if_any(c, student_id=user.user_id, university_id=user.university_id, assignment_id=att["assignment_id"], attempt_id=attempt_id, new_text=body.draft_text or "")
        return _attempt_view(row)


def _open_attempt_for(c, user: CurrentUser, assignment_id: str, lock: bool = False):
    a = student_assignment(c, user, assignment_id)
    att = one(c, f"SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s AND status IN ('DRAFT','IN_PROGRESS') {'FOR UPDATE' if lock else ''}", (user.user_id, a["assignment_id"]))
    if att is None:
        raise conflict("Start an attempt before using the whiteboard.", "no_open_attempt")
    return att


@router.get("/assignments/{assignment_id}/whiteboard")
def get_whiteboard(assignment_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        a = student_assignment(c, user, assignment_id)
        att = one(c, "SELECT whiteboard, whiteboard_updated_at FROM attempts WHERE student_id=%s AND assignment_id=%s ORDER BY attempt_number DESC LIMIT 1", (user.user_id, a["assignment_id"]))
        return {**whiteboard_view(att and att["whiteboard"], include_scene=True), "updated_at": iso(att and att["whiteboard_updated_at"])}


@router.put("/assignments/{assignment_id}/whiteboard")
def save_whiteboard(assignment_id: str, body: WhiteboardIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Autosave target for the thinking space. Replaces the board of the student's OPEN attempt (a submitted attempt's board is frozen)."""
    with db.tx() as c:
        att = _open_attempt_for(c, user, assignment_id, lock=True)
        stored = att.get("whiteboard") or {}
        if body.scene is not None:
            # Native board save: ONLY the scene changes. Legacy steps/strokes/elements (incl. everything the Coach wrote) stay exactly as stored,
            # so nothing existing is ever deleted by a save, and older clients keep working on the legacy data.
            trusted = {e["id"] for e in (stored.get("elements") or []) if e.get("author") == "coach"}
            board = {**stored, "scene": enforce_scene_authorship(body.scene, trusted)}
            serialized = json.dumps(board)
            if len(serialized.encode("utf-8")) > SCENE_MAX_BYTES + 500_000:
                raise AppError(413, "The board is too large to save. Remove some images or large drawings.", code="board_too_large")
            row = one(c, "UPDATE attempts SET whiteboard=%s::jsonb, whiteboard_updated_at=now() WHERE attempt_id=%s RETURNING whiteboard_updated_at",
                      (serialized, att["attempt_id"]))
            return {**whiteboard_view(board, include_scene=True), "updated_at": iso(row["whiteboard_updated_at"])}
        board = body.model_dump(mode="json", exclude_none=True)
        # Authorship is decided strictly by trusted SERVER evidence, never by arbitrary client claims:
        # 1. Existing coach elements with unchanged content stay "coach".
        # 2. Existing coach elements modified by the student become author "student", with provenance preserved (original_author: "coach", student_modified: True).
        # 3. New elements can only be author "coach" if their ID bears a valid server HMAC signature for this attempt or was registered in learning_events.
        # 4. Student elements cannot masquerade as coach elements under any circumstances.
        prev = {e["id"]: e for e in ((att.get("whiteboard") or {}).get("elements") or [])}
        for e in board["elements"]:
            p = prev.get(e["id"])
            if p is not None:
                if p.get("author") == "coach":
                    same = p.get("kind") == e.get("kind") and p.get("text") == e.get("text") and p.get("latex") == e.get("latex") and p.get("shape") == e.get("shape")
                    if same:
                        e["author"] = "coach"
                        e["original_author"] = "coach"
                    else:
                        e["author"] = "student"
                        e["original_author"] = "coach"
                        e["student_modified"] = True
                else:
                    e["author"] = "student"
                    if p.get("original_author") == "coach":
                        e["original_author"] = "coach"
                        e["student_modified"] = True
                    else:
                        e.pop("original_author", None)
                        e.pop("student_modified", None)
            else:
                claimed_coach = e.get("author") == "coach"
                if claimed_coach and (
                    verify_coach_element_id(att["attempt_id"], e.get("id"))
                    or is_registered_coach_element(c, att["attempt_id"], e.get("id"))
                ):
                    e["author"] = "coach"
                    e["original_author"] = "coach"
                else:
                    e["author"] = "student"
                    e.pop("original_author", None)
                    e.pop("student_modified", None)
        board["next_seq"] = max(board.get("next_seq", 0), max((e["seq"] + 1 for e in board["elements"]), default=0), (att.get("whiteboard") or {}).get("next_seq", 0))
        if stored.get("scene"):
            board["scene"] = stored["scene"]               # a legacy client's save must never drop the native board
        serialized = json.dumps({k: v for k, v in board.items() if k != "scene"})
        if len(serialized.encode("utf-8")) > 380_000:
            raise AppError(413, "Whiteboard content exceeds maximum allowed storage limit (400KB). Please reduce images or strokes.", code="board_too_large")
        row = one(c, "UPDATE attempts SET whiteboard=%s::jsonb, whiteboard_updated_at=now() WHERE attempt_id=%s RETURNING whiteboard_updated_at",
                  (json.dumps(board), att["attempt_id"]))
        return {**whiteboard_view(board, include_scene=True), "updated_at": iso(row["whiteboard_updated_at"])}


def _finalize(c, user: CurrentUser, attempt_id: str, *, text: Optional[str], file_id: Optional[str], file_key: Optional[str], kind: str):
    att = student_attempt(c, user, attempt_id, lock=True)
    if att["status"] not in OPEN:
        raise conflict("This attempt was already submitted.", "already_submitted")
    sid = new_id("sub")
    c.execute("""INSERT INTO submissions (submission_id, attempt_id, submission_type, submission_text, submission_file_url, university_id, student_id, assignment_id, file_id)
                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (sid, attempt_id, kind, text, file_key, user.university_id, user.user_id, att["assignment_id"], file_id))
    c.execute("UPDATE attempts SET status='SUBMITTED' WHERE attempt_id=%s", (attempt_id,))
    c.execute("UPDATE ai_sessions SET status='ENDED', ended_at=now() WHERE attempt_id=%s AND status='ACTIVE'", (attempt_id,))
    insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="SUBMISSION", assignment_id=att["assignment_id"], attempt_id=attempt_id,
                 payload={"submission_id": sid, "type": kind, "characters": len(text or "")})
    return {"submission_id": sid, "attempt_id": attempt_id, "status": "submitted"}


@router.post("/attempts/{attempt_id}/submit")
def submit_text(attempt_id: str, body: SubmitTextIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    try:
        with db.tx() as c:
            return _finalize(c, user, attempt_id, text=body.text, file_id=None, file_key=None, kind="text")
    except pgerr.UniqueViolation:
        raise conflict("This attempt was already submitted.", "already_submitted") from None


@router.post("/attempts/{attempt_id}/submit-file", dependencies=[Depends(upload_rate_limit)])
async def submit_file(attempt_id: str, request: Request, file: UploadFile = File(...), user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Upload the work as a file. The file is validated, stored privately, its text is extracted (so the Coach and the instructor can
    read it) and the attempt is submitted, all in ONE transaction. Student files are never indexed into course retrieval."""
    data = await read_upload(file, get_backend_config().max_upload_mb * 1024 * 1024)
    return await run_in_threadpool(_submit_file_sync, request, db, user, attempt_id, file.filename, file.content_type, data)


def _submit_file_sync(request: Request, db: Database, user: CurrentUser, attempt_id: str, filename: str, ctype: Optional[str], data: bytes) -> dict:
    pipeline = request.app.state.pipeline
    with db.tx() as c:
        att = student_attempt(c, user, attempt_id)                    # authorise + fail fast before any heavy work
        asg = student_assignment(c, user, att["assignment_id"])
    vf = validate_upload(filename, ctype, data, R.SUBMISSION)
    mode, _ = R.mode_for(vf.spec, R.SUBMISSION)
    extracted = None
    if mode == R.EXTRACT_ONLY:
        try:
            extracted = pipeline.extract_now(vf, data)
        except ExtractionError as exc:
            raise AppError(422, f"We couldn't read this file: {exc}", code=exc.code) from exc
    key = None
    try:
        with db.tx() as c:
            row, key = pipeline.save(c, vf, data, purpose=R.SUBMISSION, uploader_id=user.user_id, university_id=user.university_id,
                                     course_id=asg["course_id"], classroom_id=asg["classroom_id"])
            if extracted is not None:
                row = pipeline.mark_done(c, row["file_id"], extracted)
            out = _finalize(c, user, attempt_id, text=(extracted.text if extracted and extracted.pages else None), file_id=row["file_id"], file_key=key, kind="file")
        out["file"] = file_view(row)
        out["text_extracted"] = bool(extracted and extracted.pages)
        if not out["text_extracted"]:
            out["warning"] = "We stored your file but couldn't read text from it, so the AI Coach and your instructor will only see the file itself."
        return out
    except Exception as exc:
        if key:
            pipeline.rollback_object(key)
        if isinstance(exc, pgerr.UniqueViolation):
            raise conflict("This attempt was already submitted.", "already_submitted") from None
        raise


# ------------------------------------------------------------------ coach transcript
@router.get("/assignments/{assignment_id}/coach")
def coach_history(assignment_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """The student's own transcript for the current (or latest) attempt, for reloading the chat page."""
    with db.tx() as c:
        student_assignment(c, user, assignment_id)
        sess = one(c, """SELECT s.session_id FROM ai_sessions s JOIN attempts t ON t.attempt_id = s.attempt_id
                          WHERE s.student_id=%s AND s.assignment_id=%s ORDER BY t.attempt_number DESC, s.started_at DESC LIMIT 1""", (user.user_id, assignment_id))
        if not sess:
            return {"messages": []}
        rows = many(c, """SELECT m.message_id, m.sender, m.content, m.created_at, i.intervention_type FROM messages m
                           LEFT JOIN ai_interactions i ON i.interaction_id = m.interaction_id WHERE m.session_id=%s ORDER BY m.created_at, m.message_id""", (sess["session_id"],))
        kind = {"HINT": "hint", "QUESTION": "question", "EXPLANATION": "explanation"}
        return {"messages": [{"id": r["message_id"], "role": "student" if r["sender"] == "STUDENT" else "coach", "content": r["content"],
                              "kind": kind.get(r["intervention_type"]), "created_at": iso(r["created_at"])} for r in rows]}
