from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from math import isfinite, isnan
from typing import Any, Literal

ColumnType = Literal["string", "integer", "float", "boolean", "datetime", "date", "unknown"]


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
    def read_file(self, path: str) -> Any:
        raise NotImplementedError

    @abstractmethod
    def shape(self, frame: Any) -> dict[str, int]:
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


def normalize_cell(value: Any) -> dict[str, Any]:
    is_null = value is None
    is_nan = False
    if isinstance(value, float):
        is_nan = isnan(value)

    if is_null:
        display = ""
        raw: Any = None
    elif is_nan:
        display = "NaN"
        raw = None
    else:
        display = str(value)
        raw = value if isinstance(value, (str, int, float, bool)) else display

    return {
        "raw": raw,
        "display": display,
        "isNull": is_null,
        "isNaN": is_nan,
    }


def infer_semantic_type(raw_type: str) -> ColumnType:
    lowered = raw_type.lower()
    if any(token in lowered for token in ("int", "uint")):
        return "integer"
    if any(token in lowered for token in ("float", "double", "decimal")):
        return "float"
    if "bool" in lowered:
        return "boolean"
    if "datetime" in lowered or "timestamp" in lowered:
        return "datetime"
    if lowered == "date" or lowered.endswith("[date]"):
        return "date"
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
