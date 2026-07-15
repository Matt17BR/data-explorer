from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
from contextlib import suppress
from typing import Any

ColumnLineage = list[dict[str, str]]


def source_lineage(schema: Sequence[Mapping[str, Any]]) -> ColumnLineage:
    return [{"id": f"c:source:{position}", "name": str(column["name"])} for position, column in enumerate(schema)]


def derive_lineage(
    before: Sequence[Mapping[str, str]],
    after_schema: Sequence[Mapping[str, Any]],
    step: Mapping[str, Any],
) -> ColumnLineage:
    kind = str(step["kind"])
    params = step["params"]
    candidates = [dict(column) for column in before]
    if kind == "renameColumn":
        candidates = [
            {
                "id": column["id"],
                "name": str(params["newName"]) if column["name"] == params["column"] else column["name"],
            }
            for column in candidates
        ]
    elif kind == "groupBy":
        by_name = _pools(candidates)
        candidates = []
        for name in params["keys"]:
            existing = by_name[str(name)]
            if existing:
                candidates.append({"id": existing.popleft(), "name": str(name)})
        for index, aggregation in enumerate(params["aggregations"]):
            candidates.append({"id": _step_column_id(step, index), "name": str(aggregation["alias"])})
    return _align(candidates, after_schema, step)


def reuse_latest_output_ids(
    draft: Sequence[Mapping[str, str]],
    committed: Sequence[Mapping[str, str]],
    base: Sequence[Mapping[str, str]],
) -> ColumnLineage:
    base_ids = {column["id"] for column in base}
    preferred = _pools(committed)
    result: ColumnLineage = []
    for column in draft:
        identifier = column["id"]
        matching = preferred[column["name"]]
        if identifier in base_ids:
            with suppress(ValueError):
                matching.remove(identifier)
        elif matching:
            identifier = matching.popleft()
        result.append({"id": identifier, "name": column["name"]})
    return result


def schema_with_lineage(
    schema: Sequence[Mapping[str, Any]], lineage: Sequence[Mapping[str, str]]
) -> list[dict[str, Any]]:
    if len(schema) != len(lineage):
        raise ValueError("Column lineage does not match the dataframe schema.")
    result = []
    for position, (column, identity) in enumerate(zip(schema, lineage, strict=True)):
        if str(column["name"]) != identity["name"]:
            raise ValueError("Column lineage order does not match the dataframe schema.")
        result.append({**column, "id": identity["id"], "position": position})
    return result


def _align(
    candidates: Sequence[Mapping[str, str]],
    after_schema: Sequence[Mapping[str, Any]],
    step: Mapping[str, Any],
) -> ColumnLineage:
    by_name = _pools(candidates)
    aligned: ColumnLineage = []
    created = 0
    for column in after_schema:
        name = str(column["name"])
        identifier = by_name[name].popleft() if by_name[name] else _step_column_id(step, created)
        if not any(candidate["id"] == identifier for candidate in candidates):
            created += 1
        aligned.append({"id": identifier, "name": name})
    return aligned


def _pools(columns: Sequence[Mapping[str, str]]) -> defaultdict[str, deque[str]]:
    pools: defaultdict[str, deque[str]] = defaultdict(deque)
    for column in columns:
        pools[column["name"]].append(column["id"])
    return pools


def _step_column_id(step: Mapping[str, Any], ordinal: int) -> str:
    return f"c:step:{step['id']}:{ordinal}"
