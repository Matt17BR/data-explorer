from __future__ import annotations

import pytest

from openwrangler_runtime import SessionManager, __version__
from openwrangler_runtime.protocol import ProtocolError, decode_envelope


def test_initialize_advertises_the_canonical_runtime_version() -> None:
    assert SessionManager().initialize()["runtimeVersion"] == __version__


def test_protocol_v2_decodes_correlated_request() -> None:
    request_id, priority, request = decode_envelope(
        {
            "protocolVersion": 2,
            "requestId": "request-1",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        }
    )

    assert request_id == "request-1"
    assert priority == "interactive"
    assert request == {"kind": "initialize"}


def test_open_session_accepts_only_a_non_empty_requested_session_identity() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "open-1",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "/tmp/sample.csv"},
            "requestedSessionId": "candidate-session",
            "pageSize": 200,
        },
    }

    assert decode_envelope(envelope)[2]["requestedSessionId"] == "candidate-session"
    envelope["request"]["requestedSessionId"] = ""
    with pytest.raises(ProtocolError, match="requestedSessionId must be a non-empty string"):
        decode_envelope(envelope)


def test_open_session_accepts_duckdb_and_rejects_unknown_backends() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "open-duckdb",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.parquet", "path": "/tmp/sample.parquet"},
            "backend": "duckdb",
            "pageSize": 200,
        },
    }

    assert decode_envelope(envelope)[2]["backend"] == "duckdb"
    envelope["request"]["backend"] = "sqlite"
    with pytest.raises(ProtocolError, match="pandas, polars, or duckdb"):
        decode_envelope(envelope)


@pytest.mark.parametrize("kind", ["getPage", "getSummary", "getDatasetStats", "getColumnValues"])
def test_view_queries_require_non_empty_view_request_ids(kind: str) -> None:
    request: dict[str, object] = {
        "kind": kind,
        "sessionId": "session-1",
        "revision": 0,
        "viewRequestId": "view-17",
        "filterModel": {"logic": "and", "filters": [], "sort": []},
    }
    if kind == "getPage":
        request.update(offset=0, limit=200)
    elif kind == "getColumnValues":
        request.update(column="city", limit=100)

    envelope = {
        "protocolVersion": 2,
        "requestId": "transport-1",
        "priority": "background" if kind != "getPage" else "interactive",
        "request": request,
    }
    assert decode_envelope(envelope)[2]["viewRequestId"] == "view-17"

    request.pop("viewRequestId")
    with pytest.raises(ProtocolError, match="viewRequestId"):
        decode_envelope(envelope)

    request["viewRequestId"] = ""
    with pytest.raises(ProtocolError, match="non-empty"):
        decode_envelope(envelope)


def test_protocol_v2_validates_transformation_steps() -> None:
    _, _, request = decode_envelope(
        {
            "protocolVersion": 2,
            "requestId": "preview-1",
            "priority": "interactive",
            "request": {
                "kind": "previewStep",
                "sessionId": "session-1",
                "revision": 0,
                "step": {
                    "id": "rename-1",
                    "kind": "renameColumn",
                    "params": {"column": {"id": "column:0", "name": "old"}, "newName": "new"},
                },
                "offset": 0,
                "limit": 200,
            },
        }
    )

    assert request["step"]["kind"] == "renameColumn"


@pytest.mark.parametrize(
    "step",
    [
        {
            "id": "select",
            "kind": "selectColumns",
            "params": {"columns": [{"id": "column:0", "name": "value"}]},
        },
        {
            "id": "drop",
            "kind": "dropColumns",
            "params": {"columns": [{"id": "column:0", "name": "value"}]},
        },
        {
            "id": "rename",
            "kind": "renameColumn",
            "params": {"column": {"id": "column:0", "name": "value"}, "newName": "amount"},
        },
        {
            "id": "clone",
            "kind": "cloneColumn",
            "params": {"column": {"id": "column:0", "name": "value"}, "newName": "copy"},
        },
        {
            "id": "cast",
            "kind": "castColumn",
            "params": {"column": {"id": "column:0", "name": "value"}, "dtype": "float"},
        },
        {
            "id": "formula-value",
            "kind": "formula",
            "params": {
                "leftColumn": {"id": "column:0", "name": "value"},
                "operator": "multiply",
                "value": 2,
                "newColumn": "doubled",
            },
        },
        {
            "id": "formula-column",
            "kind": "formula",
            "params": {
                "leftColumn": {"id": "column:0", "name": "value"},
                "operator": "add",
                "rightColumn": {"id": "column:1", "name": "other"},
                "newColumn": "total",
            },
        },
        {
            "id": "length-empty-name",
            "kind": "textLength",
            "params": {"column": {"id": "column:2", "name": ""}, "newColumn": "length"},
        },
    ],
    ids=lambda step: str(step["id"]),
)
def test_protocol_v2_accepts_canonical_column_references(step: dict) -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": f"preview-{step['id']}",
        "priority": "interactive",
        "request": {
            "kind": "previewStep",
            "sessionId": "session-1",
            "revision": 0,
            "step": step,
            "offset": 0,
            "limit": 200,
        },
    }

    assert decode_envelope(envelope)[2]["step"] == step


@pytest.mark.parametrize(
    ("step", "message"),
    [
        (
            {"id": "select-string", "kind": "selectColumns", "params": {"columns": ["value"]}},
            "column reference object",
        ),
        (
            {"id": "drop-empty", "kind": "dropColumns", "params": {"columns": []}},
            "non-empty array of column references",
        ),
        (
            {
                "id": "rename-string",
                "kind": "renameColumn",
                "params": {"column": "value", "newName": "amount"},
            },
            "column reference object",
        ),
        (
            {
                "id": "clone-name-only",
                "kind": "cloneColumn",
                "params": {"column": {"name": "value"}, "newName": "copy"},
            },
            "missing required fields: id",
        ),
        (
            {
                "id": "cast-id-only",
                "kind": "castColumn",
                "params": {"column": {"id": "column:0"}, "dtype": "float"},
            },
            "missing required fields: name",
        ),
        (
            {
                "id": "formula-string",
                "kind": "formula",
                "params": {
                    "leftColumn": "value",
                    "operator": "add",
                    "rightColumn": "other",
                    "newColumn": "total",
                },
            },
            "column reference object",
        ),
        (
            {
                "id": "length-extra",
                "kind": "textLength",
                "params": {
                    "column": {"id": "column:0", "name": "value", "position": 0},
                    "newColumn": "length",
                },
            },
            "unknown fields: position",
        ),
        (
            {
                "id": "length-empty-id",
                "kind": "textLength",
                "params": {"column": {"id": "", "name": "value"}, "newColumn": "length"},
            },
            "id must be a non-empty string",
        ),
        (
            {
                "id": "length-non-string-name",
                "kind": "textLength",
                "params": {"column": {"id": "column:0", "name": 42}, "newColumn": "length"},
            },
            "name must be a string",
        ),
        (
            {
                "id": "rename-name-field",
                "kind": "renameColumn",
                "params": {"columnName": "value", "newName": "amount"},
            },
            "missing required parameters: column",
        ),
    ],
)
def test_protocol_v2_rejects_legacy_or_malformed_column_references(step: dict, message: str) -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": f"preview-{step['id']}",
        "priority": "interactive",
        "request": {
            "kind": "previewStep",
            "sessionId": "session-1",
            "revision": 0,
            "step": step,
            "offset": 0,
            "limit": 200,
        },
    }

    with pytest.raises(ProtocolError, match=message):
        decode_envelope(envelope)


def test_protocol_v2_validates_applied_step_inspection() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "inspect-1",
        "priority": "interactive",
        "request": {
            "kind": "inspectStep",
            "sessionId": "session-1",
            "revision": 2,
            "stepId": "round-value",
            "offset": 20,
            "limit": 10,
        },
    }

    assert decode_envelope(envelope)[2] == envelope["request"]
    envelope["request"]["limit"] = 10_000
    assert decode_envelope(envelope)[2]["limit"] == 10_000

    envelope["request"]["limit"] = 10_001
    with pytest.raises(ProtocolError, match="inspectStep limit must not exceed 10000"):
        decode_envelope(envelope)

    envelope["request"]["limit"] = 10
    envelope["request"]["stepId"] = ""
    with pytest.raises(ProtocolError, match="stepId must be a non-empty string"):
        decode_envelope(envelope)

    envelope["request"]["stepId"] = "round-value"
    envelope["request"]["unexpected"] = True
    with pytest.raises(ProtocolError, match="unknown fields"):
        decode_envelope(envelope)


def test_protocol_v2_rejects_malformed_transformation_steps() -> None:
    with pytest.raises(ProtocolError, match="missing required"):
        decode_envelope(
            {
                "protocolVersion": 2,
                "requestId": "preview-bad",
                "priority": "interactive",
                "request": {
                    "kind": "previewStep",
                    "sessionId": "session-1",
                    "revision": 0,
                    "step": {
                        "id": "rename-1",
                        "kind": "renameColumn",
                        "params": {"column": {"id": "column:0", "name": "old"}},
                    },
                    "offset": 0,
                    "limit": 200,
                },
            }
        )


def test_protocol_v2_validates_export_format() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "export-1",
        "priority": "interactive",
        "request": {
            "kind": "exportData",
            "sessionId": "session-1",
            "revision": 2,
            "path": "/tmp/cleaned.csv",
            "format": "csv",
        },
    }
    assert decode_envelope(envelope)[2]["format"] == "csv"
    envelope["request"]["format"] = "xlsx"
    with pytest.raises(ProtocolError, match="csv or parquet"):
        decode_envelope(envelope)


@pytest.mark.parametrize(
    "envelope",
    [
        {"protocolVersion": 1, "requestId": "x", "priority": "interactive", "request": {"kind": "initialize"}},
        {"protocolVersion": 2, "requestId": "", "priority": "interactive", "request": {"kind": "initialize"}},
        {"protocolVersion": 2, "requestId": "x", "priority": "fast", "request": {"kind": "initialize"}},
        {"protocolVersion": 2, "requestId": "x", "priority": "interactive", "request": {"kind": "getPage"}},
    ],
)
def test_protocol_v2_rejects_malformed_envelopes(envelope: object) -> None:
    with pytest.raises(ProtocolError):
        decode_envelope(envelope)
