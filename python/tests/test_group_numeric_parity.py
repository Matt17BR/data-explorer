from __future__ import annotations

from decimal import Decimal
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step

_WIDE_INTEGER = 2**63


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Any:
    if request.param == "pandas":
        return PandasEngine()
    if request.param == "polars":

        def reject_to_pandas(*_args: Any, **_kwargs: Any) -> None:
            raise AssertionError("Polars group operations must stay native")

        for frame_type in (pl.DataFrame, pl.LazyFrame, pl.Series):
            monkeypatch.setattr(frame_type, "to_pandas", reject_to_pandas, raising=False)
        return PolarsEngine()
    runtime = DuckDBEngine()
    request.addfinalizer(runtime.close)
    return runtime


def _wide_integer_frame(engine: Any) -> Any:
    groups = [_WIDE_INTEGER, _WIDE_INTEGER, None, None]
    values = [_WIDE_INTEGER + 1, _WIDE_INTEGER + 2, None, None]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(
            {
                "group": pd.Series(groups, dtype=object),
                "value": pd.Series(values, dtype=object),
            }
        )
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(
            {
                "group": pl.Series(groups, dtype=pl.Int128),
                "value": pl.Series(values, dtype=pl.Int128),
            }
        )
    return duckdb.sql(
        "SELECT * FROM (VALUES "
        "(CAST(9223372036854775808 AS HUGEINT), CAST(9223372036854775809 AS HUGEINT)), "
        "(CAST(9223372036854775808 AS HUGEINT), CAST(9223372036854775810 AS HUGEINT)), "
        "(NULL::HUGEINT, NULL::HUGEINT), "
        '(NULL::HUGEINT, NULL::HUGEINT)) AS source("group", value)'
    )


def _decimal_frame(engine: Any) -> Any:
    values = [Decimal("1.10"), Decimal("2.20"), None, None]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(
            {
                "group": ["a", "a", "b", "b"],
                "value": pd.Series(values, dtype=object),
            }
        )
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(
            {
                "group": ["a", "a", "b", "b"],
                "value": pl.Series(values, dtype=pl.Decimal(10, 2)),
            }
        )
    return duckdb.sql(
        "SELECT * FROM (VALUES "
        "('a', CAST(1.10 AS DECIMAL(10, 2))), "
        "('a', CAST(2.20 AS DECIMAL(10, 2))), "
        "('b', NULL::DECIMAL(10, 2)), "
        "('b', NULL::DECIMAL(10, 2))) AS source(\"group\", value)"
    )


def _group_operation(engine: Any, frame: Any, operations: tuple[str, ...]) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public_step = validate_step(
        {
            "id": "numeric-group-parity",
            "kind": "groupBy",
            "params": {
                "keys": [lineage[0]],
                "aggregations": [
                    {
                        "column": lineage[1],
                        "operation": operation,
                        "alias": operation,
                    }
                    for operation in operations
                ],
            },
        }
    )
    return bind_step(public_step, schema, lineage)


def _execute_generated(engine: Any, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    code = compile(engine.compile_plan([operation]), "<group-numeric-parity>", "exec")
    exec(code, namespace, namespace)
    return namespace["clean_data"](frame)


def _typed_rows(engine: Any, frame: Any) -> list[dict[str, dict[str, Any]]]:
    schema = engine.schema(frame)
    page = engine.page(
        frame,
        0,
        10,
        column_projection=[(column["position"], column["id"]) for column in schema],
    )
    return [{column["name"]: cell for column, cell in zip(schema, row["values"], strict=True)} for row in page["rows"]]


def test_nullable_wide_integer_group_keys_and_extrema_stay_exact_live_and_generated(engine: Any) -> None:
    frame = _wide_integer_frame(engine)
    operation = _group_operation(engine, frame, ("min", "max", "first", "last"))

    live = _typed_rows(engine, engine.apply_transform(frame, operation))
    generated = _typed_rows(engine, _execute_generated(engine, frame, operation))

    assert live == generated
    wide_group = next(row for row in live if row["group"]["kind"] == "integer")
    null_group = next(row for row in live if row["group"]["kind"] == "null")
    assert wide_group["group"]["display"] == str(_WIDE_INTEGER)
    assert wide_group["group"]["raw"] == str(_WIDE_INTEGER)
    expected = {
        "min": _WIDE_INTEGER + 1,
        "max": _WIDE_INTEGER + 2,
        "first": _WIDE_INTEGER + 1,
        "last": _WIDE_INTEGER + 2,
    }
    for operation_name, value in expected.items():
        assert wide_group[operation_name]["kind"] == "integer"
        assert wide_group[operation_name]["display"] == str(value)
        assert wide_group[operation_name]["raw"] == str(value)
        assert null_group[operation_name]["kind"] == "null"


def test_decimal_group_mean_and_median_are_portable_floats_with_typed_nulls(engine: Any) -> None:
    frame = _decimal_frame(engine)
    operation = _group_operation(engine, frame, ("mean", "median"))

    live = _typed_rows(engine, engine.apply_transform(frame, operation))
    generated = _typed_rows(engine, _execute_generated(engine, frame, operation))

    assert live == generated
    populated_group = next(row for row in live if row["group"]["display"] == "a")
    null_group = next(row for row in live if row["group"]["display"] == "b")
    for operation_name in ("mean", "median"):
        assert populated_group[operation_name]["kind"] == "number"
        assert populated_group[operation_name]["raw"] == pytest.approx(1.65)
        assert null_group[operation_name]["kind"] == "null"


def test_decimal_group_sum_preserves_exact_value_and_declared_scale(engine: Any) -> None:
    frame = _decimal_frame(engine)
    operation = _group_operation(engine, frame, ("sum",))

    live = _typed_rows(engine, engine.apply_transform(frame, operation))
    generated = _typed_rows(engine, _execute_generated(engine, frame, operation))

    assert live == generated
    populated_group = next(row for row in live if row["group"]["display"] == "a")
    null_group = next(row for row in live if row["group"]["display"] == "b")
    assert populated_group["sum"]["kind"] == "decimal"
    assert populated_group["sum"]["raw"] == "3.30"
    assert null_group["sum"]["kind"] == "decimal"
    assert null_group["sum"]["raw"] == "0.00"
