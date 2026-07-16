from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from openwrangler_runtime.engines import PandasEngine
from openwrangler_runtime.session import SessionManager

ROOT = Path(__file__).resolve().parents[2]


def test_pandas_file_session_matches_protocol():
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": "sample.tsv", "path": str(ROOT / "fixtures" / "sample.tsv")},
        backend="pandas",
        page_size=10,
    )

    assert opened["metadata"]["backend"] == "pandas"
    assert opened["metadata"]["shape"] == {"rows": 4, "columns": 4}
    assert opened["metadata"]["schema"][0]["name"] == "city"
    assert "stats" not in opened["metadata"]
    assert opened["summaries"] == []

    summaries = manager.get_summary(
        opened["metadata"]["sessionId"],
        0,
        {"filters": [], "sort": []},
        ["city"],
    )["summaries"]
    assert summaries[0]["visualization"]["kind"] == "categorical"

    stats = manager.get_dataset_stats(opened["metadata"]["sessionId"], 0, {"filters": [], "sort": []})
    assert stats["stats"]["duplicateRows"] == 0

    filter_model = {
        "filters": [
            {
                "column": "year",
                "type": "integer",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["2024"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [{"column": "sales", "direction": "asc", "nulls": "last"}],
    }
    page = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, filter_model)

    assert page["metadata"]["filteredShape"]["rows"] == 2
    assert [row["values"][0]["display"] for row in page["page"]["rows"]] == ["Rome", "Milan"]


def test_pandas_excel_file_session(tmp_path):
    path = tmp_path / "sample.xlsx"
    pd.DataFrame({"name": ["alpha", "beta"], "value": [1, 2]}).to_excel(path, index=False)

    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": "sample.xlsx", "path": str(path)}, backend="pandas")

    assert opened["metadata"]["shape"] == {"rows": 2, "columns": 2}


def test_pandas_excel_reader_matches_the_format_dependency(monkeypatch):
    calls: list[tuple[str, int, str]] = []

    def read_excel(path: str, *, sheet_name: int, engine: str) -> pd.DataFrame:
        calls.append((path, sheet_name, engine))
        return pd.DataFrame({"value": [1]})

    monkeypatch.setattr(pd, "read_excel", read_excel)
    runtime = PandasEngine()

    runtime.read_file("modern.xlsx", {"sheet": 1})
    runtime.read_file("legacy.xls", {"sheet": 1})

    assert calls == [("modern.xlsx", 1, "openpyxl"), ("legacy.xls", 1, "xlrd")]


def test_pandas_csv_import_options(tmp_path):
    path = tmp_path / "latin1.csv"
    path.write_bytes("city;value\nM\xfcnchen;7\n".encode("latin-1"))

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "file",
            "label": "latin1.csv",
            "path": str(path),
            "importOptions": {"delimiter": ";", "encoding": "latin-1", "hasHeader": True, "quoteChar": '"'},
        },
        backend="pandas",
    )

    assert opened["metadata"]["schema"][0]["name"] == "city"
    assert opened["page"]["rows"][0]["values"][0]["display"] == "München"


def test_pandas_utf8_lossy_is_a_replacement_policy_not_a_codec(tmp_path):
    path = tmp_path / "damaged.csv"
    path.write_bytes(b"name,value\nsafe,1\nbroken-\xff,2\n")

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "file",
            "label": path.name,
            "path": str(path),
            "importOptions": {"encoding": "utf8-lossy", "hasHeader": True},
        },
        backend="pandas",
    )

    assert [row["values"][0]["display"] for row in opened["page"]["rows"]] == ["safe", "broken-�"]


def test_pandas_viewing_supports_duplicate_and_non_string_column_labels():
    engine = PandasEngine()
    labels = pd.Index(["duplicate", "duplicate", 7], dtype="object")
    frame = pd.DataFrame([[1, None, 3], [1, 2, 4]], columns=labels)
    frame = engine.ensure_row_ids(frame, "labels")

    schema = engine.schema(frame)
    assert [column["name"] for column in schema] == ["duplicate", "duplicate", "7"]
    assert [column["id"] for column in schema] == ["c:0", "c:1", "c:2"]
    assert [summary["column"] for summary in engine.summaries(frame)] == ["duplicate", "duplicate", "7"]
    assert [cell["display"] for cell in engine.page(frame, 0, 1)["rows"][0]["values"]] == ["1", "NaN", "3"]
    stats = engine.header_stats(frame)
    assert stats["missingCells"] == 1
    assert stats["missingValuesByColumn"] == [
        {"column": "duplicate", "count": 0},
        {"column": "duplicate", "count": 1},
        {"column": "7", "count": 0},
    ]


def test_pandas_page_projection_addresses_duplicate_columns_by_position() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame([[1, 2, 3]], columns=pd.Index(["duplicate", "duplicate", 7], dtype="object"))
    frame = engine.ensure_row_ids(frame, "projected-duplicates")

    page = engine.page(
        frame,
        0,
        1,
        total_rows=1,
        column_projection=[(1, "stable:second-duplicate"), (2, "stable:integer-label")],
    )

    assert page["columnIds"] == ["stable:second-duplicate", "stable:integer-label"]
    assert [cell["display"] for cell in page["rows"][0]["values"]] == ["2", "3"]


def test_pandas_summaries_separate_nan_from_other_missing_values():
    frame = pd.DataFrame(
        {
            "float": pd.Series([1.0, float("nan")], dtype="float64"),
            "object": pd.Series([None, float("nan")], dtype="object"),
            "nullable": pd.Series([1.0, pd.NA], dtype="Float64"),
            "datetime": pd.Series([pd.Timestamp("2026-01-01"), pd.NaT]),
        }
    )

    summaries = {summary["column"]: summary for summary in PandasEngine().summaries(frame)}

    assert (summaries["float"]["nullCount"], summaries["float"]["nanCount"]) == (0, 1)
    assert (summaries["object"]["nullCount"], summaries["object"]["nanCount"]) == (1, 1)
    assert (summaries["nullable"]["nullCount"], summaries["nullable"]["nanCount"]) == (1, 0)
    assert (summaries["datetime"]["nullCount"], summaries["datetime"]["nanCount"]) == (1, 0)


def test_pandas_custom_code_cannot_mutate_nested_source_objects():
    source = pd.DataFrame({"nested": [[1], [2]], "value": [1, 2]})
    engine = PandasEngine()
    frame = engine.ensure_row_ids(source, "nested-source")
    step = {
        "id": "custom",
        "kind": "customCode",
        "params": {"code": "df.iloc[0, 0].append(99)\nresult = df"},
    }

    transformed = engine.apply_transform(frame, step)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace, namespace)
    generated = namespace["clean_data"](frame)

    assert source["nested"].tolist() == [[1], [2]]
    assert frame["nested"].tolist() == [[1], [2]]
    assert transformed["nested"].tolist() == [[1, 99], [2]]
    assert generated["nested"].tolist() == [[1, 99], [2]]
