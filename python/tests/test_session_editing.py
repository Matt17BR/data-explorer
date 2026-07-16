from __future__ import annotations

import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.session import SessionManager


def transform(step_id: str, kind: str, **params):
    return {"id": step_id, "kind": kind, "params": params}


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_draft_preview_apply_edit_and_undo_replays_the_immutable_source(tmp_path, backend, monkeypatch):
    source = "group,value\na,1\na,2\nb,3\n"
    path = tmp_path / "editing.csv"
    path.write_text(source, encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    assert opened["metadata"]["steps"] == []

    preview = manager.preview_step(
        session_id,
        0,
        transform("score", "formula", leftColumn="value", operator="multiply", value=2, newColumn="score"),
        0,
        10,
    )
    assert preview["revision"] == 1
    assert preview["metadata"]["draftStep"]["id"] == "score"
    assert preview["metadata"]["steps"] == []
    assert preview["diff"]["addedColumns"] == ["score"]
    assert preview["page"]["rows"][0]["values"][2]["display"] in {"2", "2.0"}
    assert "def clean_data(df):" in preview["code"]

    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["revision"] == 2
    assert applied["action"] == "apply"
    assert [item["id"] for item in applied["metadata"]["steps"]] == ["score"]
    assert "draftStep" not in applied["metadata"]

    edited_preview = manager.preview_step(
        session_id,
        2,
        transform("score-v2", "formula", leftColumn="value", operator="multiply", value=3, newColumn="score"),
        0,
        10,
        replace_step_id="score",
    )
    assert edited_preview["revision"] == 3
    assert edited_preview["diff"]["changedCells"] == 3
    assert edited_preview["page"]["rows"][2]["values"][2]["display"] in {"9", "9.0"}

    edited = manager.apply_draft(session_id, 3, 0, 10)
    assert [item["id"] for item in edited["metadata"]["steps"]] == ["score-v2"]
    assert edited["metadata"]["shape"] == {"rows": 3, "columns": 3}

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["revision"] == 5
    assert undone["metadata"]["steps"] == []
    assert undone["metadata"]["shape"] == {"rows": 3, "columns": 2}
    assert path.read_text(encoding="utf-8") == source


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_discard_restores_committed_plan_and_stale_revisions_are_rejected(tmp_path, backend):
    path = tmp_path / "discard.csv"
    path.write_text("name,value\na,1\nb,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    session_id = opened["metadata"]["sessionId"]

    preview = manager.preview_step(
        session_id,
        0,
        transform("drop", "dropColumns", columns=["name"]),
        0,
        10,
    )
    assert preview["metadata"]["shape"] == {"rows": 2, "columns": 1}
    with pytest.raises(EngineError, match="Stale"):
        manager.discard_draft(session_id, 0, 0, 10)

    discarded = manager.discard_draft(session_id, 1, 0, 10)
    assert discarded["action"] == "discard"
    assert discarded["revision"] == 2
    assert discarded["metadata"]["shape"] == {"rows": 2, "columns": 2}
    assert discarded["metadata"]["steps"] == []


def test_viewing_sessions_cannot_preview_transformations(tmp_path):
    path = tmp_path / "viewing.csv"
    path.write_text("value\n1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend="pandas", mode="viewing"
    )
    with pytest.raises(EngineError, match="viewing mode"):
        manager.preview_step(
            opened["metadata"]["sessionId"],
            0,
            transform("drop", "dropColumns", columns=["value"]),
            0,
            10,
        )


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_latest_structural_step_keeps_its_input_schema_for_editing(tmp_path, backend):
    path = tmp_path / "structural.csv"
    path.write_text("name,value\na,1\nb,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    session_id = opened["metadata"]["sessionId"]

    manager.preview_step(session_id, 0, transform("drop", "dropColumns", columns=["name"]), 0, 10)
    applied = manager.apply_draft(session_id, 1, 0, 10)

    assert [column["name"] for column in applied["metadata"]["schema"]] == ["value"]
    assert [column["name"] for column in applied["metadata"]["latestStepInputSchema"]] == ["name", "value"]

    edited = manager.preview_step(
        session_id,
        2,
        transform("drop-v2", "dropColumns", columns=["value"]),
        0,
        10,
        replace_step_id="drop",
    )
    assert [column["name"] for column in edited["metadata"]["schema"]] == ["name"]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_structural_diffs_use_stable_row_and_column_lineage(tmp_path, backend, monkeypatch):
    path = tmp_path / "lineage.csv"
    path.write_text("group,value\na,1\na,2\nb,3\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars lineage must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    session_id = opened["metadata"]["sessionId"]
    source_ids = [column["id"] for column in opened["metadata"]["schema"]]
    row_ids = [row["id"] for row in opened["page"]["rows"]]
    assert source_ids == ["c:source:0", "c:source:1"]
    assert len(set(row_ids)) == 3
    assert all("open_wrangler_internal" not in column["name"] for column in opened["metadata"]["schema"])

    sorted_preview = manager.preview_step(
        session_id,
        0,
        transform("sort", "sortRows", rules=[{"column": "value", "direction": "desc", "nulls": "last"}]),
        0,
        10,
    )
    assert sorted_preview["page"]["rows"][0]["id"] == row_ids[-1]
    assert sorted_preview["diff"]["changedCells"] == 0
    assert sorted_preview["diff"]["addedRows"] == 0
    assert sorted_preview["diff"]["removedRows"] == 0
    manager.discard_draft(session_id, 1, 0, 10)

    filtered = manager.preview_step(
        session_id,
        2,
        transform(
            "filter",
            "filterRows",
            filterModel={
                "filters": [
                    {
                        "column": "value",
                        "type": "integer",
                        "predicates": [{"operator": "gt", "value": 1}],
                    }
                ],
                "sort": [],
            },
        ),
        0,
        10,
    )
    assert [row["id"] for row in filtered["page"]["rows"]] == row_ids[1:]
    assert filtered["diff"]["removedRows"] == 1
    assert filtered["diff"]["changedCells"] == 0
    manager.discard_draft(session_id, 3, 0, 10)

    renamed = manager.preview_step(
        session_id,
        4,
        transform("rename", "renameColumn", column="value", newName="amount"),
        0,
        10,
    )
    assert [column["id"] for column in renamed["metadata"]["schema"]] == source_ids
    assert renamed["diff"]["addedColumns"] == []
    assert renamed["diff"]["removedColumns"] == []
    assert renamed["diff"]["changedCells"] == 0
    manager.discard_draft(session_id, 5, 0, 10)

    reordered = manager.preview_step(
        session_id,
        6,
        transform("select", "selectColumns", columns=["value", "group"]),
        0,
        10,
    )
    assert [column["id"] for column in reordered["metadata"]["schema"]] == list(reversed(source_ids))
    assert reordered["diff"]["addedColumns"] == []
    assert reordered["diff"]["removedColumns"] == []
    manager.discard_draft(session_id, 7, 0, 10)

    grouped = manager.preview_step(
        session_id,
        8,
        transform(
            "group",
            "groupBy",
            keys=["group"],
            aggregations=[{"column": "value", "operation": "sum", "alias": "total"}],
        ),
        0,
        10,
    )
    assert [column["id"] for column in grouped["metadata"]["schema"]] == [
        source_ids[0],
        "c:step:group:0",
    ]
    assert grouped["diff"]["addedColumns"] == ["total"]
    assert grouped["diff"]["removedColumns"] == ["value"]
    assert grouped["diff"]["addedRows"] == 2
    assert grouped["diff"]["removedRows"] == 3


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_internal_row_ids_never_enter_exports_or_statistics(tmp_path, backend):
    path = tmp_path / "identity-source.csv"
    path.write_text("group,value\na,1\na,1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    session_id = opened["metadata"]["sessionId"]
    stats = manager.get_dataset_stats(session_id, 0, {"filters": [], "sort": []})["stats"]
    assert stats["duplicateRows"] == 1
    assert [item["column"] for item in stats["missingValuesByColumn"]] == ["group", "value"]

    custom = manager.preview_step(
        session_id,
        0,
        transform(
            "custom",
            "customCode",
            code=(
                'columns = df.collect_schema().names() if hasattr(df, "collect_schema") else list(df.columns)\n'
                'assert all("open_wrangler_internal" not in str(column) for column in columns)\n'
                "result = df"
            ),
        ),
        0,
        10,
    )
    assert [column["name"] for column in custom["metadata"]["schema"]] == ["group", "value"]
    manager.discard_draft(session_id, 1, 0, 10)

    destination = tmp_path / f"{backend}-identity.csv"
    manager.export_data(session_id, 2, str(destination), "csv")
    assert destination.read_text(encoding="utf-8").splitlines()[0] == "group,value"
    assert "open_wrangler_internal" not in destination.read_text(encoding="utf-8")


@pytest.mark.parametrize("backend", ["pandas", "polars"])
@pytest.mark.parametrize("format_name", ["csv", "parquet"])
def test_export_is_atomic_native_and_excludes_view_filters(tmp_path, backend, format_name, monkeypatch):
    source = "group,value\na,1\na,2\nb,3\n"
    source_path = tmp_path / "source.csv"
    source_path.write_text(source, encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars export must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    manager.preview_step(
        session_id,
        0,
        transform("score", "formula", leftColumn="value", operator="multiply", value=2, newColumn="score"),
        0,
        10,
    )
    manager.apply_draft(session_id, 1, 0, 10)
    view_filter = {
        "filters": [
            {
                "column": "group",
                "type": "string",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": "a"}],
            }
        ],
        "sort": [],
    }
    manager.get_page(session_id, 2, 0, 10, view_filter)

    destination = tmp_path / f"cleaned.{format_name}"
    destination.write_text("existing destination", encoding="utf-8")
    exported = manager.export_data(session_id, 2, str(destination), format_name)
    result = pl.read_csv(destination) if format_name == "csv" else pl.read_parquet(destination)

    assert exported["kind"] == "dataExported"
    assert exported["shape"] == {"rows": 3, "columns": 3}
    assert result.to_dict(as_series=False) == {
        "group": ["a", "a", "b"],
        "value": [1, 2, 3],
        "score": [2, 4, 6],
    }
    assert source_path.read_text(encoding="utf-8") == source
    assert not list(tmp_path.glob(f".{destination.name}.*.tmp"))


def test_export_rejects_pending_drafts_and_source_overwrite(tmp_path):
    source_path = tmp_path / "source.csv"
    source_path.write_text("value\n1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)}, backend="pandas"
    )
    session_id = opened["metadata"]["sessionId"]
    manager.preview_step(session_id, 0, transform("clone", "cloneColumn", column="value", newName="copy"), 0, 10)

    with pytest.raises(EngineError, match="Apply or discard"):
        manager.export_data(session_id, 1, str(tmp_path / "cleaned.csv"), "csv")
    manager.discard_draft(session_id, 1, 0, 10)
    with pytest.raises(EngineError, match="never overwrites"):
        manager.export_data(session_id, 2, str(source_path), "csv")


def test_failed_export_preserves_existing_destination_and_removes_temporary_file(tmp_path, monkeypatch):
    source_path = tmp_path / "source.csv"
    source_path.write_text("value\n1\n", encoding="utf-8")
    destination = tmp_path / "cleaned.csv"
    destination.write_text("keep me", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)}, backend="pandas"
    )

    def fail_export(_frame, path, _format):
        with open(path, "w", encoding="utf-8") as temporary:
            temporary.write("partial")
        raise EngineError("simulated export failure")

    monkeypatch.setattr(manager.engines["pandas"], "export_data", fail_export)
    with pytest.raises(EngineError, match="simulated"):
        manager.export_data(opened["metadata"]["sessionId"], 0, str(destination), "csv")

    assert destination.read_text(encoding="utf-8") == "keep me"
    assert not list(tmp_path.glob(f".{destination.name}.*.tmp"))


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_by_example_requires_warning_preview_before_apply(tmp_path, backend):
    path = tmp_path / "examples.csv"
    path.write_text("value\na\nb\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    preview = manager.preview_step(
        opened["metadata"]["sessionId"],
        0,
        transform(
            "example",
            "byExample",
            sourceColumns=["value"],
            newColumn="upper",
            examples=[
                {"inputs": {"value": "a"}, "output": "A"},
                {"inputs": {"value": "b"}, "output": "B"},
            ],
        ),
        0,
        10,
    )
    assert preview["warnings"][0].startswith("Ambiguous examples")
    assert preview["metadata"]["draftStep"]["params"]["program"]["kind"] == "case"
    assert [row["values"][1]["display"] for row in preview["page"]["rows"]] == ["A", "B"]
    applied = manager.apply_draft(opened["metadata"]["sessionId"], 1, 0, 10)
    assert applied["metadata"]["steps"][0]["params"]["program"]["kind"] == "case"
