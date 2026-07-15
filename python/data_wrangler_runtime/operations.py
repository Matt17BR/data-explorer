from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


class OperationError(ValueError):
    """Raised when a transformation step is unknown or malformed."""


@dataclass(frozen=True)
class OperationDefinition:
    kind: str
    title: str
    group: str
    required: tuple[str, ...]
    optional: tuple[str, ...] = ()


OPERATION_DEFINITIONS = (
    OperationDefinition("sortRows", "Sort rows", "Rows / order", ("rules",)),
    OperationDefinition("filterRows", "Filter rows", "Rows / order", ("filterModel",)),
    OperationDefinition("dropMissingRows", "Drop missing rows", "Rows / order", (), ("columns", "how")),
    OperationDefinition("dropDuplicates", "Drop duplicate rows", "Rows / order", (), ("columns", "keep")),
    OperationDefinition("selectColumns", "Select columns", "Columns / types", ("columns",)),
    OperationDefinition("dropColumns", "Drop columns", "Columns / types", ("columns",)),
    OperationDefinition("renameColumn", "Rename column", "Columns / types", ("column", "newName")),
    OperationDefinition("cloneColumn", "Clone column", "Columns / types", ("column", "newName")),
    OperationDefinition("castColumn", "Convert column type", "Columns / types", ("column", "dtype")),
    OperationDefinition(
        "formula",
        "Create formula column",
        "Columns / types",
        ("leftColumn", "operator", "newColumn"),
        ("rightColumn", "value"),
    ),
    OperationDefinition("textLength", "Text length", "Columns / types", ("column", "newColumn")),
    OperationDefinition(
        "oneHotEncode", "One-hot encode", "Categorical / text", ("columns",), ("prefixSeparator", "dropOriginal")
    ),
    OperationDefinition(
        "multiLabelBinarize",
        "Multi-label binarize",
        "Categorical / text",
        ("column", "delimiter"),
        ("prefix", "dropOriginal"),
    ),
    OperationDefinition(
        "findReplace",
        "Find and replace",
        "Categorical / text",
        ("column", "find", "replacement"),
        ("regex", "newColumn"),
    ),
    OperationDefinition("stripText", "Strip text", "Categorical / text", ("column",), ("characters", "newColumn")),
    OperationDefinition("splitText", "Split text", "Categorical / text", ("column", "delimiter", "index", "newColumn")),
    OperationDefinition("capitalizeText", "Capitalize text", "Categorical / text", ("column",), ("newColumn",)),
    OperationDefinition("lowerText", "Lowercase text", "Categorical / text", ("column",), ("newColumn",)),
    OperationDefinition("upperText", "Uppercase text", "Categorical / text", ("column",), ("newColumn",)),
    OperationDefinition("minMaxScale", "Min-max scale", "Numeric / datetime", ("column",), ("newColumn",)),
    OperationDefinition("roundNumber", "Round number", "Numeric / datetime", ("column",), ("decimals", "newColumn")),
    OperationDefinition("floorNumber", "Floor number", "Numeric / datetime", ("column",), ("newColumn",)),
    OperationDefinition("ceilNumber", "Ceiling number", "Numeric / datetime", ("column",), ("newColumn",)),
    OperationDefinition(
        "formatDatetime", "Format datetime", "Numeric / datetime", ("column", "format"), ("newColumn",)
    ),
    OperationDefinition("groupBy", "Group and aggregate", "Aggregation", ("keys", "aggregations")),
    OperationDefinition("customCode", "Custom engine-native code", "Custom", ("code",)),
)

OPERATION_BY_KIND = {definition.kind: definition for definition in OPERATION_DEFINITIONS}
FORMULA_OPERATORS = {"add", "subtract", "multiply", "divide", "modulo", "power"}
AGGREGATIONS = {"sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"}
CAST_DTYPES = {"string", "integer", "float", "boolean", "date", "datetime"}


def operation_catalog() -> list[dict[str, Any]]:
    return [
        {
            "kind": definition.kind,
            "title": definition.title,
            "group": definition.group,
            "required": list(definition.required),
            "optional": list(definition.optional),
        }
        for definition in OPERATION_DEFINITIONS
    ]


def validate_step(value: Mapping[str, Any]) -> dict[str, Any]:
    step_id = value.get("id")
    kind = value.get("kind")
    params = value.get("params")
    if not isinstance(step_id, str) or not step_id:
        raise OperationError("Transformation step id must be a non-empty string.")
    if not isinstance(kind, str) or kind not in OPERATION_BY_KIND:
        raise OperationError(f"Unsupported transformation operation: {kind!r}.")
    if not isinstance(params, Mapping):
        raise OperationError("Transformation params must be an object.")

    definition = OPERATION_BY_KIND[kind]
    missing = [name for name in definition.required if name not in params]
    if missing:
        raise OperationError(f"{kind} is missing required parameters: {', '.join(missing)}.")
    unexpected = set(params) - set(definition.required) - set(definition.optional)
    if unexpected:
        raise OperationError(f"{kind} contains unknown parameters: {', '.join(sorted(unexpected))}.")

    normalized = dict(params)
    _validate_common(kind, normalized)
    return {"id": step_id, "kind": kind, "params": normalized}


def _validate_common(kind: str, params: dict[str, Any]) -> None:
    for key in ("column", "newColumn", "newName", "leftColumn", "rightColumn"):
        if key in params and (not isinstance(params[key], str) or not params[key]):
            raise OperationError(f"{kind}.{key} must be a non-empty string.")
    for key in ("columns", "keys"):
        if key in params and not _is_string_list(params[key], allow_empty=kind == "dropMissingRows"):
            raise OperationError(f"{kind}.{key} must be an array of column names.")

    if kind == "sortRows":
        rules = params["rules"]
        if not isinstance(rules, list) or not rules:
            raise OperationError("sortRows.rules must be a non-empty array.")
        for rule in rules:
            if not isinstance(rule, Mapping) or not isinstance(rule.get("column"), str):
                raise OperationError("Each sort rule must name a column.")
            if rule.get("direction") not in {"asc", "desc"} or rule.get("nulls", "last") not in {"first", "last"}:
                raise OperationError("Sort directions and null ordering are invalid.")
    elif kind == "filterRows":
        model = params["filterModel"]
        if not isinstance(model, Mapping) or not isinstance(model.get("filters"), list):
            raise OperationError("filterRows.filterModel must contain a filters array.")
    elif kind == "dropMissingRows" and params.get("how", "any") not in {"any", "all"}:
        raise OperationError("dropMissingRows.how must be any or all.")
    elif kind == "dropDuplicates" and params.get("keep", "first") not in {"first", "last", "none"}:
        raise OperationError("dropDuplicates.keep must be first, last, or none.")
    elif kind == "castColumn" and params["dtype"] not in CAST_DTYPES:
        raise OperationError(f"castColumn.dtype must be one of: {', '.join(sorted(CAST_DTYPES))}.")
    elif kind == "formula":
        if params["operator"] not in FORMULA_OPERATORS:
            raise OperationError("formula.operator is not supported.")
        has_column = isinstance(params.get("rightColumn"), str)
        has_value = (
            "value" in params
            and isinstance(params.get("value"), int | float)
            and not isinstance(params.get("value"), bool)
        )
        if has_column == has_value:
            raise OperationError("formula requires exactly one of rightColumn or numeric value.")
    elif kind == "splitText" and (not isinstance(params["index"], int) or params["index"] < 0):
        raise OperationError("splitText.index must be a non-negative integer.")
    elif kind == "roundNumber" and not isinstance(params.get("decimals", 0), int):
        raise OperationError("roundNumber.decimals must be an integer.")
    elif kind == "groupBy":
        aggregations = params["aggregations"]
        if not isinstance(aggregations, list) or not aggregations:
            raise OperationError("groupBy.aggregations must be a non-empty array.")
        for aggregation in aggregations:
            if not isinstance(aggregation, Mapping):
                raise OperationError("Each aggregation must be an object.")
            if not all(isinstance(aggregation.get(key), str) and aggregation.get(key) for key in ("column", "alias")):
                raise OperationError("Each aggregation must contain column and alias names.")
            if aggregation.get("operation") not in AGGREGATIONS:
                raise OperationError(f"Unsupported aggregation: {aggregation.get('operation')!r}.")
    elif kind == "customCode" and (not isinstance(params["code"], str) or not params["code"].strip()):
        raise OperationError("customCode.code must be non-empty Python code assigning a dataframe to result.")


def _is_string_list(value: Any, *, allow_empty: bool = False) -> bool:
    return (
        isinstance(value, list)
        and (allow_empty or bool(value))
        and all(isinstance(item, str) and item for item in value)
    )
