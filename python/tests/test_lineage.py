from __future__ import annotations

from data_wrangler_runtime.lineage import derive_lineage, schema_with_lineage, source_lineage


def schema(*names: str):
    return [
        {
            "id": f"legacy:{position}",
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
        schema("renamed", "renamed", "value"),
        {"id": "rename", "kind": "renameColumn", "params": {"column": "duplicate", "newName": "renamed"}},
    )
    assert [column["id"] for column in renamed] == ["c:source:0", "c:source:1", "c:source:2"]
    assert [column["name"] for column in renamed] == ["renamed", "renamed", "value"]
    assert [column["id"] for column in schema_with_lineage(schema("renamed", "renamed", "value"), renamed)] == [
        "c:source:0",
        "c:source:1",
        "c:source:2",
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
