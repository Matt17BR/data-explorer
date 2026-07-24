from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from base64 import b64encode
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from importlib import import_module
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
VIEW_COMPARABLE_TYPES = frozenset({"string", "integer", "float", "decimal", "boolean", "datetime", "date", "duration"})
_TYPED_SELECTION_CELL_KINDS = frozenset(
    {"string", "integer", "number", "decimal", "boolean", "datetime", "date", "duration", "infinity"}
)
_MAX_TYPED_SELECTION_TEXT_CHARACTERS = 65_536
_TYPED_SELECTION_KINDS_BY_COLUMN: Mapping[str, frozenset[str]] = {
    # A heterogeneous Pandas object column is intentionally exposed as a
    # semantic string column. Its native scalar representatives still need to
    # round-trip without collapsing integer 1 into the literal string "1".
    "string": _TYPED_SELECTION_CELL_KINDS,
    "integer": frozenset({"integer"}),
    "float": frozenset({"number", "infinity"}),
    "decimal": frozenset({"decimal"}),
    "boolean": frozenset({"boolean"}),
    "datetime": frozenset({"datetime"}),
    "date": frozenset({"date"}),
    "duration": frozenset({"duration"}),
}
_NULL_PREDICATE_OPERATORS = frozenset({"isNull", "isNotNull"})
_ORDERED_PREDICATE_OPERATORS = frozenset(
    {"equals", "notEquals", "gt", "gte", "lt", "lte", "between", *_NULL_PREDICATE_OPERATORS}
)
VIEW_PREDICATE_OPERATORS: Mapping[str, frozenset[str]] = {
    "string": frozenset({"contains", "startsWith", "endsWith", *_ORDERED_PREDICATE_OPERATORS}),
    "integer": _ORDERED_PREDICATE_OPERATORS,
    "float": frozenset({*_ORDERED_PREDICATE_OPERATORS, "isNaN", "isNotNaN"}),
    "decimal": _ORDERED_PREDICATE_OPERATORS,
    "boolean": frozenset({"equals", "notEquals", *_NULL_PREDICATE_OPERATORS}),
    "datetime": _ORDERED_PREDICATE_OPERATORS,
    "date": _ORDERED_PREDICATE_OPERATORS,
    "duration": _ORDERED_PREDICATE_OPERATORS,
    "binary": _NULL_PREDICATE_OPERATORS,
    "list": _NULL_PREDICATE_OPERATORS,
    "struct": _NULL_PREDICATE_OPERATORS,
    "unknown": _NULL_PREDICATE_OPERATORS,
}
_INTEGER_VIEW_TEXT = re.compile(r"^[+-]?\d+$")
_NUMBER_VIEW_TEXT = re.compile(r"^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$")
_INFINITY_VIEW_TEXT = re.compile(r"^[+-]?Infinity$")
_DATE_VIEW_TEXT = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DATETIME_VIEW_TEXT = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$")
_DURATION_SECONDS_TEXT = re.compile(r"^[+-]?(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$")
_DURATION_TEXT = re.compile(r"^(?:(-?\d+) days?, )?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$")


def validate_view_predicate_operator(column_type: str | None, operator: Any) -> str:
    normalized = str(operator)
    if normalized not in VIEW_PREDICATE_OPERATORS.get(str(column_type), frozenset()):
        raise EngineError(f"View predicate {normalized!r} is unavailable for {column_type or 'unknown'} columns.")
    return normalized


def coerce_typed_view_value(value: Any, column_type: str | None) -> Any:
    """Bind public filter text to a portable native scalar without losing precision."""

    try:
        if isinstance(value, Mapping):
            return _decode_typed_selection(value, column_type)
        if column_type == "string":
            return str(value)
        if column_type == "integer":
            if isinstance(value, bool):
                raise ValueError("boolean is not an integer filter value")
            text = str(value)
            if not _INTEGER_VIEW_TEXT.fullmatch(text):
                raise ValueError("expected an optional sign followed by decimal digits")
            return int(text)
        if column_type == "float":
            if isinstance(value, bool):
                raise ValueError("boolean is not a float filter value")
            text = str(value)
            if text == "NaN":
                raise ValueError("NaN must use the explicit includeNaN option")
            if not (_NUMBER_VIEW_TEXT.fullmatch(text) or _INFINITY_VIEW_TEXT.fullmatch(text)):
                raise ValueError("expected a decimal number or explicit Infinity")
            result = float(text)
            if isnan(result):
                raise ValueError("NaN must use the explicit includeNaN option")
            if not isfinite(result) and not _INFINITY_VIEW_TEXT.fullmatch(text):
                raise ValueError("numeric overflow must use explicit Infinity")
            return result
        if column_type == "decimal":
            text = str(value)
            if not _NUMBER_VIEW_TEXT.fullmatch(text):
                raise ValueError("expected a decimal number")
            return Decimal(text)
        if column_type == "boolean":
            if isinstance(value, bool):
                return value
            normalized = str(value).strip().lower()
            if normalized not in {"true", "false"}:
                raise ValueError("expected true or false")
            return normalized == "true"
        if column_type == "date":
            if isinstance(value, date) and not isinstance(value, datetime):
                return value
            text = str(value)
            if not _DATE_VIEW_TEXT.fullmatch(text):
                raise ValueError("expected YYYY-MM-DD")
            return date.fromisoformat(text)
        if column_type == "datetime":
            if isinstance(value, datetime):
                return value
            text = str(value)
            if not _DATETIME_VIEW_TEXT.fullmatch(text):
                raise ValueError("expected an ISO datetime with a four-digit year")
            if (
                int(text[11:13]) > 23
                or int(text[14:16]) > 59
                or (len(text) >= 19 and text[16] == ":" and int(text[17:19]) > 59)
            ):
                raise ValueError("datetime hours, minutes, or seconds are outside their portable range")
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        if column_type == "duration":
            if isinstance(value, timedelta):
                return value
            text = str(value)
            if _DURATION_SECONDS_TEXT.fullmatch(text):
                return timedelta(microseconds=int(Decimal(text) * 1_000_000))
            match = _DURATION_TEXT.fullmatch(text)
            if not match:
                raise ValueError("expected seconds or '[days, ]HH:MM:SS[.ffffff]'")
            days, hours, minutes, seconds, fraction = match.groups()
            hour = int(hours)
            minute = int(minutes)
            second = int(seconds)
            if hour > 23 or minute > 59 or second > 59:
                raise ValueError("duration hours, minutes, or seconds are outside their portable range")
            return timedelta(
                days=int(days or 0),
                hours=hour,
                minutes=minute,
                seconds=second,
                microseconds=int((fraction or "").ljust(6, "0") or "0"),
            )
    except (TypeError, ValueError, ArithmeticError) as error:
        raise EngineError(f"Invalid {column_type or 'unknown'} view-filter value {value!r}: {error}") from error
    raise EngineError(f"View comparisons are unavailable for {column_type or 'unknown'} columns.")


def typed_selection_value(value: Any, column_type: str) -> dict[str, Any] | None:
    """Return the portable selection token for one non-missing scalar value."""

    cell = normalize_cell(value)
    if column_type == "float" and cell["kind"] == "integer":
        try:
            cell = normalize_cell(float(value))
        except (TypeError, ValueError, OverflowError):
            return None
    if cell["isNull"] or cell["isNaN"] or cell["kind"] not in _TYPED_SELECTION_CELL_KINDS:
        return None
    token = {
        "kind": "typedSelection",
        "version": 1,
        "columnType": column_type,
        "cell": cell,
    }
    try:
        _decode_typed_selection(token, column_type)
    except (EngineError, TypeError, ValueError, ArithmeticError):
        return None
    return token


def _decode_typed_selection(value: Mapping[str, Any], column_type: str | None) -> Any:
    if set(value) != {"kind", "version", "columnType", "cell"}:
        raise ValueError("typed selection tokens must contain only kind, version, columnType, and cell")
    if value.get("kind") != "typedSelection" or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("typed selection tokens require kind 'typedSelection' and version 1")
    token_column_type = value.get("columnType")
    if token_column_type != column_type or token_column_type not in VIEW_COMPARABLE_TYPES:
        raise ValueError("typed selection token columnType does not match the filtered column")
    cell = value.get("cell")
    if not isinstance(cell, Mapping):
        raise ValueError("typed selection token cell must be an object")
    expected_cell_fields = {"kind", "raw", "display", "isNull", "isNaN"}
    if set(cell) not in {frozenset(expected_cell_fields), frozenset({*expected_cell_fields, "sign"})}:
        raise ValueError("typed selection token cell has an invalid shape")
    cell_kind = cell.get("kind")
    if cell_kind not in _TYPED_SELECTION_KINDS_BY_COLUMN[str(token_column_type)]:
        raise ValueError("typed selection token cell kind is incompatible with the filtered column")
    if (
        not isinstance(cell.get("display"), str)
        or len(cell["display"]) > _MAX_TYPED_SELECTION_TEXT_CHARACTERS
        or cell.get("isNull") is not False
        or cell.get("isNaN") is not False
    ):
        raise ValueError("typed selection token cell must be a normalized present scalar")
    raw = cell.get("raw")
    if isinstance(raw, str) and len(raw) > _MAX_TYPED_SELECTION_TEXT_CHARACTERS:
        raise ValueError("typed selection token raw text is too long")
    if cell_kind == "infinity":
        sign = cell.get("sign")
        if set(cell) != {*expected_cell_fields, "sign"} or raw is not None or sign not in {-1, 1}:
            raise ValueError("typed infinity selections require a null raw value and sign")
        expected_display = "-Infinity" if sign < 0 else "Infinity"
        if cell["display"] != expected_display:
            raise ValueError("typed infinity selection display does not match its sign")
        return float("-inf") if sign < 0 else float("inf")
    if "sign" in cell:
        raise ValueError("only typed infinity selections may contain sign")
    if cell_kind == "string":
        if not isinstance(raw, str) or cell["display"] != raw:
            raise ValueError("typed string selections require matching string raw and display values")
        return raw
    if cell_kind == "boolean":
        if type(raw) is not bool or cell["display"] != str(raw):
            raise ValueError("typed boolean selections require a boolean raw value")
        return raw
    semantic_type = {
        "integer": "integer",
        "number": "float",
        "decimal": "decimal",
        "datetime": "datetime",
        "date": "date",
        "duration": "duration",
    }[str(cell_kind)]
    return coerce_typed_view_value(raw, semantic_type)


def generated_view_value_helper_lines() -> list[str]:
    """Return the standalone equivalent used by generated Pandas/Polars code."""

    return [
        "def _open_wrangler_typed_selection(value, column_type):",
        "    if set(value) != {'kind', 'version', 'columnType', 'cell'}:",
        "        raise ValueError('Typed selection tokens have an invalid shape.')",
        (
            "    if value.get('kind') != 'typedSelection' or "
            "type(value.get('version')) is not int or value['version'] != 1:"
        ),
        "        raise ValueError(\"Typed selection tokens require kind 'typedSelection' and version 1.\")",
        "    token_column_type = value.get('columnType')",
        "    comparable = {'string', 'integer', 'float', 'decimal', 'boolean', 'datetime', 'date', 'duration'}",
        "    if token_column_type != column_type or token_column_type not in comparable:",
        "        raise ValueError('Typed selection token columnType does not match the filtered column.')",
        "    cell = value.get('cell')",
        "    required = {'kind', 'raw', 'display', 'isNull', 'isNaN'}",
        "    if not isinstance(cell, dict) or set(cell) not in {frozenset(required), frozenset(required | {'sign'})}:",
        "        raise ValueError('Typed selection token cell has an invalid shape.')",
        "    allowed = {",
        (
            "        'string': {'string', 'integer', 'number', 'decimal', 'boolean', "
            "'datetime', 'date', 'duration', 'infinity'},"
        ),
        "        'integer': {'integer'},",
        "        'float': {'number', 'infinity'},",
        "        'decimal': {'decimal'},",
        "        'boolean': {'boolean'},",
        "        'datetime': {'datetime'},",
        "        'date': {'date'},",
        "        'duration': {'duration'},",
        "    }",
        "    cell_kind = cell.get('kind')",
        "    if cell_kind not in allowed[token_column_type]:",
        "        raise ValueError('Typed selection token cell kind is incompatible with the filtered column.')",
        "    display = cell.get('display')",
        (
            "    if not isinstance(display, str) or len(display) > 65536 or "
            "cell.get('isNull') is not False or cell.get('isNaN') is not False:"
        ),
        "        raise ValueError('Typed selection token cell must be a normalized present scalar.')",
        "    raw = cell.get('raw')",
        "    if isinstance(raw, str) and len(raw) > 65536:",
        "        raise ValueError('Typed selection token raw text is too long.')",
        "    if cell_kind == 'infinity':",
        "        sign = cell.get('sign')",
        "        if set(cell) != required | {'sign'} or raw is not None or sign not in {-1, 1}:",
        "            raise ValueError('Typed infinity selections require a null raw value and sign.')",
        "        expected_display = '-Infinity' if sign < 0 else 'Infinity'",
        "        if cell['display'] != expected_display:",
        "            raise ValueError('Typed infinity selection display does not match its sign.')",
        "        return float('-inf') if sign < 0 else float('inf')",
        "    if 'sign' in cell:",
        "        raise ValueError('Only typed infinity selections may contain sign.')",
        "    if cell_kind == 'string':",
        "        if not isinstance(raw, str) or cell['display'] != raw:",
        "            raise ValueError('Typed string selections require matching string raw and display values.')",
        "        return raw",
        "    if cell_kind == 'boolean':",
        "        if type(raw) is not bool or cell['display'] != str(raw):",
        "            raise ValueError('Typed boolean selections require a boolean raw value.')",
        "        return raw",
        (
            "    semantic_type = {'integer': 'integer', 'number': 'float', 'decimal': 'decimal', "
            "'datetime': 'datetime', 'date': 'date', 'duration': 'duration'}[cell_kind]"
        ),
        "    return _open_wrangler_view_value(raw, semantic_type)",
        "",
        "",
        "def _open_wrangler_view_value(value, column_type):",
        "    import re",
        "    if isinstance(value, dict):",
        "        return _open_wrangler_typed_selection(value, column_type)",
        "    if column_type == 'string':",
        "        return str(value)",
        "    if column_type == 'integer':",
        "        if isinstance(value, bool):",
        "            raise ValueError('Boolean is not an integer view-filter value.')",
        "        text = str(value)",
        "        if not re.fullmatch(r'[+-]?\\d+', text):",
        "            raise ValueError('Integer view-filter values require decimal digits.')",
        "        return int(text)",
        "    if column_type == 'float':",
        "        if isinstance(value, bool):",
        "            raise ValueError('Boolean is not a float view-filter value.')",
        "        text = str(value)",
        "        if text == 'NaN':",
        "            raise ValueError('NaN must use the explicit includeNaN option.')",
        ("        number = re.fullmatch(r'[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+))(?:[eE][+-]?\\d+)?', text)"),
        "        infinity = re.fullmatch(r'[+-]?Infinity', text)",
        "        if not (number or infinity):",
        "            raise ValueError('Float view-filter values require a decimal number or explicit Infinity.')",
        "        result = float(text)",
        "        if result != result:",
        "            raise ValueError('NaN must use the explicit includeNaN option.')",
        "        if result in {float('inf'), float('-inf')} and not infinity:",
        "            raise ValueError('Numeric overflow must use explicit Infinity.')",
        "        return result",
        "    if column_type == 'decimal':",
        "        text = str(value)",
        ("        if not re.fullmatch(r'[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+))(?:[eE][+-]?\\d+)?', text):"),
        "            raise ValueError('Decimal view-filter values require a decimal number.')",
        "        return Decimal(text)",
        "    if column_type == 'boolean':",
        "        if isinstance(value, bool):",
        "            return value",
        "        normalized = str(value).strip().lower()",
        "        if normalized not in {'true', 'false'}:",
        "            raise ValueError('Boolean view-filter values must be true or false.')",
        "        return normalized == 'true'",
        "    if column_type == 'date':",
        "        if isinstance(value, date) and not isinstance(value, datetime):",
        "            return value",
        "        text = str(value)",
        "        if not re.fullmatch(r'\\d{4}-\\d{2}-\\d{2}', text):",
        "            raise ValueError('Date view-filter values require YYYY-MM-DD.')",
        "        return date.fromisoformat(text)",
        "    if column_type == 'datetime':",
        "        if isinstance(value, datetime):",
        "            return value",
        "        text = str(value)",
        (
            "        if not re.fullmatch("
            "r'\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,6})?)?'"
            " r'(?:Z|[+-]\\d{2}:?\\d{2})?', text):"
        ),
        "            raise ValueError('Datetime view-filter values require a portable ISO datetime.')",
        (
            "        if (int(text[11:13]) > 23 or int(text[14:16]) > 59 or "
            "(len(text) >= 19 and text[16] == ':' and int(text[17:19]) > 59)):"
        ),
        "            raise ValueError('Datetime components are outside their portable range.')",
        "        return datetime.fromisoformat(text.replace('Z', '+00:00'))",
        "    if column_type == 'duration':",
        "        if isinstance(value, timedelta):",
        "            return value",
        "        text = str(value)",
        "        if re.fullmatch(r'[+-]?(?:\\d+(?:\\.\\d{0,6})?|\\.\\d{1,6})', text):",
        "            return timedelta(microseconds=int(Decimal(text) * 1000000))",
        ("        match = re.fullmatch(r'(?:(-?\\d+) days?, )?(\\d{1,2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,6}))?', text)"),
        "        if not match:",
        "            raise ValueError(\"Duration view-filter values require seconds or '[days, ]HH:MM:SS[.ffffff]'.\")",
        "        days, hours, minutes, seconds, fraction = match.groups()",
        "        hour, minute, second = int(hours), int(minutes), int(seconds)",
        "        if hour > 23 or minute > 59 or second > 59:",
        "            raise ValueError('Duration components are outside their portable range.')",
        (
            "        return timedelta(days=int(days or 0), hours=hour, minutes=minute, seconds=second, "
            "microseconds=int((fraction or '').ljust(6, '0') or '0'))"
        ),
        "    raise ValueError('View comparisons are unavailable for ' + str(column_type) + ' columns.')",
        "",
        "",
    ]


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
    runtime_modules: tuple[str, ...] = ()

    def runtime_modules_for_source(self, source: Mapping[str, Any] | None) -> tuple[str, ...]:
        """Return optional modules that must be initialized for one source."""
        return ()

    def prepare(self, source: Mapping[str, Any] | None = None) -> None:
        """Load optional native dependencies on the caller-owned thread."""
        for module_name in (*self.runtime_modules, *self.runtime_modules_for_source(source)):
            import_module(module_name)

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
