from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any

import pytest
from jupyter_client.manager import KernelManager


@pytest.fixture
def live_kernel():
    manager = KernelManager()
    manager.start_kernel(extra_arguments=["--HistoryManager.hist_file=:memory:"])
    client = manager.blocking_client()
    client.start_channels()
    client.wait_for_ready(timeout=20)
    try:
        yield manager, client
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)


def test_real_kernel_transport_handles_both_engines_and_restart(live_kernel) -> None:
    manager, client = live_kernel
    bootstrap = """
import data_wrangler_runtime.kernel_agent as __de_kernel_agent
import data_wrangler_runtime.notebook as __de_notebook
__de_notebook.register_formatters()
"""
    _execute(client, bootstrap)

    initialized = _dispatch(client, "initialize", {"kind": "initialize"})
    assert initialized["response"]["kind"] == "initialized"
    assert initialized["response"]["protocolVersion"] == 2

    _execute(
        client,
        "import pandas as pd\nimport polars as pl\npandas_frame = pd.DataFrame({'value': [1, 2]})\n"
        "polars_frame = pl.DataFrame({'value': [3, 4]})",
    )
    _, pandas_mime = _execute_with_data(client, "pandas_frame")
    _, polars_mime = _execute_with_data(client, "polars_frame")
    mime_type = "application/vnd.data-explorer.viewer.v2+json"
    assert pandas_mime[mime_type]["metadata"]["backend"] == "pandas"
    assert polars_mime[mime_type]["metadata"]["backend"] == "polars"
    pandas_opened = _dispatch(
        client,
        "pandas",
        {
            "kind": "openSession",
            "source": {"kind": "notebookVariable", "label": "pandas_frame", "variableName": "pandas_frame"},
            "backend": "pandas",
            "mode": "viewing",
            "pageSize": 10,
        },
    )
    polars_opened = _dispatch(
        client,
        "polars",
        {
            "kind": "openSession",
            "source": {"kind": "notebookVariable", "label": "polars_frame", "variableName": "polars_frame"},
            "backend": "polars",
            "mode": "viewing",
            "pageSize": 10,
        },
    )
    assert pandas_opened["response"]["metadata"]["backend"] == "pandas"
    assert polars_opened["response"]["metadata"]["backend"] == "polars"
    assert pandas_opened["response"]["page"]["rows"][1]["values"][0]["display"] == "2"
    assert polars_opened["response"]["page"]["rows"][0]["values"][0]["display"] == "3"

    manager.restart_kernel(now=True)
    client.wait_for_ready(timeout=20)
    _execute(client, bootstrap)
    restarted = _dispatch(client, "restarted", {"kind": "initialize"})
    assert restarted["response"]["kind"] == "initialized"


def _dispatch(client: Any, request_id: str, request: Mapping[str, Any]) -> dict[str, Any]:
    envelope = {
        "protocolVersion": 2,
        "requestId": request_id,
        "priority": "interactive",
        "request": request,
    }
    payload = base64.b64encode(json.dumps(envelope).encode()).decode()
    marker = request_id.replace("-", "")
    output = _execute(
        client,
        f"""
import base64 as __de_base64
import data_wrangler_runtime.kernel_agent as __de_kernel_agent
__de_payload = __de_base64.b64decode({payload!r}).decode("utf-8")
print("__DATA_EXPLORER_START_{marker}__")
print(__de_kernel_agent.dispatch_json(__de_payload))
print("__DATA_EXPLORER_END_{marker}__")
""",
    )
    start = f"__DATA_EXPLORER_START_{marker}__"
    end = f"__DATA_EXPLORER_END_{marker}__"
    return json.loads(output.split(start, 1)[1].split(end, 1)[0].strip())


def _execute(client: Any, code: str) -> str:
    return _execute_with_data(client, code)[0]


def _execute_with_data(client: Any, code: str) -> tuple[str, dict[str, Any]]:
    message_id = client.execute(code)
    chunks: list[str] = []
    data: dict[str, Any] = {}
    while True:
        message = client.get_iopub_msg(timeout=20)
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        message_type = message.get("msg_type")
        content = message.get("content", {})
        if message_type == "stream":
            chunks.append(str(content.get("text", "")))
        elif message_type in {"display_data", "execute_result"}:
            data.update(content.get("data", {}))
        elif message_type == "error":
            pytest.fail("\n".join(content.get("traceback", [])))
        elif message_type == "status" and content.get("execution_state") == "idle":
            return "".join(chunks), data
