"""Response shaping: DB rows -> the JSON the frontend consumes (snake_case; the frontend maps to its own types)."""
from __future__ import annotations

from typing import Any, Optional

from .db import Row, many, one
from .files import registry as R

_FE_KIND = {"PRESENTATION": "slides", "SPREADSHEET": "dataset"}


def iso(dt) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


def file_view(f: Row) -> dict[str, Any]:
    return {"file_id": f["file_id"], "filename": f["original_filename"], "extension": f["extension"], "mime_type": f["mime_type"],
            "size_bytes": f["size_bytes"], "kind": f["kind"], "index_mode": f["index_mode"], "status": f["status"],
            "note": f.get("processing_note"), "error": f.get("processing_error"), "page_count": f.get("page_count"),
            "created_at": iso(f["created_at"]), "processed_at": iso(f.get("processed_at"))}


def material_view(m: Row, f: Optional[Row]) -> dict[str, Any]:
    kind = _FE_KIND.get(f["kind"], "reading") if f else "reading"
    summary = ""
    if f:
        label = R.get_spec(f["extension"]).label if R.get_spec(f["extension"]) else f["extension"].upper()
        summary = f"{label} · {f['size_bytes'] / 1_048_576:.1f} MB" if f["size_bytes"] >= 104_858 else f"{label} · {max(1, f['size_bytes'] // 1024)} KB"
    return {"id": m["material_id"], "course_id": m["course_id"], "classroom_id": m["classroom_id"], "title": m["title"], "summary": summary,
            "kind": kind, "created_at": iso(m["created_at"]), "file": file_view(f) if f else None}


def course_view(c: Row, *, teacher_name: str, material_count: int, assignment_count: int, student_count: Optional[int] = None,
                classroom_id: Optional[str] = None, join_code: Optional[str] = None) -> dict[str, Any]:
    out = {"id": c["course_id"], "code": c["code"], "name": c["title"], "description": c.get("description") or "", "teacher": teacher_name,
           "status": "Active" if c["status"] == "ACTIVE" else "Archived", "color": c["color"], "material_count": material_count,
           "assignment_count": assignment_count, "classroom_id": classroom_id}
    if student_count is not None:
        out["student_count"] = student_count
    if join_code is not None:
        out["join_code"] = join_code
    return out


def assignment_view(a: Row, *, status: Optional[str] = None, attachments: Optional[list[dict]] = None) -> dict[str, Any]:
    out = {"id": a["assignment_id"], "course_id": a["course_id"], "classroom_id": a["classroom_id"], "title": a["title"], "topic": a.get("subject_area") or "",
           "prompt": a["instructions"], "due_date": iso(a.get("due_at")), "ai_mode": a["default_policy"].lower(), "is_programming": a["is_programming"],
           "lifecycle": a["status"], "version": a["version"], "published_at": iso(a.get("published_at")), "updated_at": iso(a.get("updated_at"))}
    if status is not None:
        out["status"] = status
    if attachments is not None:
        out["attachments"] = attachments
    return out


def student_status(conn, student_id: str, assignment_id: str) -> str:
    """not_started | in_progress | submitted | verified, derived from the latest attempt and its verification run."""
    att = one(conn, "SELECT attempt_id, status FROM attempts WHERE student_id=%s AND assignment_id=%s ORDER BY attempt_number DESC LIMIT 1", (student_id, assignment_id))
    if att is None:
        return "not_started"
    if att["status"] in ("DRAFT", "IN_PROGRESS"):
        return "in_progress"
    if att["status"] == "SUBMITTED":
        done = one(conn, "SELECT 1 AS x FROM verification_runs WHERE attempt_id=%s AND status='COMPLETED' LIMIT 1", (att["attempt_id"],))
        return "verified" if done else "submitted"
    return "not_started"          # ABANDONED


def attachments_for(conn, assignment_id: str, *, include_pending: bool) -> list[dict]:
    rows = many(conn, """SELECT f.*, aa.attachment_id, aa.role FROM assignment_attachments aa JOIN stored_files f ON f.file_id = aa.file_id
                          WHERE aa.assignment_id = %s ORDER BY aa.created_at""", (assignment_id,))
    return [{**file_view(r), "attachment_id": r["attachment_id"], "role": r["role"]} for r in rows
            if include_pending or r["status"] in ("READY", "STORED_ONLY")]


def grade_view(sub: Optional[Row]) -> Optional[dict[str, Any]]:
    """The ONE serialisation of a grade, used by the student and teacher endpoints so the two can never disagree."""
    if not sub or sub.get("score") is None:
        return None
    score, mx = float(sub["score"]), float(sub["max_score"])
    return {"score": score, "max_score": mx, "percentage": round(score / mx * 100, 1), "feedback": sub.get("feedback"),
            "graded_at": iso(sub.get("graded_at")),
            "graded_by": " ".join(p for p in (sub.get("g_first"), sub.get("g_last")) if p) or None}


def whiteboard_view(raw: Optional[dict], include_scene: bool = False) -> dict[str, Any]:
    """The student's thinking space as stored on the attempt: typed steps + freehand strokes (empty board if none yet).
    `include_scene` adds the native board scene (large): used by the board's own load/save and the teacher's read-only view, never by Coach turns."""
    wb = raw or {}
    out = {"steps": wb.get("steps", []), "strokes": wb.get("strokes", []), "elements": wb.get("elements", []), "next_seq": wb.get("next_seq", 0)}
    if include_scene and wb.get("scene"):
        out["scene"] = wb["scene"]
    return out
