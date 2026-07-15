from __future__ import annotations

from math import isnan
from typing import Any

import pandas as pd
import polars as pl
import pytest

from data_wrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from data_wrangler_runtime.operations import OperationError, validate_step


@pytest.fixture(params=["pandas", "polars"])
def engine(request, monkeypatch):
    if request.param == "pandas":
        return PandasEngine()
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    return PolarsEngine()


def step(kind: str, **params: Any) -> dict[str, Any]:
    return validate_step({"id": f"edge-{kind}", "kind": kind, "params": params})


def frame_for(engine: PandasEngine | PolarsEngine, data: dict[str, list[Any]]) -> Any:
    return pd.DataFrame(data) if isinstance(engine, PandasEngine) else pl.DataFrame(data)


def records(frame: Any) -> list[dict[str, Any]]:
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    return frame.to_dicts() if isinstance(frame, pl.DataFrame) else frame.to_dict(orient="records")


def execute_generated(engine: PandasEngine | PolarsEngine, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace, namespace)
    return namespace["clean_data"](frame)


def normalized(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and isnan(value):
        return None
    return value


def assert_records_equal(left: Any, right: Any) -> None:
    left_rows = records(left)
    right_rows = records(right)
    assert [list(row) for row in left_rows] == [list(row) for row in right_rows]
    assert [{key: normalized(value) for key, value in row.items()} for row in left_rows] == [
        {key: normalized(value) for key, value in row.items()} for row in right_rows
    ]


def test_multi_sort_honors_per_column_null_order_and_stable_ties(engine) -> None:
    frame = frame_for(
        engine,
        {
            "id": [0, 1, 2, 3, 4, 5],
            "primary": [1, None, 1, 1, None, 1],
            "secondary": [2, 1, None, 2, None, 1],
        },
    )
    operation = step(
        "sortRows",
        rules=[
            {"column": "primary", "direction": "asc", "nulls": "last"},
            {"column": "secondary", "direction": "desc", "nulls": "first"},
        ],
    )

    transformed = engine.apply_transform(frame, operation)
    assert [row["id"] for row in records(transformed)] == [2, 0, 3, 5, 4, 1]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))

    filter_operation = step("filterRows", filterModel={"filters": [], "sort": operation["params"]["rules"]})
    filtered = engine.apply_transform(frame, filter_operation)
    assert [row["id"] for row in records(filtered)] == [2, 0, 3, 5, 4, 1]
    assert_records_equal(filtered, execute_generated(engine, frame, filter_operation))


def test_min_max_scale_preserves_null_and_nan_for_constant_columns(engine) -> None:
    frame = frame_for(engine, {"value": [5.0, None, 5.0, float("nan")]})
    operation = step("minMaxScale", column="value", newColumn="scaled")

    transformed = engine.apply_transform(frame, operation)
    assert [normalized(row["scaled"]) for row in records(transformed)] == [0.0, None, 0.0, None]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_numeric_operations_handle_non_finite_values_deterministically(engine) -> None:
    frame = frame_for(
        engine,
        {"value": [1.2, 3.2, None, float("nan"), float("inf"), float("-inf")]},
    )
    operations = [
        step("minMaxScale", column="value", newColumn="scaled"),
        step("roundNumber", column="value", decimals=0, newColumn="rounded"),
        step("floorNumber", column="value", newColumn="floored"),
        step("ceilNumber", column="value", newColumn="ceiled"),
    ]
    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)

    result = records(transformed)
    assert [normalized(row["scaled"]) for row in result] == [0.0, 1.0, None, None, None, None]
    assert [normalized(row["floored"]) for row in result] == [1.0, 3.0, None, None, float("inf"), float("-inf")]
    assert [normalized(row["ceiled"]) for row in result] == [2.0, 4.0, None, None, float("inf"), float("-inf")]

    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(operations), namespace, namespace)
    assert_records_equal(transformed, namespace["clean_data"](frame))


def test_missing_and_duplicate_row_modes_match_generated_code(engine) -> None:
    missing_frame = frame_for(
        engine,
        {
            "left": [1.0, None, None, float("nan"), 4.0],
            "right": [None, 2.0, None, 3.0, 4.0],
        },
    )
    drop_any = step("dropMissingRows", columns=["left", "right"], how="any")
    drop_all = step("dropMissingRows", columns=["left", "right"], how="all")
    any_result = engine.apply_transform(missing_frame, drop_any)
    all_result = engine.apply_transform(missing_frame, drop_all)

    assert len(records(any_result)) == 1
    assert len(records(all_result)) == 4
    assert_records_equal(any_result, execute_generated(engine, missing_frame, drop_any))
    assert_records_equal(all_result, execute_generated(engine, missing_frame, drop_all))

    duplicate_frame = frame_for(
        engine,
        {"key": ["a", "a", "b", "b", "c"], "value": [1.0, 1.0, None, None, 3.0]},
    )
    keep_last = step("dropDuplicates", columns=["key", "value"], keep="last")
    keep_none = step("dropDuplicates", columns=["key", "value"], keep="none")
    last_result = engine.apply_transform(duplicate_frame, keep_last)
    none_result = engine.apply_transform(duplicate_frame, keep_none)

    assert [row["key"] for row in records(last_result)] == ["a", "b", "c"]
    assert [row["key"] for row in records(none_result)] == ["c"]
    assert_records_equal(last_result, execute_generated(engine, duplicate_frame, keep_last))
    assert_records_equal(none_result, execute_generated(engine, duplicate_frame, keep_none))


def test_categorical_encoders_ignore_missing_labels_and_match_generated_code(engine) -> None:
    if isinstance(engine, PandasEngine):
        one_hot_frame = pd.DataFrame(
            {
                "group": pd.Categorical(["a", None, "β"], categories=["a", "β", "unused"]),
                "value": [1, 2, 3],
            }
        )
    else:
        one_hot_frame = pl.DataFrame({"group": ["a", None, "β"], "value": [1, 2, 3]}).with_columns(
            pl.col("group").cast(pl.Categorical)
        )
    one_hot = step("oneHotEncode", columns=["group"], prefixSeparator="_", dropOriginal=False)
    one_hot_result = engine.apply_transform(one_hot_frame, one_hot)
    one_hot_rows = records(one_hot_result)

    assert list(one_hot_rows[0]) == ["group", "value", "group_a", "group_β"]
    assert [row["group_a"] for row in one_hot_rows] == [1, 0, 0]
    assert [row["group_β"] for row in one_hot_rows] == [0, 0, 1]
    assert_records_equal(one_hot_result, execute_generated(engine, one_hot_frame, one_hot))

    labels_frame = frame_for(engine, {"tags": [None, "", "red|β"], "value": [1, 2, 3]})
    labels = step(
        "multiLabelBinarize",
        column="tags",
        delimiter="|",
        prefix="tag_",
        dropOriginal=False,
    )
    labels_result = engine.apply_transform(labels_frame, labels)
    label_rows = records(labels_result)

    assert list(label_rows[0]) == ["tags", "value", "tag_red", "tag_β"]
    assert [row["tag_red"] for row in label_rows] == [0, 0, 1]
    assert [row["tag_β"] for row in label_rows] == [0, 0, 1]
    assert_records_equal(labels_result, execute_generated(engine, labels_frame, labels))

    empty_labels_frame = frame_for(engine, {"tags": [None, ""], "value": [1, 2]})
    empty_result = engine.apply_transform(empty_labels_frame, labels)
    assert [list(row) for row in records(empty_result)] == [["tags", "value"], ["tags", "value"]]
    assert_records_equal(empty_result, execute_generated(engine, empty_labels_frame, labels))


@pytest.mark.parametrize(
    ("operation", "data", "message"),
    [
        (
            step("oneHotEncode", columns=["group"], prefixSeparator="_", dropOriginal=False),
            {"group": ["a"], "group_a": [7]},
            "One-hot encoding would create duplicate column names: group_a",
        ),
        (
            step("multiLabelBinarize", column="tags", delimiter="|", prefix="tag_", dropOriginal=False),
            {"tags": ["red"], "tag_red": [7]},
            "Multi-label binarization would create duplicate column names: tag_red",
        ),
    ],
)
def test_categorical_output_collisions_fail_before_creating_duplicate_columns(engine, operation, data, message) -> None:
    frame = frame_for(engine, data)

    with pytest.raises(EngineError, match=message):
        engine.apply_transform(frame, operation)
    with pytest.raises(ValueError, match=message):
        execute_generated(engine, frame, operation)


def test_grouping_is_ordered_and_nullable_aggregations_match(engine) -> None:
    frame = frame_for(
        engine,
        {
            "group": ["b", "b", "a", "a", None, None],
            "value": [None, 2, None, 1, None, None],
            "text": [None, "B", "A", None, "Z", None],
        },
    )
    operation = step(
        "groupBy",
        keys=["group"],
        aggregations=[
            {"column": "value", "operation": "nUnique", "alias": "unique_values"},
            {"column": "text", "operation": "first", "alias": "first_text"},
            {"column": "text", "operation": "last", "alias": "last_text"},
            {"column": "value", "operation": "count", "alias": "value_count"},
            {"column": "value", "operation": "sum", "alias": "value_sum"},
        ],
    )

    transformed = engine.apply_transform(frame, operation)
    result = records(transformed)
    assert [normalized(row["group"]) for row in result] == ["b", "a", None]
    assert [
        {
            "unique_values": row["unique_values"],
            "first_text": normalized(row["first_text"]),
            "last_text": normalized(row["last_text"]),
            "value_count": row["value_count"],
            "value_sum": row["value_sum"],
        }
        for row in result
    ] == [
        {"unique_values": 1, "first_text": "B", "last_text": "B", "value_count": 1, "value_sum": 2},
        {"unique_values": 1, "first_text": "A", "last_text": "A", "value_count": 1, "value_sum": 1},
        {"unique_values": 0, "first_text": "Z", "last_text": "Z", "value_count": 0, "value_sum": 0},
    ]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_group_aliases_are_unique_and_cannot_replace_keys() -> None:
    with pytest.raises(OperationError, match="aliases must be unique"):
        step(
            "groupBy",
            keys=["group"],
            aggregations=[
                {"column": "value", "operation": "sum", "alias": "result"},
                {"column": "value", "operation": "mean", "alias": "result"},
            ],
        )
    with pytest.raises(OperationError, match="cannot duplicate a group key"):
        step(
            "groupBy",
            keys=["group"],
            aggregations=[{"column": "value", "operation": "sum", "alias": "group"}],
        )


@pytest.mark.parametrize(
    ("kind", "params", "message"),
    [
        ("oneHotEncode", {"columns": ["group"], "dropOriginal": "yes"}, "dropOriginal must be a boolean"),
        (
            "multiLabelBinarize",
            {"column": "tags", "delimiter": "", "prefix": "tag_"},
            "delimiter must be a non-empty string",
        ),
        (
            "findReplace",
            {"column": "text", "find": 1, "replacement": "x"},
            "find and replacement must be strings",
        ),
        (
            "splitText",
            {"column": "text", "delimiter": "-", "index": True, "newColumn": "part"},
            "index must be a non-negative integer",
        ),
        ("roundNumber", {"column": "value", "decimals": True}, "decimals must be an integer"),
        ("formatDatetime", {"column": "date", "format": ""}, "format must be a non-empty string"),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": "value",
                            "predicates": [{"operator": "between", "value": 1}],
                        }
                    ],
                    "sort": [],
                }
            },
            "between requires a secondValue",
        ),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [{"column": "value", "predicates": [{"operator": "mystery"}]}],
                    "sort": [],
                }
            },
            "Unsupported filter operator",
        ),
    ],
)
def test_operation_parameters_are_rejected_before_engine_execution(kind, params, message) -> None:
    with pytest.raises(OperationError, match=message):
        step(kind, **params)


def test_unicode_text_operations_preserve_nulls_and_match_generated_code(engine) -> None:
    frame = frame_for(engine, {"text": ["straße", "İSTANBUL", "élAN", None]})
    operations = [
        step("upperText", column="text", newColumn="upper"),
        step("lowerText", column="text", newColumn="lower"),
        step("capitalizeText", column="text", newColumn="capitalized"),
    ]
    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)

    result = records(transformed)
    assert result[0]["upper"] == "STRASSE"
    assert result[1]["lower"] == "i̇stanbul"
    assert result[2]["capitalized"] == "Élan"
    assert normalized(result[3]["upper"]) is None

    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(operations), namespace, namespace)
    assert_records_equal(transformed, namespace["clean_data"](frame))


def test_custom_code_exceptions_are_structured_engine_errors(engine) -> None:
    frame = frame_for(engine, {"value": [1]})
    backend = "Pandas" if isinstance(engine, PandasEngine) else "Polars"

    with pytest.raises(EngineError, match=rf"Custom {backend} code failed: boom"):
        engine.apply_transform(frame, step("customCode", code="raise ValueError('boom')"))
    with pytest.raises(EngineError, match=rf"Custom {backend} code must assign"):
        engine.apply_transform(frame, step("customCode", code="result = 42"))
