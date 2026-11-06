from __future__ import annotations

import json
import logging
import threading
import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..access import allowed_document_ids, coach_application_context, student_assignment
from ..auth import CurrentUser, get_db, require_student
from ..config import get_backend_config
from ..db import Database, many, new_id, one
from ai.whiteboard import apply_actions, count_by_kind, fallback_actions, parse_actions, render_changes, snapshot, student_changes, student_item_count
from ..records import REVISION_SNAPSHOT_CHARS, whiteboard_context
from ..views import whiteboard_view
from ..errors import AppError, conflict
from ..ratelimit import ai_rate_limit
from ..records import insert_event, insert_evidence, insert_risk_signal
from ..schemas import CoachIn

BOARD_MAX_BYTES = 380_000            # below the database CHECK (400 000): a turn must never fail on board size
log = logging.getLogger("socratiq.ai.stream")
router = APIRouter(tags=["ai"])
OPEN = ("DRAFT", "IN_PROGRESS")
_KIND = {"HINT": "hint", "QUESTION": "question", "EXPLANATION": "explanation"}


def _read_turn(db: Database, user: CurrentUser, body: CoachIn) -> dict:
    """Short read-only transaction: everything the Coach may see, derived server-side (no connection is held while the LLM runs)."""
    cfg = get_backend_config()
    with db.tx() as c:
        a = student_assignment(c, user, body.assignment_id)
        att = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s AND status IN ('DRAFT','IN_PROGRESS')", (user.user_id, a["assignment_id"]))
        if att is None:
            raise conflict("Start an attempt before asking the Coach for help.", "no_open_attempt")
        sess = one(c, "SELECT * FROM ai_sessions WHERE attempt_id=%s AND status='ACTIVE'", (att["attempt_id"],))
        if sess is None:
            c.execute("""INSERT INTO ai_sessions (session_id, student_id, assignment_id, attempt_id, policy, university_id)
                         VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                      (new_id("ses"), user.user_id, a["assignment_id"], att["attempt_id"], a["default_policy"], user.university_id))
            sess = one(c, "SELECT * FROM ai_sessions WHERE attempt_id=%s AND status='ACTIVE'", (att["attempt_id"],))
        history = list(reversed(many(c, "SELECT sender, content FROM messages WHERE session_id=%s ORDER BY created_at DESC, message_id DESC LIMIT %s",
                                     (sess["session_id"], cfg.coach_history_window))))
        last = one(c, """SELECT intervention_type, assistance_level, diagnosis, diagnosis_confidence, diagnosis_explanation, diagnosis_evidence, referenced_concepts
                           FROM ai_interactions WHERE session_id=%s ORDER BY created_at DESC LIMIT 1""", (sess["session_id"],))
        # What the student did on the board since the Coach last replied. Baseline = the snapshot stored on the last AI_INTERACTION event
        # (jsonb payload, no schema change). No baseline (first turn, older events) means no delta.
        base = one(c, """SELECT payload->'board_snapshot' AS snap FROM learning_events
                          WHERE attempt_id=%s AND event_type='AI_INTERACTION' ORDER BY occurred_at DESC, event_id DESC LIMIT 1""", (att["attempt_id"],))
        board_changes = student_changes(base and base["snap"], att.get("whiteboard"))
        allowed = allowed_document_ids(c, a)
        a = {**a, **coach_application_context(c, a)}      # exact relational context (names, attachments, material catalogue, concepts)
        prior = None
        if last and last["diagnosis"]:
            concepts = last["referenced_concepts"] or []
            prior = {"diagnosis": {"category": last["diagnosis"], "concept": concepts[0] if concepts else None, "explanation": last["diagnosis_explanation"] or "",
                                   "evidence": last["diagnosis_evidence"] or "", "confidence": float(last["diagnosis_confidence"] or 0.0)},
                     "intervention": {"type": last["intervention_type"], "assistance_level": last["assistance_level"], "rationale": "previous turn"}}

    return {"a": a, "att": att, "sess": sess, "history": history, "allowed": allowed, "prior": prior, "board_changes": board_changes}


def _persist_turn(db: Database, user: CurrentUser, body: CoachIn, ctx: dict, out) -> dict:
    """Persist the whole turn atomically and return the client payload."""
    a, att, sess = ctx["a"], ctx["att"], ctx["sess"]
    interaction_id, coach_msg_id = new_id("int"), new_id("msg")
    with db.tx() as c:
        c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (sess["session_id"],))         # serialise turns of one session
        cur = one(c, "SELECT status, whiteboard FROM attempts WHERE attempt_id=%s FOR UPDATE", (att["attempt_id"],))
        if cur is None or cur["status"] not in OPEN:
            raise conflict("This attempt was submitted while the Coach was replying.", "attempt_closed")
        # Whiteboard: the server is the source of truth. The model's actions are re-validated against the board AS STORED NOW (it may have
        # been autosaved since the turn started) and applied atomically with the rest of the turn; invalid or unsafe actions are dropped.
        board_out = None
        board_after = cur["whiteboard"]                  # the board as the NEXT turn's baseline: after the Coach's own writing, so it is never reported back as a student change
        proposed, _malformed = parse_actions(out.board_actions)
        proposed = proposed or fallback_actions(body.message)          # unmistakable commands ("clear the board") still work if the model forgot
        if proposed:
            res = apply_actions(cur["whiteboard"], proposed, message=body.message, intent=body.board_intent, policy=sess["policy"])
            report = {"applied": res.applied, "rejected": res.rejected}
            if res.applied:
                blob = json.dumps(res.board)
                legacy_bytes = len(json.dumps({k: v for k, v in res.board.items() if k != "scene"}))      # the native scene has its own, larger budget
                if legacy_bytes <= BOARD_MAX_BYTES:
                    c.execute("UPDATE attempts SET whiteboard=%s::jsonb, whiteboard_updated_at=now() WHERE attempt_id=%s", (blob, att["attempt_id"]))
                    board_after = res.board
                    board_out = {**whiteboard_view(res.board), "report": report}
                else:
                    board_out = {**whiteboard_view(cur["whiteboard"]), "report": {"applied": [], "rejected": [{"action": "all", "reason": "the board is too large"}]}}
            else:
                board_out = {**whiteboard_view(cur["whiteboard"]), "report": report}
        dx = out.diagnosis or {}
        c.execute("""INSERT INTO ai_interactions (interaction_id, session_id, student_id, assignment_id, intervention_type, assistance_level, diagnosis,
                        diagnosis_confidence, diagnosis_explanation, diagnosis_evidence, response, referenced_concepts, tools_used, university_id)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s)""",
                  (interaction_id, sess["session_id"], user.user_id, a["assignment_id"], out.intervention["type"], out.intervention["assistance_level"],
                   dx.get("category"), dx.get("confidence"), dx.get("explanation"), dx.get("evidence"), out.response,
                   json.dumps(out.referenced_concepts), json.dumps(out.tools_used), user.university_id))
        for rank, s in enumerate(out.sources, start=1):     # provenance, only for chunks that really exist inside THIS tenant/course
            if s.get("chunk_id"):
                c.execute("""INSERT INTO ai_interaction_sources (interaction_id, document_id, chunk_id, final_score, retrieval_rank)
                             SELECT %s, ch.document_id, ch.chunk_id, %s, %s FROM document_chunks ch
                              WHERE ch.chunk_id=%s AND ch.university_id=%s AND ch.course_id=%s ON CONFLICT DO NOTHING""",
                          (interaction_id, s.get("score"), rank, s["chunk_id"], user.university_id, a["course_id"]))
        # clock_timestamp(), not now(): now() is frozen for the whole transaction, which would give both messages the same
        # created_at and make their order in the chat history depend on random ids.
        c.execute("INSERT INTO messages (message_id, session_id, sender, content, created_at) VALUES (%s,%s,'STUDENT',%s, clock_timestamp())",
                  (new_id("msg"), sess["session_id"], body.message))
        c.execute("INSERT INTO messages (message_id, session_id, sender, content, interaction_id, created_at) VALUES (%s,%s,'COACH',%s,%s, clock_timestamp())",
                  (coach_msg_id, sess["session_id"], out.response, interaction_id))
        event_id = insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="AI_INTERACTION", assignment_id=a["assignment_id"],
                                session_id=sess["session_id"], attempt_id=att["attempt_id"], interaction_id=interaction_id,
                                payload={"intervention": out.intervention["type"], "diagnosis": dx.get("category"), "concepts": out.referenced_concepts,
                                         "sources": len(out.sources), "tools_used": out.tools_used,
                                         "draft_snapshot": (att.get("draft_text") or "")[:REVISION_SNAPSHOT_CHARS],
                                         "whiteboard_steps": student_item_count(cur["whiteboard"]),           # items the STUDENT wrote on the board
                                         "board_actions_applied": len((board_out or {}).get("report", {}).get("applied", [])),
                                         "board_actions_rejected": len((board_out or {}).get("report", {}).get("rejected", [])),
                                         "board_mode": body.mode,
                                         "board_snapshot": snapshot(board_after),                                 # baseline for the next turn's delta (ids + clipped content, no strokes)
                                         "board_student_changes": count_by_kind(ctx.get("board_changes") or [])})   # evidence: what changed before this turn, counts only   # what the student had when the Coach replied
        for ev in out.evidence:
            insert_evidence(c, student_id=user.user_id, university_id=user.university_id, assignment_id=a["assignment_id"], ev=ev, event_id=event_id)
        for sig in out.risk_signals:
            insert_risk_signal(c, student_id=user.user_id, university_id=user.university_id, assignment_id=a["assignment_id"],
                               session_id=sess["session_id"], event_id=event_id, sig=sig)
        turn = one(c, "UPDATE ai_sessions SET turn_count = turn_count + 1 WHERE session_id=%s RETURNING turn_count", (sess["session_id"],))["turn_count"]

    return {"interaction_id": interaction_id, "turn": turn,
            "message": {"id": coach_msg_id, "role": "coach", "content": out.response, "kind": _KIND.get(out.intervention["type"])},
            "intervention": {"type": out.intervention["type"]},
            "sources": [{"document_title": s.get("document_title"), "page_number": s.get("page_number"), "section": s.get("section")} for s in out.sources],
            **({"board": board_out} if board_out is not None else {})}


def _ask_ai(ai, user: CurrentUser, body: CoachIn, ctx: dict, *, stream: bool):
    board = ctx["att"].get("whiteboard")
    changes = render_changes(ctx.get("board_changes") or [])
    if changes:      # a transient copy for the Coach only: it is never stored, and apply_actions works on the board as stored
        board = {**(board or {}), "changes_since_last_reply": changes}
    kw = dict(student_id=user.user_id, student_name=user.name, assignment=ctx["a"], session_id=ctx["sess"]["session_id"], policy=ctx["sess"]["policy"],
              attempt_text=(ctx["att"].get("draft_text") or "") + whiteboard_context(ctx["att"].get("whiteboard")), message=body.message, history=ctx["history"], turn_index=ctx["sess"]["turn_count"],
              allowed_document_ids=ctx["allowed"], prior=ctx["prior"], board=board, board_mode=body.mode,
              board_selected_id=body.selected_id, board_intent=body.board_intent)
    return ai.coach_turn_stream(**kw) if stream else ai.coach_turn(**kw)


@router.post("/ai/coach", dependencies=[Depends(ai_rate_limit)])
def coach(body: CoachIn, request: Request, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """One Socratic Coach turn. Identity, university, classroom, policy and the retrieval whitelist are ALL derived server-side;
    the request only carries the assignment id and the student's message."""
    ctx = _read_turn(db, user, body)
    out = _ask_ai(request.app.state.ai, user, body, ctx, stream=False)        # policy comes from the assignment row, never from the client
    return _persist_turn(db, user, body, ctx, out)


# Turns currently being generated, per session (this process only; see ratelimit.py for the multi-worker caveat).
# Entries expire so a client that disconnects before the stream ever starts (its `finally` would never run) cannot lock a session.
_inflight: dict[str, float] = {}
_inflight_lock = threading.Lock()
_INFLIGHT_TTL_SECONDS = 150


def _claim_turn(session_id: str) -> None:
    now = time.monotonic()
    with _inflight_lock:
        for k in [k for k, t in _inflight.items() if now - t > _INFLIGHT_TTL_SECONDS]:
            del _inflight[k]
        if session_id in _inflight:
            raise conflict("The Coach is still answering your previous message.", "turn_in_progress")
        _inflight[session_id] = now


def _release_turn(session_id: str) -> None:
    with _inflight_lock:
        _inflight.pop(session_id, None)

_STAGE_LABELS = {      # graph node -> what the student sees. Honest: one label per real step of the Coach pipeline.
    "understand_context": "Reading the assignment and your work",
    "analyze_code": "Looking at your code",
    "diagnose": "Working out where you are",
    "choose_intervention": "Choosing how to help",
    "retrieve_context": "Checking the course materials",
    "context_response": "Preparing an answer",
    "generate_response": "Writing a reply",
    "validate": "Checking the reply keeps you thinking",
    "safe_fallback": "Preparing a safe reply",
}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/ai/coach/stream", dependencies=[Depends(ai_rate_limit)])
def coach_stream(body: CoachIn, request: Request, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Server-Sent Events version of /ai/coach: the same context, the same Coach graph, the same persistence.

    Events: `stage` (a real pipeline step finished), `final` (the persisted turn, same payload as /ai/coach), `error`.
    The reply text is deliberately sent only in `final`, after the validation step, so a student never sees a draft that the
    validator would have rejected. If the client disconnects mid-turn nothing is persisted, and a second turn for the same session
    is refused (409) while one is running, which prevents double submits."""
    ctx = _read_turn(db, user, body)                       # auth / state errors surface as normal HTTP errors BEFORE streaming starts
    sid = ctx["sess"]["session_id"]
    _claim_turn(sid)
    ai = request.app.state.ai

    def events():
        try:
            yield _sse("stage", {"stage": "start", "label": "Starting"})
            out = None
            for kind, val in _ask_ai(ai, user, body, ctx, stream=True):
                if kind == "stage":
                    yield _sse("stage", {"stage": val, "label": _STAGE_LABELS.get(val, "Working")})
                else:
                    out = val
            if out is None:
                raise AppError(503, "The Coach did not produce a reply. Please try again.", "ai_unavailable")
            yield _sse("final", _persist_turn(db, user, body, ctx, out))
        except AppError as exc:
            yield _sse("error", {"code": exc.code or "error", "message": exc.message, "status": exc.status_code})
        except GeneratorExit:
            log.info("coach stream closed by client session=%s", sid)
            raise
        except Exception:  # noqa: BLE001
            log.exception("coach stream failed session=%s", sid)
            yield _sse("error", {"code": "internal_error", "message": "Something went wrong on our side.", "status": 500})
        finally:
            _release_turn(sid)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
