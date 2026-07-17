from __future__ import annotations

import json
from contextlib import suppress
from typing import Any

from IPython.core.getipython import get_ipython
from IPython.display import display

from .engines import EngineError, UnsupportedDataFrameError, default_engine_registry

MIME_TYPE_V2 = "application/vnd.openwrangler.viewer.v2+json"
MAX_SAVED_ROWS = 10_000
MAX_SAVED_COLUMNS = 2_048
MAX_SAVED_CELLS = 100_000
MAX_SAVED_PAYLOAD_BYTES = 16_777_216
MAX_SAVED_LABEL_CHARACTERS = 256
MAX_SAVED_COLUMN_CHARACTERS = 512
MAX_SAVED_CELL_CHARACTERS = 65_536
MAX_SAVED_PAYLOAD_NODES = 1_000_000
MAX_SAVED_PAYLOAD_DEPTH = 64
_JSON_UTF8_VALIDATION_CHUNK_CHARACTERS = 16 * 1024


def show(
    value: Any,
    label: str = "dataframe",
    backend: str | None = None,
    page_size: int = 200,
    *,
    variable_name: str | None = None,
) -> None:
    """Display a deterministic dataframe snapshot using the Open Wrangler renderer."""
    payload = build_payload(value, label, backend, page_size, variable_name=variable_name)
    display({MIME_TYPE_V2: payload}, raw=True)


def build_payload(
    value: Any,
    label: str = "dataframe",
    backend: str | None = None,
    page_size: int = 200,
    *,
    variable_name: str | None = None,
) -> dict[str, Any]:
    if not isinstance(label, str) or not label:
        raise EngineError("Notebook output label must be a non-empty string.")
    _validate_text_limit(label, MAX_SAVED_LABEL_CHARACTERS, "Notebook output label")
    if not isinstance(page_size, int) or isinstance(page_size, bool) or page_size < 1 or page_size > MAX_SAVED_ROWS:
        raise EngineError(f"Notebook output page_size must be an integer between 1 and {MAX_SAVED_ROWS}.")
    if variable_name is not None:
        _validate_text_limit(variable_name, MAX_SAVED_LABEL_CHARACTERS, "Notebook variable_name")
        if not _is_python_identifier(variable_name):
            raise EngineError("Notebook variable_name must be a valid Python identifier.")

    registry = default_engine_registry()
    try:
        engine = registry.create(backend) if backend else registry.detect(value)
    except UnsupportedDataFrameError as error:
        raise EngineError(
            "Open Wrangler notebook output supports Pandas and Polars dataframe or series values."
        ) from error
    try:
        if "notebookOutput" not in engine.capabilities.source_kinds:
            raise EngineError(f"The {engine.name} backend does not support notebook output sources.")
        frame = _normalize_snapshot_value(engine, value)
        filter_model = {"filters": [], "sort": []}
        source: dict[str, Any] = {"kind": "notebookOutput", "label": label}
        if variable_name:
            source["variableName"] = variable_name
        shape = engine.shape(frame)
        schema = engine.schema(frame)
        if len(schema) > MAX_SAVED_COLUMNS:
            raise EngineError(
                f"Notebook output captures at most {MAX_SAVED_COLUMNS:,} columns; received {len(schema):,}. "
                "Select fewer columns before displaying the dataframe."
            )
        _validate_snapshot_schema_fields(schema)
        filtered_shape = dict(shape)
        effective_page_size = min(
            page_size,
            MAX_SAVED_CELLS // len(schema) if schema else page_size,
        )
        page = engine.page(frame, 0, effective_page_size, total_rows=shape["rows"])
        _validate_snapshot_dimensions(schema, page)
        metadata = {
            "protocolVersion": 2,
            "sessionId": f"notebook-output:{label}",
            "revision": 0,
            "backend": engine.name,
            "mode": "viewing",
            "source": source,
            "capabilities": {
                "editable": False,
                "lazy": False,
                "cancel": False,
                "exportCsv": False,
                "exportParquet": False,
                "notebookInsert": False,
            },
            "shape": shape,
            "filteredShape": filtered_shape,
            "schema": schema,
            "filterModel": filter_model,
            "steps": [],
        }
        payload = {
            "mimeVersion": 2,
            "metadata": metadata,
            "page": page,
            "summaries": [],
        }
        _validate_snapshot_fields(metadata, page)
        _validate_snapshot_payload_size(payload)
    except BaseException as error:
        with suppress(Exception):
            engine.close()
        if isinstance(error, RecursionError):
            raise EngineError(
                "Notebook output contains data nested too deeply to serialize safely. "
                f"Use at most {MAX_SAVED_PAYLOAD_DEPTH} nested payload levels."
            ) from error
        raise
    try:
        engine.close()
    except Exception as error:
        raise EngineError(f"Could not close the {engine.name} notebook output engine: {error}") from error
    return payload


def _normalize_snapshot_value(engine: Any, value: Any) -> Any:
    if engine.name == "polars":
        import polars as pl

        if isinstance(value, pl.LazyFrame):
            # A saved output needs only a streamed row count, metadata-only
            # schema discovery, and one bounded terminal page. Normalizing a
            # LazyFrame would collect the complete source before any limit can
            # protect the kernel.
            return value
    return engine.normalize(value)


def _validate_text_limit(value: str, limit: int, label: str) -> None:
    if len(value) > limit:
        raise EngineError(
            f"{label} may contain at most {limit:,} characters; received {len(value):,}. "
            "Shorten the value before displaying the dataframe."
        )


def _validate_snapshot_schema_fields(schema: list[dict[str, Any]]) -> None:
    for position, column in enumerate(schema):
        for field_name in ("id", "name", "rawType"):
            value = column.get(field_name)
            if not isinstance(value, str):
                raise EngineError(f"Notebook output column {position + 1} has a malformed {field_name} field.")
            _validate_text_limit(
                value,
                MAX_SAVED_COLUMN_CHARACTERS,
                f"Notebook output column {position + 1} {field_name}",
            )


def _validate_snapshot_fields(metadata: dict[str, Any], page: dict[str, Any]) -> None:
    source = metadata.get("source", {})
    _validate_text_limit(source["label"], MAX_SAVED_LABEL_CHARACTERS, "Notebook output label")
    variable_name = source.get("variableName")
    if variable_name is not None:
        _validate_text_limit(variable_name, MAX_SAVED_LABEL_CHARACTERS, "Notebook variable_name")
    _validate_snapshot_schema_fields(metadata.get("schema", []))

    column_ids = page.get("columnIds", [])
    for position, column_id in enumerate(column_ids):
        if not isinstance(column_id, str):
            raise EngineError(f"Notebook output page column identity {position + 1} is malformed.")
        _validate_text_limit(
            column_id,
            MAX_SAVED_COLUMN_CHARACTERS,
            f"Notebook output page column identity {position + 1}",
        )
    for row_position, row in enumerate(page.get("rows", [])):
        row_id = row.get("id")
        if not isinstance(row_id, str):
            raise EngineError(f"Notebook output row {row_position + 1} has a malformed identity.")
        _validate_text_limit(
            row_id,
            MAX_SAVED_COLUMN_CHARACTERS,
            f"Notebook output row {row_position + 1} identity",
        )
        for column_position, cell in enumerate(row.get("values", [])):
            context = f"Notebook output cell at row {row_position + 1}, column {column_position + 1}"
            display_value = cell.get("display")
            if not isinstance(display_value, str):
                raise EngineError(f"{context} has a malformed display field.")
            _validate_text_limit(display_value, MAX_SAVED_CELL_CHARACTERS, f"{context} display")
            _validate_nested_strings(cell.get("raw"), context)


def _validate_nested_strings(value: Any, context: str) -> None:
    stack = [value]
    seen: set[int] = set()
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            _validate_text_limit(current, MAX_SAVED_CELL_CHARACTERS, f"{context} nested string")
        elif isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                raise EngineError(f"{context} contains a repeated or cyclic nested object.")
            seen.add(identity)
            for key, nested in current.items():
                if isinstance(key, str):
                    _validate_text_limit(key, MAX_SAVED_CELL_CHARACTERS, f"{context} nested key")
                stack.append(nested)
        elif isinstance(current, (list, tuple)):
            identity = id(current)
            if identity in seen:
                raise EngineError(f"{context} contains a repeated or cyclic nested array.")
            seen.add(identity)
            stack.extend(current)


def _validate_snapshot_dimensions(schema: list[dict[str, Any]], page: dict[str, Any]) -> None:
    rows = page.get("rows")
    if not isinstance(rows, list):
        raise EngineError("Notebook output paging returned malformed rows.")
    if len(rows) > MAX_SAVED_ROWS:
        raise EngineError(
            f"Notebook output captures at most {MAX_SAVED_ROWS:,} rows; received {len(rows):,}. "
            "Reduce page_size before displaying the dataframe."
        )
    captured_cells = sum(len(row.get("values", [])) for row in rows if isinstance(row, dict))
    if captured_cells > MAX_SAVED_CELLS:
        raise EngineError(
            f"Notebook output captures at most {MAX_SAVED_CELLS:,} cells; received {captured_cells:,}. "
            "Reduce page_size or select fewer columns before displaying the dataframe."
        )
    expected_cells = len(rows) * len(schema)
    if captured_cells != expected_cells:
        raise EngineError("Notebook output paging did not return one complete value for every captured cell.")


def _validate_snapshot_payload_size(payload: Any) -> None:
    _validate_snapshot_payload_graph(payload)
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    serialized_bytes = 0
    try:
        for serialized_chunk in encoder.iterencode(payload):
            # ``JSONEncoder.iterencode`` avoids joining the complete payload,
            # but a token can still contain a large string. Encode bounded
            # slices so validation never creates the very oversized byte
            # string that this limit exists to prevent.
            for offset in range(0, len(serialized_chunk), _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS):
                encoded_chunk = serialized_chunk[offset : offset + _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS].encode(
                    "utf-8"
                )
                serialized_bytes += len(encoded_chunk)
                if serialized_bytes > MAX_SAVED_PAYLOAD_BYTES:
                    raise EngineError(
                        f"Notebook output captures at most {MAX_SAVED_PAYLOAD_BYTES:,} serialized bytes; "
                        f"received {serialized_bytes:,}. Reduce page_size or shorten large values before "
                        "displaying the dataframe."
                    )
    except (TypeError, ValueError, RecursionError) as error:
        raise EngineError(f"Notebook output could not be serialized as strict JSON: {error}") from error


def _validate_snapshot_payload_graph(payload: Any) -> None:
    stack: list[tuple[Any, int]] = [(payload, 0)]
    seen: set[int] = set()
    nodes = 0
    while stack:
        current, depth = stack.pop()
        if depth > MAX_SAVED_PAYLOAD_DEPTH:
            raise EngineError(
                f"Notebook output captures at most {MAX_SAVED_PAYLOAD_DEPTH} nested payload levels; "
                f"encountered a value at depth {depth}. Shorten nested values before displaying the dataframe."
            )
        nodes += 1
        if nodes > MAX_SAVED_PAYLOAD_NODES:
            raise EngineError(
                f"Notebook output captures at most {MAX_SAVED_PAYLOAD_NODES:,} payload nodes; "
                f"received at least {nodes:,}. Reduce page_size or simplify nested values before "
                "displaying the dataframe."
            )
        if isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                raise EngineError("Notebook output must not contain repeated or cyclic nested objects.")
            seen.add(identity)
            stack.extend((nested, depth + 1) for nested in current.values())
        elif isinstance(current, (list, tuple)):
            identity = id(current)
            if identity in seen:
                raise EngineError("Notebook output must not contain repeated or cyclic nested arrays.")
            seen.add(identity)
            stack.extend((nested, depth + 1) for nested in current)


def register_formatters(shell: Any | None = None) -> bool:
    """Register v2 inline formatters after the extension has permission to use the kernel."""
    active_shell: Any = shell if shell is not None else get_ipython()
    if active_shell is None:
        return False
    formatter = active_shell.display_formatter.mimebundle_formatter
    registered = False
    for dataframe_type in _available_dataframe_types():
        formatter.for_type(
            dataframe_type,
            lambda value: {MIME_TYPE_V2: build_payload(value, label=type(value).__name__)},
        )
        registered = True
    return registered


def _available_dataframe_types() -> list[type[Any]]:
    types: list[type[Any]] = []
    try:
        import pandas as pd

        types.extend((pd.DataFrame, pd.Series))
    except ImportError:
        pass
    try:
        import polars as pl

        types.extend((pl.DataFrame, pl.LazyFrame, pl.Series))
    except ImportError:
        pass
    return types


def _is_python_identifier(value: str) -> bool:
    return value.isascii() and value.isidentifier()
