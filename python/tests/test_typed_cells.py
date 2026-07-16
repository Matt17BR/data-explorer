from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal

import numpy as np
import pandas as pd

from openwrangler_runtime.engines import PandasEngine
from openwrangler_runtime.engines.base import infer_semantic_type, normalize_cell


def test_typed_cells_preserve_values_json_cannot_represent_directly() -> None:
    assert normalize_cell(2**63)["raw"] == str(2**63)
    assert normalize_cell(Decimal("1.2300"))["kind"] == "decimal"
    assert normalize_cell(float("nan"))["kind"] == "nan"
    assert normalize_cell(float("-inf"))["sign"] == -1
    assert normalize_cell(datetime(2026, 7, 15, 12, 30))["raw"] == "2026-07-15T12:30:00"
    assert normalize_cell(date(2026, 7, 15))["raw"] == "2026-07-15"


def test_typed_cells_normalize_numpy_and_pandas_scalars() -> None:
    assert normalize_cell(np.int64(7)) == {
        "kind": "integer",
        "raw": 7,
        "display": "7",
        "isNull": False,
        "isNaN": False,
    }
    assert normalize_cell(np.bool_(True))["kind"] == "boolean"
    assert normalize_cell(np.bool_(True))["raw"] is True
    assert normalize_cell(np.float32("nan"))["kind"] == "nan"
    assert normalize_cell(np.float64("inf"))["sign"] == 1
    assert normalize_cell(np.datetime64("2026-07-16")) == {
        "kind": "datetime",
        "raw": "2026-07-16",
        "display": "2026-07-16",
        "isNull": False,
        "isNaN": False,
    }
    assert normalize_cell(np.datetime64("NaT"))["kind"] == "null"
    assert normalize_cell(np.timedelta64(1, "D"))["raw"] == 86_400
    assert normalize_cell(np.timedelta64(1, "ns")) == {
        "kind": "duration",
        "raw": 1e-9,
        "display": "1 nanoseconds",
        "isNull": False,
        "isNaN": False,
    }
    assert normalize_cell(np.timedelta64("NaT"))["kind"] == "null"
    assert normalize_cell(np.array([1, 2]))["kind"] == "unknown"
    assert normalize_cell(np.array([1]))["kind"] == "unknown"
    assert normalize_cell(np.longdouble(1))["kind"] in {"number", "unknown"}
    assert normalize_cell(pd.NA)["kind"] == "null"
    assert normalize_cell(pd.NaT)["kind"] == "null"
    assert normalize_cell(pd.Timestamp("2026-07-15T12:30:00+02:00"))["raw"] == "2026-07-15T12:30:00+02:00"
    assert normalize_cell(timedelta(days=1))["raw"] == 86_400
    assert normalize_cell(pd.Timedelta(1, unit="ns"))["raw"] == 1e-9


def test_nested_typed_cells_are_strict_json_safe() -> None:
    cell = normalize_cell(
        {
            "values": [np.int64(3), float("nan"), float("-inf"), Decimal("1.20")],
            "when": datetime(2026, 7, 15, 12, 30),
            "missing": pd.NA,
        }
    )

    assert cell["kind"] == "struct"
    assert cell["raw"] == {
        "values": [3, "NaN", "-Infinity", "1.20"],
        "when": "2026-07-15T12:30:00",
        "missing": None,
    }
    json.dumps(cell, allow_nan=False)


def test_projected_page_retains_typed_cell_encodings_and_strict_json() -> None:
    engine = PandasEngine()
    frame = engine.ensure_row_ids(
        pd.DataFrame(
            {
                "omitted": ["wide payload"],
                "huge": [2**80],
                "missing": [float("nan")],
            }
        ),
        "typed-projection",
    )

    page = engine.page(
        frame,
        0,
        1,
        total_rows=1,
        column_projection=[(1, "stable:huge"), (2, "stable:missing")],
    )

    assert page["columnIds"] == ["stable:huge", "stable:missing"]
    assert page["rows"][0]["values"][0]["raw"] == str(2**80)
    assert page["rows"][0]["values"][1]["kind"] == "nan"
    json.dumps(page, allow_nan=False)


def test_semantic_type_inference_covers_duckdb_scalar_and_nested_types() -> None:
    assert infer_semantic_type("HUGEINT") == "integer"
    assert infer_semantic_type("DECIMAL(38, 6)") == "decimal"
    assert infer_semantic_type("TIMESTAMP WITH TIME ZONE") == "datetime"
    assert infer_semantic_type("INTERVAL") == "duration"
    assert infer_semantic_type("BLOB") == "binary"
    assert infer_semantic_type("VARCHAR") == "string"
    assert infer_semantic_type("UUID") == "string"
    assert infer_semantic_type("INTEGER[]") == "list"
    assert infer_semantic_type("MAP(VARCHAR, INTEGER)") == "struct"
