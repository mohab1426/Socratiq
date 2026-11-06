"""Per-user sliding-window limits (LLM calls, uploads, invite-code guesses). In-memory = per process;
use Redis/edge limits if you run several workers."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import Depends

from .auth import CurrentUser, get_current_user
from .config import get_backend_config
from .errors import AppError

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()


def limiter(name: str, per_minute: Callable[[], int], message: str):
    def dep(user: CurrentUser = Depends(get_current_user)) -> None:
        limit, now = per_minute(), time.monotonic()
        with _lock:
            q = _hits[(name, user.user_id)]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= limit:
                raise AppError(429, message, code="rate_limited")
            q.append(now)
    return dep


ai_rate_limit = limiter("ai", lambda: get_backend_config().ai_rate_limit_per_minute, "You're sending messages too fast. Please wait a moment.")
upload_rate_limit = limiter("upload", lambda: get_backend_config().upload_rate_limit_per_minute, "Too many uploads. Please wait a moment.")
join_rate_limit = limiter("join", lambda: 10, "Too many attempts. Please wait a minute before trying another code.")


def reset_limits() -> None:   # tests
    with _lock:
        _hits.clear()
