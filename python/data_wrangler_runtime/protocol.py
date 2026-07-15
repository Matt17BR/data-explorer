from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .operations import OperationError, validate_step

PROTOCOL_VERSION = 2
REQUEST_PRIORITIES = {"interactive", "background"}
REQUEST_FIELDS: dict[str, tuple[str, ...]] = {
    "initialize": (),
    "openSession": ("source", "pageSize"),
    "getPage": ("sessionId", "revision", "offset", "limit", "filterModel"),
    "getSummary": ("sessionId", "revision", "filterModel"),
    "getDatasetStats": ("sessionId", "revision", "filterModel"),
    "getColumnValues": ("sessionId", "revision", "column", "filterModel", "limit"),
    "previewStep": ("sessionId", "revision", "step", "offset", "limit"),
    "applyDraft": ("sessionId", "revision", "offset", "limit"),
    "discardDraft": ("sessionId", "revision", "offset", "limit"),
    "undoStep": ("sessionId", "revision", "offset", "limit"),
    "closeSession": ("sessionId", "revision"),
    "cancelRequest": ("targetRequestId",),
}
REQUEST_ALLOWED_FIELDS: dict[str, set[str]] = {
    "initialize": {"kind"},
    "openSession": {"kind", "source", "backend", "mode", "pageSize"},
    "getPage": {"kind", "sessionId", "revision", "offset", "limit", "filterModel"},
    "getSummary": {"kind", "sessionId", "revision", "filterModel", "columns"},
    "getDatasetStats": {"kind", "sessionId", "revision", "filterModel"},
    "getColumnValues": {"kind", "sessionId", "revision", "column", "filterModel", "search", "limit"},
    "previewStep": {"kind", "sessionId", "revision", "step", "replaceStepId", "offset", "limit"},
    "applyDraft": {"kind", "sessionId", "revision", "offset", "limit"},
    "discardDraft": {"kind", "sessionId", "revision", "offset", "limit"},
    "undoStep": {"kind", "sessionId", "revision", "offset", "limit"},
    "closeSession": {"kind", "sessionId", "revision"},
    "cancelRequest": {"kind", "targetRequestId"},
}


class ProtocolError(ValueError):
    """Raised when a transport envelope or request violates protocol v2."""


def decode_request(value: Any) -> dict[str, Any]:
    request = _mapping(value, "request")
    kind = request.get("kind")
    if not isinstance(kind, str) or kind not in REQUEST_FIELDS:
        raise ProtocolError(f"Unsupported request kind: {kind!r}")
    missing = [field for field in REQUEST_FIELDS[kind] if field not in request]
    if missing:
        raise ProtocolError(f"{kind} request is missing required fields: {', '.join(missing)}")
    unexpected = set(request) - REQUEST_ALLOWED_FIELDS[kind]
    if unexpected:
        raise ProtocolError(f"{kind} request contains unknown fields: {', '.join(sorted(unexpected))}")

    if "sessionId" in request and not isinstance(request["sessionId"], str):
        raise ProtocolError("sessionId must be a string.")
    if "revision" in request and not _is_non_negative_integer(request["revision"]):
        raise ProtocolError("revision must be a non-negative integer.")
    for field in ("pageSize", "limit"):
        if field in request and (not _is_non_negative_integer(request[field]) or request[field] < 1):
            raise ProtocolError(f"{field} must be a positive integer.")
    if "offset" in request and not _is_non_negative_integer(request["offset"]):
        raise ProtocolError("offset must be a non-negative integer.")
    if "filterModel" in request:
        model = _mapping(request["filterModel"], "filterModel")
        if not isinstance(model.get("filters"), list) or not isinstance(model.get("sort"), list):
            raise ProtocolError("filterModel must contain filters and sort arrays.")
    if kind == "openSession":
        source = _mapping(request["source"], "source")
        if source.get("kind") not in {"file", "notebookVariable", "notebookOutput"}:
            raise ProtocolError("source.kind is not supported.")
        if not isinstance(source.get("label"), str) or not source["label"]:
            raise ProtocolError("source.label must be a non-empty string.")
        if request.get("backend") not in {None, "pandas", "polars"}:
            raise ProtocolError("backend must be pandas or polars.")
        if request.get("mode") not in {None, "viewing", "editing"}:
            raise ProtocolError("mode must be viewing or editing.")
    if kind == "previewStep":
        step = _mapping(request["step"], "step")
        try:
            request = dict(request)
            request["step"] = validate_step(step)
        except OperationError as error:
            raise ProtocolError(str(error)) from error
        if "replaceStepId" in request and (
            not isinstance(request["replaceStepId"], str) or not request["replaceStepId"]
        ):
            raise ProtocolError("replaceStepId must be a non-empty string.")
    return dict(request)


def decode_envelope(value: Any) -> tuple[str, str, dict[str, Any]]:
    envelope = _mapping(value, "envelope")
    unexpected = set(envelope) - {"protocolVersion", "requestId", "priority", "request"}
    if unexpected:
        raise ProtocolError(f"Envelope contains unknown fields: {', '.join(sorted(unexpected))}")
    if envelope.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolError(
            f"Unsupported protocol version {envelope.get('protocolVersion')!r}; expected {PROTOCOL_VERSION}."
        )
    request_id = envelope.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        raise ProtocolError("requestId must be a non-empty string.")
    priority = envelope.get("priority")
    if priority not in REQUEST_PRIORITIES:
        raise ProtocolError("priority must be interactive or background.")
    return request_id, str(priority), decode_request(envelope.get("request"))


def response_envelope(request_id: str, response: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "response": dict(response),
    }


def error_response(
    message: str,
    *,
    code: str = "runtime_error",
    detail: str | None = None,
    recoverable: bool = True,
    session_id: str | None = None,
) -> dict[str, Any]:
    response: dict[str, Any] = {
        "kind": "error",
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    if detail:
        response["detail"] = detail
    if session_id:
        response["sessionId"] = session_id
    return response


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{label} must be a JSON object.")
    return value


def _is_non_negative_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0
