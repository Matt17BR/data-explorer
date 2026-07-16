from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .engines.base import is_internal_row_id_label


class ColumnBindingError(ValueError):
    """Raised when a public column reference cannot bind to one exact input column."""


@dataclass(frozen=True, slots=True)
class _Column:
    identifier: str
    name: str
    position: int

    def bound_reference(self) -> dict[str, str | int]:
        return {"id": self.identifier, "name": self.name, "position": self.position}


class _BindingContext:
    def __init__(
        self,
        schema: Sequence[Mapping[str, Any]],
        lineage: Sequence[Mapping[str, str]],
    ) -> None:
        if len(schema) != len(lineage):
            raise ColumnBindingError("Column binding schema and lineage lengths differ.")

        self.columns: list[_Column] = []
        self.by_id: dict[str, _Column] = {}
        for position, (schema_column, identity) in enumerate(zip(schema, lineage, strict=True)):
            if not isinstance(schema_column, Mapping) or "name" not in schema_column:
                raise ColumnBindingError(f"Column schema at position {position} has no name.")
            if not isinstance(identity, Mapping):
                raise ColumnBindingError(f"Column lineage at position {position} must be an object.")
            schema_name = str(schema_column["name"])
            identifier = identity.get("id")
            identity_name = identity.get("name")
            if not isinstance(identifier, str) or not identifier:
                raise ColumnBindingError(f"Column lineage at position {position} has an invalid identity.")
            if not isinstance(identity_name, str):
                raise ColumnBindingError(f"Column lineage at position {position} has an invalid name.")
            if schema_name != identity_name:
                raise ColumnBindingError(
                    f"Column lineage name mismatch at position {position}: "
                    f"schema has {schema_name!r}, lineage has {identity_name!r}."
                )
            if identifier in self.by_id:
                raise ColumnBindingError(f"Duplicate column identity in the input schema: {identifier}")
            column = _Column(identifier, schema_name, position)
            self.columns.append(column)
            self.by_id[identifier] = column

    def bind(self, reference: Any, label: str) -> dict[str, str | int]:
        if not isinstance(reference, Mapping):
            raise ColumnBindingError(f"{label} must be a column reference.")
        fields = set(reference)
        if fields != {"id", "name"}:
            missing = {"id", "name"} - fields
            if missing:
                raise ColumnBindingError(f"{label} is missing required fields: {', '.join(sorted(missing))}.")
            unexpected = fields - {"id", "name"}
            raise ColumnBindingError(
                f"{label} contains unknown fields: {', '.join(sorted(str(field) for field in unexpected))}."
            )
        identifier = reference.get("id")
        name = reference.get("name")
        if not isinstance(identifier, str) or not identifier:
            raise ColumnBindingError(f"{label}.id must be a non-empty string.")
        if not isinstance(name, str):
            raise ColumnBindingError(f"{label}.name must be a string.")
        column = self.by_id.get(identifier)
        if column is None:
            raise ColumnBindingError(f"Unknown or stale column identity for {label}: {identifier}")
        if name != column.name:
            raise ColumnBindingError(
                f"Column reference name mismatch for {label}: identity {identifier} is {column.name!r}, not {name!r}."
            )
        return column.bound_reference()

    def bind_many(self, references: Any, label: str) -> list[dict[str, str | int]]:
        if not isinstance(references, list):
            raise ColumnBindingError(f"{label} must be an array of column references.")
        bound: list[dict[str, str | int]] = []
        seen: set[str] = set()
        for index, reference in enumerate(references):
            item = self.bind(reference, f"{label}[{index}]")
            identifier = str(item["id"])
            if identifier in seen:
                raise ColumnBindingError(f"{label} contains duplicate column identity: {identifier}")
            seen.add(identifier)
            bound.append(item)
        return bound

    def reject_output_collision(
        self,
        output_name: Any,
        label: str,
        *,
        replacing: Mapping[str, Any] | None = None,
    ) -> None:
        if not isinstance(output_name, str) or not output_name:
            raise ColumnBindingError(f"{label} must be a non-empty string.")
        if is_internal_row_id_label(output_name):
            raise ColumnBindingError(f"{label} uses Open Wrangler's reserved private row-identity prefix.")
        replacing_id = None if replacing is None else str(replacing["id"])
        if any(column.name == output_name and column.identifier != replacing_id for column in self.columns):
            raise ColumnBindingError(f"{label} collides with an existing column: {output_name}")


def bind_step(
    step: Mapping[str, Any],
    schema: Sequence[Mapping[str, Any]],
    lineage: Sequence[Mapping[str, str]],
) -> dict[str, Any]:
    """Bind public stable references to one exact dataframe schema.

    Only operations whose public contract uses ``ColumnReference`` are bound.
    Other operations are copied unchanged so a session can keep one parallel
    executable plan without leaking private positions into persisted metadata.
    """

    bound = deepcopy(dict(step))
    kind = str(bound.get("kind", ""))
    if kind not in {
        "selectColumns",
        "dropColumns",
        "renameColumn",
        "cloneColumn",
        "castColumn",
        "formula",
        "textLength",
    }:
        return bound

    params = bound.get("params")
    if not isinstance(params, dict):
        raise ColumnBindingError(f"{kind}.params must be an object.")
    context = _BindingContext(schema, lineage)

    if kind in {"selectColumns", "dropColumns"}:
        params["columns"] = context.bind_many(params.get("columns"), f"{kind}.columns")
        if kind == "dropColumns" and len(params["columns"]) == len(context.columns):
            raise ColumnBindingError("dropColumns must leave at least one visible column.")
        return bound

    if kind in {"renameColumn", "cloneColumn", "castColumn", "textLength"}:
        params["column"] = context.bind(params.get("column"), f"{kind}.column")

    if kind == "renameColumn":
        context.reject_output_collision(params.get("newName"), "renameColumn.newName", replacing=params["column"])
    elif kind == "cloneColumn":
        context.reject_output_collision(params.get("newName"), "cloneColumn.newName")
    elif kind == "formula":
        params["leftColumn"] = context.bind(params.get("leftColumn"), "formula.leftColumn")
        if "rightColumn" in params:
            params["rightColumn"] = context.bind(params.get("rightColumn"), "formula.rightColumn")
        context.reject_output_collision(params.get("newColumn"), "formula.newColumn")
    elif kind == "textLength":
        context.reject_output_collision(params.get("newColumn"), "textLength.newColumn")

    return bound
