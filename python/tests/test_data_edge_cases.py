from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pandas as pd
import polars as pl
import pytest

from data_wrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from data_wrangler_runtime.session import SessionManager


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_delimited_jsonl_and_parquet_imports(backend: str, tmp_path) -> None:
    csv_path = tmp_path / "quoted.csv"
    csv_path.write_text('name;note\nalpha;"one;two"\n', encoding="utf-8")
    tsv_path = tmp_path / "sample.tsv"
    tsv_path.write_text("name\tvalue\nbeta\t2\n", encoding="utf-8")
    no_header_path = tmp_path / "no-header.csv"
    no_header_path.write_text("epsilon|5\n", encoding="utf-8")
    jsonl_path = tmp_path / "sample.jsonl"
    jsonl_path.write_text('{"name":"gamma","value":3}\n', encoding="utf-8")
    parquet_path = tmp_path / "sample.parquet"
    pl.DataFrame({"name": ["delta"], "value": [4]}).write_parquet(parquet_path)

    cases = [
        (csv_path, {"delimiter": ";", "encoding": "utf-8", "quoteChar": '"', "hasHeader": True}, "alpha"),
        (tsv_path, None, "beta"),
        (no_header_path, {"delimiter": "|", "encoding": "utf-8", "hasHeader": False}, "epsilon"),
        (jsonl_path, None, "gamma"),
        (parquet_path, None, "delta"),
    ]
    for path, options, expected in cases:
        manager = SessionManager()
        source = {"kind": "file", "label": path.name, "path": str(path)}
        if options is not None:
            source["importOptions"] = options
        opened = manager.open_session(source, backend=backend)
        session_id = opened["metadata"]["sessionId"]

        assert opened["page"]["rows"][0]["values"][0]["display"] == expected
        if backend == "polars" and path.suffix != ".xlsx":
            assert isinstance(manager.sessions[session_id].original, pl.LazyFrame)
        manager.close_session(session_id, 0)
        assert manager.sessions == {}


@pytest.mark.parametrize("backend", ["pandas", "polars"])
@pytest.mark.parametrize("sheet", ["second", 1])
def test_excel_sheet_name_and_zero_based_index(backend: str, sheet: str | int, tmp_path) -> None:
    path = tmp_path / "sheets.xlsx"
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame({"name": ["first"]}).to_excel(writer, sheet_name="first", index=False)
        pd.DataFrame({"name": ["second"]}).to_excel(writer, sheet_name="second", index=False)

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "file",
            "label": path.name,
            "path": str(path),
            "importOptions": {"sheet": sheet},
        },
        backend=backend,
    )

    assert opened["page"]["rows"][0]["values"][0]["display"] == "second"


def test_polars_nested_parquet_preserves_native_typed_values(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    path = tmp_path / "nested.parquet"
    long_value = "λ" * 20_000
    pl.DataFrame(
        {
            "huge": pl.Series([2**63, None], dtype=pl.UInt64),
            "decimal": pl.Series([Decimal("1.2300"), Decimal("2.0000")], dtype=pl.Decimal(10, 4)),
            "zoned": pl.Series([datetime(2026, 1, 1), datetime(2026, 1, 2)]).dt.replace_time_zone("Europe/Berlin"),
            "items": [[1, 2], [3]],
            "record": [{"x": 1}, {"x": 2}],
            "binary": [b"a", b"b"],
            "category": pl.Series(["a", "b"], dtype=pl.Categorical),
            "duration": pl.Series([1, 2], dtype=pl.Duration("ms")),
            "floating": [float("inf"), float("nan")],
            "long": [long_value, "short"],
        }
    ).write_parquet(path)

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend="polars", page_size=10
    )
    schema = {column["name"]: column["type"] for column in opened["metadata"]["schema"]}
    first_row = opened["page"]["rows"][0]["values"]

    assert schema == {
        "huge": "integer",
        "decimal": "decimal",
        "zoned": "datetime",
        "items": "list",
        "record": "struct",
        "binary": "binary",
        "category": "string",
        "duration": "duration",
        "floating": "float",
        "long": "string",
    }
    assert [cell["kind"] for cell in first_row] == [
        "integer",
        "decimal",
        "datetime",
        "list",
        "struct",
        "binary",
        "string",
        "duration",
        "infinity",
        "string",
    ]
    assert first_row[0]["raw"] == str(2**63)
    assert first_row[-1]["display"] == long_value

    summaries = manager.get_summary(
        opened["metadata"]["sessionId"],
        0,
        {"filters": [], "sort": []},
        ["decimal", "items", "record", "floating"],
    )["summaries"]
    assert [summary["type"] for summary in summaries] == ["decimal", "list", "struct", "float"]
    assert summaries[0]["numeric"]["min"] == 1.23
    assert summaries[1]["topValues"][0]["value"] == "[1,2]"
    assert summaries[2]["topValues"][0]["value"] == '{"x":1}'


def test_pandas_nullable_values_have_protocol_kinds() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "integer": pd.Series([1, pd.NA], dtype="Int64"),
            "boolean": pd.Series([True, pd.NA], dtype="boolean"),
            "timestamp": [pd.Timestamp("2026-07-15T12:30:00+02:00"), pd.NaT],
        }
    )
    frame = engine.ensure_row_ids(frame, "nullable")

    rows = engine.page(frame, 0, 2)["rows"]
    assert [cell["kind"] for cell in rows[0]["values"]] == ["integer", "boolean", "datetime"]
    assert [cell["kind"] for cell in rows[1]["values"]] == ["null", "null", "null"]


def test_zero_column_frames_remain_pageable() -> None:
    pandas_engine = PandasEngine()
    pandas_frame = pandas_engine.ensure_row_ids(pd.DataFrame(index=range(2)), "empty-pandas")
    assert pandas_engine.shape(pandas_frame) == {"rows": 2, "columns": 0}
    assert pandas_engine.schema(pandas_frame) == []
    assert pandas_engine.summaries(pandas_frame) == []
    assert [row["values"] for row in pandas_engine.page(pandas_frame, 0, 10)["rows"]] == [[], []]

    polars_engine = PolarsEngine()
    polars_frame = polars_engine.ensure_row_ids(pl.DataFrame(), "empty-polars")
    assert polars_engine.shape(polars_frame) == {"rows": 0, "columns": 0}
    assert polars_engine.schema(polars_frame) == []
    assert polars_engine.summaries(polars_frame) == []
    assert polars_engine.page(polars_frame, 0, 10)["rows"] == []


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_malformed_and_missing_files_raise_structured_engine_errors(backend: str, tmp_path) -> None:
    manager = SessionManager()
    missing = tmp_path / "missing.csv"
    with pytest.raises(EngineError, match=r"Could not read missing\.csv"):
        manager.open_session({"kind": "file", "label": missing.name, "path": str(missing)}, backend=backend)

    malformed = tmp_path / "broken.parquet"
    malformed.write_bytes(b"not parquet")
    with pytest.raises(EngineError, match=r"Could not read broken\.parquet"):
        manager.open_session({"kind": "file", "label": malformed.name, "path": str(malformed)}, backend=backend)

    assert manager.sessions == {}
