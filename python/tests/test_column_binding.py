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
