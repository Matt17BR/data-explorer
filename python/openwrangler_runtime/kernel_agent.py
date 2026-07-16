from __future__ import annotations

import json
import traceback
from typing import Any

from .protocol import decode_envelope, decode_request, error_response, response_envelope
from .server import dispatch
from .session import SessionManager

_manager = SessionManager()


def dispatch_json(payload: str) -> str:
    """Dispatch an Open Wrangler request inside the active Jupyter kernel."""
    try:
        decoded = json.loads(payload)
        if isinstance(decoded, dict) and "protocolVersion" in decoded:
            request_id, _, request = decode_envelope(decoded)
            response = dispatch(_manager, request)
            return json.dumps(response_envelope(request_id, response), default=str, allow_nan=False)
        request = decode_request(decoded)
        response = dispatch(_manager, request)
        return json.dumps({"response": response}, default=str, allow_nan=False)
    except Exception as error:
        return json.dumps(
            {
                "response": error_response(str(error), detail=traceback.format_exc()),
            },
            default=str,
            allow_nan=False,
        )


def dispatch_request(request: dict[str, Any]) -> dict[str, Any]:
    """Small direct-call hook for tests and future in-kernel integrations."""
    return dispatch(_manager, decode_request(request))
