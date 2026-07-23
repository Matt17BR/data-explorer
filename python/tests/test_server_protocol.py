from __future__ import annotations

import json
import subprocess
import sys
import threading
from codecs import getincrementaldecoder
from concurrent.futures import Future
from contextlib import suppress
from importlib.util import find_spec
from io import StringIO, TextIOWrapper
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Any

import pytest

import openwrangler_runtime.server as server


class _ServerOutputPumps:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        stdout = process.stdout
        stderr = process.stderr
        assert stdout is not None
        assert stderr is not None
        self._responses: Queue[str | BaseException | None] = Queue(maxsize=16)
        self._stderr_lock = threading.Lock()
        self._stderr_tail = ""
        self._stdout_error: BaseException | None = None
        self._stderr_error: BaseException | None = None

        def publish_stdout(value: str | BaseException | None) -> None:
            while True:
                try:
                    self._responses.put_nowait(value)
                    return
                except Full:
                    with suppress(Empty):
                        self._responses.get_nowait()

        def read_stdout() -> None:
            try:
                for line in stdout:
                    publish_stdout(line)
            except BaseException as error:  # pragma: no cover - defensive stream failure
                self._stdout_error = error
                publish_stdout(error)
            finally:
                publish_stdout(None)

        def drain_stderr() -> None:
            try:
                assert isinstance(stderr, TextIOWrapper)
                decoder = getincrementaldecoder(stderr.encoding or "utf-8")(errors="replace")
                while chunk := stderr.buffer.read1(4_096):
                    with self._stderr_lock:
                        self._stderr_tail = f"{self._stderr_tail}{decoder.decode(chunk)}"[-16_384:]
                final_text = decoder.decode(b"", final=True)
                if final_text:
                    with self._stderr_lock:
                        self._stderr_tail = f"{self._stderr_tail}{final_text}"[-16_384:]
            except BaseException as error:  # pragma: no cover - defensive stream failure
                self._stderr_error = error
                with self._stderr_lock:
                    self._stderr_tail = f"{self._stderr_tail}\nStderr pump failed: {error}"[-16_384:]

        self._stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def stderr_tail(self) -> str:
        with self._stderr_lock:
            return self._stderr_tail

    def read_response(self, timeout: float = 60.0) -> dict[str, Any]:
        try:
            value = self._responses.get(timeout=timeout)
        except Empty as error:
            raise TimeoutError(
                f"Runtime server did not answer within {timeout:g} seconds.\n{self.stderr_tail()}"
            ) from error
        if isinstance(value, BaseException):
            raise value
        if value is None:
            raise AssertionError(f"Runtime server closed stdout before responding.\n{self.stderr_tail()}")
        try:
            return json.loads(value)
        except json.JSONDecodeError as error:
            raise AssertionError(f"Runtime server returned malformed JSON.\n{self.stderr_tail()}") from error

    def join(self, timeout: float = 5.0) -> None:
        self._stdout_thread.join(timeout)
        self._stderr_thread.join(timeout)
        if self._stdout_thread.is_alive() or self._stderr_thread.is_alive():
            raise AssertionError("Runtime server output pumps did not stop after process termination.")
        if self._stdout_error is not None:
            raise AssertionError("Runtime server stdout pump failed.") from self._stdout_error
        if self._stderr_error is not None:
            raise AssertionError("Runtime server stderr pump failed.") from self._stderr_error


def _send_server_envelope(
    process: subprocess.Popen[str],
    output: _ServerOutputPumps,
    envelope: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    assert process.stdin is not None
    process.stdin.write(f"{json.dumps(envelope)}\n")
    process.stdin.flush()
    return output.read_response(timeout)


def _send_server_request(
    process: subprocess.Popen[str],
    output: _ServerOutputPumps,
    request_id: str,
    request: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    envelope = {
        "protocolVersion": 2,
        "requestId": request_id,
        "priority": "interactive",
        "request": request,
    }
    response = _send_server_envelope(process, output, envelope, timeout=timeout)
    assert response["protocolVersion"] == 2
    assert response["requestId"] == request_id
    return response["response"]


def _join_and_close_server_output(process: subprocess.Popen[str], output: _ServerOutputPumps) -> None:
    try:
        output.join()
    finally:
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()


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
    output = _ServerOutputPumps(process)
    responses: dict[str, Any] = {}
    return_code: int | None = None
    try:
        for request in requests:
            response = _send_server_envelope(process, output, request, timeout=30.0)
            responses[response["requestId"]] = response
        assert process.stdin is not None
        process.stdin.close()
        return_code = process.wait(timeout=10)
    finally:
        if process.stdin is not None and not process.stdin.closed:
            with suppress(BrokenPipeError):
                process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        _join_and_close_server_output(process, output)

    assert return_code == 0, output.stderr_tail()

    assert responses["initialize"]["protocolVersion"] == 2
    assert responses["initialize"]["response"]["kind"] == "initialized"
    assert responses["invalid"]["response"]["code"] == "invalid_request"
    assert responses["missing-session"]["response"]["kind"] == "error"
    assert responses["missing-session"]["response"]["viewRequestId"] == "view-missing"


def test_stdio_server_opens_polars_then_pandas_in_one_process(tmp_path: Path) -> None:
    if find_spec("polars") is None or find_spec("pandas") is None:
        pytest.skip("The mixed-engine server regression requires both Polars and Pandas.")
    csv_path = tmp_path / "first.csv"
    tsv_path = tmp_path / "second.tsv"
    csv_path.write_text("city,value\nBerlin,12\nParis,7\n", encoding="utf-8")
    tsv_path.write_text("city\tvalue\nRome\t4\nMadrid\t9\n", encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, "-m", "openwrangler_runtime.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    output = _ServerOutputPumps(process)
    return_code: int | None = None
    try:
        for backend, source_path, session_id in (
            ("polars", csv_path, "mixed-engine-polars"),
            ("pandas", tsv_path, "mixed-engine-pandas"),
        ):
            response = _send_server_request(
                process,
                output,
                f"open-{backend}",
                {
                    "kind": "openSession",
                    "source": {"kind": "file", "label": source_path.name, "path": str(source_path)},
                    "requestedSessionId": session_id,
                    "backend": backend,
                    "mode": "editing",
                    "pageSize": 20,
                    "columnOffset": 0,
                    "columnLimit": 16,
                },
                timeout=60.0,
            )
            assert response["kind"] == "sessionOpened", response
            assert response["metadata"]["sessionId"] == session_id
            assert response["metadata"]["backend"] == backend

        for backend, session_id in (
            ("polars", "mixed-engine-polars"),
            ("pandas", "mixed-engine-pandas"),
        ):
            response = _send_server_request(
                process,
                output,
                f"close-{backend}",
                {"kind": "closeSession", "sessionId": session_id, "revision": 0},
                timeout=30.0,
            )
            assert response == {"kind": "sessionClosed", "sessionId": session_id}

        assert process.stdin is not None
        process.stdin.close()
        return_code = process.wait(timeout=10)
    finally:
        if process.stdin is not None and not process.stdin.closed:
            with suppress(BrokenPipeError):
                process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        _join_and_close_server_output(process, output)

    assert return_code == 0, output.stderr_tail()


def test_stdio_server_prepares_backend_on_reader_thread_before_dispatch(monkeypatch) -> None:
    reader_thread = threading.current_thread()
    dispatched = threading.Event()

    class TrackingManager:
        def __init__(self) -> None:
            self.prepare_thread: threading.Thread | None = None
            self.dispatch_thread: threading.Thread | None = None

        def prepare_backend(self, source: dict[str, Any], backend: str | None) -> None:
            assert source["path"] == "sample.csv"
            assert backend == "pandas"
            self.prepare_thread = threading.current_thread()

        def open_session(self, *_args: Any) -> dict[str, Any]:
            self.dispatch_thread = threading.current_thread()
            dispatched.set()
            return {"kind": "sessionOpened"}

        def close_all(self) -> None:
            return None

    manager = TrackingManager()
    envelope = {
        "protocolVersion": 2,
        "requestId": "main-thread-prepare",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "sample.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }

    def input_lines():
        yield f"{json.dumps(envelope)}\n"
        assert dispatched.wait(5)

    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", lambda: manager)
    monkeypatch.setattr(server.sys, "stdin", input_lines())
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    response = json.loads(output.getvalue())
    assert response["requestId"] == "main-thread-prepare"
    assert response["response"]["kind"] == "sessionOpened"
    assert manager.prepare_thread is reader_thread
    assert manager.dispatch_thread is not None
    assert manager.dispatch_thread is not reader_thread


def test_stdio_server_reports_backend_preparation_failure(monkeypatch) -> None:
    class FailingManager:
        def prepare_backend(self, _source: dict[str, Any], _backend: str | None) -> None:
            raise server.EngineError("native import failed")

        def close_all(self) -> None:
            return None

    envelope = {
        "protocolVersion": 2,
        "requestId": "prepare-failed",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "sample.csv"},
            "backend": "pandas",
            "pageSize": 20,
            "columnOffset": 0,
            "columnLimit": 16,
        },
    }
    output = StringIO()
    monkeypatch.setattr(server, "SessionManager", FailingManager)
    monkeypatch.setattr(server.sys, "stdin", StringIO(f"{json.dumps(envelope)}\n"))
    monkeypatch.setattr(server.sys, "stdout", output)

    server.main()

    response = json.loads(output.getvalue())
    assert response["requestId"] == "prepare-failed"
    assert response["response"]["kind"] == "error"
    assert response["response"]["code"] == "engine_error"
    assert response["response"]["message"] == "native import failed"


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
