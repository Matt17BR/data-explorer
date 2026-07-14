from __future__ import annotations

from pathlib import Path

import polars as pl

from data_wrangler_runtime.session import SessionManager

ROOT = Path(__file__).resolve().parents[2]


def test_polars_file_session_pages_filters_and_summarizes_without_pandas(monkeypatch):
    def fail_to_pandas(*_args, **_kwargs):
        raise AssertionError("Polars sessions must not convert to pandas")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", fail_to_pandas, raising=False)

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": "sample.csv", "path": str(ROOT / "fixtures" / "sample.csv")},
        backend="polars",
        page_size=2,
    )

    assert opened["metadata"]["backend"] == "polars"
    assert opened["metadata"]["shape"] == {"rows": 4, "columns": 4}
    assert opened["metadata"]["stats"]["missingValuesByColumn"][0] == {"column": "city", "count": 0}
    assert opened["page"]["rows"][0]["values"][0]["display"] == "Milan"

    filter_model = {
        "filters": [
            {
                "column": "city",
                "type": "string",
                "valueFilter": None,
                "predicates": [{"kind": "predicate", "operator": "contains", "value": "i"}],
            }
        ],
        "sort": [{"column": "sales", "direction": "desc", "nulls": "last"}],
    }
    page = manager.get_page(opened["metadata"]["sessionId"], 0, 10, filter_model)

    assert page["metadata"]["filteredShape"]["rows"] == 3
    assert [row["values"][0]["display"] for row in page["page"]["rows"]] == ["Berlin", "Milan", "Paris"]

    summary = manager.get_summary(opened["metadata"]["sessionId"], filter_model, ["sales"])
    assert summary["summaries"][0]["numeric"]["max"] == 12.0
    assert summary["summaries"][0]["visualization"]["kind"] == "numeric"
    assert summary["summaries"][0]["visualization"]["bins"]


def test_polars_column_values_and_parquet(tmp_path):
    frame = pl.DataFrame({"group": ["a", "a", "b"], "value": [1, 2, 3]})
    path = tmp_path / "sample.parquet"
    frame.write_parquet(path)

    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": "sample.parquet", "path": str(path)}, backend="polars")
    values = manager.get_column_values(opened["metadata"]["sessionId"], "group", {"filters": [], "sort": []})

    assert values["values"] == [{"value": "a", "count": 2}, {"value": "b", "count": 1}]
