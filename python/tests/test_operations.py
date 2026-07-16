from __future__ import annotations

from math import isnan

import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.operations import OperationError, operation_catalog, validate_step

PRIVATE_COLUMN = f"{INTERNAL_ROW_ID_PREFIX}guessed"


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


def public_ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def bound_step(step_id: str, kind: str, **params):
    return {"id": step_id, "kind": kind, "params": params}


def test_operation_registry_is_complete_and_validation_is_strict():
    catalog = operation_catalog()
    assert len(catalog) == 27
    assert {item["kind"] for item in catalog} >= {"sortRows", "oneHotEncode", "groupBy", "byExample", "customCode"}
    with pytest.raises(OperationError, match="Unsupported"):
        validate_step({"id": "bad", "kind": "unknown", "params": {}})
    with pytest.raises(OperationError, match="exactly one"):
        step(
            "bad-formula",
            "formula",
            leftColumn=public_ref("c:source:3", "value"),
            operator="add",
            newColumn="result",
        )
    with pytest.raises(OperationError, match="exactly one"):
        step(
            "bool-formula",
            "formula",
            leftColumn=public_ref("c:source:3", "value"),
            operator="add",
            value=True,
            newColumn="result",
        )


@pytest.mark.parametrize(
    "operation",
    [
        {
            "id": "sort",
            "kind": "sortRows",
            "params": {"rules": [{"column": "value", "direction": "asc", "nulls": "last"}]},
        },
        {
            "id": "filter",
            "kind": "filterRows",
            "params": {
                "filterModel": {
                    "filters": [
                        {
                            "column": "value",
                            "type": "integer",
                            "predicates": [{"kind": "predicate", "operator": "gt", "value": 1}],
                        }
                    ],
                    "sort": [],
                }
            },
        },
        {"id": "missing", "kind": "dropMissingRows", "params": {"columns": ["value"]}},
        {"id": "duplicates", "kind": "dropDuplicates", "params": {"columns": ["value"]}},
    ],
)
def test_row_order_operations_reject_name_only_transform_columns(operation) -> None:
    with pytest.raises(OperationError, match="column reference"):
        validate_step(operation)


def test_optional_row_column_lists_have_strict_empty_semantics() -> None:
    missing = validate_step({"id": "missing", "kind": "dropMissingRows", "params": {"columns": [], "how": "any"}})
    omitted = validate_step({"id": "all", "kind": "dropMissingRows", "params": {}})

    assert missing["params"]["columns"] == []
    assert "columns" not in omitted["params"]
    with pytest.raises(OperationError, match="non-empty array"):
        validate_step({"id": "duplicates", "kind": "dropDuplicates", "params": {"columns": []}})


@pytest.mark.parametrize(
    ("kind", "params"),
    [
        (
            "sortRows",
            {
                "rules": [
                    {
                        "column": public_ref("private", PRIVATE_COLUMN),
                        "direction": "asc",
                        "nulls": "last",
                    }
                ]
            },
        ),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": public_ref("private", PRIVATE_COLUMN),
                            "type": "string",
                            "predicates": [{"kind": "predicate", "operator": "equals", "value": "x"}],
                        }
                    ],
                    "sort": [],
                }
            },
        ),
        ("dropMissingRows", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        ("dropDuplicates", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        ("selectColumns", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        ("dropColumns", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        (
            "renameColumn",
            {"column": public_ref("c:source:0", "value"), "newName": PRIVATE_COLUMN},
        ),
        (
            "cloneColumn",
            {"column": public_ref("c:source:0", "value"), "newName": PRIVATE_COLUMN},
        ),
        ("castColumn", {"column": public_ref("private", PRIVATE_COLUMN), "dtype": "float"}),
        (
            "formula",
            {
                "leftColumn": public_ref("private", PRIVATE_COLUMN),
                "operator": "add",
                "value": 1,
                "newColumn": "result",
            },
        ),
        (
            "textLength",
            {"column": public_ref("c:source:0", "value"), "newColumn": PRIVATE_COLUMN},
        ),
        ("oneHotEncode", {"columns": [PRIVATE_COLUMN]}),
        ("multiLabelBinarize", {"column": "tags", "delimiter": "|", "prefix": PRIVATE_COLUMN}),
        ("findReplace", {"column": PRIVATE_COLUMN, "find": "a", "replacement": "b"}),
        ("stripText", {"column": PRIVATE_COLUMN}),
        ("splitText", {"column": PRIVATE_COLUMN, "delimiter": "-", "index": 0, "newColumn": "part"}),
        ("capitalizeText", {"column": PRIVATE_COLUMN}),
        ("lowerText", {"column": PRIVATE_COLUMN}),
        ("upperText", {"column": PRIVATE_COLUMN}),
        ("minMaxScale", {"column": PRIVATE_COLUMN}),
        ("roundNumber", {"column": "value", "newColumn": PRIVATE_COLUMN}),
        ("floorNumber", {"column": PRIVATE_COLUMN}),
        ("ceilNumber", {"column": PRIVATE_COLUMN}),
        ("formatDatetime", {"column": PRIVATE_COLUMN, "format": "%Y"}),
        (
            "groupBy",
            {
                "keys": ["group"],
                "aggregations": [{"column": PRIVATE_COLUMN, "operation": "first", "alias": "leaked"}],
            },
        ),
        (
            "groupBy",
            {
                "keys": ["group"],
                "aggregations": [{"column": "value", "operation": "sum", "alias": PRIVATE_COLUMN}],
            },
        ),
        (
            "byExample",
            {
                "sourceColumns": [PRIVATE_COLUMN],
                "newColumn": "result",
                "examples": [
                    {"inputs": {PRIVATE_COLUMN: "a"}, "output": "x"},
                    {"inputs": {PRIVATE_COLUMN: "b"}, "output": "x"},
                ],
                "program": {"kind": "literal", "value": "x"},
            },
        ),
    ],
)
def test_every_explicit_operation_column_slot_rejects_the_private_namespace(kind, params) -> None:
    with pytest.raises(OperationError, match="reserved private row-identity prefix"):
        validate_step({"id": f"private-{kind}", "kind": kind, "params": params})


def test_rows_and_order_operations(engine_and_frame):
    engine, frame = engine_and_frame
    sorted_frame = engine.apply_transform(
        frame,
        bound_step(
            "sort",
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:3", "value", 3),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        ),
    )
    assert [record["value"] for record in records(sorted_frame)[:2]] == [2.8, 2.8]

    filtered = engine.apply_transform(
        frame,
        bound_step(
            "filter",
            "filterRows",
            filterModel={
                "logic": "and",
                "filters": [
                    {
                        "column": bound_ref("c:source:1", "text", 1),
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

    without_missing = engine.apply_transform(
        frame,
        bound_step(
            "missing",
            "dropMissingRows",
            columns=[bound_ref("c:source:3", "value", 3)],
            how="any",
        ),
    )
    assert len(records(without_missing)) == 3

    duplicates = engine.apply_transform(
        frame,
        bound_step(
            "duplicates",
            "dropDuplicates",
            columns=[
                bound_ref("c:source:3", "value", 3),
                bound_ref("c:source:4", "other", 4),
            ],
            keep="first",
        ),
    )
    assert len(records(duplicates)) == 3


def test_column_and_type_operations_match_generated_code(engine_and_frame):
    engine, frame = engine_and_frame
    plan = [
        bound_step(
            "clone",
            "cloneColumn",
            column=bound_ref("c:source:3", "value", 3),
            newName="value_copy",
        ),
        bound_step(
            "formula",
            "formula",
            leftColumn=bound_ref("c:source:4", "other", 4),
            operator="multiply",
            value=10,
            newColumn="score",
        ),
        bound_step(
            "length",
            "textLength",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="text_length",
        ),
        bound_step(
            "cast",
            "castColumn",
            column=bound_ref("c:source:4", "other", 4),
            dtype="float",
        ),
        bound_step(
            "rename",
            "renameColumn",
            column=bound_ref("c:source:0", "group", 0),
            newName="category",
        ),
        bound_step(
            "drop",
            "dropColumns",
            columns=[
                bound_ref("c:source:2", "tags", 2),
                bound_ref("c:source:5", "date", 5),
            ],
        ),
        bound_step(
            "select",
            "selectColumns",
            columns=[
                bound_ref("c:source:0", "category", 0),
                bound_ref("c:source:1", "text", 1),
                bound_ref("c:source:3", "value", 2),
                bound_ref("c:source:4", "other", 3),
                bound_ref("c:step:clone:0", "value_copy", 4),
                bound_ref("c:step:formula:0", "score", 5),
                bound_ref("c:step:length:0", "text_length", 6),
            ],
        ),
    ]
    transformed = apply_plan(engine, frame, plan)
    result = records(transformed)
    assert list(result[0]) == ["category", "text", "value", "other", "value_copy", "score", "text_length"]
    assert result[0]["category"] == "a"
    assert result[0]["score"] == 20
    assert result[0]["text_length"] == 11
    assert_semantically_equal(transformed, execute_generated(engine, frame, plan))


def test_structural_adapters_reject_public_references_before_execution(engine_and_frame):
    engine, frame = engine_and_frame
    public_step = {
        "id": "unbound-cast",
        "kind": "castColumn",
        "params": {"column": public_ref("c:source:3", "value"), "dtype": "float"},
    }

    with pytest.raises(EngineError, match="requires a bound column reference"):
        engine.apply_transform(frame, public_step)
    with pytest.raises(EngineError, match="requires a bound column reference"):
        engine.compile_plan([public_step])


def test_pandas_bound_structural_operations_target_duplicate_and_non_string_columns():
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            [1, 10, 100, "ab"],
            [2, 20, 200, "c"],
        ],
        columns=pd.Index(["duplicate", "duplicate", 7, "text"], dtype=object),
    )

    selected = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "select-exact",
            "selectColumns",
            columns=[
                bound_ref("c:source:1", "duplicate", 1),
                bound_ref("c:source:2", "7", 2),
                bound_ref("c:source:0", "duplicate", 0),
            ],
        ),
    )
    assert list(selected.columns) == ["duplicate", 7, "duplicate"]
    assert selected.iloc[:, 0].tolist() == [10, 20]
    assert selected.iloc[:, 1].tolist() == [100, 200]
    assert selected.iloc[:, 2].tolist() == [1, 2]

    dropped = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "drop-exact",
            "dropColumns",
            columns=[bound_ref("c:source:0", "duplicate", 0)],
        ),
    )
    assert list(dropped.columns) == ["duplicate", 7, "text"]
    assert dropped.iloc[:, 0].tolist() == [10, 20]

    renamed = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "rename-exact",
            "renameColumn",
            column=bound_ref("c:source:1", "duplicate", 1),
            newName="renamed_duplicate",
        ),
    )
    assert list(renamed.columns) == ["duplicate", "renamed_duplicate", 7, "text"]
    assert renamed["duplicate"].tolist() == [1, 2]
    assert renamed["renamed_duplicate"].tolist() == [10, 20]

    cloned = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "clone-exact",
            "cloneColumn",
            column=bound_ref("c:source:1", "duplicate", 1),
            newName="duplicate_copy",
        ),
    )
    assert cloned["duplicate_copy"].tolist() == [10, 20]

    cast = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "cast-exact",
            "castColumn",
            column=bound_ref("c:source:2", "7", 2),
            dtype="float",
        ),
    )
    assert cast.iloc[:, 0].tolist() == [1, 2]
    assert cast.iloc[:, 1].tolist() == [10, 20]
    assert cast.iloc[:, 2].tolist() == [100.0, 200.0]
    assert str(cast.iloc[:, 2].dtype) == "Float64"

    formula = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "formula-exact",
            "formula",
            leftColumn=bound_ref("c:source:0", "duplicate", 0),
            operator="add",
            rightColumn=bound_ref("c:source:1", "duplicate", 1),
            newColumn="sum",
        ),
    )
    assert formula["sum"].tolist() == [11, 22]

    lengths = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "length-exact",
            "textLength",
            column=bound_ref("c:source:3", "text", 3),
            newColumn="text_length",
        ),
    )
    assert lengths["text_length"].tolist() == [2, 1]


@pytest.mark.parametrize(
    ("operation", "existing_position", "existing_values", "output_name", "output_values"),
    [
        (
            bound_step(
                "clone-multiindex",
                "cloneColumn",
                column=bound_ref("c:source:0", "('number', 'input')", 0),
                newName="clone_flat",
            ),
            2,
            [101, 102],
            "clone_flat",
            [1, 2],
        ),
        (
            bound_step(
                "formula-multiindex",
                "formula",
                leftColumn=bound_ref("c:source:0", "('number', 'input')", 0),
                operator="add",
                value=10,
                newColumn="formula_flat",
            ),
            3,
            [201, 202],
            "formula_flat",
            [11, 12],
        ),
        (
            bound_step(
                "length-multiindex",
                "textLength",
                column=bound_ref("c:source:1", "('text', 'input')", 1),
                newColumn="length_flat",
            ),
            4,
            [301, 302],
            "length_flat",
            [2, 1],
        ),
    ],
)
def test_pandas_multiindex_derived_columns_append_flat_labels_without_overwriting(
    operation: dict,
    existing_position: int,
    existing_values: list[int],
    output_name: str,
    output_values: list[int],
) -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            [1, "ab", 101, 201, 301],
            [2, "c", 102, 202, 302],
        ],
        columns=pd.MultiIndex.from_tuples(
            [
                ("number", "input"),
                ("text", "input"),
                ("clone_flat", "existing"),
                ("formula_flat", "existing"),
                ("length_flat", "existing"),
            ]
        ),
    )

    result = assert_pandas_live_matches_generated(engine, frame, operation)

    assert list(result.columns[:-1]) == list(frame.columns)
    assert len(result.columns) == len(frame.columns) + 1
    assert result.columns[-1] == output_name
    assert result.iloc[:, existing_position].tolist() == existing_values
    assert result.iloc[:, -1].tolist() == output_values


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


def assert_pandas_live_matches_generated(
    engine: PandasEngine,
    frame: pd.DataFrame,
    operation: dict,
) -> pd.DataFrame:
    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])
    pd.testing.assert_frame_equal(live, generated)
    return live


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
