"""SmartBoard API endpoints.
Provides real-time AI endpoints matching the SmartBoard reference:
- /api/v1/smartboard/config: API Key & service readiness
- /api/v1/smartboard/generate-image: AI Image generation proxy
- /api/v1/smartboard/generate-simulation: HTML/JS interactive simulation generator
- /api/v1/smartboard/generate-vector: Structured vector graphics generator (legacy board)
- /api/v1/smartboard/generate-diagram: Validated, coordinate-free diagram specification for the native board (layout/placement happen client-side)
- /api/v1/smartboard/chat: Multimodal chat with board vision and tool calling
- WebSocket /api/v1/smartboard/live: Bi-directional WebSocket relay to Google Multimodal Live API
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import websockets

from ..access import allowed_document_ids, coach_application_context, student_assignment, student_course
from ..auth import CurrentUser
from ..board_auth import sign_coach_element_id
from ..db import Database, many, new_id, one
from ..records import insert_event
from ai.rag.models import RetrievalScope
from ai.rag.security import sanitize_untrusted_text
from ai.whiteboard.diagram import DiagramRejected, build_prompt, parse_diagram

log = logging.getLogger("socratiq.smartboard")

router = APIRouter(prefix="/smartboard", tags=["smartboard"])
SMARTBOARD_MODEL = os.getenv("SMARTBOARD_GEMINI_MODEL", "gemini-3-flash-preview")


def _get_smartboard_models() -> list[str]:
    primary = os.getenv("SMARTBOARD_GEMINI_MODEL", "gemini-3-flash-preview").strip()
    fallbacks = ["gemini-3-flash-preview", "gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"]
    result: list[str] = []
    for m in [primary] + fallbacks:
        if m and m not in result:
            result.append(m)
    return result


def _get_gemini_keys() -> list[str]:
    keys = []
    # Check all possible environment variables, prioritizing keys 2, 3, 4 then 1
    for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY_2", "GOOGLE_AI_STUDIO_API_KEY_3", "GOOGLE_AI_STUDIO_API_KEY_4", "GOOGLE_AI_STUDIO_API_KEY_1", "AI_DEFAULT_API_KEY"):
        val = os.getenv(key)
        if val and val.strip() and val.strip() != "no":
            m = re.match(r"^\$\{([^}]+)\}$", val.strip())
            if m:
                nested = os.getenv(m.group(1))
                if nested and nested.strip() and nested.strip() != "no" and nested.strip() not in keys:
                    keys.append(nested.strip())
            elif val.strip() not in keys:
                keys.append(val.strip())
    return keys


def _get_gemini_key() -> Optional[str]:
    keys = _get_gemini_keys()
    return keys[0] if keys else None


async def _call_gemini_generate_content(
    payload: Dict[str, Any],
    timeout: float = 35.0,
    preferred_models: Optional[List[str]] = None,
) -> Dict[str, Any]:
    key_check = _get_gemini_key()
    if not key_check:
        raise HTTPException(status_code=503, detail="Gemini API key is not configured")

    keys = _get_gemini_keys()
    if key_check not in keys:
        keys = [key_check] + keys
    if not keys:
        raise HTTPException(status_code=503, detail="Gemini API key is not configured")

    models = preferred_models or _get_smartboard_models()
    last_status = 503
    last_error = "No response from Gemini API"
    had_timeout = False

    import httpx
    async with httpx.AsyncClient(timeout=timeout) as client:
        for model in models:
            for key in keys:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
                try:
                    resp = await client.post(url, json=payload)
                    if resp.status_code == 200:
                        return resp.json()

                    last_status = resp.status_code
                    last_error = resp.text
                    log.warning(
                        "Gemini generateContent call failed on model=%s, key=%s..., status=%s: %s",
                        model, key[:8] if len(key) >= 8 else key, resp.status_code, resp.text[:120]
                    )
                    # If model not found / deprecated (404), skip remaining keys for this model
                    if resp.status_code == 404:
                        break
                except httpx.TimeoutException as exc:
                    had_timeout = True
                    last_status = 504
                    last_error = "Gemini API timed out"
                    log.warning("Gemini generateContent timeout on model=%s: %s", model, exc)
                except Exception as exc:
                    log.warning("Gemini generateContent exception on model=%s: %s", model, exc)
                    last_error = str(exc)

    if had_timeout and last_status == 503:
        last_status = 504
    raise HTTPException(status_code=last_status, detail=f"Gemini API error: {last_error}")


def _authenticate_token(token: str, app: Any) -> Optional[CurrentUser]:
    if not token or not token.strip():
        return None
    try:
        verifier = getattr(app.state, "token_verifier", None)
        if not verifier:
            return None
        identity = verifier.verify(token.strip())
        db = getattr(app.state, "db", None)
        if not db:
            return None
        with db.tx() as c:
            row = one(c, "SELECT user_id, auth_user_id::text AS auth_user_id, university_id, role, email, first_name, last_name FROM users WHERE auth_user_id = %s",
                      (identity.auth_user_id,))
            if row:
                return CurrentUser(**row)
    except Exception as exc:
        log.warning("SmartBoard token authentication failed: %s", exc)
        return None
    return None


def _authenticate_request(request: Request) -> Optional[CurrentUser]:
    auth_header = request.headers.get("authorization", "")
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return _authenticate_token(token.strip(), request.app)


class ImageGenIn(BaseModel):
    prompt: str
    size: str = "1K"


class SimulationGenIn(BaseModel):
    prompt: str


class VectorGenIn(BaseModel):
    prompt: str


class ChatMessageIn(BaseModel):
    role: str
    text: Optional[str] = ""
    audio: Optional[str] = None
    mime_type: Optional[str] = "audio/wav"


class ChatIn(BaseModel):
    messages: List[ChatMessageIn]
    screenshot: Optional[str] = None
    tools: Optional[List[Dict[str, Any]]] = None
    systemInstruction: Optional[str] = None
    assignment_id: Optional[str] = None
    course_id: Optional[str] = None
    board: Optional[Dict[str, Any]] = None
    selected_id: Optional[str] = None
    board_intent: Optional[str] = None


class RetrieveIn(BaseModel):
    query: str
    assignment_id: Optional[str] = None
    course_id: Optional[str] = None
    top_k: int = 4


@router.get("/config")
def get_config():
    key = _get_gemini_key()
    return {"status": "online" if key else "no_key"}


@router.get("/context")
async def get_smartboard_context(
    request: Request,
    assignment_id: Optional[str] = None,
    course_id: Optional[str] = None
):
    db = getattr(request.app.state, "db", None)
    if not db:
        raise HTTPException(status_code=503, detail="Database not configured")
    user = _authenticate_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required for educational context")

    with db.tx() as c:
        if assignment_id:
            try:
                a = student_assignment(c, user, assignment_id)
            except Exception:
                raise HTTPException(status_code=404, detail="Assignment not found or not accessible")
            allowed_docs = allowed_document_ids(c, a)
            app_ctx = coach_application_context(c, a)
            return {
                "assignment": {
                    "assignment_id": a["assignment_id"],
                    "title": a["title"],
                    "instructions": a["instructions"],
                    "subject_area": a.get("subject_area"),
                    "is_programming": a.get("is_programming"),
                    "concepts": app_ctx.get("concepts", []),
                    "attachments": app_ctx.get("attachments", []),
                    "materials": app_ctx.get("materials", []),
                },
                "course": {
                    "course_id": a["course_id"],
                    "title": app_ctx.get("course_title"),
                    "code": app_ctx.get("course_code"),
                },
                "allowed_documents_count": len(allowed_docs)
            }
        elif course_id:
            try:
                course = student_course(c, user, course_id)
            except Exception:
                raise HTTPException(status_code=404, detail="Course not found or not accessible")
            return {
                "course": {
                    "course_id": course["course_id"],
                    "title": course.get("title") or course.get("name"),
                    "code": course.get("code"),
                }
            }
        else:
            raise HTTPException(status_code=400, detail="assignment_id or course_id required")


@router.post("/retrieve")
async def retrieve_materials(request: Request, body: RetrieveIn):
    db = getattr(request.app.state, "db", None)
    if not db:
        raise HTTPException(status_code=503, detail="Database not configured")
    user = _authenticate_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")

    rag_service = getattr(getattr(request.app.state, "pipeline", None), "rag", None)
    if not rag_service:
        return {"results": []}

    with db.tx() as c:
        if body.assignment_id:
            try:
                a = student_assignment(c, user, body.assignment_id)
            except Exception:
                raise HTTPException(status_code=404, detail="Assignment not found or not accessible")
            course_id = a["course_id"]
            classroom_id = a.get("classroom_id")
            allowed_docs = allowed_document_ids(c, a)
        elif body.course_id:
            try:
                course = student_course(c, user, body.course_id)
            except Exception:
                raise HTTPException(status_code=404, detail="Course not found or not accessible")
            course_id = body.course_id
            classroom_id = course.get("classroom_id")
            docs = many(c, """
                SELECT f.document_id FROM stored_files f
                 WHERE f.document_id IS NOT NULL AND f.status = 'READY' AND f.university_id = %s AND f.course_id = %s
                   AND f.purpose = 'MATERIAL' AND EXISTS (
                        SELECT 1 FROM enrollments e WHERE e.student_id = %s AND e.classroom_id = f.classroom_id AND e.status = 'active')
            """, (user.university_id, course_id, user.user_id))
            allowed_docs = sorted({r["document_id"] for r in docs})
        else:
            raise HTTPException(status_code=400, detail="assignment_id or course_id required")

    scope = RetrievalScope(
        university_id=user.university_id,
        course_id=course_id,
        classroom_id=classroom_id,
        assignment_id=body.assignment_id,
        allowed_document_ids=allowed_docs or ()
    )
    chunks = rag_service.retrieve_course_material(
        course_id=course_id,
        query=body.query,
        top_k=body.top_k,
        scope=scope
    )
    results = []
    for r in chunks:
        meta = r.metadata if isinstance(r.metadata, dict) else {}
        results.append({
            "source": r.source,
            "content": sanitize_untrusted_text(r.content),
            "document_title": meta.get("document_title") or meta.get("title") or r.source,
            "page_number": meta.get("page_number"),
            "section": meta.get("section"),
            "score": meta.get("score", 1.0)
        })
    return {"results": results}


@router.post("/generate-image")
async def generate_image(body: ImageGenIn):
    key = _get_gemini_key()
    if not key:
        raise HTTPException(status_code=503, detail="Gemini API key is not configured")

    prompt = f"{body.prompt}. Minimalist style, isolated subject on white background if possible, high quality."
    url = f"https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key={key}"
    
    # Try Imagen API first
    payload = {
        "instances": [{"prompt": prompt}],
        "parameters": {"sampleCount": 1, "aspectRatio": "1:1"}
    }
    
    import httpx
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                predictions = data.get("predictions", [])
                if predictions and "bytesBase64Encoded" in predictions[0]:
                    b64 = predictions[0]["bytesBase64Encoded"]
                    mime = predictions[0].get("mimeType", "image/png")
                    return {"imageUrl": f"data:{mime};base64,{b64}"}
        except Exception as e:
            log.warning("Imagen direct API attempt failed: %s", e)

        # Fallback to generateContent with gemini-2.5-flash / image preview if supported
        fallback_url = f"https://generativelanguage.googleapis.com/v1beta/models/{SMARTBOARD_MODEL}:generateContent?key={key}"
        fb_payload = {
            "contents": [{"parts": [{"text": f"Generate a detailed visual illustration for: {prompt}"}]}]
        }
        try:
            resp = await client.post(fallback_url, json=fb_payload)
            if resp.status_code == 200:
                data = resp.json()
                for cand in data.get("candidates", []):
                    for part in cand.get("content", {}).get("parts", []):
                        if "inlineData" in part:
                            inline = part["inlineData"]
                            return {"imageUrl": f"data:{inline.get('mimeType', 'image/jpeg')};base64,{inline['data']}"}
        except Exception as e:
            log.warning("Image fallback failed: %s", e)

    # Return placeholder svg if external generative image fails
    placeholder_svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#64748b">{body.prompt[:40]}</text></svg>'
    import base64
    b64_svg = base64.b64encode(placeholder_svg.encode()).decode()
    return {"imageUrl": f"data:image/svg+xml;base64,{b64_svg}"}


@router.post("/generate-simulation")
async def generate_simulation(body: SimulationGenIn):
    system_prompt = (
        f'Create a self-contained, interactive HTML/JS simulation for: "{body.prompt}".\n'
        '- Use Tailwind CSS for styling.\n'
        '- Important: Use a clean, modern design with a WHITE background (bg-white) and dark text (text-slate-900) to fit a light-mode whiteboard.\n'
        '- It must fit within a 500x400px container.\n'
        '- Keep the code concise, efficient, and direct without boilerplate comments.\n'
        '- Return ONLY the raw HTML code (no markdown fences, no explanations).\n'
        '- Ensure it is visually appealing, responsive and fully interactive.'
    )
    payload = {
        "contents": [{"parts": [{"text": system_prompt}]}]
    }

    data = await _call_gemini_generate_content(payload, timeout=40.0)
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        code = text.replace("```html", "").replace("```", "").strip()
        return {"code": code}
    except (KeyError, IndexError):
        raise HTTPException(status_code=500, detail="Malformed model response")


@router.post("/generate-vector")
async def generate_vector(body: VectorGenIn):
    prompt = (
        f'Generate a vector drawing for: "{body.prompt}".\n'
        'Return a JSON object with an "elements" property containing an array of shapes.\n'
        'Supported shapes:\n'
        '- {"type": "rect", "x": 0, "y": 0, "width": 100, "height": 80, "color": "#2563eb", "filled": true}\n'
        '- {"type": "circle", "x": 50, "y": 50, "radius": 40, "color": "#ef4444", "filled": true}\n'
        '- {"type": "triangle", "x": 0, "y": 0, "width": 80, "height": 80, "color": "#16a34a", "filled": true}\n'
        '- {"type": "line", "x1": 0, "y1": 0, "x2": 100, "y2": 100, "color": "#000000", "strokeWidth": 3}\n'
        '- {"type": "path", "pathData": "M 0 0 L 50 50", "color": "#000000", "strokeWidth": 3}\n'
        'Coordinates should be relative to (0,0) as the top-left of the drawing.\n'
        'Output ONLY valid JSON.'
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json"}
    }

    data = await _call_gemini_generate_content(payload, timeout=30.0)
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        return parsed
    except Exception as e:
        log.warning("Vector parsing error: %s", e)
        return {"elements": []}


class DiagramGenIn(BaseModel):
    request: str
    board: List[Dict[str, Any]] = []
    selected_id: Optional[str] = None


_DIAGRAM_ATTEMPTS = 2
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.:\-]")


def _board_digest(items: List[Dict[str, Any]]) -> tuple[list[str], set[str]]:
    """Existing board text as DATA for the model: bounded, sanitised, id-addressed. The model may name one of these ids as its target."""
    lines, ids = [], set()
    for it in items[:40]:
        if not isinstance(it, dict):
            continue
        eid = _SAFE_ID.sub("", str(it.get("id", "")))[:64]
        text = re.sub(r"\s+", " ", sanitize_untrusted_text(str(it.get("text", "")))).strip()[:160]
        if eid and text:
            ids.add(eid)
            lines.append(f"{eid} | {text}")
    return lines, ids


@router.post("/generate-diagram")
async def generate_diagram(body: DiagramGenIn):
    """Stage 1-2 of the drawing pipeline: understand the request and return a STRICTLY VALIDATED diagram specification.
    The model never provides board coordinates. A malformed or incoherent answer is fed back for one repair attempt, then rejected."""
    req = re.sub(r"\s+", " ", sanitize_untrusted_text(body.request)).strip()
    if not 1 <= len(req) <= 1000:
        raise HTTPException(status_code=422, detail={"code": "bad_request", "errors": ["the request must be 1-1000 characters"]})
    lines, ids = _board_digest(body.board)
    selected = _SAFE_ID.sub("", body.selected_id or "")[:64] or None
    prompt = build_prompt(req, lines, selected if selected in ids else None)
    errors: list[str] = []
    for attempt in range(_DIAGRAM_ATTEMPTS):
        text = prompt if not errors else (
            prompt + "\n\nYour previous answer was REJECTED for these reasons. Fix every one and output the corrected JSON object only:\n- " + "\n- ".join(errors[:6]))
        data = await _call_gemini_generate_content({"contents": [{"parts": [{"text": text}]}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4}}, timeout=45.0)
        try:
            raw = data["candidates"][0]["content"]["parts"][0]["text"]
        except Exception:
            errors = ["the model returned no text"]
            continue
        try:
            spec = parse_diagram(raw)
        except DiagramRejected as e:
            errors = e.errors
            log.info("diagram attempt %d rejected: %s", attempt + 1, "; ".join(e.errors[:4]))
            continue
        rel = spec.get("relation")
        if rel and rel.get("targetId") and rel["targetId"] not in ids:
            rel.pop("targetId")                              # the model may only point at elements that really exist on this board
        return {"spec": spec, "attempts": attempt + 1}
    raise HTTPException(status_code=422, detail={"code": "diagram_invalid", "errors": errors[:6]})


@router.post("/chat")
async def chat(request: Request, body: ChatIn):
    key = _get_gemini_key()
    if not key:
        raise HTTPException(status_code=503, detail="Gemini API key is not configured")

    db = getattr(request.app.state, "db", None)
    user = None
    a = None
    course = None
    allowed_docs: list[str] = []
    app_ctx: dict[str, Any] = {}
    sources: list[dict[str, Any]] = []
    rag_contexts: list[str] = []

    # If assignment or course context is provided, authenticate and verify access
    if body.assignment_id or body.course_id:
        if not db:
            raise HTTPException(status_code=503, detail="Database not configured")
        user = _authenticate_request(request)
        if not user:
            raise HTTPException(status_code=401, detail="Authentication required when accessing assignment or course context")

        with db.tx() as c:
            if body.assignment_id:
                try:
                    a = student_assignment(c, user, body.assignment_id)
                except Exception:
                    raise HTTPException(status_code=404, detail="Assignment not found or not accessible")
                allowed_docs = allowed_document_ids(c, a)
                app_ctx = coach_application_context(c, a)
                course_id = a["course_id"]
                classroom_id = a.get("classroom_id")
            elif body.course_id:
                try:
                    course = student_course(c, user, body.course_id)
                except Exception:
                    raise HTTPException(status_code=404, detail="Course not found or not accessible")
                course_id = body.course_id
                classroom_id = course.get("classroom_id")
                docs = many(c, """
                    SELECT f.document_id FROM stored_files f
                     WHERE f.document_id IS NOT NULL AND f.status = 'READY' AND f.university_id = %s AND f.course_id = %s
                       AND f.purpose = 'MATERIAL' AND EXISTS (
                            SELECT 1 FROM enrollments e WHERE e.student_id = %s AND e.classroom_id = f.classroom_id AND e.status = 'active')
                """, (user.university_id, course_id, user.user_id))
                allowed_docs = sorted({r["document_id"] for r in docs})

        # Grounding: Retrieve course material chunks matching the student's query
        rag_service = getattr(getattr(request.app.state, "pipeline", None), "rag", None)
        user_texts = [m.text for m in body.messages if m.role == "user" and m.text]
        query = user_texts[-1] if user_texts else ""

        if query and rag_service and (allowed_docs or body.course_id):
            scope = RetrievalScope(
                university_id=user.university_id,
                course_id=course_id,
                classroom_id=classroom_id,
                assignment_id=body.assignment_id,
                allowed_document_ids=allowed_docs or ()
            )
            try:
                chunks = rag_service.retrieve_course_material(
                    course_id=course_id,
                    query=query,
                    top_k=4,
                    scope=scope
                )
                for r in chunks:
                    meta = r.metadata if isinstance(r.metadata, dict) else {}
                    doc_title = meta.get("document_title") or meta.get("title") or r.source
                    page = meta.get("page_number")
                    sources.append({
                        "source": r.source,
                        "title": doc_title,
                        "page": page,
                        "score": meta.get("score", 1.0)
                    })
                    loc = f" (Page {page})" if page else ""
                    rag_contexts.append(f"[{doc_title}{loc}]: {sanitize_untrusted_text(r.content)}")
            except Exception as exc:
                log.warning("SmartBoard chat RAG retrieval failed: %s", exc)

    # Build contextual enrichment blocks
    context_blocks = []
    if a:
        context_blocks.append(
            f"--- ASSIGNMENT CONTEXT ---\n"
            f"Course: {app_ctx.get('course_title') or a.get('course_title', '')} ({app_ctx.get('course_code') or a.get('course_code', '')})\n"
            f"Assignment Title: {a.get('title')}\n"
            f"Instructions: {a.get('instructions') or 'None'}\n"
            f"Subject Area: {a.get('subject_area') or 'General'}\n"
            f"Core Concepts: {', '.join(app_ctx.get('concepts', [])) or 'None specified'}\n"
            f"Key Attachments: {', '.join(att.get('filename', '') for att in app_ctx.get('attachments', [])) or 'None'}\n"
            f"Available Materials: {', '.join(m.get('title', '') for m in app_ctx.get('materials', [])) or 'None'}"
        )
    elif course:
        context_blocks.append(
            f"--- COURSE CONTEXT ---\n"
            f"Course: {course.get('title') or course.get('name', '')} ({course.get('code', '')})"
        )

    if rag_contexts:
        context_blocks.append(
            "--- RELEVANT COURSE MATERIALS & LECTURE NOTES ---\n"
            + "\n\n".join(rag_contexts)
            + "\n\nInstruction: Use the above course materials to guide your explanations, cite concepts and page numbers when relevant, and ensure your terminology directly matches what the instructor taught."
        )

    if body.board:
        elements = body.board.get("elements", [])
        if isinstance(elements, list) and elements:
            summary_lines = []
            for el in elements[:40]:
                el_type = el.get("kind") or el.get("type", "element")
                el_text = el.get("text") or el.get("title") or el.get("latex") or el.get("caption") or ""
                pos = f"at ({int(el.get('x', 0))}, {int(el.get('y', 0))})"
                sel = " [SELECTED BY STUDENT]" if str(el.get("id")) == str(body.selected_id) else ""
                summary_lines.append(f"- {el_type}{sel} {pos}: {el_text[:60]}")
            context_blocks.append(
                f"--- STUDENT'S CURRENT SMARTBOARD WORK ({len(elements)} items) ---\n"
                + "\n".join(summary_lines)
                + (f"\n(Currently selected element: {body.selected_id})" if body.selected_id else "")
            )

    pedagogy_and_language = (
        "--- PEDAGOGICAL POLICY & LANGUAGE DIRECTIVE ---\n"
        "1. You are the SocratiQ AI Learning Companion on this SmartBoard.\n"
        "2. LANGUAGE: Default strictly to speaking and writing in English. Only switch to Arabic if the student explicitly addresses you in Arabic. Never speak Spanish.\n"
        "3. SOCRATIC COACHING: Help the student learn by asking guiding questions, breaking problems down, and illustrating key concepts visually on the board. Do not simply give away full solutions to assignment questions.\n"
        "4. VISUAL BOARD INTERACTION: When helpful, place diagrams, concept notes, cards, or shapes onto empty areas of the board without overlapping existing content."
    )
    context_blocks.append(pedagogy_and_language)

    base_sys = body.systemInstruction or "You are the SocratiQ AI Learning Companion on this SmartBoard."
    enriched_system_instruction = base_sys + "\n\n" + "\n\n".join(context_blocks)

    contents = []
    for m in body.messages:
        parts = []
        if m.text:
            parts.append({"text": m.text})
        if m.audio:
            clean_audio = m.audio.split(",")[-1] if "," in m.audio else m.audio
            parts.append({
                "inlineData": {
                    "mimeType": m.mime_type or "audio/wav",
                    "data": clean_audio
                }
            })
        if not parts:
            parts.append({"text": ""})
        contents.append({
            "role": "user" if m.role == "user" else "model",
            "parts": parts
        })

    # If screenshot provided, attach to last user message
    if body.screenshot and contents:
        last_user = next((c for c in reversed(contents) if c["role"] == "user"), None)
        if last_user:
            clean_b64 = body.screenshot.split(",")[-1] if "," in body.screenshot else body.screenshot
            last_user["parts"].append({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": clean_b64
                }
            })

    config: Dict[str, Any] = {}
    if body.tools:
        config["tools"] = [{"functionDeclarations": body.tools}]
    config["systemInstruction"] = {"parts": [{"text": enriched_system_instruction}]}
    payload = {
        "contents": contents,
        **({"tools": config["tools"]} if "tools" in config else {}),
        "systemInstruction": config["systemInstruction"]
    }

    # Validate audio base64 if present
    import base64
    for idx, m in enumerate(body.messages):
        if m.audio:
            if len(m.audio) > 10 * 1024 * 1024:  # 10MB limit
                raise HTTPException(status_code=413, detail="Audio payload too large (max 10MB)")
            try:
                clean_audio = m.audio.split(",")[-1] if "," in m.audio else m.audio
                base64.b64decode(clean_audio, validate=True)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid audio base64 payload")

    data = await _call_gemini_generate_content(payload, timeout=45.0)

    reply_text = None
    function_calls = []
    try:
        parts = data["candidates"][0]["content"]["parts"]
        for p in parts:
            if "text" in p and not reply_text:
                reply_text = p["text"]
            if "functionCall" in p:
                function_calls.append({"functionCall": p["functionCall"]})
    except (KeyError, IndexError):
        pass

    # Persist interaction telemetry for teacher dashboard & analytics and issue signed coach element IDs
    if db and user and a:
        try:
            with db.tx() as c:
                att = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s AND status IN ('DRAFT','IN_PROGRESS') ORDER BY attempt_number DESC LIMIT 1",
                          (user.user_id, a["assignment_id"]))
                if att:
                    coach_element_ids = []
                    for fc in function_calls:
                        el_id = sign_coach_element_id(att["attempt_id"])
                        fc["element_id"] = el_id
                        if "functionCall" in fc:
                            fc["functionCall"]["element_id"] = el_id
                        coach_element_ids.append(el_id)

                    sess = one(c, "SELECT * FROM ai_sessions WHERE attempt_id=%s AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1", (att["attempt_id"],))
                    if sess is None:
                        sess_id = new_id("ses")
                        c.execute("""INSERT INTO ai_sessions (session_id, student_id, assignment_id, attempt_id, policy, university_id)
                                     VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                  (sess_id, user.user_id, a["assignment_id"], att["attempt_id"], a.get("default_policy") or "SOCRATIC", user.university_id))
                        sess = one(c, "SELECT * FROM ai_sessions WHERE attempt_id=%s AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1", (att["attempt_id"],))

                    if sess:
                        interaction_id = new_id("int")
                        tool_names = [fc["functionCall"]["name"] for fc in function_calls if "functionCall" in fc and "name" in fc["functionCall"]]
                        c.execute("""INSERT INTO ai_interactions (interaction_id, session_id, student_id, assignment_id, intervention_type, assistance_level, diagnosis,
                                        diagnosis_confidence, diagnosis_explanation, diagnosis_evidence, response, referenced_concepts, tools_used, university_id)
                                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s)""",
                                  (interaction_id, sess["session_id"], user.user_id, a["assignment_id"],
                                   "SMARTBOARD_GUIDANCE", "SUGGESTION", "GUIDED_PRACTICE", 0.9,
                                   "SmartBoard AI collaborative interaction", "Interactive whiteboard exploration",
                                   reply_text or "SmartBoard action", json.dumps([]), json.dumps(tool_names), user.university_id))

                        last_user_text = next((m.text for m in reversed(body.messages) if m.role == "user" and m.text), "SmartBoard interaction")
                        c.execute("INSERT INTO messages (message_id, session_id, sender, content, created_at) VALUES (%s,%s,'STUDENT',%s, clock_timestamp())",
                                  (new_id("msg"), sess["session_id"], last_user_text))
                        c.execute("INSERT INTO messages (message_id, session_id, sender, content, interaction_id, created_at) VALUES (%s,%s,'COACH',%s,%s, clock_timestamp())",
                                  (new_id("msg"), sess["session_id"], reply_text or "SmartBoard whiteboard update", interaction_id))

                        insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="AI_INTERACTION",
                                     assignment_id=a["assignment_id"], session_id=sess["session_id"], attempt_id=att["attempt_id"],
                                     interaction_id=interaction_id,
                                     payload={
                                         "intervention": "SMARTBOARD_GUIDANCE",
                                         "tools_used": tool_names,
                                         "coach_element_ids": coach_element_ids,
                                         "sources": len(sources),
                                         "mode": "smartboard",
                                         "channel": "chat"
                                     })
                        c.execute("UPDATE ai_sessions SET turn_count = turn_count + 1 WHERE session_id=%s", (sess["session_id"],))
        except Exception as e:
            log.warning("Failed to record SmartBoard telemetry: %s", e)

    return {"text": reply_text, "functionCalls": function_calls, "sources": sources}


@router.websocket("/live")
async def live_relay(client_ws: WebSocket):
    await client_ws.accept()
    keys = _get_gemini_keys()
    if not keys:
        await client_ws.close(code=1011, reason="Gemini API key is not configured")
        return

    # Receive initial setup message from client
    try:
        first_msg = await client_ws.receive()
    except Exception:
        return

    setup_text = first_msg.get("text")
    setup_bytes = first_msg.get("bytes")
    if not setup_text and not setup_bytes:
        await client_ws.close(code=1008, reason="Missing setup message")
        return

    raw_payload_text = setup_text or (setup_bytes.decode("utf-8") if isinstance(setup_bytes, bytes) else "")
    parsed_client_payload: Dict[str, Any] = {}
    try:
        parsed_client_payload = json.loads(raw_payload_text)
    except Exception:
        pass

    # Extract optional authentication token and context identifiers
    token = parsed_client_payload.pop("token", None) if isinstance(parsed_client_payload, dict) else None
    assignment_id = parsed_client_payload.pop("assignment_id", None) if isinstance(parsed_client_payload, dict) else None
    course_id = parsed_client_payload.pop("course_id", None) if isinstance(parsed_client_payload, dict) else None

    # Retrieve core Gemini setup dict (client may send {"setup": {...}} or flat setup payload)
    setup_body = parsed_client_payload.get("setup", parsed_client_payload) if isinstance(parsed_client_payload, dict) else {}

    # Enforce authentication if assignment_id was specified
    if assignment_id:
        if not token:
            await client_ws.close(code=1008, reason="Authentication token required for assignment live session")
            return
        user = _authenticate_token(token, client_ws.app)
        if not user:
            await client_ws.close(code=1008, reason="Authentication failed")
            return

        db = getattr(client_ws.app.state, "db", None)
        att_id = None
        if db:
            with db.tx() as c:
                try:
                    a = student_assignment(c, user, assignment_id)
                    att = one(c, "SELECT * FROM attempts WHERE student_id=%s AND assignment_id=%s AND status IN ('DRAFT','IN_PROGRESS') ORDER BY attempt_number DESC LIMIT 1",
                              (user.user_id, assignment_id))
                    if att:
                        att_id = att["attempt_id"]
                    app_ctx = coach_application_context(c, a)
                    assignment_text = (
                        f"\n--- ASSIGNMENT CONTEXT ---\n"
                        f"Course: {app_ctx.get('course_title', '')} ({app_ctx.get('course_code', '')})\n"
                        f"Assignment Title: {a.get('title')}\n"
                        f"Instructions: {a.get('instructions') or 'None'}\n"
                        f"Concepts: {', '.join(app_ctx.get('concepts', []))}\n"
                    )
                    sys_inst = setup_body.setdefault("systemInstruction", {}).setdefault("parts", [])
                    sys_inst.append({"text": assignment_text})
                except Exception as exc:
                    log.warning("Live relay assignment authorization failed: %s", exc)
                    await client_ws.close(code=1008, reason="Assignment access denied")
                    return
    elif token:
        # User provided token without specific assignment (general course or student live session)
        user = _authenticate_token(token, client_ws.app)
        if not user:
            await client_ws.close(code=1008, reason="Authentication failed")
            return
        att_id = None

    # Strictly enforce English default language policy in setup instructions
    language_directive = (
        "\n--- LANGUAGE DIRECTIVE ---\n"
        "Always speak in English by default. Do not speak Spanish. "
        "Only switch to Arabic if the student explicitly addresses you in Arabic."
    )
    if isinstance(setup_body, dict):
        sys_inst = setup_body.setdefault("systemInstruction", {}).setdefault("parts", [])
        sys_inst.append({"text": language_directive})

    # Prepare cleaned setup payload to send upstream to Google (no auth tokens or internal metadata)
    cleaned_setup_msg = json.dumps({"setup": setup_body} if "model" in setup_body else setup_body)

    connected_ws = None
    for key in keys:
        google_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={key}"
        try:
            g_ws = await websockets.connect(google_url)
            await g_ws.send(cleaned_setup_msg)
            ack = await asyncio.wait_for(g_ws.recv(), timeout=5)
            if isinstance(ack, bytes):
                try:
                    await client_ws.send_text(ack.decode("utf-8"))
                except UnicodeDecodeError:
                    await client_ws.send_bytes(ack)
            else:
                await client_ws.send_text(ack)
            connected_ws = g_ws
            break
        except Exception as e:
            log.warning("Live WebSocket setup failed on key, trying fallback: %s", str(e)[:100])
            try:
                await g_ws.close()
            except Exception:
                pass

    if not connected_ws:
        await client_ws.close(code=1011, reason="All Gemini API keys failed or exceeded quota")
        return

    google_ws = connected_ws
    stop_event = asyncio.Event()
    live_coach_ids: list[str] = []
    live_tools_used: list[str] = []

    async def client_to_google():
        try:
            while not stop_event.is_set():
                msg = await client_ws.receive()
                if "text" in msg and msg["text"]:
                    await google_ws.send(msg["text"])
                elif "bytes" in msg and msg["bytes"]:
                    await google_ws.send(msg["bytes"])
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.warning("client_to_google interrupted: %s", e)
        finally:
            stop_event.set()

    async def google_to_client():
        try:
            async for message in google_ws:
                if stop_event.is_set():
                    break
                raw_text = None
                if isinstance(message, str):
                    raw_text = message
                elif isinstance(message, bytes):
                    try:
                        raw_text = message.decode("utf-8")
                    except UnicodeDecodeError:
                        raw_text = None

                # If the message contains function calls and we have an open attempt, stamp signed element_id
                if raw_text and att_id:
                    try:
                        parsed = json.loads(raw_text)
                        tc = parsed.get("toolCall")
                        if tc and isinstance(tc, dict) and "functionCalls" in tc:
                            for fc in tc["functionCalls"]:
                                el_id = sign_coach_element_id(att_id)
                                fc["element_id"] = el_id
                                live_coach_ids.append(el_id)
                                live_tools_used.append(fc.get("name", "unknown"))
                            raw_text = json.dumps(parsed)
                            if isinstance(message, bytes):
                                message = raw_text.encode("utf-8")
                            else:
                                message = raw_text
                    except Exception:
                        pass

                if isinstance(message, bytes):
                    try:
                        await client_ws.send_text(message.decode("utf-8"))
                    except UnicodeDecodeError:
                        await client_ws.send_bytes(message)
                elif isinstance(message, str):
                    await client_ws.send_text(message)
                else:
                    await client_ws.send_bytes(message)
        except Exception as e:
            log.warning("google_to_client interrupted: %s", e)
        finally:
            stop_event.set()

    try:
        done, pending = await asyncio.wait(
            [asyncio.create_task(client_to_google()), asyncio.create_task(google_to_client())],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
    finally:
        try:
            await google_ws.close()
        except Exception:
            pass
        try:
            await client_ws.close()
        except Exception:
            pass

        # Record Live Voice interaction telemetry on session completion
        if db and user and assignment_id and att_id:
            try:
                with db.tx() as c:
                    sess = one(c, "SELECT * FROM ai_sessions WHERE attempt_id=%s AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1", (att_id,))
                    if sess is None:
                        sess_id = new_id("ses")
                        c.execute("""INSERT INTO ai_sessions (session_id, student_id, assignment_id, attempt_id, policy, university_id)
                                     VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                  (sess_id, user.user_id, assignment_id, att_id, "SOCRATIC", user.university_id))
                        sess = one(c, "SELECT * FROM ai_sessions WHERE attempt_id=%s AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1", (att_id,))
                    if sess:
                        interaction_id = new_id("int")
                        c.execute("""INSERT INTO ai_interactions (interaction_id, session_id, student_id, assignment_id, intervention_type, assistance_level, diagnosis,
                                        diagnosis_confidence, diagnosis_explanation, diagnosis_evidence, response, referenced_concepts, tools_used, university_id)
                                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s)""",
                                  (interaction_id, sess["session_id"], user.user_id, assignment_id,
                                   "SMARTBOARD_GUIDANCE", "SUGGESTION", "GUIDED_PRACTICE", 0.9,
                                   "SmartBoard Live Voice interaction", "Interactive live voice exploration",
                                   "SmartBoard Live Voice session", json.dumps([]), json.dumps(live_tools_used), user.university_id))
                        insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="AI_INTERACTION",
                                     assignment_id=assignment_id, session_id=sess["session_id"], attempt_id=att_id,
                                     interaction_id=interaction_id,
                                     payload={
                                         "intervention": "SMARTBOARD_GUIDANCE",
                                         "tools_used": live_tools_used,
                                         "coach_element_ids": live_coach_ids,
                                         "sources": 0,
                                         "mode": "smartboard",
                                         "channel": "live"
                                     })
                        c.execute("UPDATE ai_sessions SET turn_count = turn_count + 1 WHERE session_id=%s", (sess["session_id"],))
            except Exception as e:
                log.warning("Failed to record Live telemetry on disconnect: %s", e)

