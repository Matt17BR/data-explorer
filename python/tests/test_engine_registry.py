from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest

from openwrangler_runtime.engines import (
    DataFrameEngine,
    DuckDBEngine,
    EngineError,
    EngineRegistry,
    PandasEngine,
    PolarsEngine,
    default_engine_registry,
)
from openwrangler_runtime.session import SessionManager


class TrackedEngine(PandasEngine):
    def __init__(
        self,
        name: str,
        result: bool | Exception,
        *,
        prepare_error: Exception | None = None,
        close_error: Exception | None = None,
    ) -> None:
        self.name = name
        self.result = result
        self.prepare_error = prepare_error
        self.close_error = close_error
        self.prepared = False
        self.prepared_source: Mapping[str, Any] | None = None
        self.closed = False

    def prepare(self, source: Mapping[str, Any] | None = None) -> None:
        self.prepared = True
        self.prepared_source = source
        if self.prepare_error is not None:
            raise self.prepare_error

    def detect(self, value: Any) -> bool:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def close(self) -> None:
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def factory(engine: TrackedEngine) -> Callable[[], DataFrameEngine]:
    return lambda: cast(DataFrameEngine, engine)


def test_default_registry_preserves_priority_and_creates_fresh_engines() -> None:
    registry = default_engine_registry()

    assert registry.backends == ("polars", "duckdb", "pandas")
    assert isinstance(registry.create("polars"), PolarsEngine)
    assert isinstance(registry.create("duckdb"), DuckDBEngine)
    assert isinstance(registry.create("pandas"), PandasEngine)
    assert registry.create("polars") is not registry.create("polars")


def test_built_in_capabilities_are_immutable_and_match_current_behavior() -> None:
    pandas = PandasEngine.capabilities
    polars = PolarsEngine.capabilities

    assert pandas.source_kinds == frozenset({"file", "notebookVariable", "notebookOutput"})
    assert pandas.supports_editing
    assert pandas.lazy_file_extensions == frozenset()
    assert pandas.export_formats == frozenset({"csv", "parquet"})
    assert not pandas.supports_shutdown_interrupt
    assert not pandas.supports_request_cancellation
    assert polars.source_kinds == pandas.source_kinds
    assert polars.supports_editing
    assert polars.lazy_file_extensions == frozenset({".csv", ".tsv", ".parquet", ".jsonl"})
    assert polars.export_formats == pandas.export_formats
    assert not polars.supports_shutdown_interrupt
    assert not polars.supports_request_cancellation

    duckdb = DuckDBEngine.capabilities
    assert duckdb.source_kinds == frozenset({"file"})
    assert duckdb.supports_editing
    assert duckdb.lazy_file_extensions == frozenset({".csv", ".tsv", ".parquet", ".jsonl"})
    assert duckdb.export_formats == frozenset({"csv", "parquet"})
    assert duckdb.supports_shutdown_interrupt
    assert not duckdb.supports_request_cancellation


def test_create_preserves_unsupported_backend_error() -> None:
    with pytest.raises(EngineError, match=r"^Unsupported backend: spark$"):
        default_engine_registry().create("spark")


def test_create_preserves_throwing_factory_diagnostic() -> None:
    def throwing_factory() -> DataFrameEngine:
        raise RuntimeError("factory exploded")

    registry = EngineRegistry((("broken", throwing_factory),))

    with pytest.raises(EngineError, match=r"broken.*factory exploded") as caught:
        registry.create("broken")
    assert isinstance(caught.value.__cause__, RuntimeError)


def test_prepare_owns_and_closes_a_transient_adapter() -> None:
    engine = TrackedEngine("prepared", True)
    registry = EngineRegistry((("prepared", factory(engine)),))

    registry.prepare("prepared")

    assert engine.prepared
    assert engine.closed


def test_prepare_failure_closes_the_transient_adapter_and_preserves_diagnostic() -> None:
    engine = TrackedEngine("broken", True, prepare_error=RuntimeError("native import failed"))
    registry = EngineRegistry((("broken", factory(engine)),))

    with pytest.raises(EngineError, match=r"broken.*native import failed") as caught:
        registry.prepare("broken")

    assert isinstance(caught.value.__cause__, RuntimeError)
    assert engine.closed


def test_prepare_failure_keeps_the_primary_diagnostic_when_cleanup_also_fails() -> None:
    engine = TrackedEngine(
        "broken",
        True,
        prepare_error=RuntimeError("native import failed"),
        close_error=RuntimeError("cleanup failed"),
    )
    registry = EngineRegistry((("broken", factory(engine)),))

    with pytest.raises(EngineError, match=r"native import failed") as caught:
        registry.prepare("broken")

    assert isinstance(caught.value.__cause__, RuntimeError)
    assert str(caught.value.__cause__) == "native import failed"
    assert engine.closed


def test_prepare_surfaces_cleanup_failure_after_success() -> None:
    engine = TrackedEngine("broken", True, close_error=RuntimeError("cleanup failed"))
    registry = EngineRegistry((("broken", factory(engine)),))

    with pytest.raises(EngineError, match=r"close.*broken.*cleanup failed") as caught:
        registry.prepare("broken")

    assert isinstance(caught.value.__cause__, RuntimeError)
    assert engine.prepared
    assert engine.closed


def test_file_backend_preparation_uses_the_automatic_polars_default() -> None:
    polars = TrackedEngine("polars", True)
    pandas = TrackedEngine("pandas", True)
    manager = SessionManager(EngineRegistry((("polars", factory(polars)), ("pandas", factory(pandas)))))
    source = {"kind": "file", "path": "sample.xlsx"}

    manager.prepare_backend(source, None)

    assert polars.prepared
    assert polars.prepared_source is source
    assert polars.closed
    assert not pandas.prepared
    assert not pandas.closed


def test_explicit_backend_preparation_overrides_the_file_default() -> None:
    polars = TrackedEngine("polars", True)
    pandas = TrackedEngine("pandas", True)
    manager = SessionManager(EngineRegistry((("polars", factory(polars)), ("pandas", factory(pandas)))))
    source = {"kind": "file", "path": "sample.tsv"}

    manager.prepare_backend(source, "pandas")

    assert not polars.prepared
    assert not polars.closed
    assert pandas.prepared
    assert pandas.prepared_source is source
    assert pandas.closed


def test_automatic_notebook_backend_does_not_guess_before_value_detection() -> None:
    pandas = TrackedEngine("pandas", True)
    manager = SessionManager(EngineRegistry((("pandas", factory(pandas)),)))

    manager.prepare_backend({"kind": "notebookVariable"}, None)

    assert not pandas.prepared
    assert not pandas.closed


def test_detect_closes_nonmatches_and_transfers_match() -> None:
    nonmatch = TrackedEngine("first", False)
    match = TrackedEngine("second", True)
    registry = EngineRegistry(
        (
            ("first", factory(nonmatch)),
            ("second", factory(match)),
        )
    )

    assert registry.detect(object()) is match
    assert nonmatch.closed
    assert not match.closed


def test_detect_closes_throwing_detector_and_preserves_diagnostic() -> None:
    failed = TrackedEngine("broken", RuntimeError("detector exploded"))
    registry = EngineRegistry((("broken", factory(failed)),))

    with pytest.raises(EngineError, match=r"broken.*detector exploded") as caught:
        registry.detect(object())
    assert isinstance(caught.value.__cause__, RuntimeError)
    assert failed.closed


def test_detect_preserves_throwing_factory_diagnostic() -> None:
    def throwing_factory() -> DataFrameEngine:
        raise RuntimeError("factory exploded")

    registry = EngineRegistry((("broken", throwing_factory),))

    with pytest.raises(EngineError, match=r"broken.*factory exploded") as caught:
        registry.detect(object())
    assert isinstance(caught.value.__cause__, RuntimeError)


def test_factory_name_mismatch_is_closed_and_rejected() -> None:
    mismatched = TrackedEngine("actual", True)
    registry = EngineRegistry((("registered", factory(mismatched)),))

    with pytest.raises(EngineError, match="registered.*actual"):
        registry.create("registered")
    assert mismatched.closed
