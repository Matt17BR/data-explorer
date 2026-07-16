from __future__ import annotations

import pytest

from openwrangler_runtime.lineage import derive_lineage, schema_with_lineage, source_lineage


def schema(*names: str):
    return [
        {
            "id": f"schema:{position}",
            "name": name,
            "position": position,
            "rawType": "object",
            "type": "string",
            "nullable": False,
        }
        for position, name in enumerate(names)
    ]


def test_duplicate_column_names_have_distinct_stable_identities() -> None:
    before_schema = schema("duplicate", "duplicate", "value")
    before = source_lineage(before_schema)

    assert [column["id"] for column in before] == ["c:source:0", "c:source:1", "c:source:2"]
    renamed = derive_lineage(
        before,
        schema("renamed", "duplicate", "value"),
        {
            "id": "rename",
            "kind": "renameColumn",
            "params": {
                "column": {"id": "c:source:0", "name": "duplicate", "position": 0},
                "newName": "renamed",
            },
        },
    )
    assert [column["id"] for column in renamed] == ["c:source:0", "c:source:1", "c:source:2"]
    assert [column["name"] for column in renamed] == ["renamed", "duplicate", "value"]
    assert [column["id"] for column in schema_with_lineage(schema("renamed", "duplicate", "value"), renamed)] == [
        "c:source:0",
        "c:source:1",
        "c:source:2",
    ]


def test_bound_structural_steps_preserve_only_the_exact_targeted_duplicate_identities() -> None:
    before = source_lineage(schema("duplicate", "duplicate", "value"))

    renamed = derive_lineage(
        before,
        schema("duplicate", "renamed", "value"),
        {
            "id": "rename-second",
            "kind": "renameColumn",
            "params": {
                "column": {"id": "c:source:1", "name": "duplicate", "position": 1},
                "newName": "renamed",
            },
        },
    )
    assert renamed == [
        {"id": "c:source:0", "name": "duplicate"},
        {"id": "c:source:1", "name": "renamed"},
        {"id": "c:source:2", "name": "value"},
    ]

    selected = derive_lineage(
        before,
        schema("value", "duplicate"),
        {
            "id": "select-exact",
            "kind": "selectColumns",
            "params": {
                "columns": [
                    {"id": "c:source:2", "name": "value", "position": 2},
                    {"id": "c:source:1", "name": "duplicate", "position": 1},
                ]
            },
        },
    )
    assert selected == [
        {"id": "c:source:2", "name": "value"},
        {"id": "c:source:1", "name": "duplicate"},
    ]

    dropped = derive_lineage(
        before,
        schema("duplicate", "value"),
        {
            "id": "drop-second",
            "kind": "dropColumns",
            "params": {"columns": [{"id": "c:source:1", "name": "duplicate", "position": 1}]},
        },
    )
    assert dropped == [
        {"id": "c:source:0", "name": "duplicate"},
        {"id": "c:source:2", "name": "value"},
    ]


def test_group_lineage_preserves_keys_and_creates_deterministic_aggregate_ids() -> None:
    before = source_lineage(schema("group", "value"))
    step = {
        "id": "group-step",
        "kind": "groupBy",
        "params": {
            "keys": ["group"],
            "aggregations": [{"column": "value", "operation": "sum", "alias": "total"}],
        },
    }
    after = derive_lineage(before, schema("group", "total"), step)

    assert after == [
        {"id": "c:source:0", "name": "group"},
        {"id": "c:step:group-step:0", "name": "total"},
    ]


def test_generated_output_identities_are_deterministic_for_replay() -> None:
    base = source_lineage(schema("a", "b"))
    step = {"id": "hot", "kind": "oneHotEncode", "params": {"columns": ["a", "b"]}}
    expected = [
        *base,
        {"id": "c:step:hot:0", "name": "a_x"},
        {"id": "c:step:hot:1", "name": "b_x"},
    ]

    assert derive_lineage(base, schema("a", "b", "a_x", "b_x"), step) == expected
    assert derive_lineage(base, schema("a", "b", "a_x", "b_x"), step) == expected


def test_schema_with_lineage_rejects_duplicate_identities() -> None:
    with pytest.raises(ValueError, match="duplicate identities"):
        schema_with_lineage(
            schema("left", "right"),
            [
                {"id": "duplicate", "name": "left"},
                {"id": "duplicate", "name": "right"},
            ],
        )
