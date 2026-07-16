from __future__ import annotations

from math import isnan

import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import PandasEngine, PolarsEngine
from openwrangler_runtime.operations import OperationError, operation_catalog, validate_step


@pytest.fixture(params=["pandas", "polars"])
def engine_and_frame(request, monkeypatch):
    records = {
        "group": ["a", "a", "b", "b"],
        "text": [" alpha-one ", "BETA-two", None, "alpha-one"],
        "tags": ["red|blue", "blue", None, "red"],
        "value": [1.2, 2.8, None, 2.8],
        "other": [2, 3, 4, 3],
        "date": ["2024-01-02", "2024-02-03", "2024-03-04", "2024-02-03"],
    }
    if request.param == "pandas":
        return PandasEngine(), pd.DataFrame(records)

    def fail_to_pandas(*_args, **_kwargs):
        raise AssertionError("Polars transformations must never convert to Pandas")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", fail_to_pandas, raising=False)
    return PolarsEngine(), pl.DataFrame(records)


def step(step_id: str, kind: str, **params):
    return validate_step({"id": step_id, "kind": kind, "params": params})


def test_operation_registry_is_complete_and_validation_is_strict():
    catalog = operation_catalog()
    assert len(catalog) == 27
    assert {item["kind"] for item in catalog} >= {"sortRows", "oneHotEncode", "groupBy", "byExample", "customCode"}
    with pytest.raises(OperationError, match="Unsupported"):
        validate_step({"id": "bad", "kind": "unknown", "params": {}})
    with pytest.raises(OperationError, match="exactly one"):
        step("bad-formula", "formula", leftColumn="value", operator="add", newColumn="result")
    with pytest.raises(OperationError, match="exactly one"):
        step("bool-formula", "formula", leftColumn="value", operator="add", value=True, newColumn="result")


def test_rows_and_order_operations(engine_and_frame):
    engine, frame = engine_and_frame
    sorted_frame = engine.apply_transform(
        frame,
        step(
            "sort",
            "sortRows",
            rules=[{"column": "value", "direction": "desc", "nulls": "last"}],
        ),
    )
    assert [record["value"] for record in records(sorted_frame)[:2]] == [2.8, 2.8]

    filtered = engine.apply_transform(
        frame,
        step(
            "filter",
            "filterRows",
            filterModel={
                "logic": "and",
                "filters": [
                    {
                        "column": "text",
                        "type": "string",
                        "logic": "and",
                        "predicates": [{"kind": "predicate", "operator": "contains", "value": "alpha"}],
                    }
                ],
                "sort": [],
            },
        ),
    )
    assert len(records(filtered)) == 2

    without_missing = engine.apply_transform(frame, step("missing", "dropMissingRows", columns=["value"], how="any"))
    assert len(records(without_missing)) == 3

    duplicates = engine.apply_transform(
        frame,
        step("duplicates", "dropDuplicates", columns=["value", "other"], keep="first"),
    )
    assert len(records(duplicates)) == 3


def test_column_and_type_operations_match_generated_code(engine_and_frame):
    engine, frame = engine_and_frame
    plan = [
        step("clone", "cloneColumn", column="value", newName="value_copy"),
        step(
            "formula",
            "formula",
            leftColumn="other",
            operator="multiply",
            value=10,
            newColumn="score",
        ),
        step("length", "textLength", column="text", newColumn="text_length"),
        step("cast", "castColumn", column="other", dtype="float"),
        step("rename", "renameColumn", column="group", newName="category"),
        step("drop", "dropColumns", columns=["tags", "date"]),
        step(
            "select",
            "selectColumns",
            columns=["category", "text", "value", "other", "value_copy", "score", "text_length"],
        ),
    ]
    transformed = apply_plan(engine, frame, plan)
    result = records(transformed)
    assert list(result[0]) == ["category", "text", "value", "other", "value_copy", "score", "text_length"]
    assert result[0]["category"] == "a"
    assert result[0]["score"] == 20
    assert result[0]["text_length"] == 11
    assert_semantically_equal(transformed, execute_generated(engine, frame, plan))


def test_text_operations(engine_and_frame):
    engine, frame = engine_and_frame
    plan = [
        step("strip", "stripText", column="text", newColumn="clean"),
        step("replace", "findReplace", column="text", find="-", replacement=" ", newColumn="replaced"),
        step("split", "splitText", column="text", delimiter="-", index=1, newColumn="suffix"),
        step("lower", "lowerText", column="text", newColumn="lower"),
        step("upper", "upperText", column="text", newColumn="upper"),
        step("capitalize", "capitalizeText", column="text", newColumn="capitalized"),
    ]
    result = records(apply_plan(engine, frame, plan))
    assert result[0]["clean"] == "alpha-one"
    assert result[0]["replaced"] == " alpha one "
    assert result[1]["suffix"] == "two"
    assert result[1]["lower"] == "beta-two"
    assert result[1]["upper"] == "BETA-TWO"
    assert result[1]["capitalized"] == "Beta-two"


def test_categorical_encoders(engine_and_frame):
    engine, frame = engine_and_frame
    encoded = engine.apply_transform(
        frame,
        step("one-hot", "oneHotEncode", columns=["group"], prefixSeparator="_", dropOriginal=False),
    )
    result = records(encoded)
    assert result[0]["group_a"] == 1
    assert result[2]["group_b"] == 1

    multilabel = engine.apply_transform(
        frame,
        step("multi-label", "multiLabelBinarize", column="tags", delimiter="|", prefix="tag_", dropOriginal=False),
    )
    result = records(multilabel)
    assert result[0]["tag_blue"] == 1
    assert result[0]["tag_red"] == 1
    assert result[1]["tag_red"] == 0


def test_numeric_datetime_grouping_and_custom_code(engine_and_frame):
    engine, frame = engine_and_frame
    numeric = apply_plan(
        engine,
        frame,
        [
            step("scale", "minMaxScale", column="value", newColumn="scaled"),
            step("round", "roundNumber", column="value", decimals=0, newColumn="rounded"),
            step("floor", "floorNumber", column="value", newColumn="floored"),
            step("ceil", "ceilNumber", column="value", newColumn="ceiled"),
            step("date", "formatDatetime", column="date", format="%Y/%m", newColumn="month"),
        ],
    )
    result = records(numeric)
    assert result[0]["scaled"] == 0.0
    assert result[1]["scaled"] == pytest.approx(1.0)
    assert result[0]["rounded"] == 1.0
    assert result[0]["floored"] == 1.0
    assert result[0]["ceiled"] == 2.0
    assert result[0]["month"] == "2024/01"

    grouped = engine.apply_transform(
        frame,
        step(
            "group",
            "groupBy",
            keys=["group"],
            aggregations=[
                {"column": "value", "operation": "sum", "alias": "total"},
                {"column": "other", "operation": "mean", "alias": "average"},
                {"column": "text", "operation": "count", "alias": "texts"},
                {"column": "tags", "operation": "nUnique", "alias": "tag_sets"},
            ],
        ),
    )
    grouped_result = records(grouped)
    assert grouped_result[0] == {"group": "a", "total": 4.0, "average": 2.5, "texts": 2, "tag_sets": 2}

    code = (
        "result = df[df['other'] > 2]"
        if isinstance(engine, PandasEngine)
        else "result = df.filter(pl.col('other') > 2)"
    )
    custom = engine.apply_transform(frame, step("custom", "customCode", code=code))
    assert len(records(custom)) == 3
    assert_semantically_equal(
        custom, execute_generated(engine, frame, [step("custom-generated", "customCode", code=code)])
    )


def test_by_example_is_native_and_generated_code_matches(engine_and_frame):
    engine, frame = engine_and_frame
    plan = [
        step(
            "example-label",
            "byExample",
            sourceColumns=["group", "other"],
            newColumn="label",
            examples=[
                {"inputs": {"group": "a", "other": 2}, "output": "a-2"},
                {"inputs": {"group": "b", "other": 4}, "output": "b-4"},
            ],
        ),
        step(
            "example-month",
            "byExample",
            sourceColumns=["date"],
            newColumn="month",
            examples=[
                {"inputs": {"date": "2024-01-02"}, "output": "01/2024"},
                {"inputs": {"date": "2024-02-03"}, "output": "02/2024"},
            ],
        ),
        step(
            "example-score",
            "byExample",
            sourceColumns=["value", "other"],
            newColumn="score",
            examples=[
                {"inputs": {"value": 1.2, "other": 2}, "output": 3.2},
                {"inputs": {"value": 2.8, "other": 3}, "output": 5.8},
            ],
        ),
    ]
    assert [operation["params"]["program"]["kind"] for operation in plan] == [
        "concat",
        "datetimeFormat",
        "arithmetic",
    ]
    transformed = apply_plan(engine, frame, plan)
    assert [row["label"] for row in records(transformed)] == ["a-2", "a-3", "b-4", "b-3"]
    assert [row["month"] for row in records(transformed)] == ["01/2024", "02/2024", "03/2024", "02/2024"]
    assert records(transformed)[0]["score"] == pytest.approx(3.2)
    assert_semantically_equal(transformed, execute_generated(engine, frame, plan))


def apply_plan(engine, frame, plan):
    result = frame
    for operation in plan:
        result = engine.apply_transform(result, operation)
    return result


def execute_generated(engine, frame, plan):
    namespace = {}
    exec(engine.compile_plan(plan), namespace, namespace)
    return namespace["clean_data"](frame)


def records(frame):
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return frame.to_dicts()
    return frame.to_dict(orient="records")


def assert_semantically_equal(left, right):
    left_records = records(left)
    right_records = records(right)
    assert len(left_records) == len(right_records)
    assert [list(item) for item in left_records] == [list(item) for item in right_records]
    for left_row, right_row in zip(left_records, right_records, strict=True):
        for key in left_row:
            left_value = left_row[key]
            right_value = right_row[key]
            if isinstance(left_value, float) and isnan(left_value):
                assert isinstance(right_value, float) and isnan(right_value)
            elif pd.isna(left_value) and pd.isna(right_value):
                continue
            else:
                assert left_value == right_value
