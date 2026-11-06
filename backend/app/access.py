"""
Centralised authorisation. Every route gets its data through these functions; they are the application-layer twin of
the RLS helpers in migration 013 (same rules, so the Data API and the backend can never disagree).

Rules:
  * everything is scoped to the caller's university;
  * a student reaches a classroom only through an ACTIVE enrolment, and an assignment only if it is PUBLISHED;
  * an instructor reaches a course if they are its instructor or teach one of its classrooms;
  * "exists but not yours" and "does not exist" are both 404, so identifiers cannot be probed.
"""
from __future__ import annotations

import psycopg

from .auth import CurrentUser
from .db import Row, many, one
from .errors import not_found


# ------------------------------------------------------------------ instructor
def teacher_course(conn: psycopg.Connection, user: CurrentUser, course_id: str, lock: bool = False) -> Row:
    row = one(conn, f"""
        SELECT c.* FROM courses c
         WHERE c.course_id = %s AND c.university_id = %s
           AND (c.instructor_id = %s OR EXISTS (SELECT 1 FROM classrooms k WHERE k.course_id = c.course_id AND k.professor_id = %s))
        {'FOR UPDATE OF c' if lock else ''}""", (course_id, user.university_id, user.user_id, user.user_id))
    if row is None or not user.is_professor:
        raise not_found("Course not found")
    return row


def teacher_classroom(conn: psycopg.Connection, user: CurrentUser, classroom_id: str) -> Row:
    row = one(conn, """
        SELECT k.* FROM classrooms k JOIN courses c ON c.course_id = k.course_id
         WHERE k.classroom_id = %s AND k.university_id = %s AND (k.professor_id = %s OR c.instructor_id = %s)""",
              (classroom_id, user.university_id, user.user_id, user.user_id))
    if row is None or not user.is_professor:
        raise not_found("Classroom not found")
    return row


def teacher_classrooms(conn: psycopg.Connection, user: CurrentUser, course_id: str) -> list[Row]:
    teacher_course(conn, user, course_id)
    return many(conn, "SELECT * FROM classrooms WHERE course_id = %s AND university_id = %s ORDER BY created_at", (course_id, user.university_id))


def default_classroom(conn: psycopg.Connection, user: CurrentUser, course_id: str, classroom_id: str | None = None) -> Row:
    """The frontend has no 'classroom' concept, so course-level actions target the course's classroom. If a course has
    several, the caller must say which one."""
    rooms = teacher_classrooms(conn, user, course_id)
    if classroom_id:
        for r in rooms:
            if r["classroom_id"] == classroom_id:
                return r
        raise not_found("Classroom not found")
    if not rooms:
        raise not_found("This course has no classroom yet")
    if len(rooms) > 1:
        from .errors import AppError
        raise AppError(422, "This course has several classrooms; specify classroom_id.", code="classroom_required")
    return rooms[0]


def teacher_assignment(conn: psycopg.Connection, user: CurrentUser, assignment_id: str, lock: bool = False) -> Row:
    row = one(conn, f"""
        SELECT a.* FROM assignments a JOIN courses c ON c.course_id = a.course_id
         WHERE a.assignment_id = %s AND a.university_id = %s
           AND (c.instructor_id = %s OR EXISTS (SELECT 1 FROM classrooms k WHERE k.course_id = c.course_id AND k.professor_id = %s))
        {'FOR UPDATE OF a' if lock else ''}""", (assignment_id, user.university_id, user.user_id, user.user_id))
    if row is None or not user.is_professor:
        raise not_found("Assignment not found")
    return row


def teacher_student(conn: psycopg.Connection, user: CurrentUser, student_id: str) -> Row:
    """A student is visible to an instructor only through a classroom the instructor teaches."""
    row = one(conn, """
        SELECT u.user_id, u.email, u.first_name, u.last_name FROM users u
         WHERE u.user_id = %s AND u.university_id = %s AND u.role = 'STUDENT'
           AND EXISTS (SELECT 1 FROM enrollments e JOIN classrooms k ON k.classroom_id = e.classroom_id JOIN courses c ON c.course_id = k.course_id
                        WHERE e.student_id = u.user_id AND (k.professor_id = %s OR c.instructor_id = %s))""",
              (student_id, user.university_id, user.user_id, user.user_id))
    if row is None or not user.is_professor:
        raise not_found("Student not found")
    return row


# ------------------------------------------------------------------ student
def student_classroom_ids(conn: psycopg.Connection, user: CurrentUser) -> list[str]:
    return [r["classroom_id"] for r in many(conn, "SELECT classroom_id FROM enrollments WHERE student_id=%s AND university_id=%s AND status='active' AND classroom_id IS NOT NULL",
                                            (user.user_id, user.university_id))]


def student_course(conn: psycopg.Connection, user: CurrentUser, course_id: str) -> Row:
    row = one(conn, """
        SELECT c.*, e.classroom_id FROM courses c JOIN enrollments e ON e.course_id = c.course_id
         WHERE c.course_id = %s AND c.university_id = %s AND e.student_id = %s AND e.status = 'active'
         ORDER BY e.created_at LIMIT 1""", (course_id, user.university_id, user.user_id))
    if row is None or not user.is_student:
        raise not_found("Course not found")
    return row


def student_assignment(conn: psycopg.Connection, user: CurrentUser, assignment_id: str) -> Row:
    row = one(conn, """
        SELECT a.* FROM assignments a
         WHERE a.assignment_id = %s AND a.university_id = %s AND a.status = 'PUBLISHED'
           AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = %s AND e.classroom_id = a.classroom_id AND e.status = 'active')""",
              (assignment_id, user.university_id, user.user_id))
    if row is None or not user.is_student:
        raise not_found("Assignment not found")
    return row


def student_attempt(conn: psycopg.Connection, user: CurrentUser, attempt_id: str, lock: bool = False) -> Row:
    row = one(conn, f"SELECT * FROM attempts WHERE attempt_id = %s AND student_id = %s AND university_id = %s {'FOR UPDATE' if lock else ''}",
              (attempt_id, user.user_id, user.university_id))
    if row is None:
        raise not_found("Attempt not found")
    student_assignment(conn, user, row["assignment_id"])       # the assignment must still be visible to the student
    return row


# ------------------------------------------------------------------ files (mirror of app.file_visible in migration 013)
def visible_file(conn: psycopg.Connection, user: CurrentUser, file_id: str) -> Row:
    row = one(conn, """
        SELECT f.* FROM stored_files f
         WHERE f.file_id = %s AND f.university_id = %s AND (
               (%s AND EXISTS (SELECT 1 FROM courses c WHERE c.course_id = f.course_id
                                AND (c.instructor_id = %s OR EXISTS (SELECT 1 FROM classrooms k WHERE k.course_id = c.course_id AND k.professor_id = %s))))
            OR (f.purpose = 'SUBMISSION' AND f.uploader_id = %s)
            OR (f.purpose = 'MATERIAL' AND f.status IN ('READY','STORED_ONLY') AND EXISTS (
                    SELECT 1 FROM enrollments e WHERE e.student_id = %s AND e.classroom_id = f.classroom_id AND e.status = 'active'))
            OR (f.purpose = 'ASSIGNMENT_ATTACHMENT' AND f.status IN ('READY','STORED_ONLY') AND EXISTS (
                    SELECT 1 FROM assignment_attachments aa JOIN assignments a ON a.assignment_id = aa.assignment_id
                     JOIN enrollments e ON e.classroom_id = a.classroom_id
                     WHERE aa.file_id = f.file_id AND a.status = 'PUBLISHED' AND e.student_id = %s AND e.status = 'active')))""",
              (file_id, user.university_id, user.is_professor, user.user_id, user.user_id, user.user_id, user.user_id, user.user_id))
    if row is None:
        raise not_found("File not found")
    return row


# ------------------------------------------------------------------ retrieval whitelist for the AI (see ai_adapter)
def allowed_document_ids(conn: psycopg.Connection, assignment: Row) -> list[str]:
    """Documents the Coach may retrieve for this assignment: READY course materials of the assignment's classroom,
    documents explicitly linked to the assignment, and the assignment's own READY attachments. Derived from live rows,
    so a deleted or unlisted file is unreachable even if stale chunks remain in the index."""
    rows = many(conn, """
        SELECT f.document_id FROM stored_files f
         WHERE f.document_id IS NOT NULL AND f.status = 'READY' AND f.university_id = %(u)s AND f.course_id = %(c)s
           AND ((f.purpose = 'MATERIAL' AND f.classroom_id = %(k)s)
             OR (f.purpose = 'ASSIGNMENT_ATTACHMENT' AND EXISTS (SELECT 1 FROM assignment_attachments aa WHERE aa.file_id = f.file_id AND aa.assignment_id = %(a)s)))
        UNION
        SELECT am.document_id FROM assignment_materials am WHERE am.assignment_id = %(a)s AND am.university_id = %(u)s""",
                {"u": assignment["university_id"], "c": assignment["course_id"], "k": assignment["classroom_id"], "a": assignment["assignment_id"]})
    return sorted({r["document_id"] for r in rows})


# ------------------------------------------------------------------ trusted application context for the Coach
def coach_application_context(conn: psycopg.Connection, assignment: Row) -> dict:
    """Relational facts the Coach is supposed to know EXACTLY (not by semantic search): university / course / classroom names,
    the assignment's declared concepts, its attachments and the course-material catalogue. Everything is read from live rows of
    the assignment's own tenant, classroom and course, so it can never widen what the student may see: the lists mirror
    `visible_file` (READY / STORED_ONLY only). Titles and file names are free text; the AI side sanitises them before prompting.

    Before this existed `student_assignment()` returned only `assignments.*`, so every one of these fields reached the Coach
    empty and the prompt told the model "Course materials available: (0) (none uploaded yet)" even when materials existed."""
    a = assignment
    ctx = one(conn, """
        SELECT u.name AS university_name, c.code AS course_code, c.title AS course_title, k.name AS classroom_name
          FROM courses c JOIN universities u ON u.university_id = c.university_id
          LEFT JOIN classrooms k ON k.classroom_id = %s AND k.course_id = c.course_id
         WHERE c.course_id = %s AND c.university_id = %s""", (a["classroom_id"], a["course_id"], a["university_id"])) or {}
    attachments = many(conn, """
        SELECT f.original_filename AS filename, aa.role FROM assignment_attachments aa JOIN stored_files f ON f.file_id = aa.file_id
         WHERE aa.assignment_id = %s AND aa.university_id = %s AND f.status IN ('READY','STORED_ONLY') ORDER BY aa.created_at""",
                       (a["assignment_id"], a["university_id"]))
    mats = many(conn, """
        SELECT m.title, f.extension AS file_type, (f.index_mode = 'RAG' AND f.status = 'READY') AS searchable
          FROM materials m JOIN stored_files f ON f.file_id = m.file_id
         WHERE m.classroom_id = %s AND m.university_id = %s AND f.status IN ('READY','STORED_ONLY') ORDER BY m.created_at DESC""",
                (a["classroom_id"], a["university_id"]))
    concepts = many(conn, """
        SELECT k.name FROM assignment_concepts ac JOIN concepts k ON k.concept_id = ac.concept_id
         WHERE ac.assignment_id = %s AND ac.university_id = %s ORDER BY k.name""", (a["assignment_id"], a["university_id"]))
    return {**ctx, "attachments": attachments, "materials": mats[:50], "materials_total": len(mats),
            "concepts": [r["name"] for r in concepts][:20]}
