from __future__ import annotations

from pathlib import Path

import pandas as pd

from data_wrangler_runtime.session import SessionManager

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
    assert opened["metadata"]["stats"]["duplicateRows"] == 0
    assert opened["summaries"][0]["visualization"]["kind"] == "categorical"

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
    page = manager.get_page(opened["metadata"]["sessionId"], 0, 10, filter_model)

    assert page["metadata"]["filteredShape"]["rows"] == 2
    assert [row["values"][0]["display"] for row in page["page"]["rows"]] == ["Rome", "Milan"]


def test_pandas_excel_file_session(tmp_path):
    path = tmp_path / "sample.xlsx"
    pd.DataFrame({"name": ["alpha", "beta"], "value": [1, 2]}).to_excel(path, index=False)

    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": "sample.xlsx", "path": str(path)}, backend="pandas")

    assert opened["metadata"]["shape"] == {"rows": 2, "columns": 2}
