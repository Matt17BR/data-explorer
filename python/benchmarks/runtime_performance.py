from __future__ import annotations

import argparse
import json
import math
import tempfile
from pathlib import Path
from time import perf_counter
from typing import Any

import polars as pl

from openwrangler_runtime.session import SessionManager

PAGE_SIZE = 200
SAMPLES = 20
EMPTY_FILTER = {"logic": "and", "filters": [], "sort": []}
RELEASE_LIMITS = {
    "csvFirstGridMs": 3_000.0,
    "parquetFirstGridMs": 5_000.0,
    "cachedPageP95Ms": 100.0,
    "uncachedPageP95Ms": 500.0,
}


def create_fixtures(directory: Path, smoke: bool = False) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    csv_rows, csv_columns = (2_000, 8) if smoke else (100_000, 50)
    parquet_rows, parquet_columns = (5_000, 8) if smoke else (1_000_000, 20)
    csv = directory / f"{csv_rows}-{csv_columns}.csv"
    parquet = directory / f"{parquet_rows}-{parquet_columns}.parquet"

    if not csv.exists():
        pl.DataFrame(
            {f"c{column:02d}": pl.int_range(column, csv_rows + column, eager=True) for column in range(csv_columns)}
        ).write_csv(csv)
    if not parquet.exists():
        (
            pl.LazyFrame()
            .select(pl.int_range(0, parquet_rows).alias("c00"))
            .with_columns([(pl.col("c00") + column).alias(f"c{column:02d}") for column in range(1, parquet_columns)])
            .sink_parquet(parquet)
        )
    return {"csv": csv, "parquet": parquet}


def measure_fixture(path: Path, expected_rows: int) -> dict[str, Any]:
    manager = SessionManager()
    started = perf_counter()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path.resolve())},
        backend="polars",
        page_size=PAGE_SIZE,
    )
    first_grid_ms = (perf_counter() - started) * 1_000
    session_id = opened["metadata"]["sessionId"]

    cached_samples = [_time_page(manager, session_id, 0) for _ in range(SAMPLES)]
    last_offset = max(0, ((expected_rows - 1) // PAGE_SIZE) * PAGE_SIZE)
    offsets = sorted(
        {(math.floor((sample / (SAMPLES - 1)) * last_offset) // PAGE_SIZE) * PAGE_SIZE for sample in range(SAMPLES)}
    )
    uncached_samples = [_time_page(manager, session_id, offset) for offset in offsets]
    manager.close_session(session_id, 0)
    if manager.sessions:
        raise AssertionError(f"Session cleanup retained {len(manager.sessions)} session(s) for {path.name}.")

    return {
        "path": path.name,
        "shape": opened["metadata"]["shape"],
        "firstGridMs": round(first_grid_ms, 3),
        "cachedPageP95Ms": round(_percentile(cached_samples, 0.95), 3),
        "uncachedPageP95Ms": round(_percentile(uncached_samples, 0.95), 3),
        "cachedSamplesMs": [round(value, 3) for value in cached_samples],
        "uncachedSamplesMs": [round(value, 3) for value in uncached_samples],
        "retainedSessions": len(manager.sessions),
    }


def run_benchmark(directory: Path, smoke: bool = False) -> dict[str, Any]:
    fixtures = create_fixtures(directory, smoke)
    csv_rows = 2_000 if smoke else 100_000
    parquet_rows = 5_000 if smoke else 1_000_000
    return {
        "limits": RELEASE_LIMITS,
        "smoke": smoke,
        "csv": measure_fixture(fixtures["csv"], csv_rows),
        "parquet": measure_fixture(fixtures["parquet"], parquet_rows),
    }


def assert_release_limits(report: dict[str, Any]) -> None:
    failures: list[str] = []
    checks = [
        ("CSV first grid", report["csv"]["firstGridMs"], RELEASE_LIMITS["csvFirstGridMs"]),
        ("Parquet first grid", report["parquet"]["firstGridMs"], RELEASE_LIMITS["parquetFirstGridMs"]),
        (
            "CSV cached page p95",
            report["csv"]["cachedPageP95Ms"],
            RELEASE_LIMITS["cachedPageP95Ms"],
        ),
        (
            "Parquet cached page p95",
            report["parquet"]["cachedPageP95Ms"],
            RELEASE_LIMITS["cachedPageP95Ms"],
        ),
        (
            "CSV uncached page p95",
            report["csv"]["uncachedPageP95Ms"],
            RELEASE_LIMITS["uncachedPageP95Ms"],
        ),
        (
            "Parquet uncached page p95",
            report["parquet"]["uncachedPageP95Ms"],
            RELEASE_LIMITS["uncachedPageP95Ms"],
        ),
    ]
    for label, actual, limit in checks:
        if actual > limit:
            failures.append(f"{label}: {actual:.3f}ms exceeded {limit:.3f}ms")
    if failures:
        raise AssertionError("Performance release gates failed:\n" + "\n".join(failures))


def _time_page(manager: SessionManager, session_id: str, offset: int) -> float:
    started = perf_counter()
    manager.get_page(session_id, 0, offset, PAGE_SIZE, EMPTY_FILTER)
    return (perf_counter() - started) * 1_000


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return ordered[index]


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark the release-size native Polars viewing path.")
    parser.add_argument("--fixture-dir", type=Path)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="openwrangler-benchmark-") as temporary:
        directory = args.fixture_dir or Path(temporary)
        report = run_benchmark(directory, smoke=args.smoke)
    if args.strict and not args.smoke:
        assert_release_limits(report)
    payload = json.dumps(report, indent=2, sort_keys=True)
    print(payload)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(payload + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
