from __future__ import annotations

import json
import runpy
import subprocess
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest

runtime_performance = SimpleNamespace(
    **runpy.run_path(str(Path(__file__).parents[1] / "benchmarks" / "runtime_performance.py"))
)


def test_performance_harness_smoke(tmp_path: Path) -> None:
    python_root = Path(__file__).parents[1]
    report = tmp_path / "report.json"
    result = subprocess.run(
        [
            sys.executable,
            str(python_root / "benchmarks" / "runtime_performance.py"),
            "--smoke",
            "--fixture-dir",
            str(tmp_path / "fixtures"),
            "--json-out",
            str(report),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    payload = json.loads(report.read_text(encoding="utf-8"))
    package_manifest = json.loads((Path(__file__).parents[2] / "package.json").read_text(encoding="utf-8"))
    configured_column_block_size = package_manifest["contributes"]["configuration"]["properties"][
        "openWrangler.fetchColumnBlockSize"
    ]["default"]
    assert runtime_performance.DEFAULT_FETCH_COLUMN_BLOCK_SIZE == configured_column_block_size == 16
    assert payload["smoke"] is True
    assert payload["csv"]["shape"] == {"rows": 2_000, "columns": 8}
    assert payload["parquet"]["shape"] == {"rows": 5_000, "columns": 8}
    assert payload["sliceTargetsAreReleaseBlocking"] is False
    assert payload["releaseGateMetrics"] == {
        "coldSourceCacheDropProof": "*.stdioTransport.coldSourceCacheDrop.applied (must be true)",
        "csvColdSourceFirstGridMs": "csv.stdioTransport.coldSourceOpenRoundTripMs",
        "csvWarmSourceReopenMedianMs": "csv.warmSourceReopenMedianMs",
        "directRuntimeCacheMissPageP95Ms": "*.directRuntimeCacheMissPageP95Ms",
        "directRuntimeCachedPageP95Ms": "*.directRuntimeCachedPageP95Ms",
        "parquetWarmSourceReopenMedianMs": "parquet.warmSourceReopenMedianMs",
        "parquetColdSourceFirstGridMs": "parquet.stdioTransport.coldSourceOpenRoundTripMs",
        "stdioSameSessionActiveProfileProof": "*.stdioTransport.statsActiveWhenPageWasSent (must be true)",
        "stdioSameSessionStatsContendedPageLatencyMs": "*.stdioTransport.sameSessionStatsContendedPageLatencyMs",
        "stdioSameSessionInteractiveOverlap": (
            "*.stdioTransport.interactivePageOverlappedProfile when statsActiveWhenPageWasSent is true"
        ),
        "stdioTransportCacheMissPageP95Ms": "*.stdioTransport.cacheMissPageP95Ms",
    }
    assert payload["limits"] == {
        "csvColdSourceFirstGridMs": 3_000.0,
        "csvWarmSourceReopenMedianMs": 3_000.0,
        "directRuntimeCacheMissPageP95Ms": 500.0,
        "directRuntimeCachedPageP95Ms": 100.0,
        "parquetWarmSourceReopenMedianMs": 5_000.0,
        "parquetColdSourceFirstGridMs": 5_000.0,
        "stdioSameSessionStatsContendedPageLatencyMs": 500.0,
        "stdioTransportCacheMissPageP95Ms": 500.0,
    }
    for fixture in (payload["csv"], payload["parquet"]):
        assert len(fixture["freshManagerOpenSamplesMs"]) >= 5
        assert fixture["firstMeasuredOpenMs"] == fixture["freshManagerOpenSamplesMs"][0]
        assert isinstance(fixture["firstOpenSourceCacheDrop"]["supported"], bool)
        assert isinstance(fixture["firstOpenSourceCacheDrop"]["applied"], bool)
        assert fixture["warmSourceReopenSamplesMs"] == fixture["freshManagerOpenSamplesMs"][1:]
        assert set(fixture["openMeasurementNotes"]) == {
            "firstMeasuredOpenMs",
            "freshManagerOpenMedianMs",
            "warmSourceReopenMedianMs",
        }
        assert fixture["firstVisibleProfileMs"] >= 0
        assert fixture["projectedGridColumns"] == min(16, fixture["expectedColumns"])
        assert fixture["initialSummaryCount"] == 0
        assert fixture["exactRowCounts"] is True
        assert fixture["expectedColumns"] == fixture["shape"]["columns"]
        assert fixture["fixtureContract"]["validated"] is True
        assert len(fixture["fixtureContract"]["columnNames"]) == fixture["expectedColumns"]
        assert fixture["fixtureContract"]["columnType"] == "Int64"
        assert fixture["lazyPolarsRetained"] is True
        assert fixture["pageCache"]["observable"] is True
        assert fixture["pageCache"]["maxEntries"] <= fixture["pageCache"]["limit"] == 8
        assert fixture["pageCache"]["maxBytes"] <= fixture["pageCache"]["byteLimit"] == 16 * 1024 * 1024
        assert fixture["cachedWarmupMs"] >= 0
        assert fixture["directRuntimeCachedPageP95Ms"] >= 0
        assert fixture["directRuntimeCacheMissPageP95Ms"] >= 0
        assert len(fixture["uncachedOffsets"]) > fixture["pageCache"]["limit"]
        assert len(fixture["uncachedOffsets"]) == len(set(fixture["uncachedOffsets"]))
        assert fixture["cachedOffset"] not in fixture["uncachedOffsets"]
        assert fixture["cachedColumnOffset"] == 0
        assert len(fixture["uncachedColumnOffsets"]) == len(fixture["uncachedOffsets"])
        assert fixture["retainedSessions"] == 0
        transport = fixture["stdioTransport"]
        assert transport["boundary"].startswith("standalone Python process")
        assert transport["initializeRoundTripMs"] >= 0
        assert transport["openRoundTripMs"] >= 0
        assert transport["coldSourceOpenRoundTripMs"] == transport["openRoundTripMs"]
        assert isinstance(transport["coldSourceCacheDrop"]["supported"], bool)
        assert isinstance(transport["coldSourceCacheDrop"]["applied"], bool)
        assert transport["cacheMissPageP95Ms"] >= 0
        assert len(transport["cacheMissPageSamplesMs"]) == len(transport["cacheMissOffsets"])
        assert len(transport["cacheMissColumnOffsets"]) == len(transport["cacheMissOffsets"])
        assert transport["sameSessionContentionColumnOffset"] >= 0
        assert transport["statsStartProof"].startswith("benchmark-only Polars header_stats")
        assert transport["sameSessionStatsDurationMs"] >= 0
        assert transport["sameSessionStatsContendedPageLatencyMs"] >= 0
        assert isinstance(transport["sameSessionContentionObserved"], bool)
        assert isinstance(transport["statsActiveWhenPageWasSent"], bool)
        assert isinstance(transport["statsCompletedBeforePageWasSent"], bool)
        assert isinstance(transport["statsStartedAfterPageWasSent"], bool)
        assert isinstance(transport["interactivePageOverlappedProfile"], bool)
        assert isinstance(transport["pageSendAfterStatsStartMs"], (int, float))
        assert isinstance(transport["statsFinishAfterPageSendMs"], (int, float))
        assert transport["serializedCompletionGapThresholdMs"] >= 5.0
        assert (
            sum(
                (
                    transport["statsActiveWhenPageWasSent"],
                    transport["statsCompletedBeforePageWasSent"],
                    transport["statsStartedAfterPageWasSent"],
                )
            )
            == 1
        )
        if not transport["statsActiveWhenPageWasSent"]:
            assert transport["sameSessionContentionObserved"] is False
            assert transport["interactivePageOverlappedProfile"] is False
        else:
            assert transport["pageSendAfterStatsStartMs"] >= 0
            assert transport["statsFinishAfterPageSendMs"] > 0
            assert transport["sameSessionContentionObserved"] is not transport["interactivePageOverlappedProfile"]
        assert transport["responseOrder"] in (["stats", "page"], ["page", "stats"])
        assert transport["closedCleanly"] is True
        assert set(fixture["sliceTargetStatus"]) == {
            "warmSourceReopenMedian",
            "directRuntimeCachedPageP95",
            "directRuntimeCacheMissPageP95",
            "stdioTransportCacheMissPageP95",
        }
    assert '"warmSourceReopenMedianMs"' in result.stdout


def test_performance_column_sampling_covers_real_horizontal_blocks() -> None:
    assert runtime_performance._sample_column_offsets(8, 4) == [0, 0, 0, 0]
    assert runtime_performance._sample_column_offsets(20, 4) == [16, 0, 16, 0]
    assert runtime_performance._sample_column_offsets(50, 5) == [16, 32, 48, 0, 16]


def test_existing_invalid_fixtures_are_atomically_regenerated_and_fully_validated(tmp_path, monkeypatch) -> None:
    fixtures = runtime_performance.create_fixtures(tmp_path, smoke=True)
    specs = runtime_performance._fixture_specs(smoke=True)

    csv_spec = specs["csv"]
    invalid_csv = pl.DataFrame(
        {name: pl.int_range(column, csv_spec.rows + column, eager=True) for column, name in enumerate(csv_spec.names)}
    ).with_row_index("row")
    invalid_csv = invalid_csv.with_columns(
        pl.when(pl.col("row") == csv_spec.rows // 2).then(pl.lit(-1)).otherwise(pl.col("c03")).alias("c03")
    ).drop("row")
    invalid_csv.write_csv(fixtures["csv"])
    pl.DataFrame({"wrong": ["schema"]}).write_parquet(fixtures["parquet"])

    replacements: list[tuple[Path, Path]] = []
    real_replace = runtime_performance.os.replace

    def observe_replace(source: str | Path, destination: str | Path) -> None:
        replacements.append((Path(source), Path(destination)))
        real_replace(source, destination)

    monkeypatch.setattr(runtime_performance.os, "replace", observe_replace)
    repaired = runtime_performance.create_fixtures(tmp_path, smoke=True)

    assert {destination for _, destination in replacements} == {fixtures["csv"], fixtures["parquet"]}
    assert all(source.parent == tmp_path and source.name.startswith(".") for source, _ in replacements)
    for kind, path in repaired.items():
        runtime_performance._assert_fixture_contract(path, specs[kind])


def test_profile_overlap_evidence_requires_the_page_send_to_fall_inside_the_stats_call() -> None:
    active_overlap = runtime_performance._profile_overlap_evidence(100, 200, 300, 9.999, 10.0)
    assert active_overlap == {
        "statsActiveWhenPageWasSent": True,
        "statsCompletedBeforePageWasSent": False,
        "statsStartedAfterPageWasSent": False,
        "interactivePageOverlappedProfile": True,
        "sameSessionContentionObserved": False,
        "pageSendAfterStatsStartMs": 0.0001,
        "statsFinishAfterPageSendMs": 0.0001,
    }

    active_serialized = runtime_performance._profile_overlap_evidence(100, 200, 300, 10.0, 10.0)
    assert active_serialized["statsActiveWhenPageWasSent"] is True
    assert active_serialized["interactivePageOverlappedProfile"] is False
    assert active_serialized["sameSessionContentionObserved"] is True

    completed = runtime_performance._profile_overlap_evidence(100, 300, 200, -50.0, 10.0)
    assert completed["statsCompletedBeforePageWasSent"] is True
    assert completed["interactivePageOverlappedProfile"] is False
    assert completed["sameSessionContentionObserved"] is False

    not_started = runtime_performance._profile_overlap_evidence(200, 100, 300, -50.0, 10.0)
    assert not_started["statsStartedAfterPageWasSent"] is True
    assert not_started["interactivePageOverlappedProfile"] is False
    assert not_started["sameSessionContentionObserved"] is False

    with pytest.raises(AssertionError, match="finish preceded"):
        runtime_performance._profile_overlap_evidence(300, 200, 100, 0.0, 10.0)


def test_release_gates_require_active_overlap_and_the_documented_transport_limits() -> None:
    fixture = {
        "stdioTransport": {
            "coldSourceOpenRoundTripMs": 1.0,
            "coldSourceCacheDrop": {"applied": True, "detail": "accepted"},
            "cacheMissPageP95Ms": 1.0,
            "sameSessionStatsContendedPageLatencyMs": 1.0,
            "sameSessionContentionObserved": False,
            "statsActiveWhenPageWasSent": True,
            "statsCompletedBeforePageWasSent": False,
            "statsStartedAfterPageWasSent": False,
            "interactivePageOverlappedProfile": True,
        },
        "warmSourceReopenMedianMs": 1.0,
        "directRuntimeCachedPageP95Ms": 1.0,
        "directRuntimeCacheMissPageP95Ms": 1.0,
    }
    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    runtime_performance.assert_release_limits(report)

    report["csv"]["stdioTransport"]["coldSourceOpenRoundTripMs"] = (
        runtime_performance.RELEASE_LIMITS["csvColdSourceFirstGridMs"] + 1
    )
    with pytest.raises(AssertionError, match="CSV cold-source first usable grid"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["parquet"]["stdioTransport"]["coldSourceCacheDrop"] = {
        "applied": False,
        "detail": "cache eviction unsupported",
    }
    with pytest.raises(AssertionError, match="Parquet cold-source proof"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["csv"]["warmSourceReopenMedianMs"] = runtime_performance.RELEASE_LIMITS["csvWarmSourceReopenMedianMs"] + 1
    with pytest.raises(AssertionError, match="CSV warm-source reopen median"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["parquet"]["stdioTransport"]["sameSessionStatsContendedPageLatencyMs"] = (
        runtime_performance.RELEASE_LIMITS["stdioSameSessionStatsContendedPageLatencyMs"] + 1
    )
    with pytest.raises(AssertionError, match="same-session stats-contended page latency"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["csv"]["stdioTransport"]["cacheMissPageP95Ms"] = (
        runtime_performance.RELEASE_LIMITS["stdioTransportCacheMissPageP95Ms"] + 1
    )
    with pytest.raises(AssertionError, match="stdio transport cache-miss page p95"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["parquet"]["stdioTransport"].update(
        {
            "sameSessionContentionObserved": True,
            "statsActiveWhenPageWasSent": True,
            "statsCompletedBeforePageWasSent": False,
            "statsStartedAfterPageWasSent": False,
            "interactivePageOverlappedProfile": False,
        }
    )
    with pytest.raises(AssertionError, match="same-session interactive overlap"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["parquet"]["stdioTransport"].update(
        {
            "sameSessionContentionObserved": False,
            "statsActiveWhenPageWasSent": False,
            "statsCompletedBeforePageWasSent": True,
            "statsStartedAfterPageWasSent": False,
            "interactivePageOverlappedProfile": False,
        }
    )
    with pytest.raises(AssertionError, match="completed before the page envelope"):
        runtime_performance.assert_release_limits(report)

    report = {"csv": deepcopy(fixture), "parquet": deepcopy(fixture)}
    report["parquet"]["stdioTransport"].update(
        {
            "sameSessionContentionObserved": False,
            "statsActiveWhenPageWasSent": False,
            "statsCompletedBeforePageWasSent": False,
            "statsStartedAfterPageWasSent": True,
            "interactivePageOverlappedProfile": False,
        }
    )
    with pytest.raises(AssertionError, match="did not prove an active"):
        runtime_performance.assert_release_limits(report)
