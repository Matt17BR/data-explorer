from __future__ import annotations

from pathlib import Path

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
    assert opened["summaries"][0]["visualization"]["kind"] == "categorical"

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
