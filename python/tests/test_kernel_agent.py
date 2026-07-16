from __future__ import annotations

import json
from concurrent.futures import CancelledError
from typing import Any

from openwrangler_runtime import kernel_agent
from openwrangler_runtime.session import SessionManager

EMPTY_FILTER = {"filters": [], "sort": []}


def _envelope(request: dict[str, Any], *, request_id: str = "kernel-request") -> str:
    return json.dumps(
        {
            "protocolVersion": 2,
            "requestId": request_id,
            "priority": "interactive",
            "request": request,
        }
    )


def test_unknown_session_error_is_a_correlated_protocol_response(monkeypatch) -> None:
    monkeypatch.setattr(kernel_agent, "_manager", SessionManager())

    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "missing-session",
                    "revision": 0,
                    "viewRequestId": "view-unknown-session",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="unknown-session-request",
            )
        )
    )

    assert result["protocolVersion"] == 2
    assert result["requestId"] == "unknown-session-request"
    assert result["response"]["kind"] == "error"
    assert result["response"]["code"] == "engine_error"
    assert result["response"]["viewRequestId"] == "view-unknown-session"


def test_decoder_error_preserves_available_request_and_view_correlation() -> None:
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-malformed",
                    "offset": 0,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="malformed-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "malformed-request",
        "response": {
            "kind": "error",
            "code": "invalid_request",
            "message": "getPage request is missing required fields: limit",
            "recoverable": False,
            "viewRequestId": "view-malformed",
        },
    }


def test_malformed_json_still_returns_a_canonical_envelope() -> None:
    result = json.loads(kernel_agent.dispatch_json("not-json"))

    assert result["protocolVersion"] == 2
    assert result["requestId"] == "unknown"
    assert result["response"]["kind"] == "error"
    assert result["response"]["code"] == "runtime_error"


def test_malformed_envelope_preserves_its_available_request_id() -> None:
    result = json.loads(
        kernel_agent.dispatch_json(
            json.dumps(
                {
                    "protocolVersion": 2,
                    "requestId": "malformed-envelope",
                    "request": {"kind": "initialize"},
                }
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "malformed-envelope",
        "response": {
            "kind": "error",
            "code": "invalid_request",
            "message": "priority must be interactive or background.",
            "recoverable": False,
        },
    }


def test_cancelled_dispatch_is_returned_as_a_correlated_response(monkeypatch) -> None:
    def cancel(_manager: SessionManager, _request: dict[str, Any]) -> dict[str, Any]:
        raise CancelledError

    monkeypatch.setattr(kernel_agent, "dispatch", cancel)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-cancelled",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="cancelled-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "cancelled-request",
        "response": {
            "kind": "cancelled",
            "targetRequestId": "cancelled-request",
            "viewRequestId": "view-cancelled",
        },
    }


def test_unexpected_dispatch_error_is_returned_as_a_correlated_response(monkeypatch) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-error",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="error-request",
            )
        )
    )

    assert result["protocolVersion"] == 2
    assert result["requestId"] == "error-request"
    assert result["response"]["kind"] == "error"
    assert result["response"]["code"] == "runtime_error"
    assert result["response"]["message"] == "unexpected failure"
    assert result["response"]["viewRequestId"] == "view-error"


def test_cancel_request_returns_a_protocol_acknowledgement() -> None:
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {"kind": "cancelRequest", "targetRequestId": "target-request"},
                request_id="cancel-command",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "cancel-command",
        "response": {"kind": "cancelled", "targetRequestId": "target-request"},
    }
