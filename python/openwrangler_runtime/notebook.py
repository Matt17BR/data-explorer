from __future__ import annotations

from contextlib import suppress
from typing import Any

from IPython.core.getipython import get_ipython
from IPython.display import display

from .engines import EngineError, UnsupportedDataFrameError, default_engine_registry

MIME_TYPE_V2 = "application/vnd.openwrangler.viewer.v2+json"
MIME_TYPE = MIME_TYPE_V2


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
    if not isinstance(page_size, int) or isinstance(page_size, bool) or page_size < 1:
        raise EngineError("Notebook output page_size must be a positive integer.")
    if variable_name is not None and not _is_python_identifier(variable_name):
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
        frame = getattr(engine, "normalize", lambda item: item)(value)
        filter_model = {"filters": [], "sort": []}
        filtered = engine.apply_filter_model(frame, filter_model)
        source: dict[str, Any] = {"kind": "notebookOutput", "label": label}
        if variable_name:
            source["variableName"] = variable_name
        shape = engine.shape(frame)
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
            "filteredShape": engine.shape(filtered),
            "schema": engine.schema(frame),
            "filterModel": filter_model,
            "steps": [],
            "stats": engine.header_stats(filtered),
        }
        payload = {
            "mimeVersion": 2,
            "metadata": metadata,
            "page": engine.page(filtered, 0, page_size),
            "summaries": engine.summaries(filtered),
        }
    except BaseException:
        with suppress(Exception):
            engine.close()
        raise
    try:
        engine.close()
    except Exception as error:
        raise EngineError(f"Could not close the {engine.name} notebook output engine: {error}") from error
    return payload


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
