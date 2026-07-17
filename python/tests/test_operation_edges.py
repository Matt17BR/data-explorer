from __future__ import annotations

from datetime import date
from math import isnan
from typing import Any, cast

import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import typed_selection_value
from openwrangler_runtime.operations import OperationError, validate_step


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


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def public_ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def bound_step(kind: str, **params: Any) -> dict[str, Any]:
    return {"id": f"edge-{kind}", "kind": kind, "params": params}


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
    if value is None or type(value).__name__ in {"NAType", "NaTType"}:
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


def typed_records(engine: PandasEngine | PolarsEngine, frame: Any) -> list[dict[str, dict[str, Any]]]:
    schema = engine.schema(frame)
    page = engine.page(
        frame,
        0,
        engine.shape(frame)["rows"],
        column_projection=[(column["position"], column["id"]) for column in schema],
    )
    return [{column["name"]: cell for column, cell in zip(schema, row["values"], strict=True)} for row in page["rows"]]


def test_column_values_break_equal_counts_by_display_text(engine) -> None:
    frame = frame_for(engine, {"city": ["Milan", "Berlin", "Milan", "Berlin", "Paris"]})

    values, has_more = engine.column_values(frame, "city")

    assert values == [
        {"value": "Berlin", "count": 2, "selectionValue": typed_selection_value("Berlin", "string")},
        {"value": "Milan", "count": 2, "selectionValue": typed_selection_value("Milan", "string")},
        {"value": "Paris", "count": 1, "selectionValue": typed_selection_value("Paris", "string")},
    ]
    assert has_more is False


def test_multi_sort_honors_per_column_null_order_and_stable_ties(engine) -> None:
    frame = frame_for(
        engine,
        {
            "id": [0, 1, 2, 3, 4, 5],
            "primary": [1, None, 1, 1, None, 1],
            "secondary": [2, 1, None, 2, None, 1],
        },
    )
    operation = bound_step(
        "sortRows",
        rules=[
            {
                "column": bound_ref("c:source:1", "primary", 1),
                "direction": "asc",
                "nulls": "last",
            },
            {
                "column": bound_ref("c:source:2", "secondary", 2),
                "direction": "desc",
                "nulls": "first",
            },
        ],
    )

    transformed = engine.apply_transform(frame, operation)
    assert [row["id"] for row in records(transformed)] == [2, 0, 3, 5, 4, 1]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))

    filter_operation = bound_step(
        "filterRows",
        filterModel={"filters": [], "sort": operation["params"]["rules"]},
    )
    filtered = engine.apply_transform(frame, filter_operation)
    assert [row["id"] for row in records(filtered)] == [2, 0, 3, 5, 4, 1]
    assert_records_equal(filtered, execute_generated(engine, frame, filter_operation))


def test_non_float_include_nan_value_filter_is_an_explicit_false_condition(engine) -> None:
    frame = frame_for(engine, {"value": [1, 2]})
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
    generated = execute_generated(engine, frame, operation)

    assert records(transformed) == []
    assert_records_equal(transformed, generated)


def test_min_max_scale_preserves_null_and_nan_for_constant_columns(engine) -> None:
    frame = frame_for(engine, {"value": [5.0, None, 5.0, float("nan")]})
    operation = bound_step(
        "minMaxScale",
        column=bound_ref("c:source:0", "value", 0),
        newColumn="scaled",
    )

    transformed = engine.apply_transform(frame, operation)
    assert [normalized(row["scaled"]) for row in records(transformed)] == [0.0, None, 0.0, None]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_numeric_operations_handle_non_finite_values_deterministically(engine) -> None:
    frame = frame_for(
        engine,
        {"value": [1.2, 3.2, None, float("nan"), float("inf"), float("-inf")]},
    )
    operations = [
        bound_step("minMaxScale", column=bound_ref("c:source:0", "value", 0), newColumn="scaled"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:0", "value", 0),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step("floorNumber", column=bound_ref("c:source:0", "value", 0), newColumn="floored"),
        bound_step("ceilNumber", column=bound_ref("c:source:0", "value", 0), newColumn="ceiled"),
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
    missing_columns = [
        bound_ref("c:source:0", "left", 0),
        bound_ref("c:source:1", "right", 1),
    ]
    drop_any = bound_step("dropMissingRows", columns=missing_columns, how="any")
    drop_all = bound_step("dropMissingRows", columns=missing_columns, how="all")
    any_result = engine.apply_transform(missing_frame, drop_any)
    all_result = engine.apply_transform(missing_frame, drop_all)

    assert len(records(any_result)) == 1
    assert len(records(all_result)) == 4
    assert_records_equal(any_result, execute_generated(engine, missing_frame, drop_any))
    assert_records_equal(all_result, execute_generated(engine, missing_frame, drop_all))
    all_columns = bound_step("dropMissingRows", columns=[], how="any")
    all_columns_result = engine.apply_transform(missing_frame, all_columns)
    assert len(records(all_columns_result)) == 1
    assert_records_equal(all_columns_result, execute_generated(engine, missing_frame, all_columns))

    duplicate_frame = frame_for(
        engine,
        {"key": ["a", "a", "b", "b", "c"], "value": [1.0, 1.0, None, None, 3.0]},
    )
    duplicate_columns = [
        bound_ref("c:source:0", "key", 0),
        bound_ref("c:source:1", "value", 1),
    ]
    keep_last = bound_step("dropDuplicates", columns=duplicate_columns, keep="last")
    keep_none = bound_step("dropDuplicates", columns=duplicate_columns, keep="none")
    last_result = engine.apply_transform(duplicate_frame, keep_last)
    none_result = engine.apply_transform(duplicate_frame, keep_none)

    assert [row["key"] for row in records(last_result)] == ["a", "b", "c"]
    assert [row["key"] for row in records(none_result)] == ["c"]
    assert_records_equal(last_result, execute_generated(engine, duplicate_frame, keep_last))
    assert_records_equal(none_result, execute_generated(engine, duplicate_frame, keep_none))
    keep_all = bound_step("dropDuplicates", keep="first")
    keep_all_result = engine.apply_transform(duplicate_frame, keep_all)
    assert [row["key"] for row in records(keep_all_result)] == ["a", "b", "c"]
    assert_records_equal(keep_all_result, execute_generated(engine, duplicate_frame, keep_all))


def test_pandas_row_order_operations_target_duplicate_and_integer_labels_positionally() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            [1, 20.0, "x", "r0"],
            [1, 10.0, "x", "r1"],
            [2, None, "y", "r2"],
            [1, 10.0, "x", "r3"],
        ],
        columns=cast(Any, ["duplicate", "duplicate", 7, "label"]),
    )
    plan = [
        bound_step(
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:1", "duplicate", 1),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        ),
        bound_step(
            "filterRows",
            filterModel={
                "filters": [
                    {
                        "column": bound_ref("c:source:0", "duplicate", 0),
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "equals", "value": 1}],
                    }
                ],
                "sort": [
                    {
                        "column": bound_ref("c:source:2", "7", 2),
                        "direction": "asc",
                        "nulls": "last",
                    }
                ],
            },
        ),
        bound_step(
            "dropMissingRows",
            columns=[bound_ref("c:source:1", "duplicate", 1)],
            how="any",
        ),
        bound_step(
            "dropDuplicates",
            columns=[
                bound_ref("c:source:1", "duplicate", 1),
                bound_ref("c:source:2", "7", 2),
            ],
            keep="first",
        ),
    ]

    transformed = frame
    for operation in plan:
        transformed = engine.apply_transform(transformed, operation)
    code = engine.compile_plan(plan)
    namespace: dict[str, Any] = {}
    exec(code, namespace, namespace)
    generated = namespace["clean_data"](frame)

    pd.testing.assert_frame_equal(transformed, generated)
    assert transformed["label"].tolist() == ["r1", "r0"]
    assert list(transformed.columns) == ["duplicate", "duplicate", 7, "label"]
    assert code.count(".iloc") >= 4


def test_pandas_optional_all_column_row_operations_exclude_no_visible_data() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [[1, "a"], [1, "a"], [None, "b"]],
        columns=cast(Any, [7, "label"]),
    )
    missing = bound_step("dropMissingRows", columns=[], how="any")
    duplicates = bound_step("dropDuplicates", keep="first")

    transformed = engine.apply_transform(engine.apply_transform(frame, missing), duplicates)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([missing, duplicates]), namespace, namespace)
    generated = namespace["clean_data"](frame)

    pd.testing.assert_frame_equal(transformed, generated)
    assert transformed.to_dict(orient="records") == [{7: 1.0, "label": "a"}]


def test_polars_all_column_row_operations_are_safe_for_a_zero_column_frame() -> None:
    engine = PolarsEngine()
    source = pl.DataFrame()
    runtime = engine.ensure_row_ids(source, "zero-columns")
    plan = [
        bound_step("dropMissingRows", columns=[], how="any"),
        bound_step("dropDuplicates", keep="first"),
    ]

    transformed = runtime
    for operation in plan:
        transformed = engine.apply_transform(transformed, operation)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(plan), namespace, namespace)
    generated = namespace["clean_data"](source)

    assert engine.shape(transformed) == {"rows": 0, "columns": 0}
    assert generated.shape == (0, 0)


def test_categorical_encoders_ignore_missing_labels_and_match_generated_code(engine) -> None:
    if isinstance(engine, PandasEngine):
        one_hot_frame = pd.DataFrame(
            {
                "group": pd.Categorical(["a", None, "β", ""], categories=["a", "β", "", "unused"]),
                "value": [1, 2, 3, 4],
            }
        )
    else:
        one_hot_frame = pl.DataFrame({"group": ["a", None, "β", ""], "value": [1, 2, 3, 4]}).with_columns(
            pl.col("group").cast(pl.Categorical)
        )
    one_hot = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "group", 0)],
        prefixSeparator="_",
        dropOriginal=False,
    )
    one_hot_result = engine.apply_transform(one_hot_frame, one_hot)
    one_hot_rows = records(one_hot_result)

    assert list(one_hot_rows[0]) == ["group", "value", "group_a", "group_β"]
    assert [row["group_a"] for row in one_hot_rows] == [1, 0, 0, 0]
    assert [row["group_β"] for row in one_hot_rows] == [0, 0, 1, 0]
    assert_records_equal(one_hot_result, execute_generated(engine, one_hot_frame, one_hot))

    scalar_frame = frame_for(
        engine,
        {
            "value": [1.0, float("nan"), None],
            "flag": [True, False, None],
            "day": [date(2024, 1, 2), date(2024, 1, 3), None],
        },
    )
    scalar_hot = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:2", "day", 2),
            bound_ref("c:source:1", "flag", 1),
            bound_ref("c:source:0", "value", 0),
        ],
        prefixSeparator="_",
        dropOriginal=False,
    )
    scalar_result = engine.apply_transform(scalar_frame, scalar_hot)
    assert list(records(scalar_result)[0]) == [
        "value",
        "flag",
        "day",
        "day_2024-01-02",
        "day_2024-01-03",
        "flag_False",
        "flag_True",
        "value_1.0",
    ]
    assert [row["value_1.0"] for row in records(scalar_result)] == [1, 0, 0]
    assert [row["flag_True"] for row in records(scalar_result)] == [1, 0, 0]
    assert [row["day_2024-01-03"] for row in records(scalar_result)] == [0, 1, 0]
    assert_records_equal(scalar_result, execute_generated(engine, scalar_frame, scalar_hot))

    ordering_frame = frame_for(engine, {"zeta": ["b", "a"], "alpha": ["y", "x"]})
    ordering = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:0", "zeta", 0),
            bound_ref("c:source:1", "alpha", 1),
        ],
        dropOriginal=False,
    )
    ordering_result = engine.apply_transform(ordering_frame, ordering)
    assert list(records(ordering_result)[0]) == ["zeta", "alpha", "alpha_x", "alpha_y", "zeta_a", "zeta_b"]
    assert_records_equal(ordering_result, execute_generated(engine, ordering_frame, ordering))

    if isinstance(engine, PandasEngine):
        labels_frame = pd.DataFrame(
            {
                "tags": pd.Categorical([None, "", "red|β"]),
                "value": [1, 2, 3],
            }
        )
    else:
        labels_frame = pl.DataFrame({"tags": [None, "", "red|β"], "value": [1, 2, 3]}).with_columns(
            pl.col("tags").cast(pl.Categorical)
        )
    labels = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
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
            bound_step(
                "oneHotEncode",
                columns=[bound_ref("c:source:0", "group", 0)],
                prefixSeparator="_",
                dropOriginal=False,
            ),
            {"group": ["a"], "group_a": [7]},
            "One-hot encoding would create duplicate column names: group_a",
        ),
        (
            bound_step(
                "multiLabelBinarize",
                column=bound_ref("c:source:0", "tags", 0),
                delimiter="|",
                prefix="tag_",
                dropOriginal=False,
            ),
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


def test_dynamic_categorical_outputs_cannot_enter_the_private_row_identity_namespace(engine) -> None:
    private_suffix = "open_wrangler_internal_row_id_forged"
    frame = frame_for(engine, {"tags": [private_suffix], "value": [1]})
    operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="__",
        dropOriginal=False,
    )

    with pytest.raises(EngineError, match="reserved private row-identity column"):
        engine.apply_transform(frame, operation)
    with pytest.raises(ValueError, match="reserved private row-identity column"):
        execute_generated(engine, frame, operation)


def test_pandas_multi_label_categorical_null_does_not_require_a_blank_category() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "tags": pd.Categorical(["red|β", None], categories=["red|β"]),
            "value": [1, 2],
        }
    )
    operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="tag_",
        dropOriginal=False,
    )

    transformed = engine.apply_transform(frame, operation)

    assert transformed["tag_red"].tolist() == [1, 0]
    assert transformed["tag_β"].tolist() == [1, 0]
    pd.testing.assert_frame_equal(transformed, execute_generated(engine, frame, operation))


def test_grouping_is_ordered_and_nullable_aggregations_match(engine) -> None:
    frame = frame_for(
        engine,
        {
            "group": ["b", "b", "a", "a", None, None],
            "value": [None, 2, None, 1, None, None],
            "text": [None, "B", "A", None, "Z", None],
        },
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {"column": bound_ref("c:source:1", "value", 1), "operation": "nUnique", "alias": "unique_values"},
            {"column": bound_ref("c:source:2", "text", 2), "operation": "first", "alias": "first_text"},
            {"column": bound_ref("c:source:2", "text", 2), "operation": "last", "alias": "last_text"},
            {"column": bound_ref("c:source:1", "value", 1), "operation": "count", "alias": "value_count"},
            {"column": bound_ref("c:source:1", "value", 1), "operation": "sum", "alias": "value_sum"},
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
            keys=[public_ref("c:source:0", "group")],
            aggregations=[
                {"column": public_ref("c:source:1", "value"), "operation": "sum", "alias": "result"},
                {"column": public_ref("c:source:1", "value"), "operation": "mean", "alias": "result"},
            ],
        )
    with pytest.raises(OperationError, match="cannot duplicate a group key"):
        step(
            "groupBy",
            keys=[public_ref("c:source:0", "group")],
            aggregations=[{"column": public_ref("c:source:1", "value"), "operation": "sum", "alias": "group"}],
        )


def test_grouping_treats_nan_as_missing_for_keys_and_every_aggregate(engine) -> None:
    frame = frame_for(
        engine,
        {
            "key": [None, float("nan"), 1.0, None, float("nan"), 1.0],
            "value": [None, float("nan"), 2.0, None, float("nan"), 3.0],
        },
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

    transformed = engine.apply_transform(frame, operation)
    result = [{key: normalized(value) for key, value in row.items()} for row in records(transformed)]

    assert result == [
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
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_grouping_emits_typed_nulls_without_erasing_a_computed_nan(engine) -> None:
    text_values = ["x", None, None, "z"]
    frame = frame_for(
        engine,
        {
            "group": ["a", "a", "b", None],
            "number": [float("inf"), float("-inf"), None, 2.0],
            "text": text_values,
        },
    )
    if isinstance(engine, PandasEngine):
        # Pandas 2.x inferred object here and failed native string min/max when
        # the group contained a missing value. Keep that boundary exercised
        # after Pandas 3 switched its default inference to StringDtype.
        frame.isetitem(2, pd.Series(text_values, dtype=object))
    number = bound_ref("c:source:1", "number", 1)
    text = bound_ref("c:source:2", "text", 2)
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {"column": number, "operation": operation_name, "alias": f"number_{operation_name}"}
            for operation_name in ("mean", "median", "min", "max", "first", "last")
        ]
        + [
            {"column": text, "operation": operation_name, "alias": f"text_{operation_name}"}
            for operation_name in ("min", "max", "first", "last")
        ],
    )

    live = typed_records(engine, engine.apply_transform(frame, operation))
    generated = typed_records(engine, execute_generated(engine, frame, operation))

    assert live == generated
    by_group = {row["group"]["display"]: row for row in live}
    assert by_group[""]["group"]["kind"] == "null"
    assert by_group["a"]["number_mean"]["kind"] == "nan"
    for name, cell in by_group["b"].items():
        if name != "group":
            assert cell["kind"] == "null"


@pytest.mark.parametrize(
    ("program", "expected_kinds"),
    [
        (
            {"kind": "column", "column": bound_ref("c:source:0", "value", 0)},
            ["string", "null", "string"],
        ),
        (
            {
                "kind": "datetimeFormat",
                "input": {"kind": "column", "column": bound_ref("c:source:0", "value", 0)},
                "inputFormat": "%Y-%m-%d",
                "outputFormat": "%Y",
            },
            ["string", "null", "null"],
        ),
    ],
)
def test_by_example_string_and_datetime_results_use_typed_nulls(
    engine: PandasEngine | PolarsEngine,
    program: dict[str, Any],
    expected_kinds: list[str],
) -> None:
    frame = frame_for(engine, {"value": ["2024-01-02", None, "invalid"]})
    operation = bound_step(
        "byExample",
        sourceColumns=[bound_ref("c:source:0", "value", 0)],
        newColumn="result",
        examples=[],
        program=program,
    )

    live = typed_records(engine, engine.apply_transform(frame, operation))
    generated = typed_records(engine, execute_generated(engine, frame, operation))

    assert live == generated
    assert [row["result"]["kind"] for row in live] == expected_kinds


def test_pandas_grouping_targets_duplicate_and_non_string_labels_positionally() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            ["ignored", "a", 1, 100],
            ["ignored", "a", 2, 200],
            ["ignored", "b", 3, 300],
            ["ignored", "b", 4, 400],
        ],
        columns=cast(Any, ["duplicate", "duplicate", 7, "metric"]),
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:1", "duplicate", 1)],
        aggregations=[
            {
                "column": bound_ref("c:source:2", "7", 2),
                "operation": "sum",
                "alias": "__ow_group_key_0",
            }
        ],
    )

    transformed = engine.apply_transform(frame, operation)

    assert list(transformed.columns) == ["duplicate", "__ow_group_key_0"]
    assert transformed.to_dict(orient="records") == [
        {"duplicate": "a", "__ow_group_key_0": 3},
        {"duplicate": "b", "__ow_group_key_0": 7},
    ]
    pd.testing.assert_frame_equal(transformed, execute_generated(engine, frame, operation))


@pytest.mark.parametrize(
    ("kind", "params", "message"),
    [
        (
            "oneHotEncode",
            {"columns": [public_ref("c:source:0", "group")], "dropOriginal": "yes"},
            "dropOriginal must be a boolean",
        ),
        (
            "multiLabelBinarize",
            {"column": public_ref("c:source:0", "tags"), "delimiter": "", "prefix": "tag_"},
            "delimiter must be a non-empty string",
        ),
        (
            "findReplace",
            {"column": public_ref("c:source:0", "text"), "find": 1, "replacement": "x"},
            "find and replacement must be strings",
        ),
        (
            "stripText",
            {"column": public_ref("c:source:0", "text"), "characters": ""},
            "characters must be a non-empty string or null",
        ),
        (
            "splitText",
            {
                "column": public_ref("c:source:0", "text"),
                "delimiter": "-",
                "index": True,
                "newColumn": "part",
            },
            "index must be a non-negative integer",
        ),
        (
            "roundNumber",
            {"column": public_ref("c:source:0", "value"), "decimals": True},
            "decimals must be an integer",
        ),
        (
            "formatDatetime",
            {"column": public_ref("c:source:0", "date"), "format": ""},
            "format must be a non-empty string",
        ),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": {"id": "c:source:0", "name": "value"},
                            "type": "integer",
                            "predicates": [{"kind": "predicate", "operator": "between", "value": 1}],
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
                    "filters": [
                        {
                            "column": {"id": "c:source:0", "name": "value"},
                            "type": "integer",
                            "predicates": [{"kind": "predicate", "operator": "mystery"}],
                        }
                    ],
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
        bound_step("upperText", column=bound_ref("c:source:0", "text", 0), newColumn="upper"),
        bound_step("lowerText", column=bound_ref("c:source:0", "text", 0), newColumn="lower"),
        bound_step(
            "capitalizeText",
            column=bound_ref("c:source:0", "text", 0),
            newColumn="capitalized",
        ),
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


def test_pandas_value_transforms_target_duplicate_and_non_string_labels_positionally() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            ["élan", "red|blue", 1.2, "2024-01-02"],
            [None, "blue", 2.8, "2024-02-03"],
        ],
        columns=cast(Any, ["duplicate", "duplicate", 7, "when"]),
    )
    operations = [
        bound_step("upperText", column=bound_ref("c:source:0", "duplicate", 0)),
        bound_step(
            "multiLabelBinarize",
            column=bound_ref("c:source:1", "duplicate", 1),
            delimiter="|",
            prefix="tag_",
            dropOriginal=False,
        ),
        bound_step(
            "oneHotEncode",
            columns=[bound_ref("c:source:1", "duplicate", 1)],
            prefixSeparator="_",
            dropOriginal=False,
        ),
        bound_step("roundNumber", column=bound_ref("c:source:2", "7", 2)),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:3", "when", 3),
            format="%Y/%m",
            newColumn="month",
        ),
    ]

    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)
    namespace: dict[str, Any] = {}
    code = engine.compile_plan(operations)
    exec(code, namespace, namespace)
    generated = namespace["clean_data"](frame)

    pd.testing.assert_frame_equal(transformed, generated)
    assert transformed.iloc[0, 0] == "ÉLAN"
    assert pd.isna(transformed.iloc[1, 0])
    assert transformed.iloc[:, 1].tolist() == ["red|blue", "blue"]
    assert transformed.iloc[:, 2].tolist() == [1.0, 3.0]
    assert transformed["tag_red"].tolist() == [1, 0]
    assert transformed["duplicate_blue"].tolist() == [0, 1]
    assert transformed["month"].tolist() == ["2024/01", "2024/02"]
    assert "df.iloc[:, 0]" in code
    assert "df.iloc[:, 1]" in code
    assert "df.iloc[:, 2]" in code
    assert "df.iloc[:, 3]" in code
    assert list(frame.columns) == ["duplicate", "duplicate", 7, "when"]


def test_value_transforms_preserve_documented_coercive_inputs(engine) -> None:
    frame = frame_for(
        engine,
        {
            "text": [123, None],
            "number": ["1.2", "2.8"],
            "date": ["2024-01-02", "invalid"],
        },
    )
    operations = [
        bound_step("upperText", column=bound_ref("c:source:0", "text", 0), newColumn="upper"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:1", "number", 1),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:2", "date", 2),
            format="%Y",
            newColumn="year",
        ),
    ]

    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)

    result = records(transformed)
    assert result[0]["upper"] in {"123", "123.0"}
    assert normalized(result[1]["upper"]) is None
    assert result[0]["rounded"] == 1.0
    assert result[1]["rounded"] == 3.0
    assert result[0]["year"] == "2024"
    assert normalized(result[1]["year"]) is None
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(operations), namespace, namespace)
    assert_records_equal(transformed, namespace["clean_data"](frame))


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ("\\", ["\\a\\b\\", "\\", None, "\\é\\🙂\\"]),
        (r"\1", [r"\1a\1b\1", r"\1", None, r"\1é\1🙂\1"]),
        ("$1", ["$1a$1b$1", "$1", None, "$1é$1🙂$1"]),
    ],
)
def test_empty_literal_find_replaces_text_boundaries_and_matches_generated_code(
    engine, replacement: str, expected: list[str | None]
) -> None:
    frame = frame_for(engine, {"text": ["ab", "", None, "é🙂"]})
    operation = bound_step(
        "findReplace",
        column=bound_ref("c:source:0", "text", 0),
        find="",
        replacement=replacement,
        regex=False,
        newColumn="expanded",
    )

    transformed = engine.apply_transform(frame, operation)

    assert [normalized(row["expanded"]) for row in records(transformed)] == expected
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_default_strip_normalizes_control_and_unicode_whitespace(engine) -> None:
    padded = "\t\n\r\v\f\u00a0\u2003X\t\n\r\v\f\u00a0\u2003"
    frame = frame_for(engine, {"text": [padded, None]})
    operation = bound_step(
        "stripText",
        column=bound_ref("c:source:0", "text", 0),
        newColumn="clean",
    )

    transformed = engine.apply_transform(frame, operation)

    assert records(transformed)[0]["clean"] == "X"
    assert normalized(records(transformed)[1]["clean"]) is None
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_custom_code_exceptions_are_structured_engine_errors(engine) -> None:
    frame = frame_for(engine, {"value": [1]})
    backend = "Pandas" if isinstance(engine, PandasEngine) else "Polars"

    with pytest.raises(EngineError, match=rf"Custom {backend} code failed: boom"):
        engine.apply_transform(frame, step("customCode", code="raise ValueError('boom')"))
    with pytest.raises(EngineError, match=rf"Custom {backend} code must assign"):
        engine.apply_transform(frame, step("customCode", code="result = 42"))
