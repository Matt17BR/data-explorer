from __future__ import annotations

import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.session import SessionManager


def transform(step_id: str, kind: str, **params):
    return {"id": step_id, "kind": kind, "params": params}


def source_ref(position: int, name: str) -> dict[str, str]:
    return {"id": f"c:source:{position}", "name": name}


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_sources_cannot_enter_the_private_row_identity_namespace(tmp_path, backend):
    path = tmp_path / f"reserved-{backend}.csv"
    path.write_text(f"{INTERNAL_ROW_ID_PREFIX}user,value\nprivate,1\n", encoding="utf-8")
    manager = SessionManager()

    with pytest.raises(EngineError, match="private row-identity prefix are reserved"):
        manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)},
            backend=backend,
            page_size=10,
        )

    assert manager.sessions == {}


def test_custom_code_cannot_forge_a_private_row_identity_column(tmp_path):
    path = tmp_path / "reserved-custom.csv"
    path.write_text("name,value\na,1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend="pandas", page_size=10
    )

    with pytest.raises(EngineError, match="private row-identity prefix are reserved"):
        manager.preview_step(
            opened["metadata"]["sessionId"],
            0,
            transform(
                "custom",
                "customCode",
                code=f"result = df.assign({INTERNAL_ROW_ID_PREFIX}forged=1)",
            ),
            0,
            10,
        )

    assert manager.sessions[opened["metadata"]["sessionId"]].revision == 0


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
        transform(
            "score",
            "formula",
            leftColumn=source_ref(1, "value"),
            operator="multiply",
            value=2,
            newColumn="score",
        ),
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
        transform(
            "score",
            "formula",
            leftColumn=source_ref(1, "value"),
            operator="multiply",
            value=3,
            newColumn="score",
        ),
        0,
        10,
        replace_step_id="score",
    )
    assert edited_preview["revision"] == 3
    assert edited_preview["diff"]["changedCells"] == 3
    assert edited_preview["page"]["rows"][2]["values"][2]["display"] in {"9", "9.0"}

    edited = manager.apply_draft(session_id, 3, 0, 10)
    assert [item["id"] for item in edited["metadata"]["steps"]] == ["score"]
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
        transform("drop", "dropColumns", columns=[source_ref(0, "name")]),
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
            transform("drop", "dropColumns", columns=[source_ref(0, "value")]),
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

    manager.preview_step(
        session_id,
        0,
        transform("drop", "dropColumns", columns=[source_ref(0, "name")]),
        0,
        10,
    )
    applied = manager.apply_draft(session_id, 1, 0, 10)

    assert [column["name"] for column in applied["metadata"]["schema"]] == ["value"]
    assert [column["name"] for column in applied["metadata"]["latestStepInputSchema"]] == ["name", "value"]

    edited = manager.preview_step(
        session_id,
        2,
        transform("drop", "dropColumns", columns=[source_ref(1, "value")]),
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
        transform(
            "sort",
            "sortRows",
            rules=[
                {
                    "column": source_ref(1, "value"),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        ),
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
                        "column": source_ref(1, "value"),
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "gt", "value": 1}],
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
        transform("rename", "renameColumn", column=source_ref(1, "value"), newName="amount"),
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
        transform(
            "select",
            "selectColumns",
            columns=[source_ref(1, "value"), source_ref(0, "group")],
        ),
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


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_row_order_binding_replays_after_an_earlier_column_reorder(tmp_path, backend):
    path = tmp_path / f"row-order-replay-{backend}.csv"
    path.write_text("a,b\n3,z\n1,x\n2,y\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]

    manager.preview_step(
        session_id,
        0,
        transform(
            "reorder",
            "selectColumns",
            columns=[source_ref(1, "b"), source_ref(0, "a")],
        ),
        0,
        10,
    )
    reordered = manager.apply_draft(session_id, 1, 0, 10)
    assert [column["id"] for column in reordered["metadata"]["schema"]] == [
        "c:source:1",
        "c:source:0",
    ]

    sorted_preview = manager.preview_step(
        session_id,
        2,
        transform(
            "sort-a",
            "sortRows",
            rules=[
                {
                    "column": source_ref(0, "a"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        ),
        0,
        10,
    )
    assert [row["values"][0]["display"] for row in sorted_preview["page"]["rows"]] == ["x", "y", "z"]
    applied = manager.apply_draft(session_id, 3, 0, 10)
    inspection = manager.inspect_step(session_id, 4, "sort-a", 0, 10)

    assert [row["id"] for row in inspection["outputPage"]["rows"]] == [row["id"] for row in applied["page"]["rows"]]
    assert [row["values"][0]["display"] for row in inspection["outputPage"]["rows"]] == ["x", "y", "z"]
    if backend == "pandas":
        assert ".iloc" in inspection["code"]


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_filter_binding_rejects_a_stale_semantic_type_before_engine_dispatch(tmp_path, backend):
    path = tmp_path / f"filter-type-{backend}.csv"
    path.write_text("value\n1.0\n2.0\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    actual_type = opened["metadata"]["schema"][0]["type"]
    stale_type = "string" if actual_type != "string" else "integer"

    with pytest.raises(EngineError, match=f"Column type mismatch.*'{actual_type}'.*'{stale_type}'"):
        manager.preview_step(
            opened["metadata"]["sessionId"],
            0,
            transform(
                "stale-filter-type",
                "filterRows",
                filterModel={
                    "filters": [
                        {
                            "column": source_ref(0, "value"),
                            "type": stale_type,
                            "predicates": [{"kind": "predicate", "operator": "isNaN"}],
                        }
                    ],
                    "sort": [],
                },
            ),
            0,
            10,
        )

    assert manager.sessions[opened["metadata"]["sessionId"]].revision == 0


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_all_column_row_operations_exclude_the_private_row_identity(tmp_path, backend):
    path = tmp_path / f"all-visible-columns-{backend}.csv"
    path.write_text("a,b\n1,x\n1,x\n,\n,\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]

    missing = manager.preview_step(
        session_id,
        0,
        transform("drop-all-missing", "dropMissingRows", columns=[], how="all"),
        0,
        10,
    )
    assert missing["page"]["totalRows"] == 2
    manager.discard_draft(session_id, 1, 0, 10)

    duplicates = manager.preview_step(
        session_id,
        2,
        transform("deduplicate-all", "dropDuplicates", keep="first"),
        0,
        10,
    )
    assert duplicates["page"]["totalRows"] == 2
    assert all("open_wrangler_internal" not in column["name"] for column in duplicates["metadata"]["schema"])


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_non_float_include_nan_value_filter_previews_an_empty_result(tmp_path, backend):
    path = tmp_path / f"integer-include-nan-{backend}.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )

    preview = manager.preview_step(
        opened["metadata"]["sessionId"],
        0,
        transform(
            "integer-nan-filter",
            "filterRows",
            filterModel={
                "filters": [
                    {
                        "column": source_ref(0, "value"),
                        "type": opened["metadata"]["schema"][0]["type"],
                        "valueFilter": {
                            "kind": "values",
                            "selectedValues": [],
                            "includeNulls": False,
                            "includeNaN": True,
                        },
                        "predicates": [],
                    }
                ],
                "sort": [],
            },
        ),
        0,
        10,
    )

    assert opened["metadata"]["schema"][0]["type"] != "float"
    assert preview["page"]["totalRows"] == 0


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_projected_preview_diff_samples_the_confirmed_filtered_sorted_lens(tmp_path, backend, monkeypatch):
    path = tmp_path / f"projected-preview-{backend}.csv"
    path.write_text("name,value\ndropped,1.2\nbeta,3.4\ngamma,10.4\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars diffs must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=3,
    )
    session_id = opened["metadata"]["sessionId"]
    view = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": 2}],
            }
        ],
        "sort": [{"column": "value", "direction": "desc", "nulls": "last"}],
    }
    confirmed = manager.get_page(
        session_id,
        0,
        0,
        1,
        view,
        column_offset=1,
        column_limit=1,
    )["page"]

    preview = manager.preview_step(
        session_id,
        0,
        transform("round-value", "roundNumber", column="value", decimals=0),
        0,
        1,
        column_offset=1,
        column_limit=1,
    )

    assert confirmed["columnIds"] == preview["page"]["columnIds"] == ["c:source:1"]
    assert confirmed["rows"][0]["id"] == preview["page"]["rows"][0]["id"]
    assert confirmed["rows"][0]["values"][0]["display"] == "10.4"
    assert preview["page"]["rows"][0]["values"][0]["display"] in {"10", "10.0"}
    assert preview["diff"]["changedCells"] == 1
    assert preview["diff"]["cells"] == [
        {
            "rowNumber": 0,
            "columnId": "c:source:1",
            "column": "value",
            "before": confirmed["rows"][0]["values"][0],
            "after": preview["page"]["rows"][0]["values"][0],
        }
    ]
    assert preview["diff"]["truncated"] is True


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
        transform(
            "score",
            "formula",
            leftColumn=source_ref(1, "value"),
            operator="multiply",
            value=2,
            newColumn="score",
        ),
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
    manager.preview_step(
        session_id,
        0,
        transform("clone", "cloneColumn", column=source_ref(0, "value"), newName="copy"),
        0,
        10,
    )

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

    session = manager.sessions[opened["metadata"]["sessionId"]]
    monkeypatch.setattr(session.engine, "export_data", fail_export)
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
