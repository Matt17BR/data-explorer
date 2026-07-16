from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import deepcopy
from pathlib import Path
from typing import Any

import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError, EngineRegistry, PandasEngine
from openwrangler_runtime.session import Session, SessionManager


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "kind": kind, "params": params}


def apply_step(
    manager: SessionManager,
    session_id: str,
    revision: int,
    transform: dict[str, Any],
) -> int:
    preview = manager.preview_step(session_id, revision, transform, 0, 10)
    applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
    return int(applied["revision"])


def observable_state(session: Session) -> dict[str, Any]:
    return {
        "original": id(session.original),
        "committed": id(session.committed),
        "filtered": id(session.filtered),
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
        "draftFrame": id(session.draft_frame) if session.draft_frame is not None else None,
        "draftLineage": deepcopy(session.draft_lineage),
        "draftShape": deepcopy(session.draft_shape),
        "draftSchema": deepcopy(session.draft_schema),
        "replaceStepId": session.replace_step_id,
        "pageCache": [(key, deepcopy(cached.payload), cached.size_bytes) for key, cached in session.page_cache.items()],
        "pageCacheBytes": session.page_cache_bytes,
        "viewGeneration": session.view_generation,
        "revision": session.revision,
    }


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_inspect_applied_step_replays_only_its_prefix_without_publishing_state(
    backend: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"inspection-{backend}.csv"
    path.write_text("name,value\na,1.2\nb,2.8\nc,3.4\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Inspection must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = 0
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "add-double",
            "formula",
            leftColumn={"id": "c:source:1", "name": "value"},
            operator="multiply",
            value=2,
            newColumn="doubled",
        ),
    )
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "round-value",
            "roundNumber",
            column={"id": "c:source:1", "name": "value"},
            decimals=0,
        ),
    )
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "rename-double",
            "renameColumn",
            column={"id": "c:step:add-double:0", "name": "doubled"},
            newName="renamed_metric",
        ),
    )
    draft = manager.preview_step(
        session_id,
        revision,
        step(
            "pending-length",
            "textLength",
            column={"id": "c:source:0", "name": "name"},
            newColumn="name_length",
        ),
        0,
        2,
    )
    revision = int(draft["revision"])
    manager.get_page(
        session_id,
        revision,
        0,
        2,
        {"logic": "and", "filters": [], "sort": [{"column": "name", "direction": "desc", "nulls": "last"}]},
    )

    session = manager.sessions[session_id]
    before = observable_state(session)
    applied_during_inspection: list[str] = []
    native_apply = session.engine.apply_transform

    def track_prefix(frame: Any, transform: Any) -> Any:
        applied_during_inspection.append(str(transform["id"]))
        return native_apply(frame, transform)

    monkeypatch.setattr(session.engine, "apply_transform", track_prefix)
    inspection = manager.inspect_step(session_id, revision, "round-value", 1, 1)

    assert inspection["kind"] == "stepInspection"
    assert inspection["revision"] == revision
    assert inspection["stepId"] == "round-value"
    assert inspection["stepIndex"] == 1
    assert inspection["inputPage"]["offset"] == 1
    assert inspection["outputPage"]["offset"] == 1
    assert inspection["inputPage"]["totalRows"] == 3
    assert len(inspection["inputPage"]["rows"]) == 1
    assert inspection["diff"]["truncated"] is True
    assert inspection["inputPage"]["rows"][0]["values"][1]["display"] == "2.8"
    assert inspection["outputPage"]["rows"][0]["values"][1]["display"] in {"3", "3.0"}
    assert inspection["diff"]["changedCells"] == 1
    assert inspection["diff"]["cells"][0]["rowNumber"] == 1
    assert [column["name"] for column in inspection["inputSchema"]] == ["name", "value", "doubled"]
    assert [column["name"] for column in inspection["outputSchema"]] == ["name", "value", "doubled"]
    assert inspection["code"] == session.engine.compile_plan(session.bound_plan[:2])
    assert "renamed_metric" not in inspection["code"]
    assert "name_length" not in inspection["code"]
    assert applied_during_inspection == ["add-double", "round-value"]
    assert observable_state(session) == before

    manager.close_session(session_id, revision)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_step_inspection_projects_each_boundary_as_its_own_contiguous_window(
    backend: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"inspection-projection-{backend}.csv"
    path.write_text("first,second,third\na,b,c\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Inspection must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "reverse",
            "selectColumns",
            columns=[
                {"id": "c:source:2", "name": "third"},
                {"id": "c:source:1", "name": "second"},
                {"id": "c:source:0", "name": "first"},
            ],
        ),
    )

    inspection = manager.inspect_step(
        session_id,
        revision,
        "reverse",
        0,
        1,
        column_offset=0,
        column_limit=1,
    )

    assert inspection["inputPage"]["columnIds"] == ["c:source:0"]
    assert inspection["outputPage"]["columnIds"] == ["c:source:2"]
    assert inspection["inputPage"]["rows"][0]["values"][0]["display"] == "a"
    assert inspection["outputPage"]["rows"][0]["values"][0]["display"] == "c"
    assert inspection["diff"]["changedCells"] == 0
    assert inspection["diff"]["cells"] == []
    assert inspection["diff"]["truncated"] is True

    manager.close_session(session_id, revision)


def test_step_inspection_marks_a_nonzero_final_block_as_truncated(tmp_path: Path) -> None:
    path = tmp_path / "inspection-final-block.csv"
    path.write_text("value\n1.2\n2.8\n3.4\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "round-value",
            "roundNumber",
            column={"id": "c:source:0", "name": "value"},
            decimals=0,
        ),
    )

    inspection = manager.inspect_step(session_id, revision, "round-value", 2, 1)

    assert inspection["inputPage"]["totalRows"] == 3
    assert inspection["inputPage"]["offset"] == 2
    assert len(inspection["inputPage"]["rows"]) == 1
    assert inspection["diff"]["changedCells"] == 1
    assert inspection["diff"]["truncated"] is True

    manager.close_session(session_id, revision)


def test_step_ids_are_unique_and_inspection_errors_leave_state_unchanged(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "inspection-errors.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "stable-id",
            "formula",
            leftColumn={"id": "c:source:0", "name": "value"},
            operator="multiply",
            value=2,
            newColumn="doubled",
        ),
    )
    session = manager.sessions[session_id]
    before = observable_state(session)

    with pytest.raises(EngineError, match="Applied step IDs must be unique: stable-id"):
        manager.preview_step(
            session_id,
            revision,
            step(
                "stable-id",
                "roundNumber",
                column={"id": "c:source:0", "name": "value"},
                decimals=0,
            ),
            0,
            2,
        )
    with pytest.raises(EngineError, match="Unknown applied step: missing"):
        manager.inspect_step(session_id, revision, "missing", 0, 2)
    with pytest.raises(EngineError, match="Stale session revision"):
        manager.inspect_step(session_id, revision - 1, "stable-id", 0, 2)

    monkeypatch.setattr(
        session.engine,
        "compile_plan",
        lambda _steps: (_ for _ in ()).throw(EngineError("inspection code failed")),
    )
    with pytest.raises(EngineError, match="inspection code failed"):
        manager.inspect_step(session_id, revision, "stable-id", 0, 2)
    assert observable_state(session) == before

    monkeypatch.undo()
    revision = apply_step(
        manager,
        session_id,
        revision,
        step(
            "second-id",
            "roundNumber",
            column={"id": "c:source:0", "name": "value"},
            decimals=0,
        ),
    )
    session.plan[1]["id"] = "stable-id"
    with pytest.raises(EngineError, match="Applied step ID is not unique: stable-id"):
        manager.inspect_step(session_id, revision, "stable-id", 0, 2)
    session.plan[1]["id"] = "second-id"
    manager.close_session(session_id, revision)


def test_step_inspection_serializes_with_plan_mutation(tmp_path: Path) -> None:
    path = tmp_path / "inspection-concurrency.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    inspection_started = threading.Event()
    release_inspection = threading.Event()

    class BlockingInspectionEngine(PandasEngine):
        block_inspection = False

        def apply_transform(self, frame: Any, step: Any) -> Any:
            if self.block_inspection:
                inspection_started.set()
                if not release_inspection.wait(2):
                    raise TimeoutError("Inspection was not released.")
            return super().apply_transform(frame, step)

    manager = SessionManager(EngineRegistry((("pandas", BlockingInspectionEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    revision = apply_step(
        manager,
        session_id,
        0,
        step(
            "round-value",
            "roundNumber",
            column={"id": "c:source:0", "name": "value"},
            decimals=0,
        ),
    )
    engine = manager.sessions[session_id].engine
    assert isinstance(engine, BlockingInspectionEngine)
    engine.block_inspection = True

    with ThreadPoolExecutor(max_workers=2) as executor:
        inspection = executor.submit(manager.inspect_step, session_id, revision, "round-value", 0, 2)
        assert inspection_started.wait(1)
        undo = executor.submit(manager.undo_step, session_id, revision, 0, 2)
        with pytest.raises(TimeoutError):
            undo.result(timeout=0.05)

        release_inspection.set()
        assert inspection.result(timeout=1)["revision"] == revision
        assert undo.result(timeout=1)["revision"] == revision + 1

    assert manager.sessions[session_id].plan == []
    manager.close_session(session_id, revision + 1)
