from __future__ import annotations

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


def step(kind: str, **params: object) -> dict[str, object]:
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
    ],
)
def test_binding_rejects_structural_output_name_collisions(operation) -> None:
    with pytest.raises(ColumnBindingError, match="collides with an existing column"):
        bind_step(operation, SCHEMA, LINEAGE)


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


def test_binding_copies_operations_outside_the_id_backed_set() -> None:
    public = step("roundNumber", column="value", decimals=1)

    bound = bind_step(public, SCHEMA, LINEAGE)

    assert bound == public
    assert bound is not public
    assert bound["params"] is not public["params"]
