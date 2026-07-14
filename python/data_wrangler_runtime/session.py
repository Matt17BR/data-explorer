from __future__ import annotations

import importlib
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .engines import DataFrameEngine, EngineError, PandasEngine, PolarsEngine


@dataclass
class Session:
    session_id: str
    source: dict[str, Any]
    backend: str
    engine: DataFrameEngine
    original: Any
    filtered: Any
    filter_model: dict[str, Any]


class SessionManager:
    def __init__(self) -> None:
        self.engines: dict[str, DataFrameEngine] = {
            "polars": PolarsEngine(),
            "pandas": PandasEngine(),
        }
        self.sessions: dict[str, Session] = {}

    def open_session(
        self, source: Mapping[str, Any], backend: str | None = None, page_size: int = 200
    ) -> dict[str, Any]:
        engine = self._engine_for_source(source, backend)
        frame = self._load_source(source, engine)
        frame = getattr(engine, "normalize", lambda value: value)(frame)
        session_id = str(uuid.uuid4())
        filter_model = {"filters": [], "sort": []}
        filtered = engine.apply_filter_model(frame, filter_model)
        session = Session(
            session_id=session_id,
            source=dict(source),
            backend=engine.name,
            engine=engine,
            original=frame,
            filtered=filtered,
            filter_model=filter_model,
        )
        self.sessions[session_id] = session
        return {
            "kind": "sessionOpened",
            "metadata": self._metadata(session),
            "page": engine.page(filtered, 0, page_size),
            "summaries": engine.summaries(filtered),
        }

    def get_page(self, session_id: str, offset: int, limit: int, filter_model: Mapping[str, Any]) -> dict[str, Any]:
        session = self._session(session_id)
        filtered = self._filtered(session, filter_model)
        return {
            "kind": "page",
            "page": session.engine.page(filtered, offset, limit),
            "metadata": self._metadata(session),
        }

    def get_summary(
        self, session_id: str, filter_model: Mapping[str, Any], columns: list[str] | None = None
    ) -> dict[str, Any]:
        session = self._session(session_id)
        filtered = self._filtered(session, filter_model)
        return {
            "kind": "summary",
            "summaries": session.engine.summaries(filtered, columns),
        }

    def get_column_values(
        self,
        session_id: str,
        column: str,
        filter_model: Mapping[str, Any],
        search: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        session = self._session(session_id)
        filtered = self._filtered(session, filter_model)
        values, has_more = session.engine.column_values(filtered, column, search, limit)
        return {
            "kind": "columnValues",
            "column": column,
            "values": values,
            "hasMore": has_more,
        }

    def _filtered(self, session: Session, filter_model: Mapping[str, Any]) -> Any:
        model = dict(filter_model)
        if model != session.filter_model:
            session.filtered = session.engine.apply_filter_model(session.original, model)
            session.filter_model = model
        return session.filtered

    def _metadata(self, session: Session) -> dict[str, Any]:
        return {
            "sessionId": session.session_id,
            "backend": session.backend,
            "source": session.source,
            "shape": session.engine.shape(session.original),
            "filteredShape": session.engine.shape(session.filtered),
            "schema": session.engine.schema(session.original),
            "filterModel": session.filter_model,
            "stats": session.engine.header_stats(session.filtered),
        }

    def _session(self, session_id: str) -> Session:
        try:
            return self.sessions[session_id]
        except KeyError as error:
            raise EngineError(f"Unknown session: {session_id}") from error

    def _engine_for_source(self, source: Mapping[str, Any], backend: str | None) -> DataFrameEngine:
        if backend:
            return self._engine(backend)
        if source.get("kind") == "file":
            return self._engine("polars")
        value = self._resolve_notebook_variable(source)
        for engine in self.engines.values():
            if engine.detect(value):
                return engine
        raise EngineError("Could not detect a supported dataframe backend for the source.")

    def _engine(self, backend: str) -> DataFrameEngine:
        try:
            return self.engines[backend]
        except KeyError as error:
            raise EngineError(f"Unsupported backend: {backend}") from error

    def _load_source(self, source: Mapping[str, Any], engine: DataFrameEngine) -> Any:
        kind = source.get("kind")
        if kind == "file":
            path = source.get("path")
            if not path:
                raise EngineError("File source is missing a path.")
            return engine.read_file(str(path))
        if kind in {"notebookVariable", "notebookOutput"}:
            return self._resolve_notebook_variable(source)
        raise EngineError(f"Unsupported source kind: {kind}")

    def _resolve_notebook_variable(self, source: Mapping[str, Any]) -> Any:
        variable_name = source.get("variableName")
        if not variable_name:
            raise EngineError("Notebook source is missing a variable name.")

        main = importlib.import_module("__main__")
        if hasattr(main, variable_name):
            return getattr(main, variable_name)
        raise EngineError(
            "Notebook variable launch requires running the Data Explorer runtime inside the active kernel. "
            f"Variable not found: {variable_name}"
        )
