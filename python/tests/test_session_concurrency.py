from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from openwrangler_runtime.engines import EngineError, EngineRegistry, PolarsEngine
from openwrangler_runtime.session import SessionManager


def test_foreground_page_overtakes_active_profile_while_mutation_waits(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\nrome,2\n", encoding="utf-8")
    profile_started = threading.Event()
    release_profile = threading.Event()

    class BlockingProfileEngine(PolarsEngine):
        def summaries(self, frame: Any, columns: Any = None) -> list[dict[str, Any]]:
            profile_started.set()
            if not release_profile.wait(2):
                raise TimeoutError("The test profile was not released.")
            return super().summaries(frame, columns)

    manager = SessionManager(EngineRegistry((("polars", BlockingProfileEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    filter_model = {"filters": [], "sort": []}

    with ThreadPoolExecutor(max_workers=3) as executor:
        profile = executor.submit(manager.get_summary, session_id, 0, filter_model, ["value"])
        assert profile_started.wait(1)

        page = executor.submit(manager.get_page, session_id, 0, 1, 1, filter_model)
        assert page.result(timeout=0.5)["page"]["offset"] == 1

        preview = executor.submit(
            manager.preview_step,
            session_id,
            0,
            {
                "id": "drop-city",
                "kind": "dropColumns",
                "params": {"columns": [{"id": "c:source:0", "name": "city"}]},
            },
            0,
            1,
        )
        try:
            preview.result(timeout=0.05)
        except TimeoutError:
            pass
        else:
            raise AssertionError("A mutation ran concurrently with an active profile.")

        release_profile.set()
        assert profile.result(timeout=1)["summaries"][0]["column"] == "value"
        assert preview.result(timeout=1)["kind"] == "stepPreview"

    manager.close_all()


def test_profile_failure_revalidates_source_and_releases_lease(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\n", encoding="utf-8")

    class ReplacingProfileEngine(PolarsEngine):
        def summaries(self, frame: Any, columns: Any = None) -> list[dict[str, Any]]:
            replacement = source_path.with_suffix(".replacement")
            replacement.write_text("city,value\nrome,2\n", encoding="utf-8")
            replacement.replace(source_path)
            raise RuntimeError("profile scan failed after replacement")

    manager = SessionManager(EngineRegistry((("polars", ReplacingProfileEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]

    with pytest.raises(EngineError, match=r"changed or is no longer available.*Reopen") as raised:
        manager.get_summary(session_id, 0, {"filters": [], "sort": []}, ["value"])

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert manager.sessions[session_id].active_profiles == 0
    manager.close_all()


def test_waiting_mutation_blocks_new_profile_admission(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\nrome,2\n", encoding="utf-8")
    first_profile_started = threading.Event()
    release_first_profile = threading.Event()
    mutation_started = threading.Event()
    release_mutation = threading.Event()
    unexpected_second_profile = threading.Event()

    class WriterPreferenceEngine(PolarsEngine):
        summary_calls = 0

        def summaries(self, frame: Any, columns: Any = None) -> list[dict[str, Any]]:
            self.summary_calls += 1
            if self.summary_calls == 1:
                first_profile_started.set()
                if not release_first_profile.wait(2):
                    raise TimeoutError("The first profile was not released.")
            else:
                unexpected_second_profile.set()
            return super().summaries(frame, columns)

        def apply_transform(self, frame: Any, step: Any) -> Any:
            mutation_started.set()
            if not release_mutation.wait(2):
                raise TimeoutError("The mutation was not released.")
            return super().apply_transform(frame, step)

    manager = SessionManager(EngineRegistry((("polars", WriterPreferenceEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    filter_model = {"filters": [], "sort": []}

    with ThreadPoolExecutor(max_workers=10) as executor:
        first_profile = executor.submit(manager.get_summary, session_id, 0, filter_model, ["value"])
        assert first_profile_started.wait(1)
        mutation = executor.submit(
            manager.preview_step,
            session_id,
            0,
            {
                "id": "drop-city",
                "kind": "dropColumns",
                "params": {"columns": [{"id": "c:source:0", "name": "city"}]},
            },
            0,
            1,
        )
        session = manager.sessions[session_id]
        for _ in range(100):
            if session.waiting_writers:
                break
            threading.Event().wait(0.005)
        assert session.waiting_writers == 1

        second_profile = executor.submit(manager.get_summary, session_id, 0, filter_model, ["city"])
        late_pages = [executor.submit(manager.get_page, session_id, 0, 1, 1, filter_model) for _ in range(6)]
        release_first_profile.set()
        assert mutation_started.wait(1)
        assert not unexpected_second_profile.wait(0.05)
        assert all(not page.done() for page in late_pages)

        release_mutation.set()
        assert first_profile.result(timeout=1)["kind"] == "summary"
        assert mutation.result(timeout=1)["kind"] == "stepPreview"
        with pytest.raises(EngineError, match="Stale session revision"):
            second_profile.result(timeout=1)
        for page in late_pages:
            with pytest.raises(EngineError, match="Stale session revision"):
                page.result(timeout=1)
        assert not unexpected_second_profile.is_set()

    manager.close_all()


def test_writer_intent_resets_after_exclusive_failure(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    filter_model = {"filters": [], "sort": []}

    with pytest.raises(EngineError, match="Unsupported transformation operation"):
        manager.preview_step(
            session_id,
            0,
            {"id": "invalid", "kind": "notAnOperation", "params": {}},
            0,
            1,
        )

    assert manager.sessions[session_id].waiting_writers == 0
    assert manager.get_page(session_id, 0, 0, 1, filter_model)["kind"] == "page"
    manager.close_all()


def test_response_metadata_is_detached_from_later_plan_mutations(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\nrome,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    filter_model = {"filters": [], "sort": []}
    preview = manager.preview_step(
        session_id,
        0,
        {
            "id": "drop-city",
            "kind": "dropColumns",
            "params": {"columns": [{"id": "c:source:0", "name": "city"}]},
        },
        0,
        1,
    )
    page = manager.get_page(session_id, preview["revision"], 0, 1, filter_model)
    snapshot = deepcopy(page)

    manager.apply_draft(session_id, preview["revision"], 0, 1)

    assert page == snapshot
    assert page["metadata"]["steps"] == []
    manager.close_all()
