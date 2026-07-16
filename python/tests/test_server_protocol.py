from __future__ import annotations

import json
import subprocess
import sys
from io import StringIO

import openwrangler_runtime.server as server


def test_stdio_server_frames_protocol_v2_responses() -> None:
    requests = [
        {
            "protocolVersion": 2,
            "requestId": "initialize",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        },
        {
            "protocolVersion": 1,
            "requestId": "invalid",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        },
    ]
    process = subprocess.run(
        [sys.executable, "-m", "openwrangler_runtime.server"],
        input="".join(f"{json.dumps(request)}\n" for request in requests),
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    responses = {item["requestId"]: item for item in map(json.loads, process.stdout.splitlines())}

    assert responses["initialize"]["protocolVersion"] == 2
    assert responses["initialize"]["response"]["kind"] == "initialized"
    assert responses["invalid"]["response"]["code"] == "invalid_request"


def test_stdio_server_closes_all_sessions_when_input_ends(monkeypatch) -> None:
    class TrackingManager:
        def __init__(self) -> None:
            self.closed = False

        def close_all(self) -> None:
            self.closed = True

    manager = TrackingManager()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", StringIO(""))

    server.main()

    assert manager.closed is True
