"""The native (Excalidraw) board scene: validation, sanitisation and trusted-authorship rules.

The scene is JSON produced by a browser and later rendered for other people (teachers). It is therefore treated as UNTRUSTED input:
only known element types, bounded numbers and sizes, no executable links, no remote embeds, and only raster image data URLs survive.
Legacy `steps` / `strokes` / `elements` are never touched by anything in here.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any, Optional

SCENE_MAX_BYTES = 2_500_000
MAX_ELEMENTS = 3000
MAX_POINTS_PER_ELEMENT = 5000
MAX_POINTS_TOTAL = 200_000
MAX_FILES = 60
MAX_FILE_CHARS = 1_300_000
MAX_FILES_TOTAL_CHARS = 2_000_000
MAX_COORD = 1_000_000.0
ALLOWED_TYPES = frozenset({"rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame", "magicframe"})   # no embeddable/iframe: they load remote pages
APPSTATE_KEYS = {"viewBackgroundColor": str, "gridSize": (int, type(None)), "gridModeEnabled": bool, "theme": str}
_DATA_URL = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$")
_SAFE_LINK = re.compile(r"^(https?://|mailto:)", re.I)
_NUMERIC = ("x", "y", "width", "height", "angle", "strokeWidth", "opacity", "fontSize")


class SceneError(ValueError):
    pass


def _num(v: Any, name: str, lo: float = -MAX_COORD, hi: float = MAX_COORD) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < lo or v > hi:
        raise SceneError(f"{name} is not a usable number")
    return float(v)


def sanitize_scene(raw: Any) -> dict[str, Any]:
    """Return a cleaned copy of `raw` or raise SceneError. Never mutates its input."""
    if not isinstance(raw, dict):
        raise SceneError("scene must be an object")
    if raw.get("type") != "excalidraw":
        raise SceneError("scene is not an excalidraw scene")
    version = raw.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or not 1 <= version <= 20:
        raise SceneError("scene version is not supported")
    elements_in = raw.get("elements")
    if not isinstance(elements_in, list) or len(elements_in) > MAX_ELEMENTS:
        raise SceneError(f"a scene holds at most {MAX_ELEMENTS} elements")

    seen: set[str] = set()
    elements: list[dict[str, Any]] = []
    total_points = 0
    for e in elements_in:
        if not isinstance(e, dict):
            raise SceneError("an element is not an object")
        eid, etype = e.get("id"), e.get("type")
        if not isinstance(eid, str) or not 1 <= len(eid) <= 128:
            raise SceneError("an element has no usable id")
        if eid in seen:
            raise SceneError("duplicate element ids")
        seen.add(eid)
        if etype not in ALLOWED_TYPES:
            continue                                                            # dropped, not fatal: e.g. a pasted embed
        for k in _NUMERIC:
            if k in e and e[k] is not None:
                _num(e[k], f"{eid}.{k}", -MAX_COORD, MAX_COORD if k != "opacity" else 100)
        clean = dict(e)
        pts = e.get("points")
        if pts is not None:
            if not isinstance(pts, list) or len(pts) > MAX_POINTS_PER_ELEMENT:
                raise SceneError(f"{eid} has too many points")
            total_points += len(pts)
            for p in pts:
                if not (isinstance(p, (list, tuple)) and len(p) == 2):
                    raise SceneError(f"{eid} has a malformed point")
                _num(p[0], f"{eid}.point"); _num(p[1], f"{eid}.point")
        if total_points > MAX_POINTS_TOTAL:
            raise SceneError("the drawing is too large")
        if isinstance(e.get("text"), str) and len(e["text"]) > 20000:
            raise SceneError(f"{eid} holds too much text")
        link = e.get("link")
        if link is not None and not (isinstance(link, str) and _SAFE_LINK.match(link) and len(link) <= 2000):
            clean["link"] = None                                                # javascript:, data: and the like never survive
        gids = e.get("groupIds")
        if gids is not None and (not isinstance(gids, list) or len(gids) > 20 or not all(isinstance(g, str) and len(g) <= 128 for g in gids)):
            raise SceneError(f"{eid} has malformed group ids")
        cd = e.get("customData")
        if cd is not None and (not isinstance(cd, dict) or len(json.dumps(cd)) > 4000):
            raise SceneError(f"{eid} has oversized custom data")
        elements.append(clean)

    app_in = raw.get("appState") or {}
    if not isinstance(app_in, dict):
        raise SceneError("appState must be an object")
    def _app_ok(k: str, v: Any) -> bool:
        t = APPSTATE_KEYS[k]
        return isinstance(v, bool) if t is bool else (not isinstance(v, bool) and isinstance(v, t))
    app = {k: v for k, v in app_in.items() if k in APPSTATE_KEYS and _app_ok(k, v)}
    if isinstance(app.get("viewBackgroundColor"), str) and len(app["viewBackgroundColor"]) > 40:
        app.pop("viewBackgroundColor")

    files_in = raw.get("files") or {}
    if not isinstance(files_in, dict) or len(files_in) > MAX_FILES:
        raise SceneError(f"a scene holds at most {MAX_FILES} images")
    used = {e.get("fileId") for e in elements if e.get("type") == "image"}
    files: dict[str, Any] = {}
    chars = 0
    for fid, f in files_in.items():
        if not isinstance(fid, str) or not 1 <= len(fid) <= 128 or not isinstance(f, dict):
            raise SceneError("a stored image is malformed")
        if fid not in used:
            continue                                                            # orphaned image data is not stored
        url = f.get("dataURL")
        if not isinstance(url, str) or len(url) > MAX_FILE_CHARS or not _DATA_URL.match(url):
            raise SceneError("only png, jpeg, gif and webp images of reasonable size can be stored")
        chars += len(url)
        if chars > MAX_FILES_TOTAL_CHARS:
            raise SceneError("the images on this board are too large; remove or shrink some")
        files[fid] = {"id": fid, "mimeType": url.split(";")[0][5:], "dataURL": url, "created": _num(f.get("created", 0), "created", 0, 1e15)}

    out: dict[str, Any] = {"type": "excalidraw", "version": version, "elements": elements, "appState": app, "files": files}
    view = raw.get("view")
    if view is not None:
        if not isinstance(view, dict):
            raise SceneError("view must be an object")
        out["view"] = {"scrollX": _num(view.get("scrollX", 0), "scrollX"), "scrollY": _num(view.get("scrollY", 0), "scrollY"), "zoom": _num(view.get("zoom", 1), "zoom", 0.01, 100)}
    if len(json.dumps(out)) > SCENE_MAX_BYTES:
        raise SceneError("the board is too large to save; remove images or large drawings")
    return out


def _meta(e: dict) -> dict:
    m = (e.get("customData") or {}).get("socratiq")
    return m if isinstance(m, dict) else {}


def enforce_scene_authorship(scene: dict[str, Any], trusted_coach_ids: set[str]) -> dict[str, Any]:
    """A scene element may only claim author "coach" if it mirrors a coach element the SERVER wrote (legacy id verified against the stored board).
    Anything else claiming to be the Coach is downgraded to "student" with provenance dropped, mirroring the legacy board's rule.
    "ai" (SmartBoard drawing assistant) is advisory display metadata only: it is never used as trusted evidence about the student's work."""
    out = []
    for e in scene["elements"]:
        m = _meta(e)
        if m.get("author") == "coach" and m.get("legacyId") not in trusted_coach_ids:
            e = {**e, "customData": {**(e.get("customData") or {}), "socratiq": {**m, "author": "student", "legacyId": None}}}
        out.append(e)
    return {**scene, "elements": out}


def scene_student_texts(scene: Optional[dict]) -> list[str]:
    """Text on the native board that the student wrote (author student/unspecified). AI- and Coach-authored text is excluded on purpose."""
    if not scene:
        return []
    live = [e for e in scene.get("elements", []) if isinstance(e, dict) and not e.get("isDeleted") and e.get("type") == "text"]
    rows = [e for e in live if _meta(e).get("author", "student") == "student" and isinstance(e.get("text"), str) and e["text"].strip()]
    rows.sort(key=lambda e: (round(float(e.get("y", 0)) / 40), float(e.get("x", 0))))
    return [e["text"] for e in rows]
