from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Mapping, Sequence
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
        target = params["column"]
        target_id = _reference_id(target)
        _require_known_ids(candidates, {target_id})
        candidates = [
            {
                "id": column["id"],
                "name": str(params["newName"]) if column["id"] == target_id else column["name"],
            }
            for column in candidates
        ]
    elif kind == "selectColumns":
        candidates = _selected_candidates(candidates, params["columns"])
    elif kind == "dropColumns":
        references = params["columns"]
        bound_ids = {_reference_id(reference) for reference in references}
        _require_known_ids(candidates, bound_ids)
        candidates = [column for column in candidates if column["id"] not in bound_ids]
    elif kind == "oneHotEncode" and params.get("dropOriginal", True):
        bound_ids = {_reference_id(reference) for reference in params["columns"]}
        _require_known_ids(candidates, bound_ids)
        candidates = [column for column in candidates if column["id"] not in bound_ids]
    elif kind == "multiLabelBinarize" and params.get("dropOriginal", False):
        bound_id = _reference_id(params["column"])
        _require_known_ids(candidates, {bound_id})
        candidates = [column for column in candidates if column["id"] != bound_id]
    elif kind == "groupBy":
        candidates = _selected_candidates(candidates, params["keys"])
        for index, aggregation in enumerate(params["aggregations"]):
            candidates.append({"id": _step_column_id(step, index), "name": str(aggregation["alias"])})
    return _align(candidates, after_schema, step)


def schema_with_lineage(
    schema: Sequence[Mapping[str, Any]], lineage: Sequence[Mapping[str, str]]
) -> list[dict[str, Any]]:
    if len(schema) != len(lineage):
        raise ValueError("Column lineage does not match the dataframe schema.")
    _require_unique_lineage_ids(lineage, "dataframe")
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


def _reference_id(reference: Any) -> str:
    if not isinstance(reference, Mapping):
        raise ValueError("Structural column lineage requires a bound column reference.")
    identifier = reference.get("id")
    if not isinstance(identifier, str) or not identifier:
        raise ValueError("Structural column lineage requires a non-empty bound column identity.")
    return identifier


def _selected_candidates(candidates: Sequence[Mapping[str, str]], references: Sequence[Any]) -> ColumnLineage:
    by_id = {column["id"]: column for column in candidates}
    bound_ids = [_reference_id(reference) for reference in references]
    try:
        return [dict(by_id[identifier]) for identifier in bound_ids]
    except KeyError as error:
        raise ValueError(f"Structural column lineage contains an unknown identity: {error.args[0]}") from error


def _require_known_ids(candidates: Sequence[Mapping[str, str]], identifiers: set[str]) -> None:
    available = {column["id"] for column in candidates}
    unknown = sorted(identifiers - available)
    if unknown:
        raise ValueError(f"Structural column lineage contains an unknown identity: {unknown[0]}")


def _require_unique_lineage_ids(lineage: Sequence[Mapping[str, str]], label: str) -> None:
    identifiers = [column.get("id") for column in lineage]
    if any(not isinstance(identifier, str) or not identifier for identifier in identifiers):
        raise ValueError(f"The {label} column lineage contains an invalid identity.")
    if len(identifiers) != len(set(identifiers)):
        raise ValueError(f"The {label} column lineage contains duplicate identities.")
