from __future__ import annotations

import argparse
import json
import math
import os
import platform
import queue
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from pathlib import Path
from statistics import median
from time import perf_counter, perf_counter_ns
from typing import Any, Literal, cast

import polars as pl

from openwrangler_runtime.session import PAGE_CACHE_BYTE_LIMIT, PAGE_CACHE_LIMIT, SessionManager

PAGE_SIZE = 200
SAMPLES = 20
FRESH_MANAGER_OPEN_SAMPLES = 5
VISIBLE_PROFILE_COLUMNS = 8
# Product default for openWrangler.fetchColumnBlockSize. The performance
# harness test reads package.json and fails if these independently owned
# process boundaries drift.
DEFAULT_FETCH_COLUMN_BLOCK_SIZE = 16
EMPTY_FILTER = {"logic": "and", "filters": [], "sort": []}
TRANSPORT_TIMEOUT_SECONDS = 30.0
SERIALIZATION_EVIDENCE_MIN_MS = 5.0
_BENCHMARK_EVENT_PREFIX = "__OPEN_WRANGLER_BENCHMARK_EVENT__ "
_BENCHMARK_SERVER_BOOTSTRAP = r"""
import json
import os
import sys
import time

from openwrangler_runtime import server
from openwrangler_runtime.engines.registry import default_engine_registry

_PREFIX = "__OPEN_WRANGLER_BENCHMARK_EVENT__ "
_backend = os.environ["OPENWRANGLER_BENCHMARK_BACKEND"]
__import__(_backend)
_probe = default_engine_registry().create(_backend)
_engine_type = type(_probe)
_probe.close()
_original_header_stats = _engine_type.header_stats


def _event(kind):
    payload = {"kind": kind, "perfCounterNs": time.perf_counter_ns()}
    print(_PREFIX + json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)


def _instrumented_header_stats(self, frame):
    _event("statsStarted")
    try:
        return _original_header_stats(self, frame)
    finally:
        _event("statsFinished")


_engine_type.header_stats = _instrumented_header_stats
server.main()
"""
Backend = Literal["polars", "pandas", "duckdb"]
BACKENDS: tuple[Backend, ...] = ("polars", "pandas", "duckdb")
RELEASE_LIMITS = {
    "csvColdSourceFirstGridMs": 3_000.0,
    "parquetColdSourceFirstGridMs": 5_000.0,
    "csvWarmSourceReopenMedianMs": 3_000.0,
    "parquetWarmSourceReopenMedianMs": 5_000.0,
    "directRuntimeCachedPageP95Ms": 100.0,
    "directRuntimeCacheMissPageP95Ms": 500.0,
    "stdioTransportCacheMissPageP95Ms": 500.0,
    "stdioSameSessionStatsContendedPageLatencyMs": 500.0,
}
SLICE_TARGETS = {
    "csvWarmSourceReopenMedianMs": 200.0,
    "parquetWarmSourceReopenMedianMs": 250.0,
    "directRuntimeCachedPageP95Ms": 5.0,
    "directRuntimeCacheMissPageP95Ms": 60.0,
    "stdioTransportCacheMissPageP95Ms": 100.0,
}
RELEASE_GATE_METRICS = {
    "csvColdSourceFirstGridMs": "csv.stdioTransport.coldSourceOpenRoundTripMs",
    "parquetColdSourceFirstGridMs": "parquet.stdioTransport.coldSourceOpenRoundTripMs",
    "coldSourceCacheDropProof": "*.stdioTransport.coldSourceCacheDrop.applied (must be true)",
    "csvWarmSourceReopenMedianMs": "csv.warmSourceReopenMedianMs",
    "parquetWarmSourceReopenMedianMs": "parquet.warmSourceReopenMedianMs",
    "directRuntimeCachedPageP95Ms": "*.directRuntimeCachedPageP95Ms",
    "directRuntimeCacheMissPageP95Ms": "*.directRuntimeCacheMissPageP95Ms",
    "stdioTransportCacheMissPageP95Ms": "*.stdioTransport.cacheMissPageP95Ms",
    "stdioSameSessionStatsContendedPageLatencyMs": "*.stdioTransport.sameSessionStatsContendedPageLatencyMs",
    "stdioSameSessionActiveProfileProof": "*.stdioTransport.statsActiveWhenPageWasSent (must be true)",
    "stdioSameSessionInteractiveOverlap": (
        "*.stdioTransport.interactivePageOverlappedProfile when statsActiveWhenPageWasSent is true"
    ),
}


@dataclass(frozen=True, slots=True)
class FixtureSpec:
    kind: Literal["csv", "parquet"]
    rows: int
    columns: int

    @property
    def names(self) -> list[str]:
        return [f"c{column:02d}" for column in range(self.columns)]

    @property
    def sentinel_rows(self) -> tuple[int, ...]:
        return tuple(sorted({0, self.rows // 2, self.rows - 1}))


_TRANSPORT_EOF = object()


def _process_memory_snapshot(pid: int) -> dict[str, Any]:
    """Return best-effort RSS evidence without adding a benchmark dependency."""
    status_path = Path("/proc") / str(pid) / "status"
    try:
        status: dict[str, str] = {}
        for line in status_path.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition(":")
            if separator:
                status[key] = value.strip()
        rss_kib = int(status["VmRSS"].split()[0])
        peak_kib = int(status["VmHWM"].split()[0])
        return {
            "supported": True,
            "sampler": "linux-proc-status",
            "rssBytes": rss_kib * 1024,
            "peakRssBytes": peak_kib * 1024,
        }
    except (FileNotFoundError, KeyError, OSError, ValueError):
        pass

    if pid == os.getpid():
        try:
            import resource

            getrusage = getattr(resource, "getrusage", None)
            usage_self = getattr(resource, "RUSAGE_SELF", None)
            if not callable(getrusage) or usage_self is None:
                raise AttributeError("resource usage sampling is unavailable")
            usage = cast(Any, getrusage)(usage_self)
            peak = int(usage.ru_maxrss)
            # macOS reports bytes; Linux and the other supported Unix targets
            # report KiB. Linux normally takes the /proc branch above.
            peak_bytes = peak if sys.platform == "darwin" else peak * 1024
            return {
                "supported": True,
                "sampler": "resource-getrusage",
                "rssBytes": None,
                "peakRssBytes": peak_bytes,
            }
        except (ImportError, OSError, ValueError):
            pass

    if os.name == "posix":
        try:
            completed = subprocess.run(
                ["ps", "-o", "rss=", "-p", str(pid)],
                check=True,
                capture_output=True,
                text=True,
                timeout=2,
            )
            rss_kib = int(completed.stdout.strip())
            return {
                "supported": True,
                "sampler": "posix-ps-rss",
                "rssBytes": rss_kib * 1024,
                "peakRssBytes": None,
            }
        except (FileNotFoundError, OSError, subprocess.SubprocessError, ValueError):
            pass

    return {
        "supported": False,
        "sampler": "unavailable",
        "rssBytes": None,
        "peakRssBytes": None,
    }


def _resource_evidence(boundary: str, samples: list[dict[str, Any]]) -> dict[str, Any]:
    rss_values = [int(sample["rssBytes"]) for sample in samples if isinstance(sample.get("rssBytes"), int)]
    peak_values = [int(sample["peakRssBytes"]) for sample in samples if isinstance(sample.get("peakRssBytes"), int)]
    return {
        "boundary": boundary,
        "supported": any(bool(sample.get("supported")) for sample in samples),
        "maxObservedRssBytes": max(rss_values) if rss_values else None,
        "maxObservedPeakRssBytes": max(peak_values) if peak_values else None,
        "samples": samples,
    }


def _total_memory_bytes() -> int | None:
    try:
        sysconf = getattr(os, "sysconf", None)
        if not callable(sysconf):
            return None
        page_size = int(cast(Any, sysconf)("SC_PAGE_SIZE"))
        pages = int(cast(Any, sysconf)("SC_PHYS_PAGES"))
        return page_size * pages
    except (AttributeError, OSError, TypeError, ValueError):
        return None


def _cpu_model() -> str | None:
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip() in {"model name", "Hardware"}:
                return value.strip()
    except OSError:
        pass
    return platform.processor() or None


def _source_revision() -> dict[str, Any]:
    repository = Path(__file__).resolve().parents[2]
    try:
        revision = subprocess.run(
            ["git", "-C", str(repository), "rev-parse", "--verify", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        tracked_status = subprocess.run(
            ["git", "-C", str(repository), "diff", "--quiet", "--ignore-submodules", "HEAD", "--"],
            check=False,
            capture_output=True,
            timeout=5,
        ).returncode
        return {
            "commit": revision,
            "trackedWorktreeDirty": tracked_status == 1 if tracked_status in {0, 1} else None,
        }
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return {"commit": None, "trackedWorktreeDirty": None}


def _benchmark_provenance(backend: Backend) -> dict[str, Any]:
    from openwrangler_runtime.version import __version__ as runtime_version

    distributions = ("openwrangler-runtime", "polars", "pandas", "duckdb", "pyarrow")
    versions: dict[str, str | None] = {}
    for distribution in distributions:
        try:
            versions[distribution] = package_version(distribution)
        except PackageNotFoundError:
            versions[distribution] = None
    return {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "selectedBackend": backend,
        "source": _source_revision(),
        "machine": {
            "operatingSystem": platform.system(),
            "operatingSystemRelease": platform.release(),
            "architecture": platform.machine(),
            "cpuModel": _cpu_model(),
            "logicalCpuCount": os.cpu_count(),
            "totalMemoryBytes": _total_memory_bytes(),
        },
        "runtime": {
            "pythonVersion": platform.python_version(),
            "pythonImplementation": platform.python_implementation(),
            "openWranglerRuntimeVersion": runtime_version,
        },
        "packages": versions,
    }


class StdioRuntimeClient:
    """Small canonical protocol-v2 client for the real standalone runtime process."""

    def __init__(self, backend: Backend = "polars") -> None:
        environment = os.environ.copy()
        python_root = str(Path(__file__).resolve().parents[1])
        environment["PYTHONPATH"] = os.pathsep.join(
            item for item in (python_root, environment.get("PYTHONPATH", "")) if item
        )
        environment["OPENWRANGLER_BENCHMARK_BACKEND"] = backend
        self.backend = backend
        self.process = subprocess.Popen(
            # The bootstrap changes no stdin/stdout behavior. It wraps only the
            # selected engine's header-statistics call so the benchmark can prove, using
            # Python's process-wide monotonic clock, that the page was sent
            # while production runtime work was genuinely active.
            [sys.executable, "-c", _BENCHMARK_SERVER_BOOTSTRAP],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=environment,
        )
        if self.process.stdin is None or self.process.stdout is None or self.process.stderr is None:
            self.process.kill()
            raise AssertionError("Could not create the standalone runtime stdio pipes.")
        self._messages: queue.Queue[object] = queue.Queue()
        self._benchmark_events: queue.Queue[object] = queue.Queue()
        self._buffered: dict[str, dict[str, Any]] = {}
        self._stderr: list[str] = []
        self._sequence = 0
        self.response_order: list[str] = []
        self.response_arrivals: dict[str, float] = {}
        self.request_send_completed_ns: dict[str, int] = {}
        self.resource_samples: list[dict[str, Any]] = []
        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            name="openwrangler-benchmark-stdout",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr,
            name="openwrangler-benchmark-stderr",
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    def record_resources(self, stage: str) -> None:
        self.resource_samples.append({"stage": stage, **_process_memory_snapshot(self.process.pid)})

    def __enter__(self) -> StdioRuntimeClient:
        return self

    def __exit__(self, exception_type: object, exception: object, traceback: object) -> None:
        self.close(raise_on_failure=exception_type is None)

    def send(
        self,
        request: dict[str, Any],
        *,
        priority: Literal["interactive", "background"] = "interactive",
        label: str | None = None,
    ) -> tuple[str, float]:
        self._sequence += 1
        request_id = f"benchmark-{label or request.get('kind', 'request')}-{self._sequence}"
        envelope = {
            "protocolVersion": 2,
            "requestId": request_id,
            "priority": priority,
            "request": request,
        }
        stdin = self.process.stdin
        if stdin is None or stdin.closed or self.process.poll() is not None:
            raise AssertionError(self._runtime_failure("Standalone runtime input is not writable."))
        started = perf_counter()
        stdin.write(json.dumps(envelope, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        stdin.flush()
        self.request_send_completed_ns[request_id] = perf_counter_ns()
        return request_id, started

    def request(
        self,
        request: dict[str, Any],
        *,
        priority: Literal["interactive", "background"] = "interactive",
        label: str | None = None,
        timeout: float = TRANSPORT_TIMEOUT_SECONDS,
    ) -> tuple[dict[str, Any], float]:
        request_id, started = self.send(request, priority=priority, label=label)
        response = self.receive(request_id, timeout=timeout)
        return response, (perf_counter() - started) * 1_000

    def receive(self, request_id: str, *, timeout: float = TRANSPORT_TIMEOUT_SECONDS) -> dict[str, Any]:
        self._drain_available()
        buffered = self._buffered.pop(request_id, None)
        if buffered is not None:
            return buffered

        deadline = perf_counter() + timeout
        while True:
            remaining = deadline - perf_counter()
            if remaining <= 0:
                raise AssertionError(self._runtime_failure(f"Timed out waiting for runtime response {request_id}."))
            try:
                item = self._messages.get(timeout=remaining)
            except queue.Empty as error:
                raise AssertionError(
                    self._runtime_failure(f"Timed out waiting for runtime response {request_id}.")
                ) from error
            response_id, response = self._decode_message(item)
            if response_id == request_id:
                return response
            if response_id in self._buffered:
                raise AssertionError(f"Standalone runtime returned duplicate response id {response_id}.")
            self._buffered[response_id] = response

    def receive_benchmark_event(
        self, expected_kind: str, *, timeout: float = TRANSPORT_TIMEOUT_SECONDS
    ) -> dict[str, Any]:
        try:
            event = self._benchmark_events.get(timeout=timeout)
        except queue.Empty as error:
            raise AssertionError(
                self._runtime_failure(f"Timed out waiting for benchmark runtime event {expected_kind}.")
            ) from error
        if isinstance(event, BaseException):
            raise AssertionError(self._runtime_failure(str(event))) from event
        if not isinstance(event, dict):
            raise AssertionError(f"Standalone runtime returned an invalid benchmark event: {event!r}.")
        if event.get("kind") != expected_kind or not isinstance(event.get("perfCounterNs"), int):
            raise AssertionError(f"Expected benchmark runtime event {expected_kind}, received {event!r}.")
        return event

    def close(self, *, raise_on_failure: bool = True) -> None:
        stdin = self.process.stdin
        if stdin is not None and not stdin.closed:
            stdin.close()
        try:
            return_code = self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return_code = self.process.wait(timeout=5)
        self._stdout_thread.join(timeout=1)
        self._stderr_thread.join(timeout=1)
        if raise_on_failure and return_code != 0:
            raise AssertionError(self._runtime_failure(f"Standalone runtime exited with code {return_code}."))

    def _read_stdout(self) -> None:
        stdout = self.process.stdout
        if stdout is None:  # pragma: no cover - constructor checks the pipe
            self._messages.put(AssertionError("Standalone runtime stdout is unavailable."))
            return
        try:
            for line in stdout:
                if not line.strip():
                    continue
                try:
                    self._messages.put((json.loads(line), perf_counter()))
                except Exception as error:
                    self._messages.put(AssertionError(f"Invalid runtime JSON frame: {line.rstrip()!r}: {error}"))
        finally:
            self._messages.put(_TRANSPORT_EOF)

    def _read_stderr(self) -> None:
        stderr = self.process.stderr
        if stderr is None:  # pragma: no cover - constructor checks the pipe
            return
        for line in stderr:
            if not line.startswith(_BENCHMARK_EVENT_PREFIX):
                self._stderr.append(line)
                continue
            try:
                self._benchmark_events.put(json.loads(line.removeprefix(_BENCHMARK_EVENT_PREFIX)))
            except Exception as error:
                self._benchmark_events.put(
                    AssertionError(f"Invalid benchmark runtime event: {line.rstrip()!r}: {error}")
                )

    def _drain_available(self) -> None:
        while True:
            try:
                item = self._messages.get_nowait()
            except queue.Empty:
                return
            response_id, response = self._decode_message(item)
            if response_id in self._buffered:
                raise AssertionError(f"Standalone runtime returned duplicate response id {response_id}.")
            self._buffered[response_id] = response

    def _decode_message(self, item: object) -> tuple[str, dict[str, Any]]:
        if isinstance(item, BaseException):
            raise AssertionError(self._runtime_failure(str(item))) from item
        if item is _TRANSPORT_EOF:
            raise AssertionError(self._runtime_failure("Standalone runtime closed stdout before responding."))
        arrival = perf_counter()
        if isinstance(item, tuple) and len(item) == 2 and isinstance(item[1], float):
            item, arrival = item
        if not isinstance(item, dict):
            raise AssertionError(f"Standalone runtime returned a non-object envelope: {item!r}.")
        if item.get("protocolVersion") != 2 or not isinstance(item.get("requestId"), str):
            raise AssertionError(f"Standalone runtime returned an invalid protocol envelope: {item!r}.")
        response = item.get("response")
        if not isinstance(response, dict) or not isinstance(response.get("kind"), str):
            raise AssertionError(f"Standalone runtime returned an invalid response payload: {item!r}.")
        request_id = item["requestId"]
        self.response_order.append(request_id)
        self.response_arrivals[request_id] = arrival
        return request_id, response

    def _runtime_failure(self, message: str) -> str:
        detail = "".join(self._stderr).strip()
        return f"{message}{f' stderr: {detail}' if detail else ''}"


def _fixture_specs(smoke: bool) -> dict[str, FixtureSpec]:
    return {
        "csv": FixtureSpec("csv", 2_000 if smoke else 100_000, 8 if smoke else 50),
        "parquet": FixtureSpec("parquet", 5_000 if smoke else 1_000_000, 8 if smoke else 20),
    }


def create_fixtures(directory: Path, smoke: bool = False) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    fixtures: dict[str, Path] = {}
    for kind, spec in _fixture_specs(smoke).items():
        path = directory / f"{spec.rows}-{spec.columns}.{kind}"
        _ensure_fixture(path, spec)
        fixtures[kind] = path
    return fixtures


def _ensure_fixture(path: Path, spec: FixtureSpec) -> None:
    if path.is_file():
        try:
            _assert_fixture_contract(path, spec)
            return
        except Exception:
            # A stale partial fixture must never make benchmark numbers look
            # valid. Regenerate and validate a replacement before publishing it.
            pass

    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{path.name}.",
        suffix=path.suffix,
        dir=path.parent,
        delete=False,
    ) as temporary_file:
        temporary = Path(temporary_file.name)
    try:
        _write_fixture(temporary, spec)
        _assert_fixture_contract(temporary, spec)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_fixture(path: Path, spec: FixtureSpec) -> None:
    if spec.kind == "csv":
        pl.DataFrame(
            {name: pl.int_range(column, spec.rows + column, eager=True) for column, name in enumerate(spec.names)}
        ).write_csv(path)
        return
    (
        pl.LazyFrame()
        .select(pl.int_range(0, spec.rows).alias("c00"))
        .with_columns([(pl.col("c00") + column).alias(name) for column, name in enumerate(spec.names[1:], start=1)])
        .sink_parquet(path)
    )


def _assert_fixture_contract(path: Path, spec: FixtureSpec) -> None:
    frame = pl.scan_csv(path) if spec.kind == "csv" else pl.scan_parquet(path)
    schema = frame.collect_schema()
    if schema.names() != spec.names:
        raise AssertionError(f"Fixture {path.name} has unexpected columns: {schema.names()!r}.")
    wrong_types = {
        name: str(dtype) for name, dtype in zip(schema.names(), schema.dtypes(), strict=True) if dtype != pl.Int64
    }
    if wrong_types:
        raise AssertionError(f"Fixture {path.name} has non-Int64 columns: {wrong_types!r}.")
    row_count = int(frame.select(pl.len()).collect(engine="streaming").item())
    if row_count != spec.rows:
        raise AssertionError(f"Fixture {path.name} has {row_count} rows; expected {spec.rows}.")

    for row_index in spec.sentinel_rows:
        sentinel = frame.slice(row_index, 1).collect(engine="streaming")
        if sentinel.height != 1:
            raise AssertionError(f"Fixture {path.name} is missing sentinel row {row_index}.")
        values = sentinel.row(0)
        incorrect = {spec.names[column]: value for column, value in enumerate(values) if value != row_index + column}
        if incorrect:
            raise AssertionError(f"Fixture {path.name} has invalid values at sentinel row {row_index}: {incorrect!r}.")


def _drop_source_file_cache(path: Path) -> dict[str, Any]:
    """Request eviction of one validated fixture without changing global caches."""
    posix_fadvise = getattr(os, "posix_fadvise", None)
    dont_need = getattr(os, "POSIX_FADV_DONTNEED", None)
    if not callable(posix_fadvise) or not isinstance(dont_need, int):
        return {
            "supported": False,
            "applied": False,
            "method": "unavailable",
            "detail": "os.posix_fadvise(POSIX_FADV_DONTNEED) is unavailable on this platform",
        }

    descriptor = os.open(path, os.O_RDONLY)
    try:
        posix_fadvise(descriptor, 0, 0, dont_need)
    except OSError as error:
        return {
            "supported": True,
            "applied": False,
            "method": "posix_fadvise(POSIX_FADV_DONTNEED)",
            "detail": f"{type(error).__name__}: {error}",
        }
    finally:
        os.close(descriptor)
    return {
        "supported": True,
        "applied": True,
        "method": "posix_fadvise(POSIX_FADV_DONTNEED)",
        "detail": "the kernel accepted a per-file page-cache eviction request",
    }


def _qualified_type_name(value: Any) -> str:
    value_type = type(value)
    return f"{value_type.__module__}.{value_type.__qualname__}"


def _is_native_lazy_frame(frame: Any, backend: Backend) -> bool:
    if backend == "polars":
        return isinstance(frame, pl.LazyFrame)
    if backend == "duckdb":
        sql_query = getattr(frame, "sql_query", None)
        return type(frame).__name__ == "DuckDBPyRelation" and callable(sql_query) and isinstance(sql_query(), str)
    return False


def measure_fixture(path: Path, spec: FixtureSpec, backend: Backend = "polars") -> dict[str, Any]:
    fresh_manager_open_samples: list[float] = []
    manager: SessionManager | None = None
    opened: dict[str, Any] | None = None

    # Fixture validation intentionally reads every source block. Evict that one
    # file before sample 1 so the first-grid measurement does not silently reuse
    # validation's page cache. Later samples remain the explicitly warm-source
    # diagnostic. The product-boundary cold-source gate is repeated over stdio.
    first_open_cache_drop = _drop_source_file_cache(path)

    # Every sample owns a new manager/session, so runtime metadata and page
    # caches cannot leak across opens. The OS source cache is deliberately not
    # controlled: sample 1 is reported separately and samples 2+ represent the
    # warm-source reopen behavior used by the release gate.
    for sample in range(FRESH_MANAGER_OPEN_SAMPLES):
        sample_manager = SessionManager()
        started = perf_counter()
        sample_opened = sample_manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path.resolve())},
            backend=backend,
            page_size=PAGE_SIZE,
            column_offset=0,
            column_limit=DEFAULT_FETCH_COLUMN_BLOCK_SIZE,
        )
        fresh_manager_open_samples.append((perf_counter() - started) * 1_000)
        _assert_open_contract(sample_opened, spec, path, backend)

        if sample == FRESH_MANAGER_OPEN_SAMPLES - 1:
            manager = sample_manager
            opened = sample_opened
        else:
            _close_and_assert_empty(sample_manager, sample_opened["metadata"]["sessionId"], path)

    if manager is None or opened is None:  # pragma: no cover - protected by FRESH_MANAGER_OPEN_SAMPLES
        raise AssertionError("The benchmark did not retain a measured session.")

    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    frame_names = ("original", "committed", "filtered")
    frame_types = {name: _qualified_type_name(getattr(session, name)) for name in frame_names}
    native_frames = {name: bool(session.engine.detect(getattr(session, name))) for name in frame_names}
    if not all(native_frames.values()):
        bridged_names = ", ".join(name for name, is_native in native_frames.items() if not is_native)
        raise AssertionError(f"{backend.title()} file session lost native frames in {bridged_names} for {path.name}.")
    lazy_frames = {name: _is_native_lazy_frame(getattr(session, name), backend) for name in frame_names}
    if backend in {"polars", "duckdb"} and not all(lazy_frames.values()):
        eager_names = ", ".join(name for name, is_lazy in lazy_frames.items() if not is_lazy)
        raise AssertionError(f"{backend.title()} file session became eager in {eager_names} for {path.name}.")

    schema = opened["metadata"]["schema"]
    profiled_columns = [column["name"] for column in schema[:VISIBLE_PROFILE_COLUMNS]]
    profile_started = perf_counter()
    profile = manager.get_summary(session_id, 0, EMPTY_FILTER, profiled_columns)
    first_visible_profile_ms = (perf_counter() - profile_started) * 1_000
    if len(profile["summaries"]) != len(profiled_columns):
        raise AssertionError(
            f"Visible-column profile returned {len(profile['summaries'])} of "
            f"{len(profiled_columns)} summaries for {path.name}."
        )
    if any(summary["totalCount"] != spec.rows for summary in profile["summaries"]):
        raise AssertionError(f"Visible-column profile returned an inexact row count for {path.name}.")

    cache_sizes: list[int] = []
    cache_bytes: list[int] = []
    initial_cache_size = _observable_cache_size(session)
    if initial_cache_size is not None:
        cache_sizes.append(initial_cache_size)
    initial_cache_bytes = _observable_cache_bytes(session)
    if initial_cache_bytes is not None:
        cache_bytes.append(initial_cache_bytes)

    cached_offset = 0
    cached_column_offset = 0
    cached_warmup_ms = _time_page(
        manager,
        session_id,
        cached_offset,
        spec.rows,
        cache_sizes,
        cache_bytes,
        column_offset=cached_column_offset,
    )
    cached_samples = [
        _time_page(
            manager,
            session_id,
            cached_offset,
            spec.rows,
            cache_sizes,
            cache_bytes,
            column_offset=cached_column_offset,
        )
        for _ in range(SAMPLES)
    ]
    uncached_offsets = _uncached_offsets(spec.rows, cached_offset)
    uncached_column_offsets = _sample_column_offsets(spec.columns, len(uncached_offsets))
    uncached_samples = [
        _time_page(
            manager,
            session_id,
            offset,
            spec.rows,
            cache_sizes,
            cache_bytes,
            column_offset=column_offset,
        )
        for offset, column_offset in zip(uncached_offsets, uncached_column_offsets, strict=True)
    ]

    page_cache_observable = bool(cache_sizes)
    max_cache_entries = max(cache_sizes) if cache_sizes else None
    if max_cache_entries is not None and max_cache_entries > PAGE_CACHE_LIMIT:
        raise AssertionError(
            f"Page cache grew to {max_cache_entries} entries for {path.name}; limit is {PAGE_CACHE_LIMIT}."
        )
    max_cache_bytes = max(cache_bytes) if cache_bytes else None
    if max_cache_bytes is not None and max_cache_bytes > PAGE_CACHE_BYTE_LIMIT:
        raise AssertionError(
            f"Page cache retained {max_cache_bytes} bytes for {path.name}; limit is {PAGE_CACHE_BYTE_LIMIT}."
        )

    _close_and_assert_empty(manager, session_id, path)
    retained_sessions = len(manager.sessions)
    stdio_transport = measure_stdio_transport(path, spec, backend)
    first_sample_ms = fresh_manager_open_samples[0]
    warm_reopen_samples = fresh_manager_open_samples[1:]
    warm_reopen_median_ms = median(warm_reopen_samples)
    cached_p95_ms = _percentile(cached_samples, 0.95)
    uncached_p95_ms = _percentile(uncached_samples, 0.95)
    warm_reopen_target = SLICE_TARGETS[f"{spec.kind}WarmSourceReopenMedianMs"]

    return {
        "backend": backend,
        "path": path.name,
        "shape": opened["metadata"]["shape"],
        "expectedRows": spec.rows,
        "expectedColumns": spec.columns,
        "fixtureContract": {
            "validated": True,
            "columnNames": spec.names,
            "columnType": "Int64",
            "sentinelRows": list(spec.sentinel_rows),
        },
        "freshManagerOpenMedianMs": round(median(fresh_manager_open_samples), 3),
        "firstMeasuredOpenMs": round(first_sample_ms, 3),
        "firstOpenSourceCacheDrop": first_open_cache_drop,
        "warmSourceReopenMedianMs": round(warm_reopen_median_ms, 3),
        "warmSourceReopenSamplesMs": [round(value, 3) for value in warm_reopen_samples],
        "freshManagerOpenSamplesMs": [round(value, 3) for value in fresh_manager_open_samples],
        "openMeasurementNotes": {
            "firstMeasuredOpenMs": (
                "First fresh-manager open after the recorded per-file source-cache eviction request."
            ),
            "warmSourceReopenMedianMs": (
                "Median of samples 2+ with a fresh manager per sample and a potentially warm OS source cache."
            ),
            "freshManagerOpenMedianMs": (
                "Diagnostic median of all values in freshManagerOpenSamplesMs; not release-gated."
            ),
        },
        "firstVisibleProfileMs": round(first_visible_profile_ms, 3),
        "profiledColumns": profiled_columns,
        "projectedGridColumns": min(DEFAULT_FETCH_COLUMN_BLOCK_SIZE, spec.columns),
        "initialSummaryCount": len(opened["summaries"]),
        "exactRowCounts": True,
        "engineMetadata": {
            "name": session.backend,
            "adapterClass": _qualified_type_name(session.engine),
            "frameTypes": frame_types,
            "nativeFrames": native_frames,
            "lazyNativeFrames": lazy_frames,
        },
        "nativeEngineRetained": all(native_frames.values()),
        "lazyNativeRetained": all(lazy_frames.values()) if backend in {"polars", "duckdb"} else False,
        "lazyPolarsRetained": backend == "polars" and all(lazy_frames.values()),
        "lazyFrames": lazy_frames,
        "directRuntimeCachedPageP95Ms": round(cached_p95_ms, 3),
        "directRuntimeCacheMissPageP95Ms": round(uncached_p95_ms, 3),
        "cachedOffset": cached_offset,
        "cachedColumnOffset": cached_column_offset,
        "cachedWarmupMs": round(cached_warmup_ms, 3),
        "uncachedOffsets": uncached_offsets,
        "uncachedColumnOffsets": uncached_column_offsets,
        "cachedSamplesMs": [round(value, 3) for value in cached_samples],
        "uncachedSamplesMs": [round(value, 3) for value in uncached_samples],
        "pageCache": {
            "observable": page_cache_observable,
            "limit": PAGE_CACHE_LIMIT,
            "maxEntries": max_cache_entries,
            "byteLimit": PAGE_CACHE_BYTE_LIMIT,
            "maxBytes": max_cache_bytes,
        },
        "sliceTargetStatus": {
            "warmSourceReopenMedian": _target_status(warm_reopen_median_ms, warm_reopen_target),
            "directRuntimeCachedPageP95": _target_status(cached_p95_ms, SLICE_TARGETS["directRuntimeCachedPageP95Ms"]),
            "directRuntimeCacheMissPageP95": _target_status(
                uncached_p95_ms, SLICE_TARGETS["directRuntimeCacheMissPageP95Ms"]
            ),
            "stdioTransportCacheMissPageP95": _target_status(
                stdio_transport["cacheMissPageP95Ms"], SLICE_TARGETS["stdioTransportCacheMissPageP95Ms"]
            ),
        },
        "stdioTransport": stdio_transport,
        "retainedSessions": retained_sessions,
    }


def _profile_overlap_evidence(
    stats_started_ns: int,
    page_sent_ns: int,
    stats_finished_ns: int,
    completion_delta_ms: float,
    serialized_gap_threshold_ms: float,
) -> dict[str, Any]:
    if stats_finished_ns < stats_started_ns:
        raise AssertionError("Dataset-statistics finish preceded its benchmark start event.")
    stats_active = stats_started_ns <= page_sent_ns < stats_finished_ns
    stats_completed = stats_finished_ns <= page_sent_ns
    stats_started_after_page = page_sent_ns < stats_started_ns
    page_overlapped = stats_active and completion_delta_ms < serialized_gap_threshold_ms
    return {
        "statsActiveWhenPageWasSent": stats_active,
        "statsCompletedBeforePageWasSent": stats_completed,
        "statsStartedAfterPageWasSent": stats_started_after_page,
        "interactivePageOverlappedProfile": page_overlapped,
        "sameSessionContentionObserved": stats_active and not page_overlapped,
        "pageSendAfterStatsStartMs": (page_sent_ns - stats_started_ns) / 1_000_000,
        "statsFinishAfterPageSendMs": (stats_finished_ns - page_sent_ns) / 1_000_000,
    }


def measure_stdio_transport(path: Path, spec: FixtureSpec, backend: Backend = "polars") -> dict[str, Any]:
    """Measure canonical JSON/envelope round trips through the real subprocess."""
    transport_samples: list[float] = []
    offsets = _uncached_offsets(spec.rows, 0)
    column_offsets = _sample_column_offsets(spec.columns, len(offsets))
    with StdioRuntimeClient(backend) as client:
        initialized, initialize_ms = client.request({"kind": "initialize"}, label="initialize")
        _expect_response_kind(initialized, "initialized", "initialize")
        client.record_resources("initialized")
        cold_source_cache_drop = _drop_source_file_cache(path)

        opened, open_ms = client.request(
            {
                "kind": "openSession",
                "source": {"kind": "file", "label": path.name, "path": str(path.resolve())},
                "backend": backend,
                "mode": "editing",
                "pageSize": PAGE_SIZE,
                "columnOffset": 0,
                "columnLimit": DEFAULT_FETCH_COLUMN_BLOCK_SIZE,
            },
            label=f"open-{spec.kind}",
        )
        _expect_response_kind(opened, "sessionOpened", f"open {path.name}")
        _assert_open_contract(opened, spec, path, backend)
        client.record_resources("session-opened")
        session_id = opened["metadata"]["sessionId"]
        revision = opened["metadata"]["revision"]

        for sample, (offset, column_offset) in enumerate(zip(offsets, column_offsets, strict=True)):
            view_request_id = f"transport-{spec.kind}-page-{sample}"
            response, elapsed_ms = client.request(
                {
                    "kind": "getPage",
                    "sessionId": session_id,
                    "revision": revision,
                    "viewRequestId": view_request_id,
                    "offset": offset,
                    "limit": PAGE_SIZE,
                    "columnOffset": column_offset,
                    "columnLimit": DEFAULT_FETCH_COLUMN_BLOCK_SIZE,
                    "filterModel": EMPTY_FILTER,
                },
                label=f"page-{spec.kind}-{sample}",
            )
            _expect_response_kind(response, "page", f"transport page {offset} for {path.name}")
            if response.get("viewRequestId") != view_request_id:
                raise AssertionError(f"Transport page {offset} did not preserve its viewRequestId for {path.name}.")
            if response["page"]["totalRows"] != spec.rows:
                raise AssertionError(f"Transport page {offset} returned an inexact row count for {path.name}.")
            _assert_page_projection(
                response["page"],
                opened["metadata"]["schema"],
                column_offset,
                f"transport page {offset} for {path.name}",
            )
            transport_samples.append(elapsed_ms)
        client.record_resources("cache-miss-pages-complete")

        contention_offset = _contention_offset(spec.rows, offsets)
        contention_column_offset = _sample_column_offsets(spec.columns, 1)[0]
        stats_view_request_id = f"transport-{spec.kind}-contended-stats"
        stats_id, stats_started = client.send(
            {
                "kind": "getDatasetStats",
                "sessionId": session_id,
                "revision": revision,
                "viewRequestId": stats_view_request_id,
                "filterModel": EMPTY_FILTER,
            },
            priority="background",
            label=f"stats-{spec.kind}",
        )
        stats_started_event = client.receive_benchmark_event("statsStarted")

        page_view_request_id = f"transport-{spec.kind}-contended-page"
        page_id, page_started = client.send(
            {
                "kind": "getPage",
                "sessionId": session_id,
                "revision": revision,
                "viewRequestId": page_view_request_id,
                "offset": contention_offset,
                "limit": PAGE_SIZE,
                "columnOffset": contention_column_offset,
                "columnLimit": DEFAULT_FETCH_COLUMN_BLOCK_SIZE,
                "filterModel": EMPTY_FILTER,
            },
            label=f"contended-page-{spec.kind}",
        )
        page_sent_ns = client.request_send_completed_ns[page_id]
        contended_page = client.receive(page_id)
        contended_page_ms = (client.response_arrivals[page_id] - page_started) * 1_000
        stats = client.receive(stats_id)
        stats_ms = (client.response_arrivals[stats_id] - stats_started) * 1_000
        stats_finished_event = client.receive_benchmark_event("statsFinished")
        client.record_resources("profile-contention-complete")
        _expect_response_kind(contended_page, "page", f"same-session contended page for {path.name}")
        _expect_response_kind(stats, "datasetStats", f"same-session dataset statistics for {path.name}")
        if contended_page.get("viewRequestId") != page_view_request_id:
            raise AssertionError(f"Contended page did not preserve its viewRequestId for {path.name}.")
        if stats.get("viewRequestId") != stats_view_request_id:
            raise AssertionError(f"Dataset statistics did not preserve their viewRequestId for {path.name}.")
        _assert_page_projection(
            contended_page["page"],
            opened["metadata"]["schema"],
            contention_column_offset,
            f"same-session contended page for {path.name}",
        )
        completion_delta_ms = (client.response_arrivals[page_id] - client.response_arrivals[stats_id]) * 1_000
        # A serialized cache miss would only begin after statistics completes,
        # leaving approximately a full uncontented cache-miss gap between the
        # two responses. A gap below half the lower-tail baseline demonstrates
        # substantial execution overlap even when CPU contention makes the two
        # callbacks complete together or reverses their write order slightly.
        serialized_gap_threshold_ms = max(
            SERIALIZATION_EVIDENCE_MIN_MS,
            _percentile(transport_samples, 0.05) * 0.5,
        )
        overlap_evidence = _profile_overlap_evidence(
            int(stats_started_event["perfCounterNs"]),
            page_sent_ns,
            int(stats_finished_event["perfCounterNs"]),
            completion_delta_ms,
            serialized_gap_threshold_ms,
        )

        closed, _ = client.request(
            {"kind": "closeSession", "sessionId": session_id, "revision": revision},
            label=f"close-{spec.kind}",
        )
        _expect_response_kind(closed, "sessionClosed", f"close {path.name}")
        client.record_resources("session-closed")

    return {
        "backend": backend,
        "boundary": "standalone Python process using canonical protocol-v2 newline-delimited JSON envelopes",
        "statsStartProof": (
            f"benchmark-only {backend.title()} header_stats entry/exit events on stderr using process-wide "
            "perf_counter_ns"
        ),
        "initializeRoundTripMs": round(initialize_ms, 3),
        "openRoundTripMs": round(open_ms, 3),
        "coldSourceOpenRoundTripMs": round(open_ms, 3),
        "coldSourceCacheDrop": cold_source_cache_drop,
        "cacheMissPageP95Ms": round(_percentile(transport_samples, 0.95), 3),
        "cacheMissPageSamplesMs": [round(value, 3) for value in transport_samples],
        "cacheMissOffsets": offsets,
        "cacheMissColumnOffsets": column_offsets,
        "sameSessionStatsDurationMs": round(stats_ms, 3),
        "sameSessionStatsContendedPageLatencyMs": round(contended_page_ms, 3),
        "sameSessionContentionOffset": contention_offset,
        "sameSessionContentionColumnOffset": contention_column_offset,
        **overlap_evidence,
        "serializedCompletionGapThresholdMs": round(serialized_gap_threshold_ms, 3),
        "pageMinusStatsCompletionMs": round(completion_delta_ms, 3),
        "responseOrder": [
            "stats" if item == stats_id else "page" for item in client.response_order if item in {stats_id, page_id}
        ],
        "processResources": _resource_evidence(
            "standalone Python runtime child only; excludes VS Code, Cursor, extension host, and webview",
            client.resource_samples,
        ),
        "closedCleanly": True,
    }


def run_benchmark(directory: Path, smoke: bool = False, backend: Backend = "polars") -> dict[str, Any]:
    process_samples = [{"stage": "benchmark-started", **_process_memory_snapshot(os.getpid())}]
    fixtures = create_fixtures(directory, smoke)
    process_samples.append({"stage": "fixtures-ready", **_process_memory_snapshot(os.getpid())})
    specs = _fixture_specs(smoke)
    csv = measure_fixture(fixtures["csv"], specs["csv"], backend)
    parquet = measure_fixture(fixtures["parquet"], specs["parquet"], backend)
    process_samples.append({"stage": "benchmark-complete", **_process_memory_snapshot(os.getpid())})
    return {
        "limits": RELEASE_LIMITS,
        "releaseGateMetrics": RELEASE_GATE_METRICS,
        "sliceTargets": SLICE_TARGETS,
        "sliceTargetsAreReleaseBlocking": False,
        "smoke": smoke,
        "backend": backend,
        "benchmarkMetadata": {
            "selectedBackend": backend,
            "fixtures": "deterministic synthetic integer CSV and Parquet sources only",
            "measurementBoundary": (
                "Direct Python SessionManager calls and standalone runtime protocol-v2 round trips. "
                "These are not VS Code, Cursor, webview, or editor first-paint timings."
            ),
            "releaseLimitsApplyToBackend": "polars",
            "selectedBackendIsReleaseGated": backend == "polars",
        },
        "provenance": _benchmark_provenance(backend),
        "processResources": _resource_evidence(
            "benchmark driver, Polars fixture generation/validation, and in-process direct runtime; "
            "excludes standalone child samples and editor processes",
            process_samples,
        ),
        "csv": csv,
        "parquet": parquet,
    }


def assert_release_limits(report: dict[str, Any]) -> None:
    reported_backend = report.get("backend", "polars")
    if reported_backend != "polars":
        raise AssertionError(
            f"Performance release gates apply only to the native Polars path, not {reported_backend!r}."
        )
    failures: list[str] = []
    checks = [
        (
            "CSV cold-source first usable grid",
            report["csv"]["stdioTransport"]["coldSourceOpenRoundTripMs"],
            RELEASE_LIMITS["csvColdSourceFirstGridMs"],
        ),
        (
            "Parquet cold-source first usable grid",
            report["parquet"]["stdioTransport"]["coldSourceOpenRoundTripMs"],
            RELEASE_LIMITS["parquetColdSourceFirstGridMs"],
        ),
        (
            "CSV warm-source reopen median",
            report["csv"]["warmSourceReopenMedianMs"],
            RELEASE_LIMITS["csvWarmSourceReopenMedianMs"],
        ),
        (
            "Parquet warm-source reopen median",
            report["parquet"]["warmSourceReopenMedianMs"],
            RELEASE_LIMITS["parquetWarmSourceReopenMedianMs"],
        ),
        (
            "CSV direct-runtime cached page p95",
            report["csv"]["directRuntimeCachedPageP95Ms"],
            RELEASE_LIMITS["directRuntimeCachedPageP95Ms"],
        ),
        (
            "Parquet direct-runtime cached page p95",
            report["parquet"]["directRuntimeCachedPageP95Ms"],
            RELEASE_LIMITS["directRuntimeCachedPageP95Ms"],
        ),
        (
            "CSV direct-runtime cache-miss page p95",
            report["csv"]["directRuntimeCacheMissPageP95Ms"],
            RELEASE_LIMITS["directRuntimeCacheMissPageP95Ms"],
        ),
        (
            "Parquet direct-runtime cache-miss page p95",
            report["parquet"]["directRuntimeCacheMissPageP95Ms"],
            RELEASE_LIMITS["directRuntimeCacheMissPageP95Ms"],
        ),
        *[
            (
                f"{kind.title()} stdio transport cache-miss page p95",
                report[kind]["stdioTransport"]["cacheMissPageP95Ms"],
                RELEASE_LIMITS["stdioTransportCacheMissPageP95Ms"],
            )
            for kind in ("csv", "parquet")
        ],
        *[
            (
                f"{kind.title()} same-session stats-contended page latency",
                report[kind]["stdioTransport"]["sameSessionStatsContendedPageLatencyMs"],
                RELEASE_LIMITS["stdioSameSessionStatsContendedPageLatencyMs"],
            )
            for kind in ("csv", "parquet")
        ],
    ]
    for label, actual, limit in checks:
        if actual > limit:
            failures.append(f"{label}: {actual:.3f}ms exceeded {limit:.3f}ms")
    for kind in ("csv", "parquet"):
        transport = report[kind]["stdioTransport"]
        if not transport["coldSourceCacheDrop"]["applied"]:
            failures.append(f"{kind.title()} cold-source proof: {transport['coldSourceCacheDrop']['detail']}")
        if not transport["statsActiveWhenPageWasSent"]:
            reason = (
                "dataset statistics completed before the page envelope was sent"
                if transport["statsCompletedBeforePageWasSent"]
                else "the benchmark did not prove an active dataset-statistics call at page send"
            )
            failures.append(f"{kind.title()} same-session active-profile proof: {reason}")
        elif transport["sameSessionContentionObserved"]:
            failures.append(
                f"{kind.title()} same-session interactive overlap: cache-miss page did not substantially "
                "overlap dataset statistics that were active when the page was sent"
            )
    if failures:
        raise AssertionError("Performance release gates failed:\n" + "\n".join(failures))


def _time_page(
    manager: SessionManager,
    session_id: str,
    offset: int,
    expected_rows: int,
    cache_sizes: list[int],
    cache_bytes: list[int],
    *,
    column_offset: int,
) -> float:
    started = perf_counter()
    response = manager.get_page(
        session_id,
        0,
        offset,
        PAGE_SIZE,
        EMPTY_FILTER,
        column_offset=column_offset,
        column_limit=DEFAULT_FETCH_COLUMN_BLOCK_SIZE,
    )
    elapsed_ms = (perf_counter() - started) * 1_000
    if response["page"]["totalRows"] != expected_rows:
        raise AssertionError(
            f"Page at offset {offset} reported {response['page']['totalRows']} rows; expected {expected_rows}."
        )
    _assert_page_projection(
        response["page"],
        response["metadata"]["schema"],
        column_offset,
        f"direct runtime page at row offset {offset}",
    )
    cache_size = _observable_cache_size(manager.sessions[session_id])
    if cache_size is not None:
        cache_sizes.append(cache_size)
    retained_bytes = _observable_cache_bytes(manager.sessions[session_id])
    if retained_bytes is not None:
        cache_bytes.append(retained_bytes)
    return elapsed_ms


def _assert_open_contract(opened: dict[str, Any], spec: FixtureSpec, path: Path, backend: Backend = "polars") -> None:
    if opened["summaries"]:
        raise AssertionError(f"First grid performed {len(opened['summaries'])} eager summaries for {path.name}.")
    if opened["metadata"].get("backend") != backend:
        raise AssertionError(
            f"First grid selected backend {opened['metadata'].get('backend')!r} for {path.name}; expected {backend!r}."
        )
    exact_counts = {
        "shape": opened["metadata"]["shape"]["rows"],
        "filteredShape": opened["metadata"]["filteredShape"]["rows"],
        "page": opened["page"]["totalRows"],
    }
    incorrect = {name: count for name, count in exact_counts.items() if count != spec.rows}
    if incorrect:
        raise AssertionError(
            f"First grid returned inexact row counts for {path.name}: {incorrect}; expected {spec.rows}."
        )
    expected_shape = {"rows": spec.rows, "columns": spec.columns}
    if opened["metadata"]["shape"] != expected_shape:
        raise AssertionError(
            f"First grid returned shape {opened['metadata']['shape']} for {path.name}; expected {expected_shape}."
        )
    schema = opened["metadata"]["schema"]
    actual_names = [column["name"] for column in schema]
    if actual_names != spec.names:
        raise AssertionError(f"First grid returned unexpected columns for {path.name}: {actual_names!r}.")
    wrong_types = {
        column["name"]: (column["rawType"], column["type"])
        for column in schema
        if column["type"] != "integer" or (backend == "polars" and column["rawType"] != "Int64")
    }
    if wrong_types:
        raise AssertionError(f"First grid returned unexpected column types for {path.name}: {wrong_types!r}.")
    first_row = opened["page"]["rows"][0]
    first_values = [cell["raw"] for cell in first_row["values"]]
    expected_grid_columns = min(DEFAULT_FETCH_COLUMN_BLOCK_SIZE, spec.columns)
    _assert_page_projection(opened["page"], schema, 0, f"first grid for {path.name}")
    if first_row["rowNumber"] != 0 or first_values != list(range(expected_grid_columns)):
        raise AssertionError(
            f"First grid returned invalid deterministic content for {path.name}: "
            f"rowNumber={first_row['rowNumber']}, values={first_values!r}."
        )


def _assert_page_projection(
    page: dict[str, Any],
    schema: list[dict[str, Any]],
    column_offset: int,
    context: str,
) -> None:
    expected_column_ids = [
        column["id"] for column in schema[column_offset : column_offset + DEFAULT_FETCH_COLUMN_BLOCK_SIZE]
    ]
    if page.get("columnIds") != expected_column_ids:
        raise AssertionError(
            f"{context} returned invalid projected column identities: "
            f"{page.get('columnIds')!r}; expected {expected_column_ids!r}."
        )


def _close_and_assert_empty(manager: SessionManager, session_id: str, path: Path) -> None:
    manager.close_session(session_id, 0)
    if manager.sessions:
        raise AssertionError(f"Session cleanup retained {len(manager.sessions)} session(s) for {path.name}.")


def _uncached_offsets(expected_rows: int, cached_offset: int) -> list[int]:
    page_count = math.ceil(expected_rows / PAGE_SIZE)
    candidate_pages = [page for page in range(page_count) if page * PAGE_SIZE != cached_offset]
    if len(candidate_pages) <= PAGE_CACHE_LIMIT:
        raise AssertionError(
            f"Fixture has only {len(candidate_pages)} uncached blocks; "
            f"need more than the {PAGE_CACHE_LIMIT}-block cache."
        )
    if len(candidate_pages) <= SAMPLES:
        selected_pages = candidate_pages
    else:
        last = len(candidate_pages) - 1
        selected_pages = [candidate_pages[math.floor((sample / (SAMPLES - 1)) * last)] for sample in range(SAMPLES)]
    offsets = [page * PAGE_SIZE for page in selected_pages]
    if len(offsets) != len(set(offsets)) or cached_offset in offsets:
        raise AssertionError("Uncached page samples must use unique offsets that exclude the cached block.")
    if len(offsets) <= PAGE_CACHE_LIMIT:
        raise AssertionError("Uncached page samples must exceed the page-cache capacity.")
    return offsets


def _sample_column_offsets(expected_columns: int, sample_count: int) -> list[int]:
    if expected_columns < 0 or sample_count < 0:
        raise AssertionError("Column sampling requires non-negative column and sample counts.")
    aligned_offsets = list(range(0, expected_columns, DEFAULT_FETCH_COLUMN_BLOCK_SIZE)) or [0]
    if len(aligned_offsets) == 1:
        return [0] * sample_count
    # Start beyond the already measured initial block, then cycle through every
    # real horizontal block so both direct and stdio miss samples exercise the
    # two-dimensional cache rather than only varying row offsets.
    return [aligned_offsets[(sample + 1) % len(aligned_offsets)] for sample in range(sample_count)]


def _contention_offset(expected_rows: int, prior_offsets: list[int]) -> int:
    recently_cached = set(prior_offsets[-PAGE_CACHE_LIMIT:])
    for page in range(math.ceil(expected_rows / PAGE_SIZE)):
        offset = page * PAGE_SIZE
        if offset not in recently_cached:
            return offset
    raise AssertionError("Could not select a cache-miss offset for the same-session contention sample.")


def _expect_response_kind(response: dict[str, Any], expected: str, context: str) -> None:
    if response.get("kind") != expected:
        raise AssertionError(f"Expected {expected} while measuring {context}, received {response!r}.")


def _observable_cache_size(session: Any) -> int | None:
    cache = getattr(session, "page_cache", None)
    return len(cache) if cache is not None else None


def _observable_cache_bytes(session: Any) -> int | None:
    retained = getattr(session, "page_cache_bytes", None)
    return int(retained) if retained is not None else None


def _target_status(actual_ms: float, target_ms: float) -> dict[str, Any]:
    return {
        "actualMs": round(actual_ms, 3),
        "targetMs": target_ms,
        "met": actual_ms < target_ms,
    }


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return ordered[index]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark a native Open Wrangler Python-runtime viewing path. "
            "Reported timings do not measure editor or webview first paint."
        )
    )
    parser.add_argument("--fixture-dir", type=Path)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--backend", choices=BACKENDS, default="polars")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="openwrangler-benchmark-") as temporary:
        directory = args.fixture_dir or Path(temporary)
        report = run_benchmark(directory, smoke=args.smoke, backend=args.backend)
    payload = json.dumps(report, indent=2, sort_keys=True)
    print(payload)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(payload + "\n", encoding="utf-8")
    # Preserve the measured evidence even when a strict gate fails so CI can
    # upload the exact regression report instead of a stale prior run.
    if args.strict and not args.smoke:
        if args.backend != "polars":
            raise AssertionError("Strict release limits are defined only for the native Polars benchmark path.")
        assert_release_limits(report)


if __name__ == "__main__":
    main()
