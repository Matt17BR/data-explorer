from __future__ import annotations

import json
from abc import ABC, abstractmethod
from base64 import b64encode
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from math import isfinite, isinf, isnan
from numbers import Integral, Real
from typing import Any, Literal

ColumnType = Literal[
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
]
EngineSourceKind = Literal["file", "notebookVariable", "notebookOutput"]
ExportFormat = Literal["csv", "parquet"]
PageColumnProjection = Sequence[tuple[int, str]]

INTERNAL_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_"
_INTERNAL_ROW_ID_PREFIX_CASEFOLD = INTERNAL_ROW_ID_PREFIX.casefold()
DEFAULT_STRIP_CHARACTERS = (
    " \t\n\r\v\f"
    "\x1c\x1d\x1e\x1f"
    "\x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)


def is_internal_row_id_label(value: Any) -> bool:
    """Recognize the private label on flat and Pandas MultiIndex columns."""

    if isinstance(value, str):
        return value.casefold().startswith(_INTERNAL_ROW_ID_PREFIX_CASEFOLD)
    return (
        isinstance(value, tuple)
        and bool(value)
        and isinstance(value[0], str)
        and value[0].casefold().startswith(_INTERNAL_ROW_ID_PREFIX_CASEFOLD)
    )


class EngineError(RuntimeError):
    """Raised when a backend cannot satisfy an Open Wrangler request."""


@dataclass(frozen=True, slots=True)
class EngineCapabilities:
    """Immutable description of the work an engine can own."""

    source_kinds: frozenset[EngineSourceKind]
    supports_editing: bool
    lazy_file_extensions: frozenset[str]
    export_formats: frozenset[ExportFormat]
    supports_shutdown_interrupt: bool
    supports_request_cancellation: bool


@dataclass(frozen=True)
class ColumnSchema:
    name: str
    raw_type: str
    type: ColumnType
    nullable: bool


class DataFrameEngine(ABC):
    name: str
    capabilities: EngineCapabilities

    def interrupt(self) -> None:
        """Request interruption of current work when the engine supports it."""
        return None

    def close(self) -> None:
        """Release resources owned by this engine instance."""
        return None

    def internal_row_id_column(self, frame: Any) -> Any | None:
        """Return the one private row-identity column, rejecting ambiguous frames."""

        matches = [label for label in self._raw_column_labels(frame) if is_internal_row_id_label(label)]
        if len(matches) > 1:
            raise EngineError(
                "A dataframe contains multiple columns in Open Wrangler's private row-identity namespace."
            )
        return matches[0] if matches else None

    def validate_internal_row_id_namespace(self, frame: Any, allowed_internal: Any | None = None) -> None:
        """Reject user columns that could be mistaken for private row identities."""

        matches = [label for label in self._raw_column_labels(frame) if is_internal_row_id_label(label)]
        if allowed_internal is None:
            unexpected = matches
        else:
            unexpected = [label for label in matches if label != allowed_internal]
            if matches.count(allowed_internal) > 1:
                unexpected.append(allowed_internal)
        if unexpected:
            raise EngineError("Column names beginning with Open Wrangler's private row-identity prefix are reserved.")

    def validate_column_addressability(self, frame: Any) -> None:
        """Reject schemas an adapter cannot target without ambiguity."""

        return None

    def validate_transformation_result(self, frame: Any) -> None:
        """Require an engine-portable dataframe result with visible data columns."""

        if not any(not is_internal_row_id_label(label) for label in self._raw_column_labels(frame)):
            raise EngineError("A transformation must leave at least one visible column.")

    @staticmethod
    def _raw_column_labels(frame: Any) -> list[Any]:
        collect_schema = getattr(frame, "collect_schema", None)
        if callable(collect_schema):
            names = getattr(collect_schema(), "names", None)
            if callable(names):
                collected_names = names()
                if isinstance(collected_names, Iterable):
                    return list(collected_names)
        columns = getattr(frame, "columns", None)
        if not isinstance(columns, Iterable):
            raise EngineError("The dataframe engine could not inspect the frame's columns.")
        return list(columns)

    @abstractmethod
    def detect(self, value: Any) -> bool:
        raise NotImplementedError

    @abstractmethod
    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        raise NotImplementedError

    @abstractmethod
    def shape(self, frame: Any) -> dict[str, int]:
        raise NotImplementedError

    @abstractmethod
    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        """Attach private row identities when a transformation did not preserve them."""
        raise NotImplementedError

    @abstractmethod
    def schema(self, frame: Any) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        raise NotImplementedError

    @abstractmethod
    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def header_stats(self, frame: Any) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        raise NotImplementedError

    @abstractmethod
    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        raise NotImplementedError

    @abstractmethod
    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        raise NotImplementedError

    @abstractmethod
    def export_data(self, frame: Any, path: str, format_name: Literal["csv", "parquet"]) -> None:
        raise NotImplementedError


def normalize_page_projection(
    column_count: int,
    projection: PageColumnProjection | None,
) -> list[tuple[int, str]]:
    """Validate a private visible-position to public-column-ID page projection."""

    if not isinstance(column_count, int) or isinstance(column_count, bool) or column_count < 0:
        raise EngineError("Page projection requires a non-negative visible column count.")
    if projection is None:
        return [(position, f"c:{position}") for position in range(column_count)]

    normalized: list[tuple[int, str]] = []
    positions: set[int] = set()
    identifiers: set[str] = set()
    for item in projection:
        if not isinstance(item, tuple | list) or len(item) != 2:
            raise EngineError("Page projection entries must contain one visible position and column identity.")
        position, identifier = item
        if not isinstance(position, int) or isinstance(position, bool) or position < 0 or position >= column_count:
            raise EngineError("Page projection references a column outside the dataframe schema.")
        if not isinstance(identifier, str) or not identifier:
            raise EngineError("Page projection column identities must be non-empty strings.")
        if position in positions or identifier in identifiers:
            raise EngineError("Page projection positions and column identities must be unique.")
        positions.add(position)
        identifiers.add(identifier)
        normalized.append((position, identifier))
    return normalized


def normalize_cell(value: Any) -> dict[str, Any]:
    type_name = type(value).__name__
    if _is_numpy_scalar_wrapper(value) and type_name not in {"datetime64", "timedelta64"}:
        converted = value.item()
        if type(converted) is not type(value):
            return normalize_cell(converted)
    numpy_datetime = value.item() if type_name == "datetime64" else None
    pandas_timedelta_value = getattr(value, "value", None)
    is_null = (
        value is None
        or type_name in {"NAType", "NaTType"}
        or (type_name == "datetime64" and numpy_datetime is None)
        or (type_name == "timedelta64" and str(value) == "NaT")
        or (isinstance(value, Decimal) and value.is_nan())
    )
    is_boolean = isinstance(value, bool) or type_name in {"bool", "bool_"}
    is_integer = isinstance(value, Integral) and not is_boolean and type_name != "timedelta64"
    is_real = isinstance(value, Real) and not is_boolean and not is_integer and type_name != "timedelta64"
    numeric_value = float(str(value)) if is_real else None
    is_nan = False
    infinity_sign: int | None = None
    if numeric_value is not None:
        is_nan = isnan(numeric_value)
        if isinf(numeric_value):
            infinity_sign = -1 if numeric_value < 0 else 1

    if is_null:
        kind = "null"
        display = ""
        raw: Any = None
    elif is_nan:
        kind = "nan"
        display = "NaN"
        raw = None
    elif numeric_value is not None and isinf(numeric_value):
        kind = "infinity"
        display = "-Infinity" if numeric_value < 0 else "Infinity"
        raw = None
    elif is_boolean:
        kind = "boolean"
        raw = bool(value)
        display = str(raw)
    elif is_integer:
        kind = "integer"
        integer_value = int(str(value))
        display = str(integer_value)
        raw = integer_value if -(2**53) + 1 <= integer_value <= (2**53) - 1 else display
    elif isinstance(value, Decimal):
        kind = "decimal"
        display = str(value)
        raw = display
    elif type_name == "datetime64":
        kind = "datetime"
        display = str(value)
        raw = display
    elif isinstance(value, datetime):
        kind = "datetime"
        display = value.isoformat()
        raw = display
    elif isinstance(value, date):
        kind = "date"
        display = value.isoformat()
        raw = display
    elif type_name == "Timedelta" and isinstance(pandas_timedelta_value, Integral):
        kind = "duration"
        display = str(value)
        raw = int(pandas_timedelta_value) / 1_000_000_000
    elif isinstance(value, timedelta):
        kind = "duration"
        display = str(value)
        raw = value.total_seconds()
    elif type_name == "timedelta64":
        kind = "duration"
        display = str(value)
        raw = _numpy_timedelta_raw(value, display)
    elif isinstance(value, bytes):
        kind = "binary"
        display = b64encode(value).decode("ascii")
        raw = display
    elif isinstance(value, (list, tuple)):
        kind = "list"
        raw = _json_safe(value)
        display = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    elif isinstance(value, Mapping):
        kind = "struct"
        raw = _json_safe(value)
        display = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    elif numeric_value is not None:
        kind = "number"
        display = str(numeric_value)
        raw = numeric_value
    elif isinstance(value, str):
        kind = "string"
        display = value
        raw = value
    else:
        kind = "unknown"
        display = str(value)
        raw = display

    cell = {
        "kind": kind,
        "raw": raw,
        "display": display,
        "isNull": is_null,
        "isNaN": is_nan,
    }
    if kind == "infinity":
        cell["sign"] = infinity_sign
    return cell


def infer_semantic_type(raw_type: str) -> ColumnType:
    lowered = raw_type.lower()
    # Container dtypes include their children (for example ``List(Int64)``), so
    # classify the outer type before looking for numeric tokens.
    if lowered.endswith("[]") or any(token in lowered for token in ("list", "array")):
        return "list"
    if any(token in lowered for token in ("struct", "dict", "map")):
        return "struct"
    if any(token in lowered for token in ("duration", "timedelta", "interval")):
        return "duration"
    if any(token in lowered for token in ("int", "uint")):
        return "integer"
    if any(token in lowered for token in ("float", "double", "decimal")):
        if "decimal" in lowered:
            return "decimal"
        return "float"
    if "bool" in lowered:
        return "boolean"
    if "datetime" in lowered or "timestamp" in lowered:
        return "datetime"
    if lowered == "date" or lowered.endswith("[date]"):
        return "date"
    if any(token in lowered for token in ("binary", "bytes", "blob")):
        return "binary"
    if any(
        token in lowered
        for token in ("str", "utf8", "object", "category", "categorical", "varchar", "char", "uuid", "enum")
    ):
        return "string"
    return "unknown"


def predicate_value(predicate: Mapping[str, Any], key: str = "value") -> Any:
    return predicate.get(key)


def numeric_visualization(values: Iterable[Any], max_bins: int = 20) -> dict[str, Any]:
    numbers = [_maybe_float(value) for value in values]
    finite_numbers = [value for value in numbers if value is not None and isfinite(value)]
    if not finite_numbers:
        return {"kind": "numeric", "bins": []}

    minimum = min(finite_numbers)
    maximum = max(finite_numbers)
    if minimum == maximum:
        return {"kind": "numeric", "bins": [{"min": minimum, "max": maximum, "count": len(finite_numbers)}]}

    bin_count = min(max_bins, max(1, len(set(finite_numbers))))
    width = (maximum - minimum) / bin_count
    counts = [0 for _ in range(bin_count)]
    for value in finite_numbers:
        index = min(int((value - minimum) / width), bin_count - 1)
        counts[index] += 1

    return {
        "kind": "numeric",
        "bins": [
            {
                "min": minimum + (width * index),
                "max": maximum if index == bin_count - 1 else minimum + (width * (index + 1)),
                "count": count,
            }
            for index, count in enumerate(counts)
        ],
    }


def categorical_visualization(top_values: list[dict[str, Any]], non_null_count: int) -> dict[str, Any]:
    shown = top_values[:6]
    shown_count = sum(int(item.get("count", 0)) for item in shown)
    return {
        "kind": "categorical",
        "categories": shown,
        "otherCount": max(0, int(non_null_count) - shown_count),
    }


def boolean_visualization(values: Iterable[Any]) -> dict[str, Any]:
    true_count = 0
    false_count = 0
    for value in values:
        if value is True:
            true_count += 1
        elif value is False:
            false_count += 1
    return {"kind": "boolean", "trueCount": true_count, "falseCount": false_count}


def datetime_visualization(minimum: Any, maximum: Any) -> dict[str, Any]:
    return {
        "kind": "datetime",
        "min": None if minimum is None else str(minimum),
        "max": None if maximum is None else str(maximum),
    }


def ensure_output_columns_available(existing: Iterable[Any], generated: Iterable[Any], operation: str) -> None:
    existing_names = {str(name) for name in existing}
    generated_names = [str(name) for name in generated]
    reserved_names = sorted(name for name in generated_names if is_internal_row_id_label(name))
    if reserved_names:
        raise EngineError(f"{operation} would create Open Wrangler's reserved private row-identity column.")
    duplicate_names = {name for name, count in Counter(generated_names).items() if count > 1}
    collisions = sorted(duplicate_names | (existing_names & set(generated_names)))
    if collisions:
        raise EngineError(
            f"{operation} would create duplicate column names: {', '.join(collisions)}. "
            "Choose a different prefix or separator."
        )


def bound_column_name(value: Any, operation: str) -> str:
    """Return the engine label from a session-bound column reference."""
    _validate_bound_column_reference(value, operation)
    return value["name"]


def bound_column_position(value: Any, operation: str) -> int:
    """Return the visible input ordinal from a session-bound column reference."""
    _validate_bound_column_reference(value, operation)
    return value["position"]


def _validate_bound_column_reference(value: Any, operation: str) -> None:
    if not isinstance(value, Mapping) or set(value) != {"id", "name", "position"}:
        raise EngineError(f"{operation} requires a bound column reference.")
    if not isinstance(value.get("id"), str) or not value["id"]:
        raise EngineError(f"{operation} requires a bound column reference.")
    if not isinstance(value.get("name"), str):
        raise EngineError(f"{operation} requires a bound column reference.")
    if isinstance(value.get("position"), bool) or not isinstance(value.get("position"), int) or value["position"] < 0:
        raise EngineError(f"{operation} requires a bound column reference.")


def _maybe_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _json_safe(value: Any) -> Any:
    type_name = type(value).__name__
    if type_name in {"datetime64", "timedelta64"}:
        return normalize_cell(value)["raw"]
    if _is_numpy_scalar_wrapper(value):
        converted = value.item()
        if type(converted) is not type(value):
            return _json_safe(converted)
    if value is None or type_name in {"NAType", "NaTType"} or (isinstance(value, Decimal) and value.is_nan()):
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool) or type_name in {"bool", "bool_"}:
        return bool(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Integral):
        return int(value)
    if isinstance(value, Real):
        numeric_value = float(value)
        if isnan(numeric_value):
            return "NaN"
        if isinf(numeric_value):
            return "-Infinity" if numeric_value < 0 else "Infinity"
        return numeric_value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if type_name == "Timedelta" and isinstance(getattr(value, "value", None), Integral):
        return int(value.value) / 1_000_000_000
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, bytes):
        return b64encode(value).decode("ascii")
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


def _is_numpy_scalar_wrapper(value: Any) -> bool:
    return any(base.__module__ == "numpy" and base.__name__ == "generic" for base in type(value).__mro__)


def _numpy_timedelta_raw(value: Any, fallback: str) -> float | str:
    try:
        return float(value / type(value)(1, "s"))
    except (TypeError, ValueError, OverflowError):
        return fallback
