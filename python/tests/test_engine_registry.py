from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

import pytest

from openwrangler_runtime.engines import (
    DataFrameEngine,
    EngineError,
    EngineRegistry,
    PandasEngine,
    PolarsEngine,
    default_engine_registry,
)


class TrackedEngine(PandasEngine):
    def __init__(self, name: str, result: bool | Exception) -> None:
        self.name = name
        self.result = result
        self.closed = False

    def detect(self, value: Any) -> bool:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def close(self) -> None:
        self.closed = True


def factory(engine: TrackedEngine) -> Callable[[], DataFrameEngine]:
    return lambda: cast(DataFrameEngine, engine)


def test_default_registry_preserves_priority_and_creates_fresh_engines() -> None:
    registry = default_engine_registry()

    assert registry.backends == ("polars", "pandas")
    assert isinstance(registry.create("polars"), PolarsEngine)
    assert isinstance(registry.create("pandas"), PandasEngine)
    assert registry.create("polars") is not registry.create("polars")


def test_built_in_capabilities_are_immutable_and_match_current_behavior() -> None:
    pandas = PandasEngine.capabilities
    polars = PolarsEngine.capabilities

    assert pandas.source_kinds == frozenset({"file", "notebookVariable", "notebookOutput"})
    assert pandas.supports_editing
    assert pandas.lazy_file_extensions == frozenset()
    assert pandas.export_formats == frozenset({"csv", "parquet"})
    assert not pandas.supports_interrupt
    assert polars.source_kinds == pandas.source_kinds
    assert polars.supports_editing
    assert polars.lazy_file_extensions == frozenset({".csv", ".tsv", ".parquet", ".jsonl"})
    assert polars.export_formats == pandas.export_formats
    assert not polars.supports_interrupt


def test_create_preserves_unsupported_backend_error() -> None:
    with pytest.raises(EngineError, match=r"^Unsupported backend: duckdb$"):
        default_engine_registry().create("duckdb")


def test_create_preserves_throwing_factory_diagnostic() -> None:
    def throwing_factory() -> DataFrameEngine:
        raise RuntimeError("factory exploded")

    registry = EngineRegistry((("broken", throwing_factory),))

    with pytest.raises(EngineError, match=r"broken.*factory exploded") as caught:
        registry.create("broken")
    assert isinstance(caught.value.__cause__, RuntimeError)


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
