from __future__ import annotations

import json
from abc import ABC, abstractmethod
from base64 import b64encode
from collections.abc import Iterable, Mapping
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

INTERNAL_ROW_ID_PREFIX = "__data_explorer_internal_row_id_"


class EngineError(RuntimeError):
    """Raised when a backend cannot satisfy a Data Explorer request."""


@dataclass(frozen=True)
class ColumnSchema:
    name: str
    raw_type: str
    type: ColumnType
    nullable: bool


class DataFrameEngine(ABC):
    name: str

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
    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
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


def normalize_cell(value: Any) -> dict[str, Any]:
    type_name = type(value).__name__
    is_null = value is None or type_name in {"NAType", "NaTType"}
    is_boolean = isinstance(value, bool) or type_name in {"bool", "bool_"}
    is_integer = isinstance(value, Integral) and not is_boolean
    is_real = isinstance(value, Real) and not is_boolean and not is_integer
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
    elif isinstance(value, datetime):
        kind = "datetime"
        display = value.isoformat()
        raw = display
    elif isinstance(value, date):
        kind = "date"
        display = value.isoformat()
        raw = display
    elif isinstance(value, timedelta):
        kind = "duration"
        display = str(value)
        raw = value.total_seconds()
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
    if any(token in lowered for token in ("list", "array")):
        return "list"
    if any(token in lowered for token in ("struct", "dict")):
        return "struct"
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
    if any(token in lowered for token in ("duration", "timedelta")):
        return "duration"
    if any(token in lowered for token in ("binary", "bytes")):
        return "binary"
    if any(token in lowered for token in ("str", "utf8", "object", "category", "categorical")):
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


def _maybe_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _json_safe(value: Any) -> Any:
    type_name = type(value).__name__
    if value is None or type_name in {"NAType", "NaTType"}:
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
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, bytes):
        return b64encode(value).decode("ascii")
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)
