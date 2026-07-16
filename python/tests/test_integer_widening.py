from __future__ import annotations

from math import isinf
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step


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


def frame_for(engine: Any, *, grouped: bool) -> Any:
    values = [2**63 - 1, 1] if grouped else [2**63 - 1, 2**63 - 2]
    if isinstance(engine, PandasEngine):
        data = {"group": ["a", "a"], "value": values}
        return pd.DataFrame(data) if grouped else pd.DataFrame({"value": values})
    if isinstance(engine, PolarsEngine):
        data = {"group": ["a", "a"], "value": values}
        return pl.DataFrame(data) if grouped else pl.DataFrame({"value": values})
    if grouped:
        return duckdb.sql(
            "SELECT * FROM (VALUES ('a', CAST(9223372036854775807 AS BIGINT)), "
            "('a', CAST(1 AS BIGINT))) AS source(\"group\", value)"
        )
    return duckdb.sql(
        "SELECT * FROM (VALUES (CAST(9223372036854775807 AS BIGINT)), "
        "(CAST(9223372036854775806 AS BIGINT))) AS source(value)"
    )


def column_values(frame: Any, column: str) -> list[Any]:
    if isinstance(frame, pd.DataFrame):
        return frame[column].tolist()
    if isinstance(frame, pl.DataFrame):
        return frame[column].to_list()
    return [row[0] for row in frame.project(f'"{column}"').fetchall()]


def generated(engine: Any, frame: Any, plan: list[dict[str, Any]]) -> Any:
    namespace: dict[str, Any] = {}
    exec(compile(engine.compile_plan(plan), "<integer-widening-plan>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


def assert_integer_surface(engine: Any, frame: Any, column: str) -> None:
    schema = engine.schema(frame)
    selected = next(item for item in schema if item["name"] == column)
    assert selected["type"] == "integer"
    assert engine.summaries(frame, [column])[0]["type"] == "integer"
    page = engine.page(frame, 0, 10, column_projection=[(selected["position"], selected["id"])])
    assert all(row["values"][0]["kind"] == "integer" for row in page["rows"])


def test_integer_group_sum_widens_before_overflow_in_live_and_generated_code(engine: Any) -> None:
    frame = frame_for(engine, grouped=True)
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "wide-sum",
            "kind": "groupBy",
            "params": {
                "keys": [lineage[0]],
                "aggregations": [
                    {"column": lineage[1], "operation": "sum", "alias": "total"},
                ],
            },
        }
    )
    operation = bind_step(public, schema, lineage)

    live = engine.apply_transform(frame, operation)
    compiled = generated(engine, frame, [operation])

    assert column_values(live, "total") == [2**63]
    assert column_values(compiled, "total") == [2**63]
    assert_integer_surface(engine, live, "total")
    assert_integer_surface(engine, compiled, "total")


def test_by_example_integer_arithmetic_widens_before_overflow_in_live_and_generated_code(engine: Any) -> None:
    frame = frame_for(engine, grouped=False)
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "wide-by-example",
            "kind": "byExample",
            "params": {
                "sourceColumns": [lineage[0]],
                "newColumn": "next_value",
                "examples": [
                    {"inputs": [1], "output": 2},
                    {"inputs": [2], "output": 3},
                ],
            },
        }
    )
    operation = bind_step(public, schema, lineage)
    assert operation["params"]["program"]["_owResultType"] == "integer"

    live = engine.apply_transform(frame, operation)
    compiled = generated(engine, frame, [operation])

    expected = [2**63, 2**63 - 1]
    assert column_values(live, "next_value") == expected
    assert column_values(compiled, "next_value") == expected
    assert_integer_surface(engine, live, "next_value")
    assert_integer_surface(engine, compiled, "next_value")


def division_frame_for(engine: Any) -> Any:
    data = {"left": [2, 4, 6, None], "right": [2, 2, 0, 2]}
    if isinstance(engine, PandasEngine):
        return pd.DataFrame({column: pd.Series(values, dtype="Int64") for column, values in data.items()})
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(data)
    return duckdb.sql(
        'SELECT * FROM (VALUES (2::BIGINT, 2::BIGINT), (4, 2), (6, 0), (NULL, 2)) AS source("left", "right")'
    )


def test_by_example_integer_division_by_an_unseen_zero_is_portable(engine: Any) -> None:
    frame = division_frame_for(engine)
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "divide-by-example",
            "kind": "byExample",
            "params": {
                "sourceColumns": lineage,
                "newColumn": "ratio",
                "examples": [
                    {"inputs": [2, 2], "output": 1.0},
                    {"inputs": [4, 2], "output": 2.0},
                ],
            },
        }
    )
    operation = bind_step(public, schema, lineage)
    assert operation["params"]["program"]["operator"] == "divide"
    assert operation["params"]["program"]["_owResultType"] == "float"

    live_frame = engine.apply_transform(frame, operation)
    compiled_frame = generated(engine, frame, [operation])
    live = column_values(live_frame, "ratio")
    compiled = column_values(compiled_frame, "ratio")

    assert live[:2] == pytest.approx([1.0, 2.0])
    assert compiled[:2] == pytest.approx([1.0, 2.0])
    assert isinf(live[2]) and live[2] > 0
    assert isinf(compiled[2]) and compiled[2] > 0
    assert live[3] is None or type(live[3]).__name__ == "NAType"
    assert compiled[3] is None or type(compiled[3]).__name__ == "NAType"
    for result in (live_frame, compiled_frame):
        ratio = next(column for column in engine.schema(result) if column["name"] == "ratio")
        page = engine.page(result, 0, 10, column_projection=[(ratio["position"], ratio["id"])])
        assert page["rows"][3]["values"][0]["kind"] == "null"


def test_pandas_wide_integer_remains_numeric_for_followup_grouping_and_parquet_export(tmp_path: Path) -> None:
    engine = PandasEngine()
    source = pd.DataFrame({"value": [-(2**63), -(2**63) + 1]})
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "decrement",
            "kind": "byExample",
            "params": {
                "sourceColumns": lineage,
                "newColumn": "previous",
                "examples": [
                    {"inputs": [1], "output": 0},
                    {"inputs": [2], "output": 1},
                ],
            },
        }
    )
    operation = bind_step(public, schema, lineage)
    transformed = engine.apply_transform(source, operation)
    transformed_generated = generated(engine, source, [operation])

    assert column_values(transformed, "previous") == [-(2**63) - 1, -(2**63)]
    assert column_values(transformed_generated, "previous") == [-(2**63) - 1, -(2**63)]
    assert_integer_surface(engine, transformed, "previous")
    assert_integer_surface(engine, transformed_generated, "previous")
    transformed_schema = engine.schema(transformed)
    transformed_lineage = source_lineage(transformed_schema)
    grouped = bind_step(
        validate_step(
            {
                "id": "sum-previous",
                "kind": "groupBy",
                "params": {
                    "keys": [transformed_lineage[0]],
                    "aggregations": [
                        {"column": transformed_lineage[1], "operation": "sum", "alias": "total"},
                    ],
                },
            }
        ),
        transformed_schema,
        transformed_lineage,
    )
    regrouped = engine.apply_transform(transformed, grouped)
    assert column_values(regrouped, "total") == [-(2**63) - 1, -(2**63)]
    assert_integer_surface(engine, regrouped, "total")

    with_divisor = pd.concat([transformed, pd.Series([1, 0], name="divisor")], axis=1)
    division_schema = engine.schema(with_divisor)
    division_lineage = source_lineage(division_schema)
    division = bind_step(
        validate_step(
            {
                "id": "divide-wide",
                "kind": "byExample",
                "params": {
                    "sourceColumns": [division_lineage[1], division_lineage[2]],
                    "newColumn": "ratio",
                    "examples": [
                        {"inputs": [2, 2], "output": 1.0},
                        {"inputs": [6, 3], "output": 2.0},
                    ],
                },
            }
        ),
        division_schema,
        division_lineage,
    )
    divided = engine.apply_transform(with_divisor, division)
    divided_generated = generated(engine, with_divisor, [division])
    assert column_values(divided, "ratio")[0] == pytest.approx(float(-(2**63) - 1))
    assert column_values(divided_generated, "ratio")[0] == pytest.approx(float(-(2**63) - 1))
    assert isinf(column_values(divided, "ratio")[1]) and column_values(divided, "ratio")[1] < 0
    assert isinf(column_values(divided_generated, "ratio")[1]) and column_values(divided_generated, "ratio")[1] < 0

    destination = tmp_path / "wide-integers.parquet"
    engine.export_data(transformed, str(destination), "parquet")
    exported = pd.read_parquet(destination)
    assert [int(value) for value in exported["previous"]] == [-(2**63) - 1, -(2**63)]
    assert engine.schema(exported)[1]["type"] == "decimal"
    assert source.to_dict(orient="list") == {"value": [-(2**63), -(2**63) + 1]}
