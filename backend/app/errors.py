from typing import Optional


class AppError(Exception):
    """Any error we want to show the client as a clean JSON error."""

    def __init__(self, status_code: int, message: str, code: Optional[str] = None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.code = code


def not_found(message: str = "Not found") -> AppError:
    # Also used for "exists but not yours" so IDs can't be probed.
    return AppError(404, message, code="not_found")


def conflict(message: str, code: Optional[str] = None) -> AppError:
    return AppError(409, message, code=code)


class AIUnavailable(AppError):
    def __init__(self, message: str = "The AI service is temporarily unavailable. Please try again."):
        super().__init__(503, message, code="ai_unavailable")
