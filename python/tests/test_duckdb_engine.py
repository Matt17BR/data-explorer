from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from math import isnan
from pathlib import Path
from typing import Any

import duckdb
import pytest

import openwrangler_runtime.engines.duckdb_engine as duckdb_runtime
from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines.base import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.registry import EngineRegistry
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import operation_catalog, validate_step
from openwrangler_runtime.session import SessionManager


def step(kind: str, **params: Any) -> dict[str, Any]:
    return validate_step({"id": f"duckdb-{kind}", "kind": kind, "params": params})


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def bound_step(kind: str, **params: Any) -> dict[str, Any]:
    return {"id": f"duckdb-{kind}", "kind": kind, "params": params}


def source_relation() -> Any:
    return duckdb.sql(
        """
        SELECT * FROM (VALUES
            ('a', ' alpha-one ', 'red|blue', CAST(1.2 AS DOUBLE), 2, '2024-01-02'),
            ('a', 'BETA-two', 'blue', CAST(2.8 AS DOUBLE), 3, '2024-02-03'),
            ('b', NULL, NULL, CAST(NULL AS DOUBLE), 4, '2024-03-04'),
            ('b', 'alpha-one', 'red', CAST(2.8 AS DOUBLE), 3, '2024-02-03')
        ) AS source("group", "text", "tags", "value", "other", "date")
        """
    )


def records(frame: Any) -> list[dict[str, Any]]:
    return [dict(zip(frame.columns, row, strict=True)) for row in frame.fetchall()]


def assert_same_relation(left: Any, right: Any) -> None:
    assert list(left.columns) == list(right.columns)
    left_rows = left.fetchall()
    right_rows = right.fetchall()
    assert len(left_rows) == len(right_rows)
    for left_row, right_row in zip(left_rows, right_rows, strict=True):
        assert len(left_row) == len(right_row)
        for left_value, right_value in zip(left_row, right_row, strict=True):
            if isinstance(left_value, float) and isnan(left_value):
                assert isinstance(right_value, float) and isnan(right_value)
            else:
                assert left_value == right_value


def execute_generated(engine: DuckDBEngine, frame: Any, plan: list[dict[str, Any]]) -> Any:
    code = engine.compile_plan(plan)
    assert "openwrangler_runtime" not in code
    namespace: dict[str, Any] = {}
    exec(compile(code, "<generated-duckdb-plan>", "exec"), namespace, namespace)
    result = namespace["clean_data"](frame)
    assert isinstance(result, duckdb.DuckDBPyRelation)
    return result


@pytest.mark.parametrize(
    "operation",
    [
        step("oneHotEncode", columns=[{"id": "c:source:0", "name": "group"}]),
        step("upperText", column={"id": "c:source:1", "name": "text"}),
        step("roundNumber", column={"id": "c:source:3", "name": "value"}),
        step("formatDatetime", column={"id": "c:source:5", "name": "date"}, format="%Y"),
    ],
)
def test_duckdb_value_adapters_reject_unbound_public_references(operation: dict[str, Any]) -> None:
    engine = DuckDBEngine()
    try:
        with pytest.raises(EngineError, match="requires a bound column reference"):
            engine.apply_transform(source_relation(), operation)
        with pytest.raises(EngineError, match="requires a bound column reference"):
            engine.compile_plan([operation])
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ("\\", ["\\a\\b\\", "\\", None, "\\é\\🙂\\"]),
        (r"\1", [r"\1a\1b\1", r"\1", None, r"\1é\1🙂\1"]),
        ("$1", ["$1a$1b$1", "$1", None, "$1é$1🙂$1"]),
    ],
)
def test_duckdb_empty_literal_find_replaces_boundaries_and_matches_generated_code(
    replacement: str, expected: list[str | None]
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES ('ab'), (''), (NULL), ('é🙂')) AS source(text)")
    operation = bound_step(
        "findReplace",
        column=bound_ref("c:source:0", "text", 0),
        find="",
        replacement=replacement,
        regex=False,
        newColumn="expanded",
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert [row["expanded"] for row in records(transformed)] == expected
        assert_same_relation(transformed, generated)
        assert "array_to_string" in engine.compile_plan([operation])
    finally:
        engine.close()


def install_conversion_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    def reject_conversion(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("DuckDB operations must never convert to Pandas, Polars, or Arrow")

    for method in ("df", "to_df", "fetchdf", "pl", "arrow"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, reject_conversion)


def test_duckdb_rejects_case_fold_ambiguous_source_columns() -> None:
    engine = DuckDBEngine()
    ambiguous = duckdb.sql('SELECT 1 AS "A", 2 AS "a"')

    with pytest.raises(EngineError, match="differ only by case"):
        engine.validate_column_addressability(ambiguous)


def test_duckdb_page_uses_an_explicit_terminal_projection(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = DuckDBEngine()
    frame = engine.ensure_row_ids(source_relation(), "projected-page")
    queries: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def capture_query(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        queries.append(query)
        return native_execute_rows(connection, source_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_query)

    page = engine.page(
        frame,
        0,
        2,
        total_rows=4,
        column_projection=[(1, "stable:text"), (4, "stable:other")],
    )

    assert len(queries) == 1
    assert queries[0].startswith("SELECT ")
    assert "SELECT *" not in queries[0].upper()
    assert '"text"' in queries[0] and '"other"' in queries[0]
    assert '"group"' not in queries[0] and '"value"' not in queries[0]
    assert page["columnIds"] == ["stable:text", "stable:other"]
    assert [cell["display"] for cell in page["rows"][0]["values"]] == [" alpha-one ", "2"]


def test_duckdb_file_readers_are_lazy_hardened_and_export_natively(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    csv_path.write_text('city;value\n"Milan";1\n"Berlin";2\n', encoding="utf-8")
    tsv_path = tmp_path / "sample.tsv"
    tsv_path.write_text("city\tvalue\nMilan\t1\nBerlin\t2\n", encoding="utf-8")
    jsonl_path = tmp_path / "sample.jsonl"
    jsonl_path.write_text('{"city":"Milan","value":1}\n{"city":"Berlin","value":2}\n', encoding="utf-8")
    parquet_path = tmp_path / "sample.parquet"
    duckdb.sql("SELECT * FROM (VALUES ('Milan', 1), ('Berlin', 2)) AS data(city, value)").write_parquet(
        str(parquet_path)
    )

    engine = DuckDBEngine()
    settings = (
        engine._owned_connection()
        .sql(
            "SELECT current_setting('autoinstall_known_extensions'), "
            "current_setting('autoload_known_extensions'), current_setting('preserve_insertion_order')"
        )
        .fetchone()
    )
    assert settings == (False, False, True)

    csv_frame = engine.read_file(
        str(csv_path),
        {"delimiter": ";", "encoding": "utf-8", "quoteChar": '"', "hasHeader": True},
    )
    assert isinstance(csv_frame, duckdb.DuckDBPyRelation)
    assert "read_csv" in csv_frame.sql_query().lower()
    assert engine.shape(csv_frame) == {"rows": 2, "columns": 2}
    assert engine.read_file(str(tsv_path)).fetchall() == [("Milan", 1), ("Berlin", 2)]
    assert engine.read_file(str(jsonl_path)).fetchall() == [("Milan", 1), ("Berlin", 2)]
    assert engine.read_file(str(parquet_path)).fetchall() == [("Milan", 1), ("Berlin", 2)]

    with pytest.raises(EngineError, match="does not support Excel"):
        engine.read_file(str(tmp_path / "unsupported.xlsx"))
    with pytest.raises(EngineError, match="supports UTF-8"):
        engine.read_file(str(csv_path), {"encoding": "latin-1"})

    identified = engine.ensure_row_ids(csv_frame, "export")
    csv_export = tmp_path / "cleaned.csv"
    parquet_export = tmp_path / "cleaned.parquet"
    engine.export_data(identified, str(csv_export), "csv")
    engine.export_data(identified, str(parquet_export), "parquet")
    assert duckdb.read_csv(str(csv_export)).columns == ["city", "value"]
    assert duckdb.read_parquet(str(parquet_export)).fetchall() == [("Milan", 1), ("Berlin", 2)]

    engine.close()
    engine.close()
    with pytest.raises(EngineError, match="closed"):
        engine.read_file(str(csv_path))


def test_duckdb_view_queries_are_typed_exact_and_concurrency_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (0, 'alpha', CAST(1.0 AS DOUBLE), 9007199254740993::HUGEINT, [1, 2], {'x': 1}),
            (1, 'alpha', CAST(1.0 AS DOUBLE), 2::HUGEINT, [1, 2], {'x': 1}),
            (2, 'beta', CAST(NULL AS DOUBLE), 3::HUGEINT, [3], {'x': 2}),
            (3, 'nan', CAST('NaN' AS DOUBLE), 4::HUGEINT, NULL, NULL)
        ) AS source(id, label, value, huge, items, record)
        """
    )
    frame = engine.ensure_row_ids(frame, "typed")

    assert [item["type"] for item in engine.schema(frame)] == [
        "integer",
        "string",
        "float",
        "integer",
        "list",
        "struct",
    ]
    first_page = engine.page(frame, 0, 4)
    second_page = engine.page(frame, 0, 4)
    assert first_page == second_page
    assert first_page["rows"][0]["values"][3] == {
        "kind": "integer",
        "raw": "9007199254740993",
        "display": "9007199254740993",
        "isNull": False,
        "isNaN": False,
    }
    assert first_page["rows"][3]["values"][2]["kind"] == "nan"

    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "or",
                "predicates": [
                    {"operator": "isNull"},
                    {"operator": "isNaN"},
                    {"operator": "gte", "value": 1},
                ],
            }
        ],
        "sort": [{"column": "label", "direction": "desc", "nulls": "last"}],
    }
    assert [row["label"] for row in records(engine.apply_filter_model(frame, model))] == [
        "nan",
        "beta",
        "alpha",
        "alpha",
    ]

    summary = engine.summaries(frame, ["value", "items"])
    assert summary[0]["nullCount"] == 1
    assert summary[0]["nanCount"] == 1
    assert summary[0]["distinctCount"] == 1
    assert summary[0]["topValues"] == [{"value": "1.0", "count": 2}]
    assert summary[0]["numeric"]["mean"] == 1.0
    assert summary[1]["topValues"][0] == {"value": "[1,2]", "count": 2}
    stats = engine.header_stats(frame)
    assert stats["missingCells"] == 4
    assert stats["missingRows"] == 2
    assert stats["duplicateRows"] == 0
    values, has_more = engine.column_values(frame, "value")
    assert values == [{"value": "1.0", "count": 2}]
    assert has_more is False

    def read_page() -> list[str]:
        return [row["id"] for row in engine.page(frame, 0, 4)["rows"]]

    def read_summary() -> int:
        return engine.summaries(frame, ["label"])[0]["distinctCount"]

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(read_page if index % 2 == 0 else read_summary) for index in range(24)]
        results = [future.result(timeout=10) for future in futures]
    assert all(result == first_page_ids(first_page) for result in results[::2])
    assert results[1::2] == [3] * 12
    engine.close()


def test_duckdb_non_float_include_nan_value_filter_is_an_explicit_false_condition() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES (1), (2)) AS source(value)")
    operation = bound_step(
        "filterRows",
        filterModel={
            "filters": [
                {
                    "column": bound_ref("c:source:0", "value", 0),
                    "type": "integer",
                    "valueFilter": {
                        "kind": "values",
                        "selectedValues": [],
                        "includeNulls": False,
                        "includeNaN": True,
                    },
                    "predicates": [],
                }
            ],
            "sort": [],
        },
    )

    transformed = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])

    assert transformed.fetchall() == []
    assert_same_relation(transformed, generated)


def first_page_ids(page: dict[str, Any]) -> list[str]:
    return [row["id"] for row in page["rows"]]


def test_duckdb_all_operations_and_generated_code_stay_native(monkeypatch: pytest.MonkeyPatch) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    source = source_relation()
    row_plan = [
        bound_step(
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:3", "value", 3),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        ),
        bound_step(
            "filterRows",
            filterModel={
                "logic": "and",
                "filters": [
                    {
                        "column": bound_ref("c:source:1", "text", 1),
                        "type": "string",
                        "logic": "and",
                        "predicates": [{"operator": "contains", "value": "alpha"}],
                    }
                ],
                "sort": [],
            },
        ),
        bound_step(
            "dropMissingRows",
            columns=[bound_ref("c:source:3", "value", 3)],
            how="any",
        ),
        bound_step(
            "dropDuplicates",
            columns=[
                bound_ref("c:source:3", "value", 3),
                bound_ref("c:source:4", "other", 4),
            ],
            keep="first",
        ),
    ]
    column_plan = [
        bound_step(
            "cloneColumn",
            column=bound_ref("c:source:3", "value", 3),
            newName="value_copy",
        ),
        bound_step(
            "formula",
            leftColumn=bound_ref("c:source:4", "other", 4),
            operator="multiply",
            value=10,
            newColumn="score",
        ),
        bound_step(
            "textLength",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="text_length",
        ),
        bound_step(
            "castColumn",
            column=bound_ref("c:source:4", "other", 4),
            dtype="float",
        ),
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:0", "group", 0),
            newName="category",
        ),
        bound_step(
            "dropColumns",
            columns=[
                bound_ref("c:source:2", "tags", 2),
                bound_ref("c:source:5", "date", 5),
            ],
        ),
        bound_step(
            "selectColumns",
            columns=[
                bound_ref("c:source:0", "category", 0),
                bound_ref("c:source:1", "text", 1),
                bound_ref("c:source:3", "value", 2),
                bound_ref("c:source:4", "other", 3),
                bound_ref("c:step:duckdb-cloneColumn:0", "value_copy", 4),
                bound_ref("c:step:duckdb-formula:0", "score", 5),
                bound_ref("c:step:duckdb-textLength:0", "text_length", 6),
            ],
        ),
    ]
    text_numeric_plan = [
        bound_step("stripText", column=bound_ref("c:source:1", "text", 1), newColumn="clean"),
        bound_step(
            "findReplace",
            column=bound_ref("c:source:1", "text", 1),
            find="-",
            replacement=" ",
            newColumn="replaced",
        ),
        bound_step(
            "splitText",
            column=bound_ref("c:source:1", "text", 1),
            delimiter="-",
            index=1,
            newColumn="suffix",
        ),
        bound_step("lowerText", column=bound_ref("c:source:1", "text", 1), newColumn="lower"),
        bound_step("upperText", column=bound_ref("c:source:1", "text", 1), newColumn="upper"),
        bound_step("capitalizeText", column=bound_ref("c:source:1", "text", 1), newColumn="capitalized"),
        bound_step(
            "oneHotEncode",
            columns=[bound_ref("c:source:0", "group", 0)],
            prefixSeparator="_",
            dropOriginal=False,
        ),
        bound_step(
            "multiLabelBinarize",
            column=bound_ref("c:source:2", "tags", 2),
            delimiter="|",
            prefix="tag_",
            dropOriginal=False,
        ),
        bound_step("minMaxScale", column=bound_ref("c:source:3", "value", 3), newColumn="scaled"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:3", "value", 3),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step("floorNumber", column=bound_ref("c:source:3", "value", 3), newColumn="floored"),
        bound_step("ceilNumber", column=bound_ref("c:source:3", "value", 3), newColumn="ceiled"),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:5", "date", 5),
            format="%Y/%m",
            newColumn="month",
        ),
    ]
    source_schema = engine.schema(source)
    source_columns = source_lineage(source_schema)
    group_plan = [
        bind_step(
            step(
                "groupBy",
                keys=[{"id": "c:source:0", "name": "group"}],
                aggregations=[
                    {"column": {"id": "c:source:3", "name": "value"}, "operation": "sum", "alias": "total"},
                    {"column": {"id": "c:source:4", "name": "other"}, "operation": "mean", "alias": "average"},
                    {"column": {"id": "c:source:1", "name": "text"}, "operation": "count", "alias": "texts"},
                    {"column": {"id": "c:source:2", "name": "tags"}, "operation": "nUnique", "alias": "tag_sets"},
                ],
            ),
            source_schema,
            source_columns,
        )
    ]
    example_plan = [
        bind_step(
            step(
                "byExample",
                sourceColumns=[
                    {"id": "c:source:0", "name": "group"},
                    {"id": "c:source:4", "name": "other"},
                ],
                newColumn="label",
                examples=[
                    {"inputs": ["a", 2], "output": "a-2"},
                    {"inputs": ["b", 4], "output": "b-4"},
                ],
            ),
            source_schema,
            source_columns,
        )
    ]
    custom_plan = [step("customCode", code='result = df.filter("other > 2")')]

    plans = [row_plan, column_plan, text_numeric_plan, group_plan, example_plan, custom_plan]
    covered = {operation["kind"] for plan in plans for operation in plan}
    assert covered == {item["kind"] for item in operation_catalog()}
    for plan in plans:
        live = source
        for operation in plan:
            live = engine.apply_transform(live, operation)
        generated = execute_generated(engine, source, plan)
        assert_same_relation(live, generated)

    transformed = source
    for operation in text_numeric_plan:
        transformed = engine.apply_transform(transformed, operation)
    output = records(transformed)
    assert output[0]["clean"] == "alpha-one"
    assert output[1]["suffix"] == "two"
    assert output[0]["group_a"] == 1
    assert output[2]["group_b"] == 1
    assert output[0]["tag_blue"] == 1
    assert output[1]["tag_red"] == 0
    assert output[0]["scaled"] == 0.0
    assert output[1]["scaled"] == 1.0
    assert output[0]["month"] == "2024/01"

    grouped = engine.apply_transform(source, group_plan[0])
    assert records(grouped)[0] == {"group": "a", "total": 4.0, "average": 2.5, "texts": 2, "tag_sets": 2}
    engine.close()


def test_duckdb_grouping_treats_nan_as_missing_for_keys_and_aggregates() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (NULL::DOUBLE, NULL::DOUBLE),
            ('NaN'::DOUBLE, 'NaN'::DOUBLE),
            (1.0, 2.0),
            (NULL::DOUBLE, NULL::DOUBLE),
            ('NaN'::DOUBLE, 'NaN'::DOUBLE),
            (1.0, 3.0)
        ) AS source("key", "value")
        """
    )
    value = bound_ref("c:source:1", "value", 1)
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "key", 0)],
        aggregations=[
            {"column": value, "operation": "sum", "alias": "total"},
            {"column": value, "operation": "mean", "alias": "average"},
            {"column": value, "operation": "min", "alias": "minimum"},
            {"column": value, "operation": "max", "alias": "maximum"},
            {"column": value, "operation": "median", "alias": "middle"},
            {"column": value, "operation": "count", "alias": "count"},
            {"column": value, "operation": "nUnique", "alias": "unique"},
            {"column": value, "operation": "first", "alias": "first"},
            {"column": value, "operation": "last", "alias": "last"},
        ],
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert records(transformed) == [
            {
                "key": None,
                "total": 0.0,
                "average": None,
                "minimum": None,
                "maximum": None,
                "middle": None,
                "count": 0,
                "unique": 0,
                "first": None,
                "last": None,
            },
            {
                "key": 1.0,
                "total": 5.0,
                "average": 2.5,
                "minimum": 2.0,
                "maximum": 3.0,
                "middle": 2.5,
                "count": 2,
                "unique": 2,
                "first": 2.0,
                "last": 3.0,
            },
        ]
        assert_same_relation(transformed, generated)
    finally:
        engine.close()


def test_duckdb_decimal_median_is_a_portable_float_and_matches_generated_code() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('a', 1.10::DECIMAL(10, 2)), "
        "('a', 2.20::DECIMAL(10, 2)), "
        "('b', NULL::DECIMAL(10, 2))) AS source(\"group\", value)"
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {
                "column": bound_ref("c:source:1", "value", 1),
                "operation": "median",
                "alias": "middle",
            }
        ],
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert records(transformed) == [
            {"group": "a", "middle": pytest.approx(1.65)},
            {"group": "b", "middle": None},
        ]
        assert str(transformed.types[1]) == "DOUBLE"
        assert_same_relation(transformed, generated)
    finally:
        engine.close()


def test_duckdb_column_values_break_equal_counts_by_display_text() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES ('Milan'), ('Berlin'), ('Milan'), ('Berlin'), ('Paris')) AS source(city)")

    try:
        values, has_more = engine.column_values(frame, "city")
        assert values == [
            {"value": "Berlin", "count": 2},
            {"value": "Milan", "count": 2},
            {"value": "Paris", "count": 1},
        ]
        assert has_more is False
    finally:
        engine.close()


def test_duckdb_missing_modes_encoders_collisions_and_custom_failures() -> None:
    engine = DuckDBEngine()
    missing = duckdb.sql(
        "SELECT * FROM (VALUES (1.0, NULL), (NULL, 2.0), (NULL, NULL), "
        "(CAST('NaN' AS DOUBLE), 3.0), (4.0, 4.0)) AS source(left_value, right_value)"
    )
    missing_columns = [
        bound_ref("c:source:0", "left_value", 0),
        bound_ref("c:source:1", "right_value", 1),
    ]
    drop_any = bound_step("dropMissingRows", columns=missing_columns, how="any")
    drop_all = bound_step("dropMissingRows", columns=missing_columns, how="all")
    assert len(engine.apply_transform(missing, drop_any).fetchall()) == 1
    assert len(engine.apply_transform(missing, drop_all).fetchall()) == 4
    assert_same_relation(engine.apply_transform(missing, drop_any), execute_generated(engine, missing, [drop_any]))
    drop_all_columns = bound_step("dropMissingRows", columns=[], how="any")
    assert len(engine.apply_transform(missing, drop_all_columns).fetchall()) == 1
    assert_same_relation(
        engine.apply_transform(missing, drop_all_columns),
        execute_generated(engine, missing, [drop_all_columns]),
    )

    duplicate = duckdb.sql(
        "SELECT * FROM (VALUES ('a', 1.0), ('a', 1.0), ('b', NULL), ('b', NULL), ('c', 3.0)) AS source(key, value)"
    )
    duplicate_columns = [
        bound_ref("c:source:0", "key", 0),
        bound_ref("c:source:1", "value", 1),
    ]
    keep_last = bound_step("dropDuplicates", columns=duplicate_columns, keep="last")
    keep_none = bound_step("dropDuplicates", columns=duplicate_columns, keep="none")
    assert [row[0] for row in engine.apply_transform(duplicate, keep_last).fetchall()] == ["a", "b", "c"]
    assert [row[0] for row in engine.apply_transform(duplicate, keep_none).fetchall()] == ["c"]
    keep_all = bound_step("dropDuplicates", keep="first")
    assert [row[0] for row in engine.apply_transform(duplicate, keep_all).fetchall()] == ["a", "b", "c"]
    assert_same_relation(
        engine.apply_transform(duplicate, keep_all),
        execute_generated(engine, duplicate, [keep_all]),
    )

    collision = duckdb.sql("SELECT 'a' AS group_name, 7 AS group_name_a")
    operation = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "group_name", 0)],
        prefixSeparator="_",
        dropOriginal=False,
    )
    with pytest.raises(EngineError, match="duplicate column names: group_name_a"):
        engine.apply_transform(collision, operation)
    with pytest.raises(ValueError, match="duplicate column names: group_name_a"):
        execute_generated(engine, collision, [operation])

    private_output = duckdb.sql("SELECT 'open_wrangler_internal_row_id_forged' AS tags, 1 AS keep")
    private_operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="__",
        dropOriginal=False,
    )
    with pytest.raises(EngineError, match="reserved private row-identity column"):
        engine.apply_transform(private_output, private_operation)
    with pytest.raises(ValueError, match="reserved private row-identity column"):
        execute_generated(engine, private_output, [private_operation])

    scalar_categories = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (CAST(1.0 AS DOUBLE), TRUE, DATE '2024-01-02'),
            (CAST('NaN' AS DOUBLE), FALSE, DATE '2024-01-03'),
            (CAST(NULL AS DOUBLE), NULL, NULL)
        ) AS source(value, flag, day)
        """
    )
    scalar_operation = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:0", "value", 0),
            bound_ref("c:source:1", "flag", 1),
            bound_ref("c:source:2", "day", 2),
        ],
        dropOriginal=False,
    )
    scalar_result = engine.apply_transform(scalar_categories, scalar_operation)
    assert scalar_result.columns == [
        "value",
        "flag",
        "day",
        "day_2024-01-02",
        "day_2024-01-03",
        "flag_False",
        "flag_True",
        "value_1.0",
    ]
    assert_same_relation(scalar_result, execute_generated(engine, scalar_categories, [scalar_operation]))

    padded = "\t\n\r\v\f\u00a0\u2003X\t\n\r\v\f\u00a0\u2003"
    whitespace = duckdb.sql(f"SELECT '{padded}' AS text")
    strip_operation = bound_step(
        "stripText",
        column=bound_ref("c:source:0", "text", 0),
        newColumn="clean",
    )
    stripped = engine.apply_transform(whitespace, strip_operation)
    assert records(stripped)[0]["clean"] == "X"
    assert_same_relation(stripped, execute_generated(engine, whitespace, [strip_operation]))

    with pytest.raises(EngineError, match="Custom DuckDB code failed: boom"):
        engine.apply_transform(source_relation(), step("customCode", code="raise ValueError('boom')"))
    with pytest.raises(EngineError, match="must assign a DuckDBPyRelation"):
        engine.apply_transform(source_relation(), step("customCode", code="result = 42"))
    engine.close()


def test_duckdb_file_session_preview_apply_profile_export_and_close(tmp_path: Path) -> None:
    source = tmp_path / "session.csv"
    source.write_text("group,value\na,1\na,2\nb,3\n", encoding="utf-8")
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    assert opened["metadata"]["backend"] == "duckdb"
    assert opened["metadata"]["shape"] == {"rows": 3, "columns": 2}
    assert isinstance(manager.sessions[session_id].original, duckdb.DuckDBPyRelation)
    assert "read_csv" in manager.sessions[session_id].original.sql_query().lower()

    operation = step(
        "formula",
        leftColumn={"id": "c:source:1", "name": "value"},
        operator="multiply",
        value=10,
        newColumn="score",
    )
    preview = manager.preview_step(session_id, 0, operation, 0, 10)
    assert preview["revision"] == 1
    assert preview["diff"]["addedColumns"] == ["score"]
    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["revision"] == 2
    assert "import duckdb" in applied["code"]
    summary = manager.get_summary(
        session_id,
        2,
        {"logic": "and", "filters": [], "sort": []},
        ["score"],
    )["summaries"][0]
    assert summary["numeric"] == {
        "min": 10.0,
        "max": 30.0,
        "mean": 20.0,
        "median": 20.0,
        "std": 10.0,
    }

    destination = tmp_path / "cleaned.parquet"
    exported = manager.export_data(session_id, 2, str(destination), "parquet")
    assert exported["shape"] == {"rows": 3, "columns": 3}
    assert duckdb.read_parquet(str(destination)).fetchall() == [("a", 1, 10), ("a", 2, 20), ("b", 3, 30)]
    assert manager.close_session(session_id, 2) == {"kind": "sessionClosed", "sessionId": session_id}
    assert manager.sessions == {}
    manager.close_all()
