from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal

import numpy as np
import pandas as pd

from data_wrangler_runtime.engines.base import normalize_cell


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
    assert normalize_cell(pd.NA)["kind"] == "null"
    assert normalize_cell(pd.NaT)["kind"] == "null"
    assert normalize_cell(pd.Timestamp("2026-07-15T12:30:00+02:00"))["raw"] == "2026-07-15T12:30:00+02:00"
    assert normalize_cell(timedelta(days=1))["raw"] == 86_400


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
