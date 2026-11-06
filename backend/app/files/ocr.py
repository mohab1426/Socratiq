"""In-process OCR (RapidOCR / ONNX). No subprocess, no external binary. Loaded lazily, guarded by a lock."""
from __future__ import annotations

import io
import threading

from .errors import ExtractionError
from .validation import MAX_IMAGE_PIXELS

_lock = threading.Lock()
_engine = None
last_mean_confidence = 0.0     # informational (best-effort, per last call; not thread-exact)
MIN_CONFIDENCE = 0.5
MAX_SIDE = 3000


def ocr_image(data: bytes) -> str:
    global _engine
    try:
        from PIL import Image
        import numpy as np
    except ImportError as exc:  # pragma: no cover
        raise ExtractionError("image support (Pillow) is not installed", code="unavailable") from exc
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise ExtractionError(f"image cannot be decoded: {exc}") from exc
    img = img.convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE))
    with _lock:
        if _engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError as exc:
                raise ExtractionError("OCR engine is not installed", code="unavailable") from exc
            _engine = RapidOCR()
        result, _ = _engine(np.array(img))
    if not result:
        return ""
    boxes = []
    for box, text, score in result:
        text = str(text).strip()
        if float(score) < MIN_CONFIDENCE or not text:
            continue
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        boxes.append({"cy": (min(ys) + max(ys)) / 2, "h": max(ys) - min(ys), "x": min(xs), "t": text, "s": float(score)})
    boxes.sort(key=lambda b: b["cy"])
    lines: list[list[dict]] = []
    for b in boxes:                                   # cluster into lines by vertical-centre proximity
        if lines:
            ref = lines[-1]
            line_cy = sum(x["cy"] for x in ref) / len(ref)
            line_h = max(x["h"] for x in ref)
            if abs(b["cy"] - line_cy) <= 0.6 * max(line_h, b["h"], 1):
                ref.append(b)
                continue
        lines.append([b])
    global last_mean_confidence
    last_mean_confidence = (sum(b["s"] for b in boxes) / len(boxes)) if boxes else 0.0
    return "\n".join(" ".join(x["t"] for x in sorted(line, key=lambda b: b["x"])) for line in lines)
