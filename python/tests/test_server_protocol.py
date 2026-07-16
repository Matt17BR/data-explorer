from __future__ import annotations

import json
import subprocess
import sys
import threading
from concurrent.futures import Future
from io import StringIO
from typing import Any

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
            "protocolVersion": 2,
            "requestId": "missing-session",
            "priority": "interactive",
            "request": {
                "kind": "getPage",
                "sessionId": "missing",
                "revision": 0,
                "viewRequestId": "view-missing",
                "offset": 0,
                "limit": 20,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": {"logic": "and", "filters": [], "sort": []},
            },
        },
        {
            "protocolVersion": 1,
            "requestId": "invalid",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        },
    ]
    process = subprocess.Popen(
        [sys.executable, "-m", "openwrangler_runtime.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    responses: dict[str, Any] = {}
    for request in requests:
        process.stdin.write(f"{json.dumps(request)}\n")
        process.stdin.flush()
        response_line = process.stdout.readline()
        assert response_line
        response = json.loads(response_line)
        responses[response["requestId"]] = response
    process.stdin.close()
    return_code = process.wait(timeout=10)
    assert return_code == 0, process.stderr.read()

    assert responses["initialize"]["protocolVersion"] == 2
    assert responses["initialize"]["response"]["kind"] == "initialized"
    assert responses["invalid"]["response"]["code"] == "invalid_request"
    assert responses["missing-session"]["response"]["kind"] == "error"
    assert responses["missing-session"]["response"]["viewRequestId"] == "view-missing"


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


def test_dispatch_echoes_view_request_id() -> None:
    class PagingManager:
        def get_page(self, *_args: Any) -> dict[str, Any]:
            return {"kind": "page", "revision": 0, "page": {}, "metadata": {}}

    response = server.dispatch(
        PagingManager(),  # type: ignore[arg-type]
        {
            "kind": "getPage",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "view-page",
            "offset": 0,
            "limit": 20,
            "columnOffset": 3,
            "columnLimit": 7,
            "filterModel": {"logic": "and", "filters": [], "sort": []},
        },
    )

    assert response["viewRequestId"] == "view-page"


def test_dispatch_routes_applied_step_inspection_without_view_correlation() -> None:
    class InspectionManager:
        def inspect_step(self, *args: Any) -> dict[str, Any]:
            assert args == ("session", 4, "round-value", 20, 10, 3, 7)
            return {"kind": "stepInspection", "revision": 4, "stepId": "round-value"}

    response = server.dispatch(
        InspectionManager(),  # type: ignore[arg-type]
        {
            "kind": "inspectStep",
            "sessionId": "session",
            "revision": 4,
            "stepId": "round-value",
            "offset": 20,
            "limit": 10,
            "columnOffset": 3,
            "columnLimit": 7,
        },
    )

    assert response == {"kind": "stepInspection", "revision": 4, "stepId": "round-value"}


def test_cancel_pending_future_only_cancels_work_that_has_not_started() -> None:
    pending_lock = threading.Lock()
    queued: Future[dict[str, Any]] = Future()
    running: Future[dict[str, Any]] = Future()
    assert running.set_running_or_notify_cancel() is True
    complete: Future[dict[str, Any]] = Future()
    complete.set_result({"kind": "initialized"})
    pending = {"queued": queued, "running": running, "complete": complete}

    assert server._cancel_pending_future(pending, pending_lock, "queued") is True
    assert queued.cancelled() is True
    assert server._cancel_pending_future(pending, pending_lock, "running") is False
    assert server._cancel_pending_future(pending, pending_lock, "complete") is False
    assert server._cancel_pending_future(pending, pending_lock, "unknown") is False

    running.set_result({"kind": "initialized"})
    assert running.result() == {"kind": "initialized"}


def test_cancel_request_does_not_suppress_an_already_running_result(monkeypatch) -> None:
    class RunningManager:
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            self.started.set()
            if not self.release.wait(2):
                raise TimeoutError("Running profile was not released.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.release.set()

    manager = RunningManager()
    profile = {
        "protocolVersion": 2,
        "requestId": "running-profile",
        "priority": "background",
        "request": {
            "kind": "getSummary",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "running-view",
            "filterModel": {"logic": "and", "filters": [], "sort": []},
            "columns": ["value"],
        },
    }
    cancellation = {
        "protocolVersion": 2,
        "requestId": "cancel-running-profile",
        "priority": "interactive",
        "request": {"kind": "cancelRequest", "targetRequestId": "running-profile"},
    }

    def input_after_work_starts():
        yield f"{json.dumps(profile)}\n"
        assert manager.started.wait(1)
        yield f"{json.dumps(cancellation)}\n"
        manager.release.set()

    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_after_work_starts())
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    responses = {item["requestId"]: item["response"] for item in map(json.loads, output.getvalue().splitlines())}
    assert responses["cancel-running-profile"]["kind"] == "error"
    assert responses["cancel-running-profile"]["code"] == "cancellation_unavailable"
    assert responses["running-profile"] == {
        "kind": "summary",
        "revision": 0,
        "viewRequestId": "running-view",
        "summaries": [],
    }


def test_interactive_executor_is_not_starved_by_background_profiles(monkeypatch) -> None:
    class BlockingManager:
        def __init__(self) -> None:
            self.release = threading.Event()
            self.interactive_started = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            if not self.release.wait(3):
                raise TimeoutError("Test background profile was not released.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def initialize(self) -> dict[str, Any]:
            self.interactive_started.set()
            self.release.set()
            return {"kind": "initialized"}

        def close_all(self) -> None:
            self.release.set()

    manager = BlockingManager()
    requests = [
        {
            "protocolVersion": 2,
            "requestId": f"profile-{index}",
            "priority": "background",
            "request": {
                "kind": "getSummary",
                "sessionId": f"session-{index}",
                "revision": 0,
                "viewRequestId": f"view-profile-{index}",
                "filterModel": {"logic": "and", "filters": [], "sort": []},
                "columns": ["value"],
            },
        }
        for index in range(4)
    ]
    requests.append(
        {
            "protocolVersion": 2,
            "requestId": "interactive",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        }
    )
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", StringIO("".join(f"{json.dumps(item)}\n" for item in requests)))
    monkeypatch.setattr(server.sys, "stdout", StringIO())

    runner = threading.Thread(target=server.main, daemon=True)
    runner.start()
    started_without_external_release = manager.interactive_started.wait(1)
    if not started_without_external_release:
        manager.release.set()
    runner.join(5)

    assert started_without_external_release is True
    assert runner.is_alive() is False


def test_eof_starts_cleanup_before_active_profiles_finish_and_cancels_queued_profiles(monkeypatch) -> None:
    class BlockingManager:
        def __init__(self) -> None:
            self.lock = threading.Lock()
            self.started = 0
            self.two_started = threading.Event()
            self.release = threading.Event()
            self.close_started = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            with self.lock:
                self.started += 1
                if self.started == 2:
                    self.two_started.set()
            if not self.release.wait(3):
                raise TimeoutError("Test profile was not released by runtime cleanup.")
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.close_started.set()
            self.release.set()

    manager = BlockingManager()
    requests = [
        {
            "protocolVersion": 2,
            "requestId": f"profile-{index}",
            "priority": "background",
            "request": {
                "kind": "getSummary",
                "sessionId": "session",
                "revision": 0,
                "viewRequestId": f"view-{index}",
                "filterModel": {"logic": "and", "filters": [], "sort": []},
                "columns": ["value"],
            },
        }
        for index in range(6)
    ]

    def input_until_workers_are_busy():
        yield from (f"{json.dumps(item)}\n" for item in requests)
        manager.two_started.wait(2)

    existing_threads = {thread.ident for thread in threading.enumerate()}
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_until_workers_are_busy())
    monkeypatch.setattr(server.sys, "stdout", StringIO())

    runner = threading.Thread(target=server.main, daemon=True)
    runner.start()
    assert manager.two_started.wait(1)
    assert manager.close_started.wait(1)
    runner.join(2)

    assert runner.is_alive() is False
    assert manager.started == 2
    runtime_threads = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in existing_threads and thread.name.startswith("openwrangler-")
    ]
    for thread in runtime_threads:
        thread.join(1)
    assert all(not thread.is_alive() for thread in runtime_threads)


def test_eof_wait_for_blocked_cleanup_is_bounded(monkeypatch) -> None:
    class StuckManager:
        def __init__(self) -> None:
            self.work_started = threading.Event()
            self.release_work = threading.Event()
            self.close_started = threading.Event()
            self.release_close = threading.Event()

        def get_summary(self, *_args: Any) -> dict[str, Any]:
            self.work_started.set()
            self.release_work.wait(3)
            return {"kind": "summary", "revision": 0, "summaries": []}

        def close_all(self) -> None:
            self.close_started.set()
            self.release_close.wait(3)

    manager = StuckManager()
    request = {
        "protocolVersion": 2,
        "requestId": "active-profile",
        "priority": "background",
        "request": {
            "kind": "getSummary",
            "sessionId": "session",
            "revision": 0,
            "viewRequestId": "active-view",
            "filterModel": {"logic": "and", "filters": [], "sort": []},
            "columns": ["value"],
        },
    }

    def input_after_work_starts():
        yield f"{json.dumps(request)}\n"
        manager.work_started.wait(2)

    existing_threads = {thread.ident for thread in threading.enumerate()}
    monkeypatch.setattr(server, "SHUTDOWN_GRACE_SECONDS", 0.05)
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_after_work_starts())
    monkeypatch.setattr(server.sys, "stdout", StringIO())

    runner = threading.Thread(target=server.main, daemon=True)
    runner.start()
    assert manager.work_started.wait(1)
    assert manager.close_started.wait(1)
    runner.join(0.5)

    assert runner.is_alive() is False

    manager.release_work.set()
    manager.release_close.set()
    runtime_threads = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in existing_threads and thread.name.startswith("openwrangler-")
    ]
    for thread in runtime_threads:
        thread.join(1)
    assert all(not thread.is_alive() for thread in runtime_threads)
