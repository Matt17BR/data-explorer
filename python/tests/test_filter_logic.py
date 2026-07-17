from __future__ import annotations

import json
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import (
    EngineError,
    coerce_typed_view_value,
    generated_view_value_helper_lines,
    typed_selection_value,
)
from openwrangler_runtime.session import SessionManager

_VIEW_LITERAL_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "view-literal-contract.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["accepted"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_portable_view_literal_contract_accepts_live_and_generated_values(case):
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)

    coerce_typed_view_value(case["value"], case["type"])
    namespace["_open_wrangler_view_value"](case["value"], case["type"])


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["rejected"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_portable_view_literal_contract_rejects_live_and_generated_values(case):
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)

    with pytest.raises(EngineError):
        coerce_typed_view_value(case["value"], case["type"])
    with pytest.raises((TypeError, ValueError, ArithmeticError)):
        namespace["_open_wrangler_view_value"](case["value"], case["type"])


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_advanced_filter_logic_matches_between_columns_and_within_a_column(tmp_path, backend):
    path = tmp_path / "logic.csv"
    path.write_text("city,value\nBerlin,2\nMilan,7\nParis,12\nRome,20\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)

    model = {
        "logic": "or",
        "filters": [
            {
                "column": "city",
                "type": "string",
                "logic": "or",
                "predicates": [
                    {"kind": "predicate", "operator": "startsWith", "value": "Ber"},
                    {"kind": "predicate", "operator": "endsWith", "value": "lan"},
                ],
            },
            {
                "column": "value",
                "type": "integer",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": 15}],
            },
        ],
        "sort": [{"column": "value", "direction": "asc", "nulls": "last"}],
    }

    response = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, model)
    assert [row["values"][0]["display"] for row in response["page"]["rows"]] == ["Berlin", "Milan", "Rome"]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_empty_value_selection_does_not_hide_every_row(tmp_path, backend):
    path = tmp_path / "empty-selection.csv"
    path.write_text("name\nalpha\nbeta\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "name",
                "type": "string",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    response = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, model)
    assert response["page"]["totalRows"] == 2


def _missing_frame(backend: str) -> Any:
    values = [None, float("nan"), 1.0]
    labels = ["null", "nan", "value"]
    if backend == "pandas":
        return pd.DataFrame(
            {
                "label": labels,
                "value": pd.Series(values, dtype="object"),
            }
        )
    if backend == "duckdb":
        return duckdb.sql(
            "SELECT * FROM (VALUES ('null', NULL::DOUBLE), ('nan', 'NaN'::DOUBLE), "
            "('value', 1.0::DOUBLE)) AS values(label, value)"
        )
    return pl.DataFrame({"label": labels, "value": values})


def _filtered_labels(frame: Any, backend: str) -> list[str]:
    if backend == "pandas":
        return frame["label"].tolist()
    if backend == "duckdb":
        return [str(row[0]) for row in frame.project('"label"').fetchall()]
    return frame.get_column("label").to_list()


def _engine(backend: str) -> Any:
    return {"pandas": PandasEngine, "polars": PolarsEngine, "duckdb": DuckDBEngine}[backend]()


def _execute_generated_filter(engine: Any, frame: Any, model: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    bound_model = deepcopy(model)
    positions = {str(name): position for position, name in enumerate(frame.columns)}
    for column_filter in bound_model["filters"]:
        name = str(column_filter["column"])
        column_filter["column"] = {
            "id": f"c:source:{positions[name]}",
            "name": name,
            "position": positions[name],
        }
    for rule in bound_model["sort"]:
        name = str(rule["column"])
        rule["column"] = {
            "id": f"c:source:{positions[name]}",
            "name": name,
            "position": positions[name],
        }
    step = {"id": "filter", "kind": "filterRows", "params": {"filterModel": bound_model}}
    exec(engine.compile_plan([step]), namespace, namespace)
    return namespace["clean_data"](frame)


def _value_selection_model(column_type: str, value: Any) -> dict[str, Any]:
    return {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": column_type,
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [value],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }


def _empty_duckdb_contract_frame(column_type: str) -> Any:
    raw_type = {
        "string": "VARCHAR",
        "integer": "HUGEINT",
        "float": "DOUBLE",
        "decimal": "DECIMAL(38, 6)",
        "boolean": "BOOLEAN",
        "date": "DATE",
        "datetime": "TIMESTAMPTZ",
        "duration": "INTERVAL",
    }[column_type]
    return duckdb.sql(f"SELECT NULL::{raw_type} AS value WHERE FALSE")


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["accepted"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_duckdb_live_and_generated_filters_accept_shared_literal_contract(case):
    engine = DuckDBEngine()
    frame = _empty_duckdb_contract_frame(case["type"])
    model = _value_selection_model(case["type"], case["value"])

    assert engine.apply_filter_model(frame, model).fetchall() == []
    assert _execute_generated_filter(engine, frame, model).fetchall() == []


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["rejected"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_duckdb_live_and_generated_filters_reject_shared_literal_contract(case):
    engine = DuckDBEngine()
    frame = _empty_duckdb_contract_frame(case["type"])
    model = _value_selection_model(case["type"], case["value"])

    with pytest.raises(EngineError, match=f"Invalid {case['type']} view-filter value"):
        engine.apply_filter_model(frame, model)
    with pytest.raises((TypeError, ValueError, ArithmeticError)):
        _execute_generated_filter(engine, frame, model)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(
    ("operator", "expected"),
    [
        ("isNull", ["null"]),
        ("isNotNull", ["nan", "value"]),
        ("isNaN", ["nan"]),
        ("isNotNaN", ["null", "value"]),
    ],
)
def test_live_and_generated_missing_predicates_distinguish_null_from_nan(backend, operator, expected):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": operator}],
            }
        ],
        "sort": [],
    }

    live = engine.apply_filter_model(frame, model)
    generated = _execute_generated_filter(engine, frame, model)

    assert _filtered_labels(live, backend) == expected
    assert _filtered_labels(generated, backend) == expected


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(
    ("include_nulls", "include_nan", "expected"),
    [
        (True, False, ["null"]),
        (False, True, ["nan"]),
        (True, True, ["null", "nan"]),
    ],
)
def test_live_and_generated_value_filters_keep_null_and_nan_independent(
    backend,
    include_nulls,
    include_nan,
    expected,
):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [],
                    "includeNulls": include_nulls,
                    "includeNaN": include_nan,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    live = engine.apply_filter_model(frame, model)
    generated = _execute_generated_filter(engine, frame, model)

    assert _filtered_labels(live, backend) == expected
    assert _filtered_labels(generated, backend) == expected


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("operator", ["notEquals", "gt"])
def test_ordinary_predicates_exclude_both_null_and_nan(backend, operator):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": operator, "value": 0}],
            }
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["value"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["value"]


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_type_incompatible_predicates_fail_closed_live_and_generated(backend):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "contains", "value": "1"}],
            }
        ],
        "sort": [],
    }

    with pytest.raises(EngineError, match="predicate 'contains' is unavailable"):
        engine.apply_filter_model(frame, model)
    with pytest.raises(EngineError, match="predicate 'contains' is unavailable"):
        _execute_generated_filter(engine, frame, model)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_nan_text_selection_requires_the_explicit_nan_option(backend):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["NaN"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    with pytest.raises(EngineError, match="explicit includeNaN"):
        engine.apply_filter_model(frame, model)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("search", "expected"), [("MIL", ["Milan"]), ("[", ["[bracket"])])
def test_column_value_search_is_case_insensitive_and_literal(backend, search, expected):
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame({"city": ["Milan", "[bracket", None]})
    elif backend == "polars":
        frame = pl.DataFrame({"city": ["Milan", "[bracket", None]})
    else:
        frame = duckdb.sql("SELECT * FROM (VALUES ('Milan'), ('[bracket'), (NULL)) AS values(city)")

    values, has_more = engine.column_values(frame, "city", search=search)

    assert [item["value"] for item in values] == expected
    assert has_more is False


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("search", "expected"), [("i", ["i"]), ("s", ["S"]), ("İ", ["İ"])])
def test_column_value_search_uses_portable_ascii_case_folding(backend, search, expected):
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame({"value": ["İ", "i", "ſ", "S"]})
    elif backend == "polars":
        frame = pl.DataFrame({"value": ["İ", "i", "ſ", "S"]})
    else:
        frame = duckdb.sql("SELECT * FROM (VALUES ('İ'), ('i'), ('ſ'), ('S')) AS values(value)")

    values, has_more = engine.column_values(frame, "value", search=search)

    assert [item["value"] for item in values] == expected
    assert has_more is False


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("needle", "expected"), [("i", ["ascii-i"]), ("s", ["ascii-s"])])
def test_live_and_generated_contains_use_portable_ascii_case_folding(backend, needle, expected):
    engine = _engine(backend)
    records = {"label": ["dotted-i", "ascii-i", "long-s", "ascii-s"], "value": ["İ", "I", "ſ", "S"]}
    if backend == "pandas":
        frame = pd.DataFrame(records)
    elif backend == "polars":
        frame = pl.DataFrame(records)
    else:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES ('dotted-i', 'İ'), ('ascii-i', 'I'), "
            "('long-s', 'ſ'), ('ascii-s', 'S')) AS values(label, value)"
        )
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "string",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "contains", "value": needle}],
            }
        ],
        "sort": [],
    }

    live = engine.apply_filter_model(frame, model)
    generated = _execute_generated_filter(engine, frame, model)

    assert _filtered_labels(live, backend) == expected
    assert _filtered_labels(generated, backend) == expected


def test_mixed_pandas_object_value_selection_preserves_pandas_equality_groups():
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "label": ["integer", "float", "boolean", "decimal", "string"],
            "value": pd.Series([1, 1.0, True, Decimal("1"), "1"], dtype="object"),
        }
    )
    values, has_more = engine.column_values(frame, "value")

    assert has_more is False
    assert [(item["value"], item["count"], item["selectionValue"]["cell"]["kind"]) for item in values] == [
        ("1", 4, "integer"),
        ("1", 1, "string"),
    ]

    for selection, expected in [
        (values[0]["selectionValue"], ["integer", "float", "boolean", "decimal"]),
        (values[1]["selectionValue"], ["string"]),
        ("1", ["string"]),
    ]:
        model = _value_selection_model("string", selection)
        assert _filtered_labels(engine.apply_filter_model(frame, model), "pandas") == expected
        assert _filtered_labels(_execute_generated_filter(engine, frame, model), "pandas") == expected


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_column_value_selection_tokens_round_trip_live_and_generated(backend):
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame({"label": ["match", "other"], "value": [7, 9]})
    elif backend == "polars":
        frame = pl.DataFrame({"label": ["match", "other"], "value": [7, 9]})
    else:
        frame = duckdb.sql("SELECT * FROM (VALUES ('match', 7), ('other', 9)) AS values(label, value)")

    values, has_more = engine.column_values(frame, "value")
    selected = next(item["selectionValue"] for item in values if item["value"] == "7")
    model = _value_selection_model("integer", selected)

    assert has_more is False
    assert selected == typed_selection_value(7, "integer")
    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match"]


def test_typed_selection_tokens_fail_closed_live_and_generated():
    token = typed_selection_value(7, "integer")
    assert token is not None
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)
    invalid = [
        {**token, "columnType": "string"},
        {**token, "unexpected": True},
        {**token, "cell": {**token["cell"], "isNull": True}},
        {**token, "cell": {**token["cell"], "kind": "string"}},
    ]

    for value in invalid:
        with pytest.raises(EngineError):
            coerce_typed_view_value(value, "integer")
        with pytest.raises((TypeError, ValueError, ArithmeticError)):
            namespace["_open_wrangler_view_value"](value, "integer")


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_live_and_generated_value_selection_uses_exact_decimal_identity(backend):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    records = {"label": ["first", "equivalent", "other"], "value": [Decimal("1.0"), Decimal("1.00"), Decimal("2")]}
    frame = pd.DataFrame(records) if backend == "pandas" else pl.DataFrame(records)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "decimal",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["1.0"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["first", "equivalent"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["first", "equivalent"]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_live_and_generated_predicates_preserve_wide_integers_and_boolean_text(backend):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    wide = 9_007_199_254_740_993
    records = {"label": ["match", "other"], "value": [wide, wide + 1], "flag": [True, False]}
    if backend == "pandas":
        frame = pd.DataFrame(records)
    else:
        frame = pl.DataFrame(records, schema_overrides={"value": pl.Int128})
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "integer",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": str(wide)}],
            },
            {
                "column": "flag",
                "type": "boolean",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": " TrUe "}],
            },
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match"]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_live_and_generated_datetime_selection_matches_equivalent_instants(backend):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    instants = [
        datetime(2024, 1, 1, 10, 0, tzinfo=timezone.utc),
        datetime(2024, 1, 1, 11, 0, tzinfo=timezone.utc),
    ]
    records = {"label": ["match", "other"], "value": instants}
    frame = pd.DataFrame(records) if backend == "pandas" else pl.DataFrame(records)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "datetime",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["2024-01-01T12:00:00+02:00"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match"]


def test_duckdb_live_and_generated_datetime_selection_preserves_offset_instants():
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('match', TIMESTAMPTZ '2024-01-01 10:00:00+00:00'), "
        "('other', TIMESTAMPTZ '2024-01-01 11:00:00+00:00')) AS values(label, value)"
    )
    model = _value_selection_model("datetime", "2024-01-01T12:00:00+02:00")

    assert _filtered_labels(engine.apply_filter_model(frame, model), "duckdb") == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), "duckdb") == ["match"]


def test_duckdb_live_and_generated_duration_selection_retains_distant_microseconds():
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('match', INTERVAL '8640000000.000001 seconds'), "
        "('other', INTERVAL '8640000000.000002 seconds')) AS values(label, value)"
    )
    model = _value_selection_model("duration", "8640000000.000001")

    assert _filtered_labels(engine.apply_filter_model(frame, model), "duckdb") == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), "duckdb") == ["match"]
