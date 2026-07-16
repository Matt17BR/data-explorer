from __future__ import annotations

import json
import subprocess
import sys


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
