from __future__ import annotations

import json
import traceback
from typing import Any

from .server import dispatch
from .session import SessionManager

_manager = SessionManager()


def dispatch_json(payload: str) -> str:
    """Dispatch a Data Explorer request inside the active Jupyter kernel."""
    try:
        request = json.loads(payload)
        response = dispatch(_manager, request)
        return json.dumps({"response": response}, default=str)
    except Exception as error:
        return json.dumps(
            {
                "error": str(error),
                "detail": traceback.format_exc(),
            },
            default=str,
        )


def dispatch_request(request: dict[str, Any]) -> dict[str, Any]:
    """Small direct-call hook for tests and future in-kernel integrations."""
    return dispatch(_manager, request)
