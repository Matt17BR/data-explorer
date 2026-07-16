from __future__ import annotations

import importlib
import json
import os
import tempfile
import threading
import uuid
from collections import OrderedDict
from collections.abc import Iterator, Mapping
from contextlib import contextmanager, suppress
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ._column_binding import ColumnBindingError, bind_step
from .engines import DataFrameEngine, EngineError, EngineRegistry, default_engine_registry
from .lineage import derive_lineage, schema_with_lineage, source_lineage
from .operations import OperationError, validate_step
from .version import __version__

PAGE_CACHE_LIMIT = 8
PAGE_CACHE_BYTE_LIMIT = 16 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class _CachedPage:
    payload: dict[str, Any]
    size_bytes: int


@dataclass(frozen=True, slots=True)
class _SourceFingerprint:
    requested_path: str
    resolved_path: str
    device: int
    inode: int
    size: int
    modified_ns: int


class _SourceChangedError(EngineError):
    """Recoverable source invalidation that must also invalidate cached pages."""


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
    filtered_shape: dict[str, int]
    plan: list[dict[str, Any]]
    bound_plan: list[dict[str, Any]]
    plan_input_schemas: list[list[dict[str, Any]]]
    committed_lineage: list[dict[str, str]]
    committed_shape: dict[str, int]
    committed_schema: list[dict[str, Any]]
    draft_step: dict[str, Any] | None
    draft_bound_step: dict[str, Any] | None
    draft_frame: Any | None
    draft_base_lineage: list[dict[str, str]] | None
    draft_base_schema: list[dict[str, Any]] | None
    draft_lineage: list[dict[str, str]] | None
    draft_shape: dict[str, int] | None
    draft_schema: list[dict[str, Any]] | None
    replace_step_id: str | None
    source_shape: dict[str, int]
    source_schema: list[dict[str, Any]]
    source_fingerprint: _SourceFingerprint | None
    page_cache: OrderedDict[tuple[int, int, int, int], _CachedPage]
    page_cache_bytes: int
    view_generation: int
    revision: int
    mode: str
    lock: Any
    admission_condition: Any
    profile_condition: Any
    active_profiles: int
    waiting_writers: int
    disposed: bool = False

    @property
    def display_frame(self) -> Any:
        return self.draft_frame if self.draft_frame is not None else self.committed

    @property
    def display_shape(self) -> dict[str, int]:
        if self.draft_frame is None:
            return self.committed_shape
        if self.draft_shape is None:
            raise EngineError("The draft dataframe is missing shape metadata.")
        return self.draft_shape

    @property
    def display_schema(self) -> list[dict[str, Any]]:
        if self.draft_frame is None:
            return self.committed_schema
        if self.draft_schema is None:
            raise EngineError("The draft dataframe is missing schema metadata.")
        return self.draft_schema

    def dispose(self, *, suppress_errors: bool = False) -> None:
        if self.disposed:
            return
        self.disposed = True
        self.view_generation += 1
        self.clear_page_cache()
        try:
            self.engine.close()
        except Exception as error:
            if not suppress_errors:
                raise EngineError(f"Could not close the {self.backend} session: {error}") from error

    def clear_page_cache(self) -> None:
        self.page_cache.clear()
        self.page_cache_bytes = 0


@dataclass(slots=True)
class _SessionMutationSnapshot:
    """Session-owned state that an edit may change before its response is complete."""

    committed: Any
    filtered: Any
    filter_model: dict[str, Any]
    filtered_shape: dict[str, int]
    plan: list[dict[str, Any]]
    bound_plan: list[dict[str, Any]]
    plan_input_schemas: list[list[dict[str, Any]]]
    committed_lineage: list[dict[str, str]]
    committed_shape: dict[str, int]
    committed_schema: list[dict[str, Any]]
    draft_step: dict[str, Any] | None
    draft_bound_step: dict[str, Any] | None
    draft_frame: Any | None
    draft_base_lineage: list[dict[str, str]] | None
    draft_base_schema: list[dict[str, Any]] | None
    draft_lineage: list[dict[str, str]] | None
    draft_shape: dict[str, int] | None
    draft_schema: list[dict[str, Any]] | None
    replace_step_id: str | None
    page_cache: OrderedDict[tuple[int, int, int, int], _CachedPage]
    page_cache_bytes: int
    view_generation: int
    revision: int

    @classmethod
    def capture(cls, session: Session) -> _SessionMutationSnapshot:
        return cls(
            committed=session.committed,
            filtered=session.filtered,
            filter_model=deepcopy(session.filter_model),
            filtered_shape=deepcopy(session.filtered_shape),
            plan=deepcopy(session.plan),
            bound_plan=deepcopy(session.bound_plan),
            plan_input_schemas=deepcopy(session.plan_input_schemas),
            committed_lineage=deepcopy(session.committed_lineage),
            committed_shape=deepcopy(session.committed_shape),
            committed_schema=deepcopy(session.committed_schema),
            draft_step=deepcopy(session.draft_step),
            draft_bound_step=deepcopy(session.draft_bound_step),
            draft_frame=session.draft_frame,
            draft_base_lineage=deepcopy(session.draft_base_lineage),
            draft_base_schema=deepcopy(session.draft_base_schema),
            draft_lineage=deepcopy(session.draft_lineage),
            draft_shape=deepcopy(session.draft_shape),
            draft_schema=deepcopy(session.draft_schema),
            replace_step_id=session.replace_step_id,
            # Cached payloads are immutable after insertion. Copy the bounded LRU
            # index, not the potentially multi-megabyte data blocks themselves.
            page_cache=OrderedDict(session.page_cache),
            page_cache_bytes=session.page_cache_bytes,
            view_generation=session.view_generation,
            revision=session.revision,
        )

    def restore(self, session: Session) -> None:
        session.committed = self.committed
        session.filtered = self.filtered
        session.filter_model = self.filter_model
        session.filtered_shape = self.filtered_shape
        session.plan = self.plan
        session.bound_plan = self.bound_plan
        session.plan_input_schemas = self.plan_input_schemas
        session.committed_lineage = self.committed_lineage
        session.committed_shape = self.committed_shape
        session.committed_schema = self.committed_schema
        session.draft_step = self.draft_step
        session.draft_bound_step = self.draft_bound_step
        session.draft_frame = self.draft_frame
        session.draft_base_lineage = self.draft_base_lineage
        session.draft_base_schema = self.draft_base_schema
        session.draft_lineage = self.draft_lineage
        session.draft_shape = self.draft_shape
        session.draft_schema = self.draft_schema
        session.replace_step_id = self.replace_step_id
        session.page_cache = self.page_cache
        session.page_cache_bytes = self.page_cache_bytes
        session.view_generation = self.view_generation
        session.revision = self.revision


class SessionManager:
    def __init__(self, registry: EngineRegistry | None = None) -> None:
        self.registry = registry or default_engine_registry()
        self.sessions: dict[str, Session] = {}
        self._sessions_lock = threading.RLock()
        self._sessions_condition = threading.Condition(self._sessions_lock)
        self._pending_opens = 0
        self._opening_session_ids: set[str] = set()
        self._closed = False
        self._shutdown_in_progress = False
        self._shutdown_complete = False
        self._shutdown_error_message: str | None = None

    def initialize(self) -> dict[str, Any]:
        return {
            "kind": "initialized",
            "protocolVersion": 2,
            "runtimeVersion": __version__,
            "capabilities": {
                "editable": True,
                "lazy": True,
                "cancel": False,
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
        requested_session_id: str | None = None,
    ) -> dict[str, Any]:
        if requested_session_id is not None and (not isinstance(requested_session_id, str) or not requested_session_id):
            raise EngineError("requestedSessionId must be a non-empty string.")
        session_id = requested_session_id or str(uuid.uuid4())
        with self._sessions_condition:
            if self._closed:
                raise EngineError("The runtime session manager is closed.")
            if session_id in self.sessions or session_id in self._opening_session_ids:
                raise EngineError(f"Session already exists: {session_id}")
            self._opening_session_ids.add(session_id)
            self._pending_opens += 1

        engine: DataFrameEngine | None = None
        session: Session | None = None
        try:
            engine = self._engine_for_source(source, backend)
            source_kind = str(source.get("kind", ""))
            if source_kind not in engine.capabilities.source_kinds:
                raise EngineError(f"The {engine.name} backend does not support {source_kind or 'unknown'} sources.")
            source_fingerprint = self._source_fingerprint(source, engine)
            load_source = dict(source)
            if source_fingerprint is not None:
                load_source["path"] = source_fingerprint.resolved_path
            frame = self._load_source(load_source, engine)
            if source.get("kind") != "file":
                frame = getattr(engine, "normalize", lambda value: value)(frame)
            engine.validate_internal_row_id_namespace(frame)
            engine.validate_column_addressability(frame)
            frame = engine.ensure_row_ids(frame, f"{session_id}:source")
            filter_model = {"logic": "and", "filters": [], "sort": []}
            source_shape = engine.shape(frame)
            source_schema = engine.schema(frame)
            initial_lineage = source_lineage(source_schema)
            session_lock = threading.RLock()
            session = Session(
                session_id=session_id,
                source=dict(source),
                backend=engine.name,
                engine=engine,
                original=frame,
                committed=frame,
                filtered=frame,
                filter_model=filter_model,
                filtered_shape=source_shape,
                plan=[],
                bound_plan=[],
                plan_input_schemas=[],
                committed_lineage=initial_lineage,
                committed_shape=source_shape,
                committed_schema=source_schema,
                draft_step=None,
                draft_bound_step=None,
                draft_frame=None,
                draft_base_lineage=None,
                draft_base_schema=None,
                draft_lineage=None,
                draft_shape=None,
                draft_schema=None,
                replace_step_id=None,
                source_shape=source_shape,
                source_schema=source_schema,
                source_fingerprint=source_fingerprint,
                page_cache=OrderedDict(),
                page_cache_bytes=0,
                view_generation=0,
                revision=0,
                mode=mode or ("editing" if source.get("kind") == "file" else "viewing"),
                lock=session_lock,
                admission_condition=threading.Condition(threading.Lock()),
                profile_condition=threading.Condition(session_lock),
                active_profiles=0,
                waiting_writers=0,
            )
            initial_page = self._page(session, 0, page_size)
            response = {
                "kind": "sessionOpened",
                "metadata": self._metadata(session),
                "page": initial_page,
                "summaries": [],
            }
            self._assert_source_unchanged(session)
            with self._sessions_condition:
                if self._closed:
                    raise EngineError("The runtime session manager is closed.")
                self.sessions[session_id] = session
            return response
        except EngineError:
            if engine is not None:
                self._dispose_open_failure(session, engine)
            raise
        except Exception as error:
            if engine is not None:
                self._dispose_open_failure(session, engine)
            label = source.get("label") or source.get("path") or source.get("variableName") or "source"
            raise EngineError(f"Could not read {label}: {error}") from error
        finally:
            with self._sessions_condition:
                self._opening_session_ids.discard(session_id)
                self._pending_opens -= 1
                self._sessions_condition.notify_all()

    def get_page(
        self,
        session_id: str,
        revision: int,
        offset: int,
        limit: int,
        filter_model: Mapping[str, Any],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with self._shared_session_read(session), self._validated_source_read(session):
            self._assert_revision(session, revision)
            self._filtered(session, filter_model)
            return {
                "kind": "page",
                "revision": session.revision,
                "page": self._page(session, offset, limit),
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
        with self._profile_view(session, revision, filter_model) as filtered:
            return {
                "kind": "summary",
                "revision": revision,
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
        with self._shared_session_read(session), self._validated_source_read(session):
            self._assert_revision(session, revision)
            filtered = self._view_query_frame(session, filter_model)
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
        with self._profile_view(session, revision, filter_model) as filtered:
            stats = session.engine.header_stats(filtered)
            return {
                "kind": "datasetStats",
                "revision": revision,
                "stats": stats,
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
        with self._atomic_session_access(session), self._validated_source_read(session):
            self._assert_revision(session, revision)
            self._assert_editable(session)
            if session.draft_step is not None:
                raise EngineError("Apply or discard the current draft before previewing another step.")
            try:
                normalized = validate_step(step)
            except OperationError as error:
                raise EngineError(str(error)) from error
            self._assert_bound_history(session)

            retained_steps = session.plan if replace_step_id is None else session.plan[:-1]
            if any(applied["id"] == normalized["id"] for applied in retained_steps):
                raise EngineError(f"Applied step IDs must be unique: {normalized['id']}")

            diff_base = session.committed
            diff_base_lineage = session.committed_lineage
            diff_base_shape = session.committed_shape
            diff_base_schema = session.committed_schema
            base = session.committed
            base_lineage = session.committed_lineage
            base_schema = session.committed_schema
            retained_bound_steps = session.bound_plan if replace_step_id is None else session.bound_plan[:-1]
            if replace_step_id is not None:
                if not session.plan or session.plan[-1]["id"] != replace_step_id:
                    raise EngineError("Only the latest applied step can be edited.")
                if normalized["id"] != replace_step_id:
                    raise EngineError("An edited step must retain the applied step ID it replaces.")
                base, base_lineage, _, base_schema = self._replay(session, session.bound_plan[:-1])

            try:
                bound_step = bind_step(normalized, base_schema, base_lineage)
            except ColumnBindingError as error:
                raise EngineError(str(error)) from error
            candidate_bound_plan = [*retained_bound_steps, bound_step]

            draft = self._apply_transform_with_row_ids(session, base, bound_step)
            draft_shape = session.engine.shape(draft)
            draft_schema = session.engine.schema(draft)
            draft_lineage = derive_lineage(base_lineage, draft_schema, bound_step)
            session.draft_step = normalized
            session.draft_bound_step = bound_step
            session.draft_frame = draft
            session.draft_base_lineage = base_lineage
            session.draft_base_schema = base_schema
            session.draft_lineage = draft_lineage
            session.draft_shape = draft_shape
            session.draft_schema = draft_schema
            session.replace_step_id = replace_step_id
            session.revision += 1
            self._refresh_filtered(session, session.filter_model)
            return {
                "kind": "stepPreview",
                "revision": session.revision,
                "metadata": self._metadata(session),
                "page": self._page(session, offset, limit),
                "diff": self._diff(
                    session,
                    diff_base,
                    draft,
                    diff_base_lineage,
                    draft_lineage,
                    diff_base_shape,
                    draft_shape,
                    diff_base_schema,
                    draft_schema,
                    normalized,
                    offset,
                    limit,
                ),
                "code": session.engine.compile_plan(candidate_bound_plan),
                "warnings": list(normalized["params"].get("warnings", [])),
            }

    def inspect_step(
        self,
        session_id: str,
        revision: int,
        step_id: str,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        """Reconstruct one applied step's boundary without publishing session state."""
        session = self._session(session_id)
        with self._shared_session_read(session), self._validated_source_read(session):
            self._assert_revision(session, revision)
            matches = [index for index, step in enumerate(session.plan) if step["id"] == step_id]
            if not matches:
                raise EngineError(f"Unknown applied step: {step_id}")
            if len(matches) != 1:
                raise EngineError(f"Applied step ID is not unique: {step_id}")
            self._assert_bound_history(session)

            step_index = matches[0]
            bound_step = session.bound_plan[step_index]
            before, _, before_shape, before_raw_schema = self._replay(session, session.bound_plan[:step_index])
            after = self._apply_transform_with_row_ids(session, before, bound_step)
            after_shape = session.engine.shape(after)
            after_raw_schema = session.engine.schema(after)

            input_schema = deepcopy(session.plan_input_schemas[step_index])
            output_schema = (
                deepcopy(session.plan_input_schemas[step_index + 1])
                if step_index + 1 < len(session.plan_input_schemas)
                else schema_with_lineage(session.committed_schema, session.committed_lineage)
            )
            before_lineage = self._lineage_from_schema(input_schema)
            after_lineage = self._lineage_from_schema(output_schema)
            # Validate that the replayed engine frames still match the recorded
            # identity boundary before returning it to an untrusted caller.
            try:
                input_schema = schema_with_lineage(before_raw_schema, before_lineage)
                output_schema = schema_with_lineage(after_raw_schema, after_lineage)
            except ValueError as error:
                raise EngineError("The applied cleaning-step history is inconsistent.") from error
            input_page = session.engine.page(before, offset, limit, total_rows=before_shape["rows"])
            output_page = session.engine.page(after, offset, limit, total_rows=after_shape["rows"])

            return {
                "kind": "stepInspection",
                "revision": session.revision,
                "stepId": step_id,
                "stepIndex": step_index,
                "inputPage": input_page,
                "outputPage": output_page,
                "inputSchema": input_schema,
                "outputSchema": output_schema,
                "diff": self._diff(
                    session,
                    before,
                    after,
                    before_lineage,
                    after_lineage,
                    before_shape,
                    after_shape,
                    before_raw_schema,
                    after_raw_schema,
                    bound_step,
                    offset,
                    limit,
                    before_page=input_page,
                    after_page=output_page,
                ),
                "code": session.engine.compile_plan(session.bound_plan[: step_index + 1]),
            }

    def apply_draft(self, session_id: str, revision: int, offset: int, limit: int) -> dict[str, Any]:
        session = self._session(session_id)
        with self._atomic_session_read(session):
            self._assert_revision(session, revision)
            self._assert_editable(session)
            self._assert_bound_history(session)
            if (
                session.draft_step is None
                or session.draft_bound_step is None
                or session.draft_frame is None
                or session.draft_base_lineage is None
                or session.draft_base_schema is None
                or session.draft_lineage is None
                or session.draft_shape is None
                or session.draft_schema is None
            ):
                raise EngineError("There is no draft step to apply.")
            if session.replace_step_id is None:
                session.plan.append(session.draft_step)
                session.bound_plan.append(session.draft_bound_step)
                session.plan_input_schemas.append(
                    schema_with_lineage(session.draft_base_schema, session.draft_base_lineage)
                )
            else:
                session.plan[-1] = session.draft_step
                session.bound_plan[-1] = session.draft_bound_step
                session.plan_input_schemas[-1] = schema_with_lineage(
                    session.draft_base_schema, session.draft_base_lineage
                )
            session.committed = session.draft_frame
            session.committed_lineage = session.draft_lineage
            session.committed_shape = session.draft_shape
            session.committed_schema = session.draft_schema
            self._clear_draft(session)
            return self._finish_plan_change(session, "apply", offset, limit, reset_view=True)

    def discard_draft(self, session_id: str, revision: int, offset: int, limit: int) -> dict[str, Any]:
        session = self._session(session_id)
        with self._atomic_session_read(session):
            self._assert_revision(session, revision)
            if session.draft_step is None:
                raise EngineError("There is no draft step to discard.")
            self._clear_draft(session)
            return self._finish_plan_change(session, "discard", offset, limit, reset_view=False)

    def undo_step(self, session_id: str, revision: int, offset: int, limit: int) -> dict[str, Any]:
        session = self._session(session_id)
        with self._atomic_session_read(session):
            self._assert_revision(session, revision)
            self._assert_editable(session)
            self._assert_bound_history(session)
            if session.draft_step is not None:
                raise EngineError("Discard the draft step before undoing an applied step.")
            if not session.plan:
                raise EngineError("There is no applied step to undo.")
            session.plan.pop()
            session.bound_plan.pop()
            session.plan_input_schemas.pop()
            (
                session.committed,
                session.committed_lineage,
                session.committed_shape,
                session.committed_schema,
            ) = self._replay(session, session.bound_plan)
            return self._finish_plan_change(session, "undo", offset, limit, reset_view=True)

    def export_data(
        self,
        session_id: str,
        revision: int,
        path: str,
        format_name: Literal["csv", "parquet"],
    ) -> dict[str, Any]:
        session = self._session(session_id)
        with self._exclusive_session_read(session):
            self._assert_revision(session, revision)
            self._assert_editable(session)
            if session.draft_step is not None:
                raise EngineError("Apply or discard the draft step before exporting cleaned data.")
            if format_name not in {"csv", "parquet"}:
                raise EngineError(f"Unsupported export format: {format_name}")
            if format_name not in session.engine.capabilities.export_formats:
                raise EngineError(f"The {session.backend} backend cannot export {format_name} data.")

            destination = Path(path).expanduser().resolve()
            source_path = session.source.get("path")
            if source_path and destination == Path(str(source_path)).expanduser().resolve():
                raise EngineError("Choose a new destination. Open Wrangler never overwrites the source file.")
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
                self._assert_source_unchanged(session)
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
                "shape": dict(session.committed_shape),
            }

    def close_session(self, session_id: str, revision: int) -> dict[str, Any]:
        session = self._session(session_id)
        with self._exclusive_session_access(session):
            # Closing is cleanup, not a state mutation that consumes a confirmed
            # revision. The caller may deliberately be using its last confirmed
            # revision after a timed-out or malformed mutation response, while the
            # runtime may already have committed a newer revision. Refusing that
            # close would orphan the live engine and session indefinitely.
            _ = revision
            with self._sessions_lock:
                if self.sessions.get(session_id) is not session:
                    raise EngineError(f"Unknown session: {session_id}")
                del self.sessions[session_id]
            session.dispose()
            return {"kind": "sessionClosed", "sessionId": session_id}

    def close_all(self) -> None:
        with self._sessions_condition:
            self._closed = True
            if self._shutdown_complete:
                self._raise_shutdown_error()
                return
            if self._shutdown_in_progress:
                while not self._shutdown_complete:
                    self._sessions_condition.wait()
                self._raise_shutdown_error()
                return
            self._shutdown_in_progress = True

            interruptible_sessions = [
                session
                for session in self.sessions.values()
                if session.engine.capabilities.supports_shutdown_interrupt and not session.disposed
            ]

        # Interrupt must not wait for the session lock: the work that needs to be
        # interrupted owns that lock until its engine call returns.
        for session in interruptible_sessions:
            with suppress(Exception):
                session.engine.interrupt()

        with self._sessions_condition:
            while self._pending_opens:
                self._sessions_condition.wait()
            sessions = list(self.sessions.values())
            self.sessions.clear()
        cleanup_errors: list[str] = []
        try:
            for session in sessions:
                with self._exclusive_session_access(session):
                    try:
                        session.dispose()
                    except EngineError as error:
                        # Shutdown is terminal, so keep draining every owned
                        # engine. Report all failures in deterministic session
                        # registration order after cleanup has finished.
                        cleanup_errors.append(str(error))
        finally:
            with self._sessions_condition:
                self._shutdown_error_message = self._format_shutdown_errors(cleanup_errors)
                self._shutdown_complete = True
                self._shutdown_in_progress = False
                self._sessions_condition.notify_all()
        self._raise_shutdown_error()

    @staticmethod
    def _format_shutdown_errors(cleanup_errors: list[str]) -> str | None:
        if not cleanup_errors:
            return None
        if len(cleanup_errors) == 1:
            return cleanup_errors[0]
        details = "; ".join(f"{index}) {message}" for index, message in enumerate(cleanup_errors, start=1))
        return f"Could not close {len(cleanup_errors)} runtime sessions: {details}"

    def _raise_shutdown_error(self) -> None:
        if self._shutdown_error_message is not None:
            raise EngineError(self._shutdown_error_message)

    def _filtered(self, session: Session, filter_model: Mapping[str, Any]) -> Any:
        model = self._normalize_filter_model(filter_model)
        if model != session.filter_model:
            self._refresh_filtered(session, model)
        return session.filtered

    def _view_query_frame(self, session: Session, filter_model: Mapping[str, Any]) -> Any:
        """Resolve a profiling view without changing the confirmed grid view."""
        model = self._normalize_filter_model(filter_model)
        if model == session.filter_model:
            return session.filtered
        if not model.get("filters") and not model.get("sort"):
            return session.display_frame
        return session.engine.apply_filter_model(session.display_frame, model)

    def _refresh_filtered(self, session: Session, filter_model: Mapping[str, Any]) -> None:
        model = self._normalize_filter_model(filter_model)
        has_filters = bool(model.get("filters"))
        has_sort = bool(model.get("sort"))
        if not has_filters and not has_sort:
            filtered = session.display_frame
            filtered_shape = session.display_shape
        else:
            filtered = session.engine.apply_filter_model(session.display_frame, model)
            filtered_shape = session.engine.shape(filtered) if has_filters else session.display_shape

        session.filtered = filtered
        session.filter_model = model
        session.filtered_shape = filtered_shape
        self._invalidate_page_cache(session)

    @staticmethod
    def _invalidate_page_cache(session: Session) -> None:
        session.view_generation += 1
        session.clear_page_cache()

    @staticmethod
    def _normalize_filter_model(filter_model: Mapping[str, Any]) -> dict[str, Any]:
        model = deepcopy(dict(filter_model))
        model.setdefault("logic", "and")
        return model

    @staticmethod
    def _page(session: Session, offset: int, limit: int) -> dict[str, Any]:
        key = (session.view_generation, session.revision, offset, limit)
        cached = session.page_cache.get(key)
        if cached is not None:
            session.page_cache.move_to_end(key)
            return cached.payload

        page = session.engine.page(
            session.filtered,
            offset,
            limit,
            total_rows=session.filtered_shape["rows"],
        )
        page_size = len(json.dumps(page, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        if page_size > PAGE_CACHE_BYTE_LIMIT:
            return page

        session.page_cache[key] = _CachedPage(page, page_size)
        session.page_cache_bytes += page_size
        session.page_cache.move_to_end(key)
        while len(session.page_cache) > PAGE_CACHE_LIMIT or session.page_cache_bytes > PAGE_CACHE_BYTE_LIMIT:
            _, evicted = session.page_cache.popitem(last=False)
            session.page_cache_bytes -= evicted.size_bytes
        return page

    def _metadata(self, session: Session) -> dict[str, Any]:
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
            "shape": dict(session.display_shape),
            "filteredShape": dict(session.filtered_shape),
            "schema": schema_with_lineage(session.display_schema, display_lineage),
            "filterModel": session.filter_model,
            "steps": session.plan,
        }
        if session.plan_input_schemas:
            metadata["latestStepInputSchema"] = session.plan_input_schemas[-1]
        if session.draft_step is not None:
            metadata["draftStep"] = session.draft_step
        if session.replace_step_id is not None:
            metadata["draftReplacesStepId"] = session.replace_step_id
        # Responses are serialized after the session lock is released. Return a
        # detached snapshot so a concurrent mutation cannot retroactively alter
        # an older response or make its metadata disagree with its revision.
        return deepcopy(metadata)

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
            session.filter_model = {"logic": "and", "filters": [], "sort": []}
        session.revision += 1
        self._refresh_filtered(session, session.filter_model)
        return {
            "kind": "planUpdated",
            "action": action,
            "revision": session.revision,
            "metadata": self._metadata(session),
            "page": self._page(session, offset, limit),
            "code": session.engine.compile_plan(session.bound_plan),
        }

    def _replay(
        self,
        session: Session,
        bound_plan: list[dict[str, Any]],
    ) -> tuple[Any, list[dict[str, str]], dict[str, int], list[dict[str, Any]]]:
        frame = session.original
        lineage = source_lineage(session.source_schema)
        schema = session.source_schema
        for step in bound_plan:
            frame = self._apply_transform_with_row_ids(session, frame, step)
            schema = session.engine.schema(frame)
            lineage = derive_lineage(lineage, schema, step)
        shape = session.source_shape if not bound_plan else session.engine.shape(frame)
        return frame, lineage, shape, schema

    @staticmethod
    def _apply_transform_with_row_ids(session: Session, frame: Any, step: Mapping[str, Any]) -> Any:
        kind = str(step["kind"])
        allowed_internal = None if kind in {"groupBy", "customCode"} else session.engine.internal_row_id_column(frame)
        transformed = session.engine.apply_transform(frame, step)
        session.engine.validate_internal_row_id_namespace(transformed, allowed_internal)
        session.engine.validate_column_addressability(transformed)
        session.engine.validate_transformation_result(transformed)
        return session.engine.ensure_row_ids(transformed, f"{session.session_id}:{step['id']}")

    def _clear_draft(self, session: Session) -> None:
        session.draft_step = None
        session.draft_bound_step = None
        session.draft_frame = None
        session.draft_base_lineage = None
        session.draft_base_schema = None
        session.draft_lineage = None
        session.draft_shape = None
        session.draft_schema = None
        session.replace_step_id = None

    def _diff(
        self,
        session: Session,
        before: Any,
        after: Any,
        before_lineage: list[dict[str, str]],
        after_lineage: list[dict[str, str]],
        before_shape: dict[str, int],
        after_shape: dict[str, int],
        before_raw_schema: list[dict[str, Any]],
        after_raw_schema: list[dict[str, Any]],
        step: Mapping[str, Any],
        offset: int,
        limit: int,
        *,
        before_page: Mapping[str, Any] | None = None,
        after_page: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        before_schema = schema_with_lineage(before_raw_schema, before_lineage)
        after_schema = schema_with_lineage(after_raw_schema, after_lineage)
        before_ids = [column["id"] for column in before_schema]
        after_ids = [column["id"] for column in after_schema]
        common_ids = [identifier for identifier in before_ids if identifier in after_ids]
        if before_page is None:
            before_page = session.engine.page(before, offset, limit, total_rows=before_shape["rows"])
        if after_page is None:
            after_page = session.engine.page(after, offset, limit, total_rows=after_shape["rows"])
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
            or before_page["totalRows"] > len(before_page["rows"])
            or after_page["totalRows"] > len(after_page["rows"]),
        }

    @staticmethod
    def _lineage_from_schema(schema: list[dict[str, Any]]) -> list[dict[str, str]]:
        return [{"id": str(column["id"]), "name": str(column["name"])} for column in schema]

    def _assert_editable(self, session: Session) -> None:
        if session.mode != "editing":
            raise EngineError("This session is in viewing mode. Change it to editing before adding steps.")
        if not session.engine.capabilities.supports_editing:
            raise EngineError(f"The {session.backend} backend does not support editing.")

    @staticmethod
    def _assert_bound_history(session: Session) -> None:
        if len(session.bound_plan) != len(session.plan) or len(session.plan_input_schemas) != len(session.plan):
            raise EngineError("The applied cleaning-step history is inconsistent.")

    def _session(self, session_id: str) -> Session:
        with self._sessions_lock:
            try:
                session = self.sessions[session_id]
            except KeyError as error:
                raise EngineError(f"Unknown session: {session_id}") from error
            if session.disposed:
                raise EngineError(f"Unknown session: {session_id}")
            return session

    def _capabilities(self, session: Session) -> dict[str, bool]:
        source_kind = session.source.get("kind")
        extension = str(session.source.get("path", "")).lower()
        engine_capabilities = session.engine.capabilities
        editable = session.mode == "editing" and engine_capabilities.supports_editing
        return {
            "editable": editable,
            "lazy": source_kind == "file" and extension.endswith(tuple(engine_capabilities.lazy_file_extensions)),
            "cancel": engine_capabilities.supports_request_cancellation,
            "exportCsv": editable and "csv" in engine_capabilities.export_formats,
            "exportParquet": editable and "parquet" in engine_capabilities.export_formats,
            "notebookInsert": source_kind == "notebookVariable",
        }

    def _assert_revision(self, session: Session, revision: int) -> None:
        if session.disposed:
            raise EngineError(f"Unknown session: {session.session_id}")
        if revision != session.revision:
            raise EngineError(f"Stale session revision {revision}; current revision is {session.revision}.")

    @contextmanager
    def _profile_view(
        self,
        session: Session,
        revision: int,
        filter_model: Mapping[str, Any],
    ) -> Iterator[Any]:
        """Lease an immutable view while allowing foreground reads to proceed."""
        # Admission is decided before competing for the dataframe lock. Once a
        # writer has announced intent, later readers cannot barge ahead of it.
        with session.admission_condition:
            while session.waiting_writers:
                session.admission_condition.wait()
            with session.lock:
                self._assert_source_unchanged(session)
                self._assert_revision(session, revision)
                filtered = self._view_query_frame(session, filter_model)
                session.active_profiles += 1
        try:
            yield filtered
        except BaseException as error:
            self._finish_profile(session, error)
            raise
        else:
            self._finish_profile(session)

    def _finish_profile(self, session: Session, cause: BaseException | None = None) -> None:
        with session.lock:
            try:
                # Lazy readers may only discover a replacement while the
                # profile is executing, so post-validation remains part of
                # the lease even when the engine call raises.
                self._assert_source_unchanged(session)
            except EngineError as source_error:
                if cause is not None:
                    raise source_error from cause
                raise
            finally:
                session.active_profiles -= 1
                session.profile_condition.notify_all()

    @contextmanager
    def _shared_session_read(self, session: Session) -> Iterator[None]:
        """Admit a short read unless an exclusive operation is already waiting."""
        with session.admission_condition:
            while session.waiting_writers:
                session.admission_condition.wait()
            session.lock.acquire()
        try:
            yield
        finally:
            session.lock.release()

    @contextmanager
    def _atomic_session_access(self, session: Session) -> Iterator[None]:
        """Run an edit exclusively and publish its state only after it fully succeeds."""
        with self._exclusive_session_access(session):
            snapshot = _SessionMutationSnapshot.capture(session)
            try:
                yield
            except BaseException as error:
                snapshot.restore(session)
                # Roll back the edit state, but never resurrect blocks read from a
                # source version that the operation proved is no longer current.
                if isinstance(error, _SourceChangedError):
                    session.clear_page_cache()
                raise

    @contextmanager
    def _atomic_session_read(self, session: Session) -> Iterator[None]:
        """Run an atomic edit while validating its lazy source before and after."""
        with self._atomic_session_access(session), self._validated_source_read(session):
            yield

    @contextmanager
    def _exclusive_session_access(self, session: Session) -> Iterator[None]:
        """Register writer intent before locking and wait for leased profiles."""
        with session.admission_condition:
            session.waiting_writers += 1
            session.admission_condition.notify_all()
        try:
            with session.lock:
                while session.active_profiles:
                    session.profile_condition.wait()
                yield
        finally:
            with session.admission_condition:
                session.waiting_writers -= 1
                session.admission_condition.notify_all()

    @contextmanager
    def _exclusive_session_read(self, session: Session) -> Iterator[None]:
        """Wait for profiles, then validate the source around an exclusive read."""
        with self._exclusive_session_access(session), self._validated_source_read(session):
            yield

    @contextmanager
    def _validated_source_read(self, session: Session) -> Iterator[None]:
        self._assert_source_unchanged(session)
        try:
            yield
        except BaseException as error:
            # A concurrent replacement can make the lazy scan itself fail. In
            # that case the source-version diagnostic must take precedence over
            # a backend-specific read error and cached blocks must be cleared.
            try:
                self._assert_source_unchanged(session)
            except EngineError as source_error:
                raise source_error from error
            raise
        else:
            self._assert_source_unchanged(session)

    def _assert_source_unchanged(self, session: Session) -> None:
        expected = session.source_fingerprint
        if expected is None:
            return
        try:
            current = self._fingerprint_path(expected.requested_path)
        except OSError as error:
            session.clear_page_cache()
            raise self._source_changed_error(session) from error
        if current != expected:
            session.clear_page_cache()
            raise self._source_changed_error(session)

    @staticmethod
    def _source_changed_error(session: Session) -> _SourceChangedError:
        label = session.source.get("label") or session.source.get("path") or "source file"
        return _SourceChangedError(
            f"The source file for {label} changed or is no longer available. Reopen the file to refresh this session."
        )

    @classmethod
    def _source_fingerprint(
        cls,
        source: Mapping[str, Any],
        engine: DataFrameEngine,
    ) -> _SourceFingerprint | None:
        if source.get("kind") != "file":
            return None
        path = source.get("path")
        if not path:
            return None
        if Path(str(path)).suffix.lower() not in engine.capabilities.lazy_file_extensions:
            return None
        try:
            return cls._fingerprint_path(str(path))
        except OSError as error:
            label = source.get("label") or path
            raise EngineError(f"Could not read {label}: {error}") from error

    @staticmethod
    def _fingerprint_path(path: str) -> _SourceFingerprint:
        requested = Path(path).expanduser().absolute()
        resolved = requested.resolve(strict=True)
        stat = resolved.stat()
        return _SourceFingerprint(
            requested_path=str(requested),
            resolved_path=str(resolved),
            device=int(stat.st_dev),
            inode=int(stat.st_ino),
            size=int(stat.st_size),
            modified_ns=int(stat.st_mtime_ns),
        )

    def _engine_for_source(self, source: Mapping[str, Any], backend: str | None) -> DataFrameEngine:
        if backend:
            return self.registry.create(backend)
        if source.get("kind") == "file":
            return self.registry.create("polars")
        value = self._resolve_notebook_variable(source)
        return self.registry.detect(value)

    @staticmethod
    def _dispose_open_failure(session: Session | None, engine: DataFrameEngine) -> None:
        if session is not None:
            session.dispose(suppress_errors=True)
            return
        with suppress(Exception):
            engine.close()

    def _load_source(self, source: Mapping[str, Any], engine: DataFrameEngine) -> Any:
        kind = source.get("kind")
        if kind == "file":
            path = source.get("path")
            if not path:
                raise EngineError("File source is missing a path.")
            options = source.get("importOptions")
            try:
                return engine.read_file(str(path), options if isinstance(options, Mapping) else None)
            except EngineError:
                raise
            except Exception as error:
                label = source.get("label") or path
                raise EngineError(f"Could not read {label}: {error}") from error
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
            "Notebook variable launch requires running the Open Wrangler runtime inside the active kernel. "
            f"Variable not found: {variable_name}"
        )
