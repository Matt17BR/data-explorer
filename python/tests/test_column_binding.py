from __future__ import annotations

from typing import Any

import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step

SCHEMA = [
    {"name": "duplicate", "type": "integer"},
    {"name": "duplicate", "type": "integer"},
    {"name": "value", "type": "integer"},
]
LINEAGE = [
    {"id": "c:source:0", "name": "duplicate"},
    {"id": "c:source:1", "name": "duplicate"},
    {"id": "c:source:2", "name": "value"},
]


def ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def step(kind: str, **params: Any) -> dict[str, Any]:
    return {"id": f"test-{kind}", "kind": kind, "params": params}


def expression_column(reference: dict[str, str]) -> dict[str, Any]:
    return {"kind": "column", "column": reference}


def by_example_step(reference: dict[str, str], program: dict[str, Any]) -> dict[str, Any]:
    return step(
        "byExample",
        sourceColumns=[reference],
        newColumn="derived",
        program=program,
    )


def test_binding_resolves_exact_duplicate_columns_and_keeps_public_step_unchanged() -> None:
    public = step(
        "selectColumns",
        columns=[ref("c:source:1", "duplicate"), ref("c:source:2", "value")],
    )

    bound = bind_step(public, SCHEMA, LINEAGE)

    assert bound["params"] == {
        "columns": [
            {"id": "c:source:1", "name": "duplicate", "position": 1},
            {"id": "c:source:2", "name": "value", "position": 2},
        ]
    }
    assert public["params"] == {"columns": [ref("c:source:1", "duplicate"), ref("c:source:2", "value")]}


@pytest.mark.parametrize(
    ("reference", "message"),
    [
        (ref("c:source:99", "value"), "Unknown or stale column identity"),
        (ref("c:source:2", "old-value"), "Column reference name mismatch"),
    ],
)
def test_binding_rejects_unknown_stale_and_name_mismatched_references(reference, message) -> None:
    with pytest.raises(ColumnBindingError, match=message):
        bind_step(step("castColumn", column=reference, dtype="float"), SCHEMA, LINEAGE)


def test_binding_rejects_duplicate_requested_and_input_identities() -> None:
    duplicate = ref("c:source:0", "duplicate")
    with pytest.raises(ColumnBindingError, match="contains duplicate column identity"):
        bind_step(step("dropColumns", columns=[duplicate, duplicate]), SCHEMA, LINEAGE)

    invalid_lineage = [*LINEAGE[:2], {"id": "c:source:1", "name": "value"}]
    with pytest.raises(ColumnBindingError, match="Duplicate column identity in the input schema"):
        bind_step(step("castColumn", column=duplicate, dtype="float"), SCHEMA, invalid_lineage)


def test_binding_rejects_dropping_every_visible_column() -> None:
    references = [ref(column["id"], column["name"]) for column in LINEAGE]

    with pytest.raises(ColumnBindingError, match="must leave at least one visible column"):
        bind_step(step("dropColumns", columns=references), SCHEMA, LINEAGE)


@pytest.mark.parametrize(
    ("reference", "message"),
    [
        ("value", "must be a column reference"),
        ({"name": "value"}, "missing required fields: id"),
        ({"id": "c:source:2"}, "missing required fields: name"),
        ({"id": "c:source:2", "name": "value", "position": 2}, "contains unknown fields: position"),
        ({"id": "", "name": "value"}, "id must be a non-empty string"),
        ({"id": "c:source:2", "name": 2}, "name must be a string"),
    ],
)
def test_binding_rejects_malformed_public_references(reference, message) -> None:
    with pytest.raises(ColumnBindingError, match=message):
        bind_step(step("castColumn", column=reference, dtype="float"), SCHEMA, LINEAGE)


@pytest.mark.parametrize(
    "operation",
    [
        step("renameColumn", column=ref("c:source:2", "value"), newName="duplicate"),
        step("cloneColumn", column=ref("c:source:2", "value"), newName="duplicate"),
        step(
            "formula",
            leftColumn=ref("c:source:2", "value"),
            operator="add",
            value=1,
            newColumn="duplicate",
        ),
        step("textLength", column=ref("c:source:2", "value"), newColumn="duplicate"),
        step("minMaxScale", column=ref("c:source:2", "value"), newColumn="duplicate"),
        step("roundNumber", column=ref("c:source:2", "value"), newColumn="duplicate"),
    ],
)
def test_binding_rejects_structural_output_name_collisions(operation) -> None:
    with pytest.raises(ColumnBindingError, match="collides with an existing column"):
        bind_step(operation, SCHEMA, LINEAGE)


def test_duplicate_label_in_place_value_updates_require_no_explicit_output_name() -> None:
    duplicate = ref("c:source:0", "duplicate")

    bound = bind_step(step("roundNumber", column=duplicate), SCHEMA, LINEAGE)
    assert bound["params"]["column"]["position"] == 0

    with pytest.raises(ColumnBindingError, match="collides with an existing column"):
        bind_step(step("roundNumber", column=duplicate, newColumn="duplicate"), SCHEMA, LINEAGE)


@pytest.mark.parametrize(
    "operation",
    [
        step("upperText", column=ref("c:value", "value"), newColumn="duplicate"),
        step("formatDatetime", column=ref("c:value", "value"), format="%Y", newColumn="duplicate"),
    ],
)
def test_text_and_datetime_outputs_reject_existing_names(operation: dict[str, Any]) -> None:
    schema = [{"name": "duplicate", "type": "string"}, {"name": "value", "type": "string"}]
    lineage = [{"id": "c:duplicate", "name": "duplicate"}, {"id": "c:value", "name": "value"}]

    with pytest.raises(ColumnBindingError, match="collides with an existing column"):
        bind_step(operation, schema, lineage)


@pytest.mark.parametrize(
    "operation",
    [
        step(
            "renameColumn",
            column=ref("c:source:2", "value"),
            newName="__open_wrangler_internal_row_id_user",
        ),
        step(
            "cloneColumn",
            column=ref("c:source:2", "value"),
            newName="__open_wrangler_internal_row_id_user",
        ),
        step(
            "formula",
            leftColumn=ref("c:source:2", "value"),
            operator="add",
            value=1,
            newColumn="__open_wrangler_internal_row_id_user",
        ),
        step(
            "textLength",
            column=ref("c:source:2", "value"),
            newColumn="__open_wrangler_internal_row_id_user",
        ),
    ],
)
def test_binding_rejects_the_private_row_identity_namespace(operation) -> None:
    with pytest.raises(ColumnBindingError, match="reserved private row-identity prefix"):
        bind_step(operation, SCHEMA, LINEAGE)


def test_binding_allows_formula_to_use_one_identity_on_both_sides() -> None:
    value = ref("c:source:2", "value")
    bound = bind_step(
        step("formula", leftColumn=value, operator="add", rightColumn=value, newColumn="total"),
        SCHEMA,
        LINEAGE,
    )

    assert bound["params"]["leftColumn"]["position"] == 2
    assert bound["params"]["rightColumn"]["position"] == 2


def test_binding_resolves_value_transform_references_without_mutating_public_steps() -> None:
    public = step("roundNumber", column=ref("c:source:2", "value"), decimals=1)

    bound = bind_step(public, SCHEMA, LINEAGE)

    assert bound["params"]["column"] == {
        "id": "c:source:2",
        "name": "value",
        "position": 2,
    }
    assert bound is not public
    assert bound["params"] is not public["params"]
    assert public["params"]["column"] == ref("c:source:2", "value")


@pytest.mark.parametrize(
    "operation",
    [
        step("oneHotEncode", columns=[ref("c:source:0", "duplicate")]),
        step("minMaxScale", column=ref("c:source:2", "value")),
        step("floorNumber", column=ref("c:source:2", "value")),
        step("ceilNumber", column=ref("c:source:2", "value")),
    ],
)
def test_binding_accepts_categorical_and_numeric_references(operation: dict[str, Any]) -> None:
    bound = bind_step(operation, SCHEMA, LINEAGE)

    reference = bound["params"].get("column", bound["params"].get("columns", [None])[0])
    assert reference["position"] in {0, 2}


@pytest.mark.parametrize(
    "operation",
    [
        step("multiLabelBinarize", column=ref("c:text", "text"), delimiter="|"),
        step("findReplace", column=ref("c:text", "text"), find="a", replacement="b"),
        step("stripText", column=ref("c:text", "text")),
        step("splitText", column=ref("c:text", "text"), delimiter="-", index=0, newColumn="part"),
        step("capitalizeText", column=ref("c:text", "text")),
        step("lowerText", column=ref("c:text", "text")),
        step("upperText", column=ref("c:text", "text")),
        step("formatDatetime", column=ref("c:text", "text"), format="%Y"),
    ],
)
def test_binding_accepts_text_and_parseable_datetime_references(operation: dict[str, Any]) -> None:
    schema = [{"name": "text", "type": "string"}]
    lineage = [{"id": "c:text", "name": "text"}]

    bound = bind_step(operation, schema, lineage)

    assert bound["params"]["column"]["position"] == 0


@pytest.mark.parametrize(
    ("operation", "schema_type"),
    [
        (step("upperText", column=ref("c:value", "value")), "integer"),
        (step("roundNumber", column=ref("c:value", "value")), "string"),
        (step("formatDatetime", column=ref("c:value", "value"), format="%Y"), "integer"),
        (step("oneHotEncode", columns=[ref("c:value", "value")]), "struct"),
    ],
)
def test_binding_preserves_coercive_value_transform_semantics(operation: dict[str, Any], schema_type: str) -> None:
    schema = [{"name": "value", "type": schema_type}]
    lineage = [{"id": "c:value", "name": "value"}]

    bound = bind_step(operation, schema, lineage)

    reference = bound["params"].get("column", bound["params"].get("columns", [None])[0])
    assert reference == {"id": "c:value", "name": "value", "position": 0}


def test_binding_recursively_resolves_row_and_order_references() -> None:
    public = step(
        "filterRows",
        filterModel={
            "logic": "and",
            "filters": [
                {
                    "column": ref("c:source:1", "duplicate"),
                    "type": "integer",
                    "predicates": [{"kind": "predicate", "operator": "gt", "value": 1}],
                }
            ],
            "sort": [
                {
                    "column": ref("c:source:2", "value"),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        },
    )

    bound = bind_step(public, SCHEMA, LINEAGE)

    assert bound["params"]["filterModel"]["filters"][0]["column"] == {
        "id": "c:source:1",
        "name": "duplicate",
        "position": 1,
    }
    assert bound["params"]["filterModel"]["sort"][0]["column"] == {
        "id": "c:source:2",
        "name": "value",
        "position": 2,
    }
    assert public["params"]["filterModel"]["filters"][0]["column"] == ref("c:source:1", "duplicate")


def test_binding_rejects_a_filter_type_that_does_not_match_the_referenced_schema() -> None:
    public = step(
        "filterRows",
        filterModel={
            "filters": [
                {
                    "column": ref("c:source:2", "value"),
                    "type": "string",
                    "predicates": [{"kind": "predicate", "operator": "isNaN"}],
                }
            ],
            "sort": [],
        },
    )

    with pytest.raises(ColumnBindingError, match="Column type mismatch.*'integer'.*'string'"):
        bind_step(public, SCHEMA, LINEAGE)


@pytest.mark.parametrize(
    "operation",
    [
        step(
            "sortRows",
            rules=[
                {
                    "column": ref("c:source:99", "value"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        ),
        step(
            "filterRows",
            filterModel={
                "filters": [
                    {
                        "column": ref("c:source:2", "stale-value"),
                        "type": "integer",
                        "predicates": [],
                    }
                ],
                "sort": [],
            },
        ),
        step("dropMissingRows", columns=[ref("c:source:99", "value")]),
        step("dropDuplicates", columns=[ref("c:source:2", "stale-value")]),
    ],
)
def test_binding_rejects_stale_or_mismatched_row_order_references(operation) -> None:
    with pytest.raises(ColumnBindingError, match="Unknown or stale|name mismatch"):
        bind_step(operation, SCHEMA, LINEAGE)


@pytest.mark.parametrize(
    "operation",
    [
        step(
            "sortRows",
            rules=[
                {"column": ref("c:source:2", "value"), "direction": "asc", "nulls": "last"},
                {"column": ref("c:source:2", "value"), "direction": "desc", "nulls": "first"},
            ],
        ),
        step(
            "filterRows",
            filterModel={
                "filters": [
                    {
                        "column": ref("c:source:2", "value"),
                        "type": "integer",
                        "predicates": [],
                    },
                    {
                        "column": ref("c:source:2", "value"),
                        "type": "integer",
                        "predicates": [],
                    },
                ],
                "sort": [],
            },
        ),
        step(
            "dropMissingRows",
            columns=[ref("c:source:2", "value"), ref("c:source:2", "value")],
        ),
        step(
            "dropDuplicates",
            columns=[ref("c:source:2", "value"), ref("c:source:2", "value")],
        ),
    ],
)
def test_binding_rejects_duplicate_row_order_references(operation) -> None:
    with pytest.raises(ColumnBindingError, match="duplicate column identity"):
        bind_step(operation, SCHEMA, LINEAGE)


def test_binding_preserves_optional_all_column_semantics() -> None:
    omitted_missing = bind_step(step("dropMissingRows", how="any"), SCHEMA, LINEAGE)
    empty_missing = bind_step(step("dropMissingRows", columns=[], how="all"), SCHEMA, LINEAGE)
    omitted_duplicates = bind_step(step("dropDuplicates", keep="first"), SCHEMA, LINEAGE)

    assert "columns" not in omitted_missing["params"]
    assert empty_missing["params"]["columns"] == []
    assert "columns" not in omitted_duplicates["params"]


@pytest.mark.parametrize(
    "semantic_type",
    ["string", "integer", "float", "decimal", "boolean", "datetime", "date", "duration", "binary"],
)
def test_group_keys_accept_only_portable_scalar_types(semantic_type: str) -> None:
    key = ref("c:key", "key")
    value = ref("c:value", "value")
    public = step(
        "groupBy",
        keys=[key],
        aggregations=[{"column": value, "operation": "count", "alias": "rows"}],
    )

    bound = bind_step(
        public,
        [{"name": "key", "type": semantic_type}, {"name": "value", "type": "string"}],
        [key, value],
    )

    assert bound["params"]["keys"] == [{**key, "position": 0}]


@pytest.mark.parametrize("semantic_type", ["null", "complex", "list", "struct", "unknown"])
def test_group_keys_reject_nonportable_types_before_dispatch(semantic_type: str) -> None:
    key = ref("c:key", "key")
    value = ref("c:value", "value")

    with pytest.raises(ColumnBindingError, match=rf"unsupported '{semantic_type}' type"):
        bind_step(
            step(
                "groupBy",
                keys=[key],
                aggregations=[{"column": value, "operation": "count", "alias": "rows"}],
            ),
            [{"name": "key", "type": semantic_type}, {"name": "value", "type": "string"}],
            [key, value],
        )


@pytest.mark.parametrize(
    ("operation", "semantic_type"),
    [
        ("sum", "integer"),
        ("mean", "float"),
        ("median", "decimal"),
        ("min", "date"),
        ("max", "duration"),
        ("nUnique", "binary"),
        ("count", "string"),
        ("first", "boolean"),
        ("last", "datetime"),
    ],
)
def test_group_aggregations_accept_the_portable_type_matrix(operation: str, semantic_type: str) -> None:
    key = ref("c:key", "key")
    value = ref("c:value", "value")

    bound = bind_step(
        step(
            "groupBy",
            keys=[key],
            aggregations=[
                {"column": value, "operation": operation, "alias": "result"},
                {"column": value, "operation": "count", "alias": "rows"},
            ],
        ),
        [{"name": "key", "type": "string"}, {"name": "value", "type": semantic_type}],
        [key, value],
    )

    assert [aggregation["column"] for aggregation in bound["params"]["aggregations"]] == [
        {**value, "position": 1},
        {**value, "position": 1},
    ]


@pytest.mark.parametrize(
    ("operation", "semantic_type"),
    [
        ("sum", "string"),
        ("mean", "boolean"),
        ("median", "date"),
        ("min", "binary"),
        ("max", "struct"),
        ("nUnique", "list"),
        ("count", "complex"),
        ("first", "struct"),
        ("last", "unknown"),
    ],
)
def test_group_aggregations_reject_nonportable_type_pairs_before_dispatch(operation: str, semantic_type: str) -> None:
    key = ref("c:key", "key")
    value = ref("c:value", "value")

    with pytest.raises(ColumnBindingError, match=rf"cannot apply '{operation}' to '{semantic_type}'"):
        bind_step(
            step(
                "groupBy",
                keys=[key],
                aggregations=[{"column": value, "operation": operation, "alias": "result"}],
            ),
            [{"name": "key", "type": "string"}, {"name": "value", "type": semantic_type}],
            [key, value],
        )


@pytest.mark.parametrize(
    "semantic_type",
    ["string", "integer", "float", "decimal", "boolean", "datetime", "date", "duration", "binary"],
)
def test_by_example_direct_columns_preserve_portable_scalar_types(semantic_type: str) -> None:
    reference = ref("c:value", "value")
    public = by_example_step(reference, expression_column(reference))

    bound = bind_step(public, [{"name": "value", "type": semantic_type}], [reference])

    expected = {"id": "c:value", "name": "value", "position": 0}
    assert bound["params"]["sourceColumns"] == [expected]
    assert bound["params"]["program"] == {"kind": "column", "column": expected}
    assert public["params"]["program"] == expression_column(reference)


@pytest.mark.parametrize(
    ("semantic_type", "program"),
    [
        (
            "string",
            {
                "kind": "case",
                "style": "upper",
                "input": expression_column(ref("c:value", "value")),
            },
        ),
        (
            "integer",
            {
                "kind": "slice",
                "input": expression_column(ref("c:value", "value")),
                "start": 0,
                "stop": 2,
            },
        ),
        (
            "date",
            {
                "kind": "datetimeFormat",
                "input": expression_column(ref("c:value", "value")),
                "inputFormat": "%Y-%m-%d",
                "outputFormat": "%d/%m/%Y",
            },
        ),
    ],
)
def test_by_example_allows_portable_text_coercions(semantic_type: str, program: dict[str, Any]) -> None:
    reference = ref("c:value", "value")

    bound = bind_step(
        by_example_step(reference, program),
        [{"name": "value", "type": semantic_type}],
        [reference],
    )

    assert bound["params"]["program"]["input"]["column"] == {
        "id": "c:value",
        "name": "value",
        "position": 0,
    }


@pytest.mark.parametrize(("semantic_type", "literal"), [("integer", 1), ("float", 1.5)])
def test_by_example_allows_portable_numeric_arithmetic(semantic_type: str, literal: int | float) -> None:
    reference = ref("c:value", "value")
    program = {
        "kind": "arithmetic",
        "left": expression_column(reference),
        "operator": "add",
        "right": {"kind": "literal", "value": literal},
    }

    bound = bind_step(
        by_example_step(reference, program),
        [{"name": "value", "type": semantic_type}],
        [reference],
    )

    assert bound["params"]["program"]["left"]["column"] == {
        "id": "c:value",
        "name": "value",
        "position": 0,
    }
    expected_type = "float" if semantic_type == "float" or isinstance(literal, float) else "integer"
    assert {key: bound["params"]["program"][key] for key in ("_owLeftType", "_owRightType", "_owResultType")} == {
        "_owLeftType": semantic_type,
        "_owRightType": "float" if isinstance(literal, float) else "integer",
        "_owResultType": expected_type,
    }


@pytest.mark.parametrize("semantic_type", ["float", "decimal", "boolean", "datetime", "duration", "binary"])
def test_by_example_rejects_nonportable_text_coercions(semantic_type: str) -> None:
    reference = ref("c:value", "value")
    program = {
        "kind": "case",
        "style": "upper",
        "input": expression_column(reference),
    }

    with pytest.raises(ColumnBindingError, match=rf"cannot apply 'case' to '{semantic_type}'"):
        bind_step(
            by_example_step(reference, program),
            [{"name": "value", "type": semantic_type}],
            [reference],
        )


@pytest.mark.parametrize(
    "program",
    [
        {
            "kind": "slice",
            "input": expression_column(ref("c:value", "value")),
            "start": 0,
            "stop": 1,
        },
        {
            "kind": "split",
            "input": expression_column(ref("c:value", "value")),
            "delimiter": "-",
            "index": 0,
        },
        {
            "kind": "concat",
            "parts": [expression_column(ref("c:value", "value")), {"kind": "literal", "value": "x"}],
        },
        {
            "kind": "regexExtract",
            "input": expression_column(ref("c:value", "value")),
            "pattern": r"(\d+)",
            "group": 1,
        },
        {
            "kind": "regexReplace",
            "input": expression_column(ref("c:value", "value")),
            "pattern": "x",
            "replacement": "y",
        },
        {
            "kind": "case",
            "style": "upper",
            "input": expression_column(ref("c:value", "value")),
        },
        {
            "kind": "datetimeFormat",
            "input": expression_column(ref("c:value", "value")),
            "inputFormat": "%Y-%m-%d",
            "outputFormat": "%Y",
        },
    ],
)
@pytest.mark.parametrize("semantic_type", ["duration", "binary"])
def test_every_by_example_text_node_rejects_duration_and_binary_sources(
    semantic_type: str,
    program: dict[str, Any],
) -> None:
    reference = ref("c:value", "value")

    with pytest.raises(ColumnBindingError, match=rf"cannot apply .* to '{semantic_type}'"):
        bind_step(
            by_example_step(reference, program),
            [{"name": "value", "type": semantic_type}],
            [reference],
        )


@pytest.mark.parametrize("semantic_type", ["decimal", "string", "boolean", "date", "datetime", "duration", "binary"])
def test_by_example_arithmetic_rejects_nonportable_operand_types(semantic_type: str) -> None:
    reference = ref("c:value", "value")
    program = {
        "kind": "arithmetic",
        "left": expression_column(reference),
        "operator": "add",
        "right": {"kind": "literal", "value": 1.0},
    }

    with pytest.raises(ColumnBindingError, match=rf"cannot apply 'arithmetic' to '{semantic_type}'"):
        bind_step(
            by_example_step(reference, program),
            [{"name": "value", "type": semantic_type}],
            [reference],
        )


@pytest.mark.parametrize("semantic_type", ["complex", "list", "struct", "unknown"])
def test_by_example_rejects_non_scalar_sources_before_program_dispatch(semantic_type: str) -> None:
    reference = ref("c:value", "value")

    with pytest.raises(ColumnBindingError, match=rf"unsupported '{semantic_type}' type"):
        bind_step(
            by_example_step(reference, expression_column(reference)),
            [{"name": "value", "type": semantic_type}],
            [reference],
        )


@pytest.mark.parametrize(
    ("program", "source_type", "semantic_type"),
    [
        (
            {
                "kind": "case",
                "style": "upper",
                "input": {"kind": "literal", "value": 1.5},
            },
            "string",
            "float",
        ),
        (
            {
                "kind": "arithmetic",
                "left": expression_column(ref("c:value", "value")),
                "operator": "add",
                "right": {"kind": "literal", "value": True},
            },
            "integer",
            "boolean",
        ),
        (
            {
                "kind": "concat",
                "parts": [expression_column(ref("c:value", "value")), {"kind": "literal", "value": None}],
            },
            "string",
            "null",
        ),
    ],
)
def test_by_example_validates_nested_literal_types(
    program: dict[str, Any],
    source_type: str,
    semantic_type: str,
) -> None:
    reference = ref("c:value", "value")

    with pytest.raises(ColumnBindingError, match=rf"cannot apply .* to '{semantic_type}'"):
        bind_step(
            by_example_step(reference, program),
            [{"name": "value", "type": source_type}],
            [reference],
        )


def test_by_example_recursively_binds_only_exact_selected_source_identities() -> None:
    selected = ref("c:selected", "duplicate")
    other = ref("c:other", "duplicate")
    schema = [{"name": "duplicate", "type": "string"}, {"name": "duplicate", "type": "string"}]
    nested_other = {
        "kind": "concat",
        "parts": [
            {"kind": "case", "style": "upper", "input": expression_column(other)},
            {"kind": "literal", "value": "suffix"},
        ],
    }

    with pytest.raises(ColumnBindingError, match="outside sourceColumns"):
        bind_step(by_example_step(selected, nested_other), schema, [selected, other])

    stale = {
        "kind": "case",
        "style": "upper",
        "input": expression_column(ref("c:selected", "renamed")),
    }
    with pytest.raises(ColumnBindingError, match="name mismatch"):
        bind_step(by_example_step(selected, stale), schema, [selected, other])


def test_by_example_type_validation_recurses_through_nested_programs() -> None:
    reference = ref("c:value", "value")
    program = {
        "kind": "concat",
        "parts": [
            {
                "kind": "arithmetic",
                "left": expression_column(reference),
                "operator": "add",
                "right": {"kind": "literal", "value": 1},
            },
            {"kind": "literal", "value": "suffix"},
        ],
    }

    with pytest.raises(ColumnBindingError, match=r"program.parts\[0\].left.*'decimal'"):
        bind_step(
            by_example_step(reference, program),
            [{"name": "value", "type": "decimal"}],
            [reference],
        )
