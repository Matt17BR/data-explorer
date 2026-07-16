from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any

import pandas as pd
import pytest

import __main__
import openwrangler_runtime.notebook as notebook
from openwrangler_runtime.engines import EngineCapabilities, EngineError, EngineRegistry, PandasEngine
from openwrangler_runtime.session import SessionManager


class TrackingPandasEngine(PandasEngine):
    def __init__(self, fail_at: str | None = None) -> None:
        self.fail_at = fail_at
        self.close_calls = 0
        self.shape_calls = 0
        self.page_calls = 0
        self.block_pages = False
        self.page_started = threading.Event()
        self.release_page = threading.Event()
        self.closed = threading.Event()
        self.interrupt_calls = 0

    def interrupt(self) -> None:
        self.interrupt_calls += 1
        self.release_page.set()

    def close(self) -> None:
        self.close_calls += 1
        self.closed.set()

    def read_file(self, path: str, options=None):
        self._fail("read")
        return super().read_file(path, options)

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        self._fail("schema")
        return super().schema(frame)

    def shape(self, frame: Any) -> dict[str, int]:
        self.shape_calls += 1
        self._fail("shape")
        return super().shape(frame)

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
    ) -> dict[str, Any]:
        self.page_calls += 1
        self._fail("page")
        if self.block_pages:
            self.page_started.set()
            if not self.release_page.wait(2):
                raise RuntimeError("timed out waiting for the page test to release")
        return super().page(frame, offset, limit, total_rows=total_rows)

    def summaries(self, frame: Any, columns=None) -> list[dict[str, Any]]:
        self._fail("summaries")
        return super().summaries(frame, columns)

    def _fail(self, stage: str) -> None:
        if self.fail_at == stage:
            raise RuntimeError(f"{stage} failure")


class ReadOnlyPandasEngine(TrackingPandasEngine):
    name = "readonly"
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"file"}),
        supports_editing=False,
        lazy_file_extensions=frozenset(),
        export_formats=frozenset(),
        supports_shutdown_interrupt=False,
        supports_request_cancellation=False,
    )


class InterruptiblePandasEngine(TrackingPandasEngine):
    capabilities = EngineCapabilities(
        source_kinds=PandasEngine.capabilities.source_kinds,
        supports_editing=PandasEngine.capabilities.supports_editing,
        lazy_file_extensions=PandasEngine.capabilities.lazy_file_extensions,
        export_formats=PandasEngine.capabilities.export_formats,
        supports_shutdown_interrupt=True,
        supports_request_cancellation=False,
    )


class BlockingReadPandasEngine(TrackingPandasEngine):
    def __init__(self) -> None:
        super().__init__()
        self.read_started = threading.Event()
        self.release_read = threading.Event()

    def read_file(self, path: str, options=None):
        self.read_started.set()
        if not self.release_read.wait(2):
            raise RuntimeError("timed out waiting for the read test to release")
        return super().read_file(path, options)


class BlockingClosePandasEngine(TrackingPandasEngine):
    def __init__(self) -> None:
        super().__init__()
        self.close_started = threading.Event()
        self.release_close = threading.Event()

    def close(self) -> None:
        self.close_calls += 1
        self.close_started.set()
        if not self.release_close.wait(2):
            raise RuntimeError("timed out waiting for the close test to release")
        self.closed.set()


class CloseFailingPandasEngine(TrackingPandasEngine):
    def __init__(self, message: str = "cleanup failure", *, fail_at: str | None = None) -> None:
        super().__init__(fail_at=fail_at)
        self.message = message

    def close(self) -> None:
        super().close()
        raise RuntimeError(self.message)


class BlockingCloseFailingPandasEngine(BlockingClosePandasEngine):
    def close(self) -> None:
        super().close()
        raise RuntimeError("joined cleanup failure")


class SummaryAndCloseFailingPandasEngine(CloseFailingPandasEngine):
    def __init__(self) -> None:
        super().__init__(fail_at="summaries")


def tracking_registry(
    created: list[TrackingPandasEngine],
    factory: Callable[[], TrackingPandasEngine] | None = None,
    *,
    backend: str = "pandas",
) -> EngineRegistry:
    def create() -> TrackingPandasEngine:
        engine = factory() if factory is not None else TrackingPandasEngine()
        created.append(engine)
        return engine

    return EngineRegistry(((backend, create),))


def csv_source(path) -> dict[str, str]:
    return {"kind": "file", "label": path.name, "path": str(path)}


def write_csv(tmp_path):
    path = tmp_path / "source.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    return path


def test_sessions_receive_distinct_engines_and_close_independently(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created))

    first = manager.open_session(csv_source(path), backend="pandas")
    second = manager.open_session(csv_source(path), backend="pandas")
    first_id = first["metadata"]["sessionId"]
    second_id = second["metadata"]["sessionId"]

    assert len(created) == 2
    assert created[0] is not created[1]
    manager.close_session(first_id, 0)
    assert created[0].close_calls == 1
    assert created[1].close_calls == 0
    assert manager.get_page(second_id, 0, 0, 10, {"filters": [], "sort": []})["page"]["totalRows"] == 2

    with pytest.raises(EngineError, match=f"Unknown session: {first_id}"):
        manager.close_session(first_id, 0)
    with pytest.raises(EngineError, match=f"Unknown session: {first_id}"):
        manager.get_page(first_id, 0, 0, 10, {"filters": [], "sort": []})
    manager.close_all()
    assert created[1].close_calls == 1


def test_requested_session_identity_is_reserved_until_cleanup(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created))

    opened = manager.open_session(
        csv_source(path),
        backend="pandas",
        requested_session_id="host-candidate",
    )
    assert opened["metadata"]["sessionId"] == "host-candidate"
    with pytest.raises(EngineError, match="Session already exists: host-candidate"):
        manager.open_session(
            csv_source(path),
            backend="pandas",
            requested_session_id="host-candidate",
        )

    manager.close_session("host-candidate", 0)
    reopened = manager.open_session(
        csv_source(path),
        backend="pandas",
        requested_session_id="host-candidate",
    )
    assert reopened["metadata"]["sessionId"] == "host-candidate"
    manager.close_all()


@pytest.mark.parametrize("fail_at", ["read", "shape", "schema", "page"])
def test_open_failure_closes_engine_and_never_registers_session(tmp_path, fail_at: str) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created, factory=lambda: TrackingPandasEngine(fail_at=fail_at)))

    with pytest.raises(EngineError, match="Could not read"):
        manager.open_session(csv_source(path), backend="pandas")

    assert len(created) == 1
    assert created[0].close_calls == 1
    assert manager.sessions == {}


def test_close_all_drains_every_session_exactly_once(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created))
    manager.open_session(csv_source(path), backend="pandas")
    manager.open_session(csv_source(path), backend="pandas")

    manager.close_all()
    manager.close_all()

    assert manager.sessions == {}
    assert [engine.close_calls for engine in created] == [1, 1]
    assert [engine.interrupt_calls for engine in created] == [0, 0]


def test_close_all_aggregates_cleanup_failures_in_registration_order(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    messages = iter(("first cleanup failure", "second cleanup failure"))
    manager = SessionManager(
        tracking_registry(created, factory=lambda: CloseFailingPandasEngine(next(messages))),
    )
    manager.open_session(csv_source(path), backend="pandas")
    manager.open_session(csv_source(path), backend="pandas")

    expected = (
        "Could not close 2 runtime sessions: "
        "1) Could not close the pandas session: first cleanup failure; "
        "2) Could not close the pandas session: second cleanup failure"
    )
    with pytest.raises(EngineError, match="first cleanup failure.*second cleanup failure") as first:
        manager.close_all()
    with pytest.raises(EngineError) as repeated:
        manager.close_all()

    assert str(first.value) == expected
    assert str(repeated.value) == expected
    assert manager.sessions == {}
    assert [engine.close_calls for engine in created] == [1, 1]


def test_concurrent_close_all_callers_receive_the_same_cleanup_failure(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    engine = BlockingCloseFailingPandasEngine()
    manager = SessionManager(tracking_registry(created, factory=lambda: engine))
    manager.open_session(csv_source(path), backend="pandas")
    second_close_started = threading.Event()

    def second_close_all() -> None:
        second_close_started.set()
        manager.close_all()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_close = executor.submit(manager.close_all)
        assert engine.close_started.wait(1)
        second_close = executor.submit(second_close_all)
        assert second_close_started.wait(1)
        try:
            with pytest.raises(FutureTimeoutError):
                second_close.result(timeout=0.05)
        finally:
            engine.release_close.set()

        with pytest.raises(EngineError) as first:
            first_close.result(timeout=2)
        with pytest.raises(EngineError) as second:
            second_close.result(timeout=2)

    assert str(first.value) == "Could not close the pandas session: joined cleanup failure"
    assert str(second.value) == str(first.value)
    assert engine.close_calls == 1
    assert manager.sessions == {}


def test_concurrent_close_all_callers_wait_for_the_same_cleanup(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    engine = BlockingClosePandasEngine()
    manager = SessionManager(
        tracking_registry(created, factory=lambda: engine),
    )
    manager.open_session(csv_source(path), backend="pandas")
    second_close_started = threading.Event()

    def second_close_all() -> None:
        second_close_started.set()
        manager.close_all()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_close = executor.submit(manager.close_all)
        assert engine.close_started.wait(1)

        second_close = executor.submit(second_close_all)
        assert second_close_started.wait(1)
        try:
            with pytest.raises(FutureTimeoutError):
                second_close.result(timeout=0.05)
        finally:
            engine.release_close.set()

        first_close.result(timeout=2)
        second_close.result(timeout=2)

    assert engine.close_calls == 1
    assert manager.sessions == {}


def test_close_all_waits_for_pending_open_and_rejects_late_registration(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    engine = BlockingReadPandasEngine()
    manager = SessionManager(
        tracking_registry(created, factory=lambda: engine),
    )
    close_all_started = threading.Event()

    def close_all() -> None:
        close_all_started.set()
        manager.close_all()

    with ThreadPoolExecutor(max_workers=2) as executor:
        open_future = executor.submit(manager.open_session, csv_source(path), "pandas")
        assert engine.read_started.wait(1)
        assert created == [engine]

        close_future = executor.submit(close_all)
        assert close_all_started.wait(1)
        try:
            with pytest.raises(FutureTimeoutError):
                close_future.result(timeout=0.05)
        finally:
            engine.release_read.set()

        with pytest.raises(EngineError):
            open_future.result(timeout=2)
        close_future.result(timeout=2)

    assert engine.close_calls == 1
    assert manager.sessions == {}


def test_explicit_close_surfaces_cleanup_failure_after_removing_session(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(
        tracking_registry(created, factory=CloseFailingPandasEngine),
    )
    opened = manager.open_session(csv_source(path), backend="pandas")
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]

    with pytest.raises(EngineError, match="cleanup failure"):
        manager.close_session(session_id, 0)

    assert created[0].close_calls == 1
    assert session.disposed
    assert manager.sessions == {}


def test_close_uses_the_last_confirmed_revision_after_an_ambiguous_mutation(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created))
    opened = manager.open_session(csv_source(path), backend="pandas")
    session_id = opened["metadata"]["sessionId"]

    preview = manager.preview_step(
        session_id,
        0,
        {
            "id": "cast-value",
            "kind": "castColumn",
            "params": {"column": {"id": "c:source:0", "name": "value"}, "dtype": "float"},
        },
        0,
        10,
    )
    assert preview["revision"] == 1

    # A transport failure can hide the revision-1 response from the extension.
    # Cleanup must still close the actual live revision instead of leaking it.
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
    assert manager.sessions == {}
    assert created[0].close_calls == 1


def test_notebook_payload_closes_transient_engine(monkeypatch) -> None:
    created: list[TrackingPandasEngine] = []
    monkeypatch.setattr(notebook, "default_engine_registry", lambda: tracking_registry(created))

    payload = notebook.build_payload(pd.DataFrame({"value": [1]}))

    assert payload["metadata"]["backend"] == "pandas"
    assert len(created) == 1
    assert created[0].close_calls == 1


def test_failed_notebook_payload_closes_transient_engine(monkeypatch) -> None:
    created: list[TrackingPandasEngine] = []
    registry = tracking_registry(created, factory=lambda: TrackingPandasEngine(fail_at="summaries"))
    monkeypatch.setattr(notebook, "default_engine_registry", lambda: registry)

    with pytest.raises(RuntimeError, match="summaries failure"):
        notebook.build_payload(pd.DataFrame({"value": [1]}))

    assert len(created) == 1
    assert created[0].close_calls == 1


def test_notebook_payload_rejects_engine_without_output_capability(monkeypatch) -> None:
    created: list[TrackingPandasEngine] = []
    registry = tracking_registry(created, factory=ReadOnlyPandasEngine, backend="readonly")
    monkeypatch.setattr(notebook, "default_engine_registry", lambda: registry)

    with pytest.raises(EngineError, match="readonly backend does not support notebook output"):
        notebook.build_payload(pd.DataFrame({"value": [1]}))

    assert created[0].close_calls == 1


def test_successful_notebook_payload_surfaces_cleanup_failure(monkeypatch) -> None:
    created: list[TrackingPandasEngine] = []
    registry = tracking_registry(created, factory=CloseFailingPandasEngine)
    monkeypatch.setattr(notebook, "default_engine_registry", lambda: registry)

    with pytest.raises(EngineError, match="Could not close the pandas notebook output engine.*cleanup failure"):
        notebook.build_payload(pd.DataFrame({"value": [1]}))

    assert created[0].close_calls == 1


def test_failed_notebook_payload_preserves_failure_when_cleanup_also_fails(monkeypatch) -> None:
    created: list[TrackingPandasEngine] = []
    registry = tracking_registry(created, factory=SummaryAndCloseFailingPandasEngine)
    monkeypatch.setattr(notebook, "default_engine_registry", lambda: registry)

    with pytest.raises(RuntimeError, match="summaries failure"):
        notebook.build_payload(pd.DataFrame({"value": [1]}))

    assert created[0].close_calls == 1


def test_capabilities_remain_exact_for_current_engines(tmp_path, monkeypatch) -> None:
    csv_path = write_csv(tmp_path)
    manager = SessionManager()
    pandas = manager.open_session(csv_source(csv_path), backend="pandas")
    polars = manager.open_session(csv_source(csv_path), backend="polars")
    viewing = manager.open_session(csv_source(csv_path), backend="pandas", mode="viewing")

    workbook = tmp_path / "source.xlsx"
    pd.DataFrame({"value": [1]}).to_excel(workbook, index=False)
    polars_excel = manager.open_session(csv_source(workbook), backend="polars")

    monkeypatch.setattr(__main__, "open_wrangler_frame", pd.DataFrame({"value": [1]}), raising=False)
    notebook_variable = manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "open_wrangler_frame",
            "variableName": "open_wrangler_frame",
        },
        backend="pandas",
    )

    assert pandas["metadata"]["capabilities"] == {
        "editable": True,
        "lazy": False,
        "cancel": False,
        "exportCsv": True,
        "exportParquet": True,
        "notebookInsert": False,
    }
    assert polars["metadata"]["capabilities"]["lazy"] is True
    assert polars_excel["metadata"]["capabilities"]["lazy"] is False
    assert viewing["metadata"]["capabilities"] == {
        "editable": False,
        "lazy": False,
        "cancel": False,
        "exportCsv": False,
        "exportParquet": False,
        "notebookInsert": False,
    }
    assert notebook_variable["metadata"]["capabilities"] == {
        "editable": False,
        "lazy": False,
        "cancel": False,
        "exportCsv": False,
        "exportParquet": False,
        "notebookInsert": True,
    }
    assert manager.initialize()["capabilities"]["cancel"] is False
    manager.close_all()


def test_interrupt_capability_and_orderly_shutdown_follow_the_engine_contract(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(
        tracking_registry(created, factory=InterruptiblePandasEngine),
    )
    opened = manager.open_session(csv_source(path), backend="pandas")
    session_id = opened["metadata"]["sessionId"]
    engine = created[0]
    engine.block_pages = True

    # Shutdown interruption lets the manager release blocked work without
    # advertising request-level cancellation on the protocol.
    assert opened["metadata"]["capabilities"]["cancel"] is False
    with ThreadPoolExecutor(max_workers=2) as executor:
        page_future = executor.submit(
            manager.get_page,
            session_id,
            0,
            0,
            1,
            {"filters": [], "sort": []},
        )
        assert engine.page_started.wait(1)
        close_future = executor.submit(manager.close_all)

        assert page_future.result(timeout=2)["page"]["totalRows"] == 2
        close_future.result(timeout=2)

    assert engine.interrupt_calls == 1
    assert engine.close_calls == 1
    assert manager.sessions == {}


def test_read_only_engine_gates_editing_and_exports(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created, factory=ReadOnlyPandasEngine, backend="readonly"))
    opened = manager.open_session(csv_source(path), backend="readonly", mode="editing")
    session_id = opened["metadata"]["sessionId"]

    assert opened["metadata"]["capabilities"]["editable"] is False
    assert opened["metadata"]["capabilities"]["exportCsv"] is False
    assert opened["metadata"]["capabilities"]["exportParquet"] is False
    with pytest.raises(EngineError, match="readonly backend does not support editing"):
        manager.preview_step(
            session_id,
            0,
            {
                "id": "clone",
                "kind": "cloneColumn",
                "params": {"column": {"id": "c:source:0", "name": "value"}, "newName": "copy"},
            },
            0,
            10,
        )
    manager.close_all()


def test_close_waits_for_in_flight_session_work(tmp_path) -> None:
    path = write_csv(tmp_path)
    created: list[TrackingPandasEngine] = []
    manager = SessionManager(tracking_registry(created))
    opened = manager.open_session(csv_source(path), backend="pandas")
    session_id = opened["metadata"]["sessionId"]
    engine = created[0]
    engine.block_pages = True

    with ThreadPoolExecutor(max_workers=2) as executor:
        page_future = executor.submit(
            manager.get_page,
            session_id,
            0,
            0,
            10,
            {"filters": [], "sort": []},
        )
        assert engine.page_started.wait(1)
        close_future = executor.submit(manager.close_session, session_id, 0)
        assert not engine.closed.wait(0.05)
        engine.release_page.set()

        assert page_future.result(timeout=2)["page"]["totalRows"] == 2
        assert close_future.result(timeout=2) == {"kind": "sessionClosed", "sessionId": session_id}

    assert engine.close_calls == 1
    assert manager.sessions == {}
