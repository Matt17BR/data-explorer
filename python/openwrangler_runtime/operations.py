from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .by_example import SynthesisError, normalize_by_example
from .engines.base import is_internal_row_id_label


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
    OperationDefinition(
        "byExample",
        "Transform by example",
        "By example",
        ("sourceColumns", "newColumn", "examples"),
        ("program", "warnings", "candidateCount"),
    ),
    OperationDefinition("customCode", "Custom engine-native code", "Custom", ("code",)),
)

OPERATION_BY_KIND = {definition.kind: definition for definition in OPERATION_DEFINITIONS}
FORMULA_OPERATORS = {"add", "subtract", "multiply", "divide", "modulo", "power"}
AGGREGATIONS = {"sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"}
CAST_DTYPES = {"string", "integer", "float", "boolean", "date", "datetime"}
FILTER_OPERATORS = {
    "equals",
    "notEquals",
    "contains",
    "startsWith",
    "endsWith",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "isNull",
    "isNotNull",
    "isNaN",
    "isNotNaN",
}
COLUMN_TYPES = {
    "string",
    "integer",
    "float",
    "decimal",
    "boolean",
    "datetime",
    "date",
    "duration",
    "binary",
    "list",
    "struct",
    "unknown",
}
_COLUMN_REFERENCE_FIELDS: dict[str, tuple[str, ...]] = {
    "renameColumn": ("column",),
    "cloneColumn": ("column",),
    "castColumn": ("column",),
    "formula": ("leftColumn", "rightColumn"),
    "textLength": ("column",),
    "multiLabelBinarize": ("column",),
    "findReplace": ("column",),
    "stripText": ("column",),
    "splitText": ("column",),
    "capitalizeText": ("column",),
    "lowerText": ("column",),
    "upperText": ("column",),
    "minMaxScale": ("column",),
    "roundNumber": ("column",),
    "floorNumber": ("column",),
    "ceilNumber": ("column",),
    "formatDatetime": ("column",),
}
_COLUMN_REFERENCE_LIST_FIELDS: dict[str, tuple[str, ...]] = {
    "selectColumns": ("columns",),
    "dropColumns": ("columns",),
    "oneHotEncode": ("columns",),
    "groupBy": ("keys",),
    "byExample": ("sourceColumns",),
}


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
    if kind == "byExample":
        try:
            normalized = normalize_by_example(normalized)
        except SynthesisError as error:
            raise OperationError(str(error)) from error
    _reject_private_column_namespace(kind, normalized)
    return {"id": step_id, "kind": kind, "params": normalized}


def _validate_common(kind: str, params: dict[str, Any]) -> None:
    reference_fields = _COLUMN_REFERENCE_FIELDS.get(kind, ())
    for key in reference_fields:
        if key in params:
            params[key] = _normalize_column_reference(params[key], f"{kind}.{key}")
    for key in _COLUMN_REFERENCE_LIST_FIELDS.get(kind, ()):
        params[key] = _normalize_column_reference_list(params[key], f"{kind}.{key}")

    if kind == "dropMissingRows" and "columns" in params:
        params["columns"] = _normalize_column_reference_list(
            params["columns"], "dropMissingRows.columns", allow_empty=True
        )
    elif kind == "dropDuplicates" and "columns" in params:
        params["columns"] = _normalize_column_reference_list(params["columns"], "dropDuplicates.columns")

    for key in ("column", "newColumn", "newName", "leftColumn", "rightColumn"):
        if key in reference_fields:
            continue
        if key in params and (not isinstance(params[key], str) or not params[key]):
            raise OperationError(f"{kind}.{key} must be a non-empty string.")
    for key in ("columns", "keys"):
        if key in _COLUMN_REFERENCE_LIST_FIELDS.get(kind, ()):
            continue
        if key == "columns" and kind in {"dropMissingRows", "dropDuplicates"}:
            continue
        if key in params and not _is_string_list(params[key], allow_empty=kind == "dropMissingRows"):
            raise OperationError(f"{kind}.{key} must be an array of column names.")
    for key in ("dropOriginal", "regex"):
        if key in params and not isinstance(params[key], bool):
            raise OperationError(f"{kind}.{key} must be a boolean.")

    if kind == "sortRows":
        params["rules"] = _normalize_transform_sort_rules(params["rules"], "sortRows.rules", allow_empty=False)
    elif kind == "filterRows":
        params["filterModel"] = _normalize_transform_filter_model(params["filterModel"])
    elif kind == "dropMissingRows" and params.get("how", "any") not in {"any", "all"}:
        raise OperationError("dropMissingRows.how must be any or all.")
    elif kind == "dropDuplicates" and params.get("keep", "first") not in {"first", "last", "none"}:
        raise OperationError("dropDuplicates.keep must be first, last, or none.")
    elif kind == "castColumn" and params["dtype"] not in CAST_DTYPES:
        raise OperationError(f"castColumn.dtype must be one of: {', '.join(sorted(CAST_DTYPES))}.")
    elif kind == "formula":
        if params["operator"] not in FORMULA_OPERATORS:
            raise OperationError("formula.operator is not supported.")
        has_column = "rightColumn" in params
        has_value = (
            "value" in params
            and isinstance(params.get("value"), int | float)
            and not isinstance(params.get("value"), bool)
        )
        if has_column == has_value:
            raise OperationError("formula requires exactly one of rightColumn or numeric value.")
    elif kind == "oneHotEncode" and not isinstance(params.get("prefixSeparator", "_"), str):
        raise OperationError("oneHotEncode.prefixSeparator must be a string.")
    elif kind == "multiLabelBinarize":
        if not isinstance(params["delimiter"], str) or not params["delimiter"]:
            raise OperationError("multiLabelBinarize.delimiter must be a non-empty string.")
        if not isinstance(params.get("prefix", ""), str):
            raise OperationError("multiLabelBinarize.prefix must be a string.")
    elif kind == "findReplace":
        if not isinstance(params["find"], str) or not isinstance(params["replacement"], str):
            raise OperationError("findReplace.find and replacement must be strings.")
    elif (
        kind == "stripText"
        and params.get("characters") is not None
        and (not isinstance(params["characters"], str) or not params["characters"])
    ):
        raise OperationError("stripText.characters must be a non-empty string or null.")
    elif kind == "splitText":
        if not isinstance(params["delimiter"], str) or not params["delimiter"]:
            raise OperationError("splitText.delimiter must be a non-empty string.")
        if isinstance(params["index"], bool) or not isinstance(params["index"], int) or params["index"] < 0:
            raise OperationError("splitText.index must be a non-negative integer.")
    elif kind == "roundNumber" and (
        isinstance(params.get("decimals", 0), bool) or not isinstance(params.get("decimals", 0), int)
    ):
        raise OperationError("roundNumber.decimals must be an integer.")
    elif kind == "formatDatetime" and (not isinstance(params["format"], str) or not params["format"]):
        raise OperationError("formatDatetime.format must be a non-empty string.")
    elif kind == "groupBy":
        aggregations = params["aggregations"]
        if not isinstance(aggregations, list) or not aggregations:
            raise OperationError("groupBy.aggregations must be a non-empty array.")
        normalized_aggregations: list[dict[str, Any]] = []
        for index, aggregation in enumerate(aggregations):
            if not isinstance(aggregation, Mapping):
                raise OperationError("Each aggregation must be an object.")
            fields = set(aggregation)
            missing = {"column", "operation", "alias"} - fields
            if missing:
                raise OperationError("Each aggregation is missing required fields: " + ", ".join(sorted(missing)) + ".")
            unexpected = fields - {"column", "operation", "alias"}
            if unexpected:
                raise OperationError(
                    "Each aggregation contains unknown fields: " + ", ".join(sorted(map(str, unexpected))) + "."
                )
            if not isinstance(aggregation.get("alias"), str) or not aggregation["alias"]:
                raise OperationError("Each aggregation must contain a non-empty alias.")
            if aggregation.get("operation") not in AGGREGATIONS:
                raise OperationError(f"Unsupported aggregation: {aggregation.get('operation')!r}.")
            normalized_aggregations.append(
                {
                    "column": _normalize_column_reference(
                        aggregation.get("column"), f"groupBy.aggregations[{index}].column"
                    ),
                    "operation": aggregation["operation"],
                    "alias": aggregation["alias"],
                }
            )
        params["aggregations"] = normalized_aggregations
        aliases = [str(aggregation["alias"]) for aggregation in normalized_aggregations]
        if len(aliases) != len(set(aliases)):
            raise OperationError("groupBy aggregation aliases must be unique.")
        key_names = {reference["name"] for reference in params["keys"]}
        if key_names & set(aliases):
            raise OperationError("groupBy aggregation aliases cannot duplicate a group key.")
    elif kind == "customCode" and (not isinstance(params["code"], str) or not params["code"].strip()):
        raise OperationError("customCode.code must be non-empty Python code assigning a dataframe to result.")


def _normalize_column_reference(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise OperationError(f"{label} must be a column reference object containing id and name.")
    missing = {"id", "name"} - set(value)
    if missing:
        raise OperationError(f"{label} is missing required fields: {', '.join(sorted(missing))}.")
    unexpected = set(value) - {"id", "name"}
    if unexpected:
        raise OperationError(f"{label} contains unknown fields: {', '.join(sorted(map(str, unexpected)))}.")
    reference_id = value["id"]
    name = value["name"]
    if not isinstance(reference_id, str) or not reference_id:
        raise OperationError(f"{label}.id must be a non-empty string.")
    if not isinstance(name, str):
        raise OperationError(f"{label}.name must be a string.")
    return {"id": reference_id, "name": name}


def _normalize_column_reference_list(
    value: Any,
    label: str,
    *,
    allow_empty: bool = False,
) -> list[dict[str, str]]:
    if not isinstance(value, list) or (not allow_empty and not value):
        qualifier = "an array" if allow_empty else "a non-empty array"
        raise OperationError(f"{label} must be {qualifier} of column references.")
    normalized = [_normalize_column_reference(item, f"{label}[{index}]") for index, item in enumerate(value)]
    identifiers = [reference["id"] for reference in normalized]
    if len(identifiers) != len(set(identifiers)):
        raise OperationError(f"{label} contains duplicate column identities.")
    return normalized


def _normalize_transform_sort_rules(value: Any, label: str, *, allow_empty: bool) -> list[dict[str, Any]]:
    if not isinstance(value, list) or (not allow_empty and not value):
        qualifier = "an array" if allow_empty else "a non-empty array"
        raise OperationError(f"{label} must be {qualifier}.")
    normalized: list[dict[str, Any]] = []
    for index, rule in enumerate(value):
        rule_label = f"{label}[{index}]"
        if not isinstance(rule, Mapping):
            raise OperationError(f"{rule_label} must be an object.")
        fields = set(rule)
        missing = {"column", "direction", "nulls"} - fields
        if missing:
            raise OperationError(f"{rule_label} is missing required fields: {', '.join(sorted(missing))}.")
        unexpected = fields - {"column", "direction", "nulls"}
        if unexpected:
            raise OperationError(f"{rule_label} contains unknown fields: {', '.join(sorted(map(str, unexpected)))}.")
        if rule.get("direction") not in {"asc", "desc"} or rule.get("nulls") not in {"first", "last"}:
            raise OperationError("Sort directions and null ordering are invalid.")
        normalized.append(
            {
                "column": _normalize_column_reference(rule.get("column"), f"{rule_label}.column"),
                "direction": rule["direction"],
                "nulls": rule["nulls"],
            }
        )
    _reject_duplicate_reference_identities((rule["column"] for rule in normalized), label)
    return normalized


def _normalize_transform_filter_model(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise OperationError("filterRows.filterModel must be an object.")
    fields = set(value)
    missing = {"filters", "sort"} - fields
    if missing:
        raise OperationError(f"filterRows.filterModel is missing required fields: {', '.join(sorted(missing))}.")
    unexpected = fields - {"logic", "filters", "sort"}
    if unexpected:
        raise OperationError(
            f"filterRows.filterModel contains unknown fields: {', '.join(sorted(map(str, unexpected)))}."
        )
    if not isinstance(value.get("filters"), list):
        raise OperationError("filterRows.filterModel.filters must be an array.")
    if value.get("logic", "and") not in {"and", "or"}:
        raise OperationError("filterRows.filterModel.logic must be either 'and' or 'or'.")
    sort = _normalize_transform_sort_rules(value["sort"], "filterRows.filterModel.sort", allow_empty=True)

    filters: list[dict[str, Any]] = []
    for index, column_filter in enumerate(value["filters"]):
        label = f"filterRows.filterModel.filters[{index}]"
        if not isinstance(column_filter, Mapping):
            raise OperationError(f"{label} must be an object.")
        filter_fields = set(column_filter)
        missing = {"column", "type", "predicates"} - filter_fields
        if missing:
            raise OperationError(f"{label} is missing required fields: {', '.join(sorted(missing))}.")
        unexpected = filter_fields - {"column", "type", "logic", "valueFilter", "predicates"}
        if unexpected:
            raise OperationError(f"{label} contains unknown fields: {', '.join(sorted(map(str, unexpected)))}.")
        if column_filter.get("type") not in COLUMN_TYPES:
            raise OperationError(f"{label}.type is not a supported column type.")
        if column_filter.get("logic", "and") not in {"and", "or"}:
            raise OperationError("Column filter logic must be either 'and' or 'or'.")
        predicates = column_filter["predicates"]
        if not isinstance(predicates, list):
            raise OperationError("Column filter predicates must be an array.")
        normalized_predicates: list[dict[str, Any]] = []
        for predicate_index, predicate in enumerate(predicates):
            predicate_label = f"{label}.predicates[{predicate_index}]"
            if not isinstance(predicate, Mapping):
                raise OperationError(f"{predicate_label} must be an object.")
            predicate_fields = set(predicate)
            missing = {"kind", "operator"} - predicate_fields
            if missing:
                raise OperationError(f"{predicate_label} is missing required fields: {', '.join(sorted(missing))}.")
            unexpected = predicate_fields - {"kind", "operator", "value", "secondValue"}
            if unexpected:
                raise OperationError(
                    f"{predicate_label} contains unknown fields: {', '.join(sorted(map(str, unexpected)))}."
                )
            if predicate.get("kind") != "predicate":
                raise OperationError(f"{predicate_label}.kind must be 'predicate'.")
            operator = predicate.get("operator") if isinstance(predicate, Mapping) else None
            if operator not in FILTER_OPERATORS:
                raise OperationError(f"Unsupported filter operator: {operator!r}.")
            if operator not in {"isNull", "isNotNull", "isNaN", "isNotNaN"} and "value" not in predicate:
                raise OperationError(f"Filter operator {operator} requires a value.")
            if operator == "between" and "secondValue" not in predicate:
                raise OperationError("Filter operator between requires a secondValue.")
            normalized_predicates.append(dict(predicate))

        value_filter = column_filter.get("valueFilter")
        if value_filter is not None:
            if not isinstance(value_filter, Mapping):
                raise OperationError("Column valueFilter must be an object.")
            value_fields = set(value_filter)
            missing = {"kind", "selectedValues", "includeNulls", "includeNaN"} - value_fields
            if missing:
                raise OperationError(f"Column valueFilter is missing required fields: {', '.join(sorted(missing))}.")
            unexpected = value_fields - {"kind", "selectedValues", "includeNulls", "includeNaN", "search"}
            if unexpected:
                raise OperationError(
                    f"Column valueFilter contains unknown fields: {', '.join(sorted(map(str, unexpected)))}."
                )
            if value_filter.get("kind") != "values" or not isinstance(value_filter.get("selectedValues"), list):
                raise OperationError("Column valueFilter must contain kind 'values' and a selectedValues array.")
            for key in ("includeNulls", "includeNaN"):
                if not isinstance(value_filter[key], bool):
                    raise OperationError(f"Column valueFilter.{key} must be a boolean.")
            if "search" in value_filter and not isinstance(value_filter["search"], str):
                raise OperationError("Column valueFilter.search must be a string.")

        normalized_filter = {
            **dict(column_filter),
            "column": _normalize_column_reference(column_filter.get("column"), f"{label}.column"),
            "predicates": normalized_predicates,
        }
        if value_filter is not None:
            normalized_filter["valueFilter"] = dict(value_filter)
        filters.append(normalized_filter)

    _reject_duplicate_reference_identities(
        (column_filter["column"] for column_filter in filters),
        "filterRows.filterModel.filters",
    )

    normalized: dict[str, Any] = {"filters": filters, "sort": sort}
    if "logic" in value:
        normalized["logic"] = value["logic"]
    return normalized


def _reject_duplicate_reference_identities(
    references: Any,
    label: str,
) -> None:
    identifiers = [reference["id"] for reference in references]
    if len(identifiers) != len(set(identifiers)):
        raise OperationError(f"{label} contains duplicate column identities.")


def _reject_private_column_namespace(kind: str, params: Mapping[str, Any]) -> None:
    """Keep every public operation away from the session's hidden row token."""

    references: list[tuple[str, Any]] = []
    if kind == "sortRows":
        references.extend(("rules.column.name", rule["column"].get("name")) for rule in params["rules"])
    elif kind == "filterRows":
        model = params["filterModel"]
        references.extend(("filterModel.filters.column.name", item["column"].get("name")) for item in model["filters"])
        references.extend(
            ("filterModel.sort.column.name", item["column"].get("name")) for item in model.get("sort", [])
        )
    elif kind in {"dropMissingRows", "dropDuplicates"}:
        references.extend(("columns.name", item.get("name")) for item in params.get("columns", []))
    elif kind in {"selectColumns", "dropColumns", "oneHotEncode"}:
        references.extend(("columns.name", item.get("name")) for item in params["columns"])
    elif kind in {
        "renameColumn",
        "cloneColumn",
        "castColumn",
        "textLength",
        "multiLabelBinarize",
        "findReplace",
        "stripText",
        "splitText",
        "capitalizeText",
        "lowerText",
        "upperText",
        "minMaxScale",
        "roundNumber",
        "floorNumber",
        "ceilNumber",
        "formatDatetime",
    }:
        references.append(("column.name", params["column"].get("name")))
    elif kind == "formula":
        references.append(("leftColumn.name", params["leftColumn"].get("name")))
        if "rightColumn" in params:
            references.append(("rightColumn.name", params["rightColumn"].get("name")))
    elif kind == "groupBy":
        references.extend(("keys.name", reference.get("name")) for reference in params["keys"])
        for aggregation in params["aggregations"]:
            references.extend(
                (
                    ("aggregations.column.name", aggregation["column"].get("name")),
                    ("aggregations.alias", aggregation["alias"]),
                )
            )
    elif kind == "byExample":
        references.extend(("sourceColumns.name", reference.get("name")) for reference in params["sourceColumns"])

    for output_field in ("newName", "newColumn"):
        if output_field in params:
            references.append((output_field, params[output_field]))
    if kind == "multiLabelBinarize" and "prefix" in params:
        references.append(("prefix", params["prefix"]))

    for label, name in references:
        if is_internal_row_id_label(name):
            raise OperationError(f"{kind}.{label} uses Open Wrangler's reserved private row-identity prefix.")


def _is_string_list(value: Any, *, allow_empty: bool = False) -> bool:
    return (
        isinstance(value, list)
        and (allow_empty or bool(value))
        and all(isinstance(item, str) and item for item in value)
    )
