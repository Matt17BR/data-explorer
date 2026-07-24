from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from typing import Any, cast

from .base import DataFrameEngine, EngineError
from .duckdb_engine import DuckDBEngine
from .pandas_engine import PandasEngine
from .polars_engine import PolarsEngine

EngineFactory = Callable[[], DataFrameEngine]
EngineFactories = Mapping[str, EngineFactory] | Iterable[tuple[str, EngineFactory]]


class UnsupportedDataFrameError(EngineError):
    """Raised when every available engine rejects a dataframe value."""


class EngineRegistry:
    """Ordered factories for creating independently owned engine instances."""

    def __init__(self, factories: EngineFactories) -> None:
        entries = cast(
            tuple[tuple[str, EngineFactory], ...],
            tuple(factories.items()) if isinstance(factories, Mapping) else tuple(factories),
        )
        names = [name for name, _factory in entries]
        if len(names) != len(set(names)):
            raise ValueError("Engine backend names must be unique.")
        self._factories: tuple[tuple[str, EngineFactory], ...] = entries

    @property
    def backends(self) -> tuple[str, ...]:
        return tuple(name for name, _factory in self._factories)

    def create(self, backend: str) -> DataFrameEngine:
        for expected_name, factory in self._factories:
            if expected_name == backend:
                return self._create_validated(expected_name, factory)
        raise EngineError(f"Unsupported backend: {backend}")

    def prepare(self, backend: str, source: Mapping[str, Any] | None = None) -> None:
        """Load one backend through an independently owned transient adapter."""
        engine = self.create(backend)
        try:
            engine.prepare(source)
        except Exception as error:
            self._close_safely(engine)
            raise EngineError(f"Could not prepare the {backend} backend: {error}") from error
        try:
            engine.close()
        except Exception as error:
            raise EngineError(f"Could not close the prepared {backend} backend: {error}") from error

    def detect(self, value: Any) -> DataFrameEngine:
        for expected_name, factory in self._factories:
            try:
                engine = factory()
            except Exception as error:
                raise EngineError(
                    f"Could not create the {expected_name} backend while detecting the dataframe source: {error}"
                ) from error
            self._validate_name(expected_name, engine)
            try:
                detected = engine.detect(value)
            except Exception as error:
                self._close_safely(engine)
                raise EngineError(
                    f"The {expected_name} backend failed while detecting the dataframe source: {error}"
                ) from error
            if detected:
                return engine
            self._close_safely(engine)
        raise UnsupportedDataFrameError("Could not detect a supported dataframe backend for the source.")

    def _create_validated(self, expected_name: str, factory: EngineFactory) -> DataFrameEngine:
        try:
            engine = factory()
        except Exception as error:
            raise EngineError(f"Could not create the {expected_name} backend: {error}") from error
        self._validate_name(expected_name, engine)
        return engine

    def _validate_name(self, expected_name: str, engine: DataFrameEngine) -> None:
        actual_name = getattr(engine, "name", None)
        if actual_name == expected_name:
            return
        self._close_safely(engine)
        raise EngineError(f"Engine factory registered as {expected_name!r} produced backend {actual_name!r}.")

    @staticmethod
    def _close_safely(engine: DataFrameEngine) -> None:
        with suppress(Exception):
            engine.close()


def default_engine_registry() -> EngineRegistry:
    """Return the built-in engines in automatic-detection priority order."""
    return EngineRegistry((("polars", PolarsEngine), ("duckdb", DuckDBEngine), ("pandas", PandasEngine)))
