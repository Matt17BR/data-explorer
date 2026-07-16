from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step

PORTABLE_INTEGER_MAX = 10**38 - 1
PORTABLE_INTEGER_MIN = -PORTABLE_INTEGER_MAX
NATIVE_UNSIGNED_MAX = 2**128 - 1


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Any:
    if request.param == "pandas":
        return PandasEngine()
    if request.param == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        return PolarsEngine()
    runtime = DuckDBEngine()
    request.addfinalizer(runtime.close)
    return runtime


@pytest.fixture(params=["polars", "duckdb"])
def unsigned_engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Any:
    if request.param == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        return PolarsEngine()
    runtime = DuckDBEngine()
    request.addfinalizer(runtime.close)
    return runtime


def integer_frame(engine: Any, values: Sequence[int | None], *, grouped: bool) -> Any:
    if isinstance(engine, PandasEngine):
        data = {"group": ["a"] * len(values), "value": pd.Series(values, dtype=object)}
        return pd.DataFrame(data) if grouped else pd.DataFrame({"value": pd.Series(values, dtype=object)})
    if isinstance(engine, PolarsEngine):
        data = {"group": ["a"] * len(values), "value": values} if grouped else {"value": values}
        schema = {"group": pl.String, "value": pl.Int128} if grouped else {"value": pl.Int128}
        return pl.DataFrame(data, schema=schema)
    literals = ["NULL::HUGEINT" if value is None else f"{value}::HUGEINT" for value in values]
    rows = ", ".join(f"('a', {literal})" if grouped else f"({literal})" for literal in literals)
    columns = '("group", value)' if grouped else "(value)"
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) AS source{columns}")


def unsigned_frame(engine: Any, values: Sequence[int | None], *, paired: bool = False) -> Any:
    if isinstance(engine, PolarsEngine):
        columns = {"left": pl.Series(values, dtype=pl.UInt128)}
        if paired:
            columns["right"] = pl.Series(values, dtype=pl.UInt128)
        return pl.DataFrame(columns)
    literals = ["NULL::UHUGEINT" if value is None else f"{value}::UHUGEINT" for value in values]
    rows = ", ".join(f"({literal}, {literal})" if paired else f"({literal})" for literal in literals)
    columns = '("left", "right")' if paired else '("left")'
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) AS source{columns}")


def bind_group_sum(engine: Any, frame: Any) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    return bind_step(
        validate_step(
            {
                "id": "portable-sum",
                "kind": "groupBy",
                "params": {
                    "keys": [lineage[0]],
                    "aggregations": [{"column": lineage[1], "operation": "sum", "alias": "total"}],
                },
            }
        ),
        schema,
        lineage,
    )


def bind_by_example(engine: Any, frame: Any, *, multiplier: bool = False, decrement: bool = False) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    examples = (
        [{"inputs": [2], "output": 6}, {"inputs": [3], "output": 9}]
        if multiplier
        else (
            [{"inputs": [1], "output": 0}, {"inputs": [2], "output": 1}]
            if decrement
            else [
                {"inputs": [1], "output": 2},
                {"inputs": [2], "output": 3},
            ]
        )
    )
    operation = bind_step(
        validate_step(
            {
                "id": "portable-arithmetic",
                "kind": "byExample",
                "params": {
                    "sourceColumns": lineage,
                    "newColumn": "result",
                    "examples": examples,
                },
            }
        ),
        schema,
        lineage,
    )
    if multiplier:
        # Division by one-third is an equally valid synthesized program for
        # these examples, so pin the private bound program to exercise the
        # adapter's checked integer-multiplication path directly.
        operation["params"]["program"] = {
            "kind": "arithmetic",
            "left": {"kind": "column", "column": {**lineage[0], "position": 0}},
            "operator": "multiply",
            "right": {"kind": "literal", "value": 3},
            "_owLeftType": "integer",
            "_owRightType": "integer",
            "_owResultType": "integer",
        }
    return operation


def bind_binary_by_example(engine: Any, frame: Any, operator: str) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "portable-binary-arithmetic",
                "kind": "byExample",
                "params": {
                    "sourceColumns": lineage,
                    "newColumn": "result",
                    "examples": [
                        {"inputs": [1, 1], "output": 0},
                        {"inputs": [2, 1], "output": 1},
                    ],
                },
            }
        ),
        schema,
        lineage,
    )
    operation["params"]["program"] = {
        "kind": "arithmetic",
        "left": {"kind": "column", "column": {**lineage[0], "position": 0}},
        "operator": operator,
        "right": {"kind": "column", "column": {**lineage[1], "position": 1}},
        "_owLeftType": "integer",
        "_owRightType": "integer",
        "_owResultType": "integer",
    }
    return operation


def generated(engine: Any, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(compile(engine.compile_plan([operation]), "<portable-integer-plan>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


def column_values(frame: Any, column: str) -> list[int]:
    if isinstance(frame, pd.DataFrame):
        return [int(value) for value in frame[column].tolist()]
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return frame.get_column(column).to_list()
    return [row[0] for row in frame.project(f'"{column}"').fetchall()]


def assert_integer_output(engine: Any, frame: Any, column: str, expected: int) -> None:
    assert column_values(frame, column) == [expected]
    selected = next(item for item in engine.schema(frame) if item["name"] == column)
    assert selected["type"] == "integer"


def assert_overflow(action: Callable[[], Any]) -> None:
    with pytest.raises(Exception, match="portable 38-digit envelope"):
        result = action()
        column_values(result, "total" if "total" in [str(item) for item in result.columns] else "result")


@pytest.mark.parametrize(
    ("success_values", "overflow_values", "expected"),
    [
        ([PORTABLE_INTEGER_MAX - 1, 1], [PORTABLE_INTEGER_MAX, 1], PORTABLE_INTEGER_MAX),
        ([PORTABLE_INTEGER_MIN + 1, -1], [PORTABLE_INTEGER_MIN, -1], PORTABLE_INTEGER_MIN),
    ],
)
def test_integer_group_sum_enforces_shared_envelope_live_and_generated(
    engine: Any,
    success_values: list[int],
    overflow_values: list[int],
    expected: int,
) -> None:
    source = integer_frame(engine, success_values, grouped=True)
    operation = bind_group_sum(engine, source)

    assert_integer_output(engine, engine.apply_transform(source, operation), "total", expected)
    assert_integer_output(engine, generated(engine, source, operation), "total", expected)

    overflow = integer_frame(engine, overflow_values, grouped=True)
    assert_overflow(lambda: engine.apply_transform(overflow, operation))
    assert_overflow(lambda: generated(engine, overflow, operation))


@pytest.mark.parametrize(
    "values",
    [
        [PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MAX, -PORTABLE_INTEGER_MAX],
        [PORTABLE_INTEGER_MAX, -PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MAX],
        [PORTABLE_INTEGER_MAX + 1, -1],
    ],
)
def test_integer_group_sum_checks_the_final_exact_result_independent_of_input_order(
    engine: Any,
    values: list[int],
) -> None:
    source = integer_frame(engine, values, grouped=True)
    operation = bind_group_sum(engine, source)

    assert_integer_output(
        engine,
        engine.apply_transform(source, operation),
        "total",
        PORTABLE_INTEGER_MAX,
    )
    assert_integer_output(engine, generated(engine, source, operation), "total", PORTABLE_INTEGER_MAX)


@pytest.mark.parametrize(
    ("source_value", "overflow_value", "expected", "decrement"),
    [
        (PORTABLE_INTEGER_MAX - 1, PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MAX, False),
        (PORTABLE_INTEGER_MIN + 1, PORTABLE_INTEGER_MIN, PORTABLE_INTEGER_MIN, True),
    ],
)
def test_by_example_addition_enforces_shared_envelope_live_and_generated(
    engine: Any,
    source_value: int,
    overflow_value: int,
    expected: int,
    decrement: bool,
) -> None:
    source = integer_frame(engine, [source_value], grouped=False)
    operation = bind_by_example(engine, source, decrement=decrement)

    assert_integer_output(engine, engine.apply_transform(source, operation), "result", expected)
    assert_integer_output(engine, generated(engine, source, operation), "result", expected)

    overflow = integer_frame(engine, [overflow_value], grouped=False)
    assert_overflow(lambda: engine.apply_transform(overflow, operation))
    assert_overflow(lambda: generated(engine, overflow, operation))


@pytest.mark.parametrize(
    ("source_value", "decrement", "expected"),
    [
        (PORTABLE_INTEGER_MAX + 1, True, PORTABLE_INTEGER_MAX),
        (PORTABLE_INTEGER_MIN - 1, False, PORTABLE_INTEGER_MIN),
    ],
)
def test_by_example_accepts_a_native_wide_operand_when_the_exact_result_is_portable(
    engine: Any,
    source_value: int,
    decrement: bool,
    expected: int,
) -> None:
    source = integer_frame(engine, [source_value], grouped=False)
    operation = bind_by_example(engine, source, decrement=decrement)

    assert_integer_output(
        engine,
        engine.apply_transform(source, operation),
        "result",
        expected,
    )
    assert_integer_output(engine, generated(engine, source, operation), "result", expected)


def test_by_example_can_multiply_a_native_wide_operand_by_zero(engine: Any) -> None:
    source = integer_frame(engine, [PORTABLE_INTEGER_MAX + 1], grouped=False)
    operation = bind_by_example(engine, source, multiplier=True)
    operation["params"]["program"]["right"]["value"] = 0

    assert_integer_output(engine, engine.apply_transform(source, operation), "result", 0)
    assert_integer_output(engine, generated(engine, source, operation), "result", 0)


def test_checked_by_example_integer_arithmetic_preserves_nulls(engine: Any) -> None:
    source = integer_frame(engine, [None, 1], grouped=False)
    operation = bind_by_example(engine, source)

    for result in (engine.apply_transform(source, operation), generated(engine, source, operation)):
        if isinstance(result, pd.DataFrame):
            values = result["result"].tolist()
        elif isinstance(result, pl.LazyFrame):
            values = result.collect().get_column("result").to_list()
        elif isinstance(result, pl.DataFrame):
            values = result.get_column("result").to_list()
        else:
            values = [row[0] for row in result.project('"result"').fetchall()]
        assert pd.isna(values[0])
        assert values[1] == 2


def test_by_example_multiplication_enforces_shared_envelope_live_and_generated(engine: Any) -> None:
    source_value = PORTABLE_INTEGER_MAX // 3
    source = integer_frame(engine, [source_value], grouped=False)
    operation = bind_by_example(engine, source, multiplier=True)

    assert_integer_output(engine, engine.apply_transform(source, operation), "result", PORTABLE_INTEGER_MAX)
    assert_integer_output(engine, generated(engine, source, operation), "result", PORTABLE_INTEGER_MAX)

    overflow = integer_frame(engine, [source_value + 1], grouped=False)
    assert_overflow(lambda: engine.apply_transform(overflow, operation))
    assert_overflow(lambda: generated(engine, overflow, operation))


def test_native_unsigned_max_subtraction_cancels_live_and_generated(unsigned_engine: Any) -> None:
    source = unsigned_frame(unsigned_engine, [NATIVE_UNSIGNED_MAX, None], paired=True)
    operation = bind_binary_by_example(unsigned_engine, source, "subtract")

    for result in (
        unsigned_engine.apply_transform(source, operation),
        generated(unsigned_engine, source, operation),
    ):
        assert column_values(result, "result") == [0, None]


def test_native_unsigned_max_multiply_zero_preserves_nulls_live_and_generated(unsigned_engine: Any) -> None:
    source = unsigned_frame(unsigned_engine, [NATIVE_UNSIGNED_MAX, None])
    operation = bind_by_example(unsigned_engine, source, multiplier=True)
    operation["params"]["program"]["right"]["value"] = 0

    for result in (
        unsigned_engine.apply_transform(source, operation),
        generated(unsigned_engine, source, operation),
    ):
        assert column_values(result, "result") == [0, None]


def test_native_unsigned_max_nonzero_product_overflows_live_and_generated(unsigned_engine: Any) -> None:
    source = unsigned_frame(unsigned_engine, [NATIVE_UNSIGNED_MAX])
    operation = bind_by_example(unsigned_engine, source, multiplier=True)
    operation["params"]["program"]["right"]["value"] = 1

    assert_overflow(lambda: unsigned_engine.apply_transform(source, operation))
    assert_overflow(lambda: generated(unsigned_engine, source, operation))


def test_polars_group_sum_rejects_a_native_int128_wrap_to_zero() -> None:
    engine = PolarsEngine()
    source = pl.DataFrame(
        {
            "group": ["a", "a", "a"],
            "value": pl.Series([2**127 - 1, 2**127 - 1, 2], dtype=pl.Int128),
        }
    )
    operation = bind_group_sum(engine, source)

    assert source.select(pl.col("value").sum()).item() == 0
    assert_overflow(lambda: engine.apply_transform(source, operation))
    assert_overflow(lambda: generated(engine, source, operation))


def test_polars_group_sum_checks_uint128_without_narrowing() -> None:
    engine = PolarsEngine()
    source = pl.DataFrame(
        {
            "group": ["a", "a"],
            "value": pl.Series([NATIVE_UNSIGNED_MAX, None], dtype=pl.UInt128),
        }
    )
    operation = bind_group_sum(engine, source)

    assert_overflow(lambda: engine.apply_transform(source, operation))
    assert_overflow(lambda: generated(engine, source, operation))


def test_polars_lazy_overflow_is_a_normal_actionable_error() -> None:
    engine = PolarsEngine()
    source = integer_frame(engine, [PORTABLE_INTEGER_MAX, 1], grouped=True).lazy()
    operation = bind_group_sum(engine, source)
    transformed = engine.apply_transform(source, operation)

    with pytest.raises(Exception, match="portable 38-digit envelope"):
        transformed.collect()

    compiled = generated(engine, source, operation)
    with pytest.raises(Exception, match="portable 38-digit envelope"):
        compiled.collect()
