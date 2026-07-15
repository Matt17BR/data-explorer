from __future__ import annotations

import importlib
import os
import tempfile
import threading
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .engines import DataFrameEngine, EngineError, PandasEngine, PolarsEngine
from .lineage import derive_lineage, reuse_latest_output_ids, schema_with_lineage, source_lineage
from .operations import OperationError, validate_step


@dataclass
class Session:
    session_id: str
    source: dict[str, Any]
    backend: str
    engine: DataFrameEngine
    original: Any
    committed: Any
    filtered: Any
    filter_model: dict[str, Any]
    plan: list[dict[str, Any]]
    plan_input_schemas: list[list[dict[str, Any]]]
    committed_lineage: list[dict[str, str]]
    draft_step: dict[str, Any] | None
    draft_frame: Any | None
    draft_base: Any | None
    draft_lineage: list[dict[str, str]] | None
    replace_step_id: str | None
    stats: dict[str, Any] | None
    source_shape: dict[str, int]
    source_schema: list[dict[str, Any]]
    revision: int
    mode: str
    lock: Any


class SessionManager:
    def __init__(self) -> None:
        self.engines: dict[str, DataFrameEngine] = {
            "polars": PolarsEngine(),
            "pandas": PandasEngine(),
        }
        self.sessions: dict[str, Session] = {}
        self._sessions_lock = threading.RLock()

    def initialize(self) -> dict[str, Any]:
        return {
            "kind": "initialized",
            "protocolVersion": 2,
            "runtimeVersion": "0.2.0a1",
            "capabilities": {
                "editable": True,
                "lazy": True,
                "cancel": True,
                "exportCsv": True,
                "exportParquet": True,
                "notebookInsert": True,
            },
        }

    def open_session(
        self,
        source: Mapping[str, Any],
        backend: str | None = None,
        page_size: int = 200,
        mode: str | None = None,
    ) -> dict[str, Any]:
        engine = self._engine_for_source(source, backend)
        frame = self._load_source(source, engine)
        if source.get("kind") != "file":
            frame = getattr(engine, "normalize", lambda value: value)(frame)
        session_id = str(uuid.uuid4())
        frame = engine.ensure_row_ids(frame, f"{session_id}:source")
        filter_model = {"filters": [], "sort": []}
        filtered = engine.apply_filter_model(frame, filter_model)
        source_shape = engine.shape(frame)
        source_schema = engine.schema(frame)
        initial_lineage = source_lineage(source_schema)
        session = Session(
            session_id=session_id,
            source=dict(source),
            backend=engine.name,
            engine=engine,
            original=frame,
            committed=frame,
            filtered=filtered,
            filter_model=filter_model,
            plan=[],
            plan_input_schemas=[],
            committed_lineage=initial_lineage,
            draft_step=None,
            draft_frame=None,
            draft_base=None,
            draft_lineage=None,
            replace_step_id=None,
            stats=None,
            source_shape=source_shape,
            source_schema=source_schema,
            revision=0,
            mode=mode or ("editing" if source.get("kind") == "file" else "viewing"),
            lock=threading.RLock(),
        )
        with self._sessions_lock:
            self.sessions[session_id] = session
        return {
            "kind": "sessionOpened",
            "metadata": self._metadata(session),
            "page": engine.page(filtered, 0, page_size),
            "summaries": engine.summaries(
                filtered,
                [column["name"] for column in source_schema[:8]],
            ),
        }

    def get_page(
        self,
        session_id: str,
        revision: int,
        offset: int,
        limit: int,
        filter_model: Mapping[str, Any],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            return {
                "kind": "page",
                "revision": session.revision,
                "page": session.engine.page(filtered, offset, limit),
                "metadata": self._metadata(session),
            }

    def get_summary(
        self,
        session_id: str,
        revision: int,
        filter_model: Mapping[str, Any],
        columns: list[str] | None = None,
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            return {
                "kind": "summary",
                "revision": session.revision,
                "summaries": session.engine.summaries(filtered, columns),
            }

    def get_column_values(
        self,
        session_id: str,
        revision: int,
        column: str,
        filter_model: Mapping[str, Any],
        search: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            values, has_more = session.engine.column_values(filtered, column, search, limit)
            return {
                "kind": "columnValues",
                "revision": session.revision,
                "column": column,
                "values": values,
                "hasMore": has_more,
            }

    def get_dataset_stats(
        self,
        session_id: str,
        revision: int,
        filter_model: Mapping[str, Any],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            filtered = self._filtered(session, filter_model)
            session.stats = session.engine.header_stats(filtered)
            return {
                "kind": "datasetStats",
                "revision": session.revision,
                "stats": session.stats,
            }

    def preview_step(
        self,
        session_id: str,
        revision: int,
        step: Mapping[str, Any],
        offset: int,
        limit: int,
        replace_step_id: str | None = None,
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            self._assert_editable(session)
            try:
                normalized = validate_step(step)
            except OperationError as error:
                raise EngineError(str(error)) from error

            diff_base = session.committed
            diff_base_lineage = session.committed_lineage
            base = session.committed
            base_lineage = session.committed_lineage
            candidate_plan = [*session.plan, normalized]
            if replace_step_id is not None:
                if not session.plan or session.plan[-1]["id"] != replace_step_id:
                    raise EngineError("Only the latest applied step can be edited.")
                candidate_plan = [*session.plan[:-1], normalized]
                base, base_lineage = self._replay(session, session.plan[:-1])

            draft = session.engine.apply_transform(base, normalized)
            draft = session.engine.ensure_row_ids(draft, f"{session.session_id}:{normalized['id']}")
            draft_lineage = derive_lineage(base_lineage, session.engine.schema(draft), normalized)
            if replace_step_id is not None:
                draft_lineage = reuse_latest_output_ids(draft_lineage, session.committed_lineage, base_lineage)
            session.draft_step = normalized
            session.draft_frame = draft
            session.draft_base = base
            session.draft_lineage = draft_lineage
            session.replace_step_id = replace_step_id
            session.stats = None
            session.revision += 1
            filtered = self._filtered(session, session.filter_model)
            return {
                "kind": "stepPreview",
                "revision": session.revision,
                "metadata": self._metadata(session),
                "page": session.engine.page(filtered, offset, limit),
                "diff": self._diff(
                    session,
                    diff_base,
                    draft,
                    diff_base_lineage,
                    draft_lineage,
                    normalized,
                    offset,
                    limit,
                ),
                "code": session.engine.compile_plan(candidate_plan),
                "warnings": list(normalized["params"].get("warnings", [])),
            }

    def apply_draft(self, session_id: str, revision: int, offset: int, limit: int) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            self._assert_editable(session)
            if session.draft_step is None or session.draft_frame is None or session.draft_lineage is None:
                raise EngineError("There is no draft step to apply.")
            if session.replace_step_id is None:
                session.plan.append(session.draft_step)
                session.plan_input_schemas.append(
                    schema_with_lineage(session.engine.schema(session.draft_base), session.committed_lineage)
                )
            else:
                session.plan[-1] = session.draft_step
                _, input_lineage = self._replay(session, session.plan[:-1])
                session.plan_input_schemas[-1] = schema_with_lineage(
                    session.engine.schema(session.draft_base), input_lineage
                )
            session.committed = session.draft_frame
            session.committed_lineage = session.draft_lineage
            self._clear_draft(session)
            return self._finish_plan_change(session, "apply", offset, limit, reset_view=True)

    def discard_draft(self, session_id: str, revision: int, offset: int, limit: int) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            if session.draft_step is None:
                raise EngineError("There is no draft step to discard.")
            self._clear_draft(session)
            return self._finish_plan_change(session, "discard", offset, limit, reset_view=False)

    def undo_step(self, session_id: str, revision: int, offset: int, limit: int) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            self._assert_editable(session)
            if session.draft_step is not None:
                raise EngineError("Discard the draft step before undoing an applied step.")
            if not session.plan:
                raise EngineError("There is no applied step to undo.")
            session.plan.pop()
            session.plan_input_schemas.pop()
            session.committed, session.committed_lineage = self._replay(session, session.plan)
            return self._finish_plan_change(session, "undo", offset, limit, reset_view=True)

    def export_data(
        self,
        session_id: str,
        revision: int,
        path: str,
        format_name: Literal["csv", "parquet"],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with session.lock:
            self._assert_revision(session, revision)
            self._assert_editable(session)
            if session.draft_step is not None:
                raise EngineError("Apply or discard the draft step before exporting cleaned data.")
            if format_name not in {"csv", "parquet"}:
                raise EngineError(f"Unsupported export format: {format_name}")

            destination = Path(path).expanduser().resolve()
            source_path = session.source.get("path")
            if source_path and destination == Path(str(source_path)).expanduser().resolve():
                raise EngineError("Choose a new destination. Data Explorer never overwrites the source file.")
            if not destination.parent.is_dir():
                raise EngineError(f"Export directory does not exist: {destination.parent}")

            temporary_path: str | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    prefix=f".{destination.name}.",
                    suffix=".tmp",
                    dir=destination.parent,
                    delete=False,
                ) as temporary:
                    temporary_path = temporary.name
                session.engine.export_data(session.committed, temporary_path, format_name)
                os.replace(temporary_path, destination)
                temporary_path = None
            finally:
                if temporary_path is not None:
                    Path(temporary_path).unlink(missing_ok=True)

            return {
                "kind": "dataExported",
                "revision": session.revision,
                "path": str(destination),
                "format": format_name,
                "shape": session.engine.shape(session.committed),
            }

    def close_session(self, session_id: str, revision: int) -> dict[str, Any]:
        self._assert_revision(self._session(session_id), revision)
        with self._sessions_lock:
            session = self.sessions.pop(session_id, None)
        if session is None:
            raise EngineError(f"Unknown session: {session_id}")
        return {"kind": "sessionClosed", "sessionId": session_id}

    def _filtered(self, session: Session, filter_model: Mapping[str, Any]) -> Any:
        model = dict(filter_model)
        if session.draft_frame is not None:
            if model != session.filter_model:
                session.filter_model = model
                session.stats = None
            return session.engine.apply_filter_model(session.draft_frame, model)
        if model != session.filter_model:
            session.filtered = session.engine.apply_filter_model(session.committed, model)
            session.filter_model = model
            session.stats = None
        return session.filtered

    def _metadata(self, session: Session) -> dict[str, Any]:
        display_frame = session.draft_frame if session.draft_frame is not None else session.committed
        filtered = self._filtered(session, session.filter_model)
        display_lineage = session.draft_lineage if session.draft_frame is not None else session.committed_lineage
        if display_lineage is None:
            raise EngineError("The active dataframe is missing column lineage.")
        metadata = {
            "protocolVersion": 2,
            "sessionId": session.session_id,
            "revision": session.revision,
            "backend": session.backend,
            "mode": session.mode,
            "source": session.source,
            "capabilities": self._capabilities(session),
            "shape": session.engine.shape(display_frame),
            "filteredShape": session.engine.shape(filtered),
            "schema": schema_with_lineage(session.engine.schema(display_frame), display_lineage),
            "filterModel": session.filter_model,
            "steps": session.plan,
        }
        if session.plan_input_schemas:
            metadata["latestStepInputSchema"] = session.plan_input_schemas[-1]
        if session.draft_step is not None:
            metadata["draftStep"] = session.draft_step
        if session.replace_step_id is not None:
            metadata["draftReplacesStepId"] = session.replace_step_id
        if session.stats is not None:
            metadata["stats"] = session.stats
        return metadata

    def _finish_plan_change(
        self,
        session: Session,
        action: str,
        offset: int,
        limit: int,
        *,
        reset_view: bool,
    ) -> dict[str, Any]:
        if reset_view:
            session.filter_model = {"filters": [], "sort": []}
        session.filtered = session.engine.apply_filter_model(session.committed, session.filter_model)
        session.stats = None
        session.revision += 1
        return {
            "kind": "planUpdated",
            "action": action,
            "revision": session.revision,
            "metadata": self._metadata(session),
            "page": session.engine.page(session.filtered, offset, limit),
            "code": session.engine.compile_plan(session.plan),
        }

    def _replay(self, session: Session, plan: list[dict[str, Any]]) -> tuple[Any, list[dict[str, str]]]:
        frame = session.original
        lineage = source_lineage(session.source_schema)
        for step in plan:
            frame = session.engine.apply_transform(frame, step)
            frame = session.engine.ensure_row_ids(frame, f"{session.session_id}:{step['id']}")
            lineage = derive_lineage(lineage, session.engine.schema(frame), step)
        return frame, lineage

    def _clear_draft(self, session: Session) -> None:
        session.draft_step = None
        session.draft_frame = None
        session.draft_base = None
        session.draft_lineage = None
        session.replace_step_id = None

    def _diff(
        self,
        session: Session,
        before: Any,
        after: Any,
        before_lineage: list[dict[str, str]],
        after_lineage: list[dict[str, str]],
        step: Mapping[str, Any],
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        before_shape = session.engine.shape(before)
        after_shape = session.engine.shape(after)
        before_schema = schema_with_lineage(session.engine.schema(before), before_lineage)
        after_schema = schema_with_lineage(session.engine.schema(after), after_lineage)
        before_ids = [column["id"] for column in before_schema]
        after_ids = [column["id"] for column in after_schema]
        common_ids = [identifier for identifier in before_ids if identifier in after_ids]
        before_page = session.engine.page(before, offset, limit)
        after_page = session.engine.page(after, offset, limit)
        before_positions = {identifier: index for index, identifier in enumerate(before_ids)}
        after_positions = {identifier: index for index, identifier in enumerate(after_ids)}
        after_names = {column["id"]: column["name"] for column in after_schema}
        before_rows = {row["id"]: row for row in before_page["rows"]}
        cells: list[dict[str, Any]] = []
        changed_cells = 0
        for after_row in after_page["rows"]:
            before_row = before_rows.get(after_row["id"])
            if before_row is None:
                continue
            for identifier in common_ids:
                old = before_row["values"][before_positions[identifier]]
                new = after_row["values"][after_positions[identifier]]
                if old != new:
                    changed_cells += 1
                    if len(cells) < 500:
                        cells.append(
                            {
                                "rowNumber": after_row["rowNumber"],
                                "column": after_names[identifier],
                                "before": old,
                                "after": new,
                            }
                        )
        replaces_rows = step["kind"] in {"groupBy", "customCode"} and not set(before_rows).intersection(
            row["id"] for row in after_page["rows"]
        )
        return {
            "addedRows": after_shape["rows"] if replaces_rows else max(0, after_shape["rows"] - before_shape["rows"]),
            "removedRows": before_shape["rows"]
            if replaces_rows
            else max(0, before_shape["rows"] - after_shape["rows"]),
            "addedColumns": [column["name"] for column in after_schema if column["id"] not in before_ids],
            "removedColumns": [column["name"] for column in before_schema if column["id"] not in after_ids],
            "changedCells": changed_cells,
            "cells": cells,
            "truncated": changed_cells > len(cells)
            or before_page["totalRows"] > offset + limit
            or after_page["totalRows"] > offset + limit,
        }

    def _assert_editable(self, session: Session) -> None:
        if session.mode != "editing":
            raise EngineError("This session is in viewing mode. Change it to editing before adding steps.")

    def _session(self, session_id: str) -> Session:
        with self._sessions_lock:
            try:
                return self.sessions[session_id]
            except KeyError as error:
                raise EngineError(f"Unknown session: {session_id}") from error

    def _capabilities(self, session: Session) -> dict[str, bool]:
        source_kind = session.source.get("kind")
        extension = str(session.source.get("path", "")).lower()
        return {
            "editable": session.mode == "editing",
            "lazy": session.backend == "polars"
            and source_kind == "file"
            and extension.endswith((".csv", ".tsv", ".parquet", ".jsonl")),
            "cancel": True,
            "exportCsv": session.mode == "editing",
            "exportParquet": session.mode == "editing",
            "notebookInsert": source_kind == "notebookVariable",
        }

    def _assert_revision(self, session: Session, revision: int) -> None:
        if revision != session.revision:
            raise EngineError(f"Stale session revision {revision}; current revision is {session.revision}.")

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
            options = source.get("importOptions")
            return engine.read_file(str(path), options if isinstance(options, Mapping) else None)
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
