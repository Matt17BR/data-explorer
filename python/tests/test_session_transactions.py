from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from openwrangler_runtime.engines import EngineError, EngineRegistry, PolarsEngine
from openwrangler_runtime.session import Session, SessionManager

VIEW_FILTER = {
    "logic": "and",
    "filters": [
        {
            "column": "value",
            "type": "integer",
            "predicates": [{"kind": "predicate", "operator": "gte", "value": 2}],
        }
    ],
    "sort": [{"column": "value", "direction": "desc", "nulls": "last"}],
}


def formula_step(step_id: str) -> dict[str, Any]:
    return {
        "id": step_id,
        "kind": "formula",
        "params": {
            "leftColumn": {"id": "c:source:1", "name": "value"},
            "operator": "multiply",
            "value": 2,
            "newColumn": "doubled",
        },
    }


def open_pandas_session(tmp_path: Path) -> tuple[SessionManager, str]:
    path = tmp_path / "transactions.csv"
    path.write_text("name,value\na,1\nb,2\nc,3\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=2,
    )
    return manager, opened["metadata"]["sessionId"]


def prime_filtered_page(manager: SessionManager, session_id: str, revision: int) -> None:
    manager.get_page(session_id, revision, 0, 1, VIEW_FILTER)


def session_state(session: Session) -> dict[str, Any]:
    """Comparable state without copying dataframe objects."""
    return {
        "committedId": id(session.committed),
        "filteredId": id(session.filtered),
        "filterModel": deepcopy(session.filter_model),
        "filteredShape": deepcopy(session.filtered_shape),
        "plan": deepcopy(session.plan),
        "boundPlan": deepcopy(session.bound_plan),
        "planInputSchemas": deepcopy(session.plan_input_schemas),
        "committedLineage": deepcopy(session.committed_lineage),
        "committedShape": deepcopy(session.committed_shape),
        "committedSchema": deepcopy(session.committed_schema),
        "draftStep": deepcopy(session.draft_step),
        "draftBoundStep": deepcopy(session.draft_bound_step),
        "draftFrameId": id(session.draft_frame) if session.draft_frame is not None else None,
        "draftBaseLineage": deepcopy(session.draft_base_lineage),
        "draftBaseSchema": deepcopy(session.draft_base_schema),
        "draftLineage": deepcopy(session.draft_lineage),
        "draftShape": deepcopy(session.draft_shape),
        "draftSchema": deepcopy(session.draft_schema),
        "replaceStepId": session.replace_step_id,
        "pageCache": [(key, deepcopy(cached.payload), cached.size_bytes) for key, cached in session.page_cache.items()],
        "pageCacheBytes": session.page_cache_bytes,
        "viewGeneration": session.view_generation,
        "revision": session.revision,
    }


def fail_after_response_page(monkeypatch: pytest.MonkeyPatch, session: Session, previous_revision: int) -> None:
    def fail_compile(_steps: Iterable[Mapping[str, Any]]) -> str:
        assert session.revision == previous_revision + 1
        assert any(key[1] == session.revision for key in session.page_cache)
        raise EngineError("late response construction failure")

    monkeypatch.setattr(session.engine, "compile_plan", fail_compile)


def assert_unchanged_and_closable(
    manager: SessionManager,
    session_id: str,
    revision: int,
    expected: dict[str, Any],
) -> None:
    assert session_state(manager.sessions[session_id]) == expected
    assert manager.close_session(session_id, revision) == {"kind": "sessionClosed", "sessionId": session_id}


def test_preview_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    prime_filtered_page(manager, session_id, 0)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 0)

    with pytest.raises(EngineError, match="late response construction"):
        manager.preview_step(session_id, 0, formula_step("preview"), 0, 2)

    assert_unchanged_and_closable(manager, session_id, 0, before)


def test_apply_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    manager.preview_step(session_id, 0, formula_step("apply"), 0, 2)
    prime_filtered_page(manager, session_id, 1)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 1)

    with pytest.raises(EngineError, match="late response construction"):
        manager.apply_draft(session_id, 1, 0, 2)

    assert_unchanged_and_closable(manager, session_id, 1, before)


def test_discard_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    manager.preview_step(session_id, 0, formula_step("discard"), 0, 2)
    prime_filtered_page(manager, session_id, 1)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 1)

    with pytest.raises(EngineError, match="late response construction"):
        manager.discard_draft(session_id, 1, 0, 2)

    assert_unchanged_and_closable(manager, session_id, 1, before)


def test_undo_rolls_back_after_late_response_construction_failure(tmp_path: Path, monkeypatch) -> None:
    manager, session_id = open_pandas_session(tmp_path)
    manager.preview_step(session_id, 0, formula_step("undo"), 0, 2)
    manager.apply_draft(session_id, 1, 0, 2)
    prime_filtered_page(manager, session_id, 2)
    session = manager.sessions[session_id]
    before = session_state(session)
    fail_after_response_page(monkeypatch, session, 2)

    with pytest.raises(EngineError, match="late response construction"):
        manager.undo_step(session_id, 2, 0, 2)

    assert_unchanged_and_closable(manager, session_id, 2, before)


def test_source_post_validation_rolls_back_preview_but_keeps_cache_invalidated(tmp_path: Path) -> None:
    path = tmp_path / "lazy-source.csv"
    path.write_text("name,value\na,1\nb,2\nc,3\n", encoding="utf-8")

    class ReplacingSourcePolarsEngine(PolarsEngine):
        def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
            code = super().compile_plan(steps)
            original = path.stat()
            replacement = path.with_name(f".{path.name}.replacement")
            replacement.write_text("name,value\nreplacement,100\n", encoding="utf-8")
            os.utime(replacement, ns=(original.st_atime_ns, original.st_mtime_ns))
            os.replace(replacement, path)
            return code

    manager = SessionManager(EngineRegistry((("polars", ReplacingSourcePolarsEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="polars",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    before = session_state(session)
    assert before["pageCache"]

    with pytest.raises(EngineError, match=r"changed or is no longer available.*Reopen"):
        manager.preview_step(session_id, 0, formula_step("source-change"), 0, 2)

    expected = {**before, "pageCache": [], "pageCacheBytes": 0}
    assert session_state(session) == expected
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
