"""Writers for the learning-process record: events, evidence, risk indicators, concept state.
Everything is written inside the caller's transaction, so a record can never exist without the thing that caused it."""
from __future__ import annotations

import json
from typing import Any, Optional

import psycopg

from .db import new_id, one

MASTERY_METHOD = "mean_verification_score_v1"


REVISION_SNAPSHOT_CHARS = 4000
REVISION_MIN_CHANGED_CHARS = 20          # a typo fix is not a revision of reasoning; roughly a sentence is


def whiteboard_context(whiteboard: Optional[dict]) -> str:
    """The STUDENT's own typed board content (legacy steps + student-authored text/equations) as plain text for diagnosis. Coach-written
    board content is deliberately excluded so it is never mistaken for the student's reasoning. Freehand drawing is not read (no OCR)."""
    from ai.whiteboard import student_work_text
    return student_work_text(whiteboard)


def record_revision_if_any(conn: psycopg.Connection, *, student_id: str, university_id: str, assignment_id: str, attempt_id: str, new_text: str) -> Optional[str]:
    """Educational meaning, not autosave noise: ONE `REVISION` event per Coach turn, written by the first draft save after that turn
    that materially differs from the work the Coach actually replied to (snapshot stored on the AI_INTERACTION event)."""
    import difflib
    row = conn.execute("""SELECT interaction_id, payload FROM learning_events WHERE attempt_id=%s AND event_type='AI_INTERACTION'
                           ORDER BY occurred_at DESC, event_id DESC LIMIT 1""", (attempt_id,)).fetchone()
    if not row:
        return None
    interaction_id, payload = row["interaction_id"], row["payload"] or {}
    if conn.execute("SELECT 1 FROM learning_events WHERE attempt_id=%s AND event_type='REVISION' AND interaction_id=%s", (attempt_id, interaction_id)).fetchone():
        return None
    before, after = payload.get("draft_snapshot") or "", (new_text or "")[:REVISION_SNAPSHOT_CHARS]
    ratio = difflib.SequenceMatcher(None, before, after, autojunk=False).ratio()
    if max(len(before), len(after)) * (1 - ratio) < REVISION_MIN_CHANGED_CHARS:
        return None
    return insert_event(conn, student_id=student_id, university_id=university_id, event_type="REVISION", assignment_id=assignment_id, attempt_id=attempt_id,
                        interaction_id=interaction_id, payload={"after_intervention": payload.get("intervention"), "after_diagnosis": payload.get("diagnosis"),
                                                                 "similarity": round(ratio, 2), "chars_before": len(before), "chars_after": len(after)})


def insert_event(conn: psycopg.Connection, *, student_id: str, university_id: str, event_type: str, assignment_id: Optional[str] = None,
                 session_id: Optional[str] = None, attempt_id: Optional[str] = None, interaction_id: Optional[str] = None,
                 verification_id: Optional[str] = None, payload: Optional[dict] = None) -> str:
    event_id = new_id("evt")
    conn.execute("""INSERT INTO learning_events (event_id, student_id, assignment_id, session_id, attempt_id, interaction_id, verification_id,
                    event_type, payload, university_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                 (event_id, student_id, assignment_id, session_id, attempt_id, interaction_id, verification_id, event_type,
                  json.dumps(payload or {}, default=str), university_id))
    return event_id


def insert_evidence(conn: psycopg.Connection, *, student_id: str, university_id: str, assignment_id: str, ev: dict[str, Any],
                    event_id: Optional[str] = None) -> str:
    evidence_id = new_id("evd")
    conn.execute("""INSERT INTO evidence_candidates (evidence_id, student_id, assignment_id, concept, evidence_type, strength, observation, university_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                 (evidence_id, student_id, assignment_id, ev.get("concept"), ev["evidence_type"], ev["strength"], ev["observation"][:2000], university_id))
    if event_id:
        conn.execute("INSERT INTO evidence_sources (evidence_id, event_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (evidence_id, event_id))
    return evidence_id


def insert_risk_signal(conn: psycopg.Connection, *, student_id: str, university_id: str, assignment_id: str, session_id: str,
                       event_id: Optional[str], sig: dict[str, Any]) -> None:
    # The AI still only OBSERVES. `severity` is the catalogue weight class of that observation (app/risk.py), not a claim about intent.
    # `confidence` stays NULL on purpose: confidence belongs to the per-student assessment (evidence quality/quantity), see risk.py.
    from .risk import severity_for
    conn.execute("""INSERT INTO risk_signals (risk_signal_id, student_id, assignment_id, session_id, learning_event_id, signal, observation, severity, metadata, university_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                 (new_id("rsk"), student_id, assignment_id, session_id, event_id, sig["signal"][:120], (sig.get("observation") or "")[:2000],
                  severity_for(sig["signal"]), json.dumps(sig.get("metadata") or {}, default=str), university_id))


def update_concept_state(conn: psycopg.Connection, *, student_id: str, university_id: str, concept_name: str) -> None:
    """Mastery estimate for one concept = mean score over this student's COMPLETED verification results on it.
    Deliberately simple and transparent (method recorded in state_metadata); only real assessments count, never chat behaviour."""
    name = concept_name.strip()[:200]
    if not name:
        return
    concept = one(conn, """INSERT INTO concepts (university_id, name) VALUES (%s,%s)
                           ON CONFLICT (university_id, normalized_name) DO UPDATE SET name = concepts.name RETURNING concept_id""", (university_id, name))
    stats = one(conn, """
        SELECT avg(r.score)::float AS mean_score, avg(r.confidence)::float AS mean_conf, count(*)::int AS n
          FROM verification_results r
          JOIN verification_questions q ON q.question_id = r.question_id
          JOIN verification_runs v ON v.verification_id = q.verification_id
         WHERE v.student_id = %s AND v.university_id = %s AND lower(btrim(q.concept)) = lower(btrim(%s))
           AND r.outcome <> 'INSUFFICIENT_EVIDENCE'""", (student_id, university_id, name))
    if not stats or not stats["n"]:
        return
    conn.execute("""
        INSERT INTO student_concept_state (student_id, concept_id, mastery_estimate, confidence, evidence_count, last_evaluated_at, state_metadata, university_id)
        VALUES (%s,%s,%s,%s,%s, now(), %s::jsonb, %s)
        ON CONFLICT (student_id, concept_id) DO UPDATE SET mastery_estimate = EXCLUDED.mastery_estimate, confidence = EXCLUDED.confidence,
              evidence_count = EXCLUDED.evidence_count, last_evaluated_at = now(), state_metadata = EXCLUDED.state_metadata""",
                 (student_id, concept["concept_id"], round(stats["mean_score"], 4), round(stats["mean_conf"], 4), stats["n"],
                  json.dumps({"method": MASTERY_METHOD}), university_id))


def mastery_label(mastery: Optional[float], evidence_count: int = 1) -> Optional[str]:
    """None = not enough evidence. Thresholds are documented in docs/API.md."""
    if mastery is None or evidence_count < 1:
        return None
    return "Strong" if mastery >= 0.75 else "Moderate" if mastery >= 0.5 else "Weak"
