from __future__ import annotations

import json

import pandas as pd
import polars as pl
import pytest

import openwrangler_runtime.notebook as notebook
from openwrangler_runtime.engines import EngineError, EngineRegistry
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine


@pytest.mark.parametrize(
    ("value", "backend"),
    [
        (pd.DataFrame({"value": [1, 2]}), "pandas"),
        (pl.DataFrame({"value": [1, 2]}), "polars"),
    ],
)
def test_show_emits_complete_mime_v2_snapshot(value, backend, monkeypatch):
    captured = []
    monkeypatch.setattr(notebook, "display", lambda payload, raw: captured.append((payload, raw)))
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Notebook output must stay native")),
            raising=False,
        )

    notebook.show(value, label="frame", variable_name="df")
    payload, raw = captured[0]
    snapshot = payload[notebook.MIME_TYPE_V2]

    assert raw is True
    assert snapshot["mimeVersion"] == 2
    assert snapshot["metadata"]["protocolVersion"] == 2
    assert snapshot["metadata"]["backend"] == backend
    assert snapshot["metadata"]["source"]["variableName"] == "df"
    assert snapshot["metadata"]["mode"] == "viewing"
    assert snapshot["metadata"]["steps"] == []
    assert "stats" not in snapshot["metadata"]
    assert snapshot["summaries"] == []
    assert snapshot["page"]["rows"][1]["values"][0]["display"] == "2"


def test_pandas_mixed_object_snapshot_preserves_cell_kinds_under_string_semantics():
    payload = notebook.build_payload(pd.DataFrame({"value": pd.Series([1, "1"], dtype="object")}), backend="pandas")

    assert payload["metadata"]["schema"][0]["type"] == "string"
    assert [row["values"][0]["kind"] for row in payload["page"]["rows"]] == ["integer", "string"]


def test_notebook_snapshot_validates_options():
    with pytest.raises(EngineError, match="variable_name"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), variable_name="not valid")
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), page_size=0)
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), page_size=10_001)


def test_notebook_snapshot_limits_variable_name_before_engine_work(monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_LABEL_CHARACTERS", 4)
    with pytest.raises(EngineError, match=r"variable_name.*at most 4 characters"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), label="data", variable_name="valid")


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_notebook_snapshot_enforces_dimension_and_byte_budgets(backend, monkeypatch):
    assert notebook.MAX_SAVED_ROWS == 10_000
    assert notebook.MAX_SAVED_COLUMNS == 2_048
    assert notebook.MAX_SAVED_CELLS == 100_000
    assert notebook.MAX_SAVED_PAYLOAD_BYTES == 16_777_216
    assert notebook.MAX_SAVED_LABEL_CHARACTERS == 256
    assert notebook.MAX_SAVED_COLUMN_CHARACTERS == 512
    assert notebook.MAX_SAVED_CELL_CHARACTERS == 65_536
    assert notebook.MAX_SAVED_PAYLOAD_NODES == 1_000_000
    assert notebook.MAX_SAVED_PAYLOAD_DEPTH == 64

    monkeypatch.setattr(notebook, "MAX_SAVED_ROWS", 2)
    notebook.build_payload(_frame(backend, 2, 1), backend=backend, page_size=2)
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(_frame(backend, 3, 1), backend=backend, page_size=3)

    monkeypatch.setattr(notebook, "MAX_SAVED_ROWS", 10_000)
    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMNS", 2)
    notebook.build_payload(_frame(backend, 1, 2), backend=backend)
    with pytest.raises(EngineError, match="at most 2 columns"):
        notebook.build_payload(_frame(backend, 1, 3), backend=backend)

    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMNS", 2_048)
    monkeypatch.setattr(notebook, "MAX_SAVED_CELLS", 4)
    notebook.build_payload(_frame(backend, 2, 2), backend=backend, page_size=2)
    bounded = notebook.build_payload(_frame(backend, 3, 2), backend=backend, page_size=3)
    assert len(bounded["page"]["rows"]) == 2
    assert bounded["page"]["totalRows"] == 3

    monkeypatch.setattr(notebook, "MAX_SAVED_CELLS", 100_000)
    payload = notebook.build_payload(_frame(backend, 1, 1), backend=backend)
    payload["metadata"]["source"]["label"] = ""
    base_size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_BYTES", base_size + 8)
    payload["metadata"]["source"]["label"] = "x" * 8
    notebook._validate_snapshot_payload_size(payload)
    payload["metadata"]["source"]["label"] += "x"
    with pytest.raises(EngineError, match="serialized bytes"):
        notebook._validate_snapshot_payload_size(payload)


def test_notebook_snapshot_counts_incremental_utf8_at_the_exact_boundary(monkeypatch):
    payload = {"value": "😀" * 20_000}
    serialized_size = len(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )

    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_BYTES", serialized_size)
    notebook._validate_snapshot_payload_size(payload)

    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_BYTES", serialized_size - 1)
    with pytest.raises(EngineError, match=rf"at most {serialized_size - 1:,} serialized bytes"):
        notebook._validate_snapshot_payload_size(payload)


def test_notebook_snapshot_aborts_repeated_maximum_cells_without_a_full_json_dump(monkeypatch):
    payload = notebook.build_payload(pd.DataFrame({"value": ["seed"]}), backend="pandas")
    maximum_text = "x" * notebook.MAX_SAVED_CELL_CHARACTERS
    row_count = notebook.MAX_SAVED_ROWS
    payload["metadata"]["shape"]["rows"] = row_count
    payload["metadata"]["filteredShape"]["rows"] = row_count
    payload["page"].update(
        {
            "limit": row_count,
            "totalRows": row_count,
            "rows": [
                {
                    "id": f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [
                        {
                            "kind": "string",
                            "raw": maximum_text,
                            "display": maximum_text,
                            "isNull": False,
                            "isNaN": False,
                        }
                    ],
                }
                for row_number in range(row_count)
            ],
        }
    )
    assert row_count * len(maximum_text) * 2 > 1_000_000_000

    def reject_full_dump(*_args, **_kwargs):
        raise AssertionError("Notebook payload validation must not materialize a complete JSON dump.")

    monkeypatch.setattr(notebook.json, "dumps", reject_full_dump)

    with pytest.raises(EngineError, match=r"at most 16,777,216 serialized bytes"):
        notebook._validate_snapshot_payload_size(payload)


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_notebook_snapshot_enforces_label_column_and_cell_text_budgets(backend, monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_LABEL_CHARACTERS", 4)
    with pytest.raises(EngineError, match=r"label.*at most 4 characters"):
        notebook.build_payload(_frame(backend, 1, 1), label="12345", backend=backend)

    monkeypatch.setattr(notebook, "MAX_SAVED_LABEL_CHARACTERS", 256)
    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMN_CHARACTERS", 8)
    with pytest.raises(EngineError, match=r"column 1 name.*at most 8 characters"):
        notebook.build_payload(_text_frame(backend, "123456789", "ok"), backend=backend)

    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMN_CHARACTERS", 512)
    monkeypatch.setattr(notebook, "MAX_SAVED_CELL_CHARACTERS", 4)
    with pytest.raises(EngineError, match=r"cell at row 1, column 1 display.*at most 4 characters"):
        notebook.build_payload(_text_frame(backend, "value", "12345"), backend=backend)


def test_notebook_snapshot_enforces_nested_string_and_key_budgets(monkeypatch):
    payload = notebook.build_payload(pd.DataFrame({"value": ["ok"]}), backend="pandas")
    cell = payload["page"]["rows"][0]["values"][0]
    cell["display"] = "ok"
    cell["raw"] = {"12345": ["12345"]}
    monkeypatch.setattr(notebook, "MAX_SAVED_CELL_CHARACTERS", 4)

    with pytest.raises(EngineError, match=r"nested key.*at most 4 characters"):
        notebook._validate_snapshot_fields(payload["metadata"], payload["page"])


def test_notebook_snapshot_enforces_payload_depth_at_the_exact_boundary(monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_DEPTH", 3)
    notebook._validate_snapshot_payload_size(_nested_lists(3))

    with pytest.raises(EngineError, match=r"at most 3 nested payload levels.*depth 4"):
        notebook._validate_snapshot_payload_size(_nested_lists(4))


def test_notebook_snapshot_enforces_payload_node_count_at_the_exact_boundary(monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_NODES", 4)
    notebook._validate_snapshot_payload_size([1, 2, 3])

    with pytest.raises(EngineError, match=r"at most 4 payload nodes.*at least 5"):
        notebook._validate_snapshot_payload_size([1, 2, 3, 4])


def test_notebook_snapshot_translates_engine_recursion_failures(monkeypatch):
    monkeypatch.setattr(
        PandasEngine,
        "page",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RecursionError("nested value overflow")),
    )

    with pytest.raises(EngineError, match=r"nested too deeply.*at most 64") as caught:
        notebook.build_payload(pd.DataFrame({"value": [1]}), backend="pandas")
    assert isinstance(caught.value.__cause__, RecursionError)


@pytest.mark.parametrize("depth", [65, 1_100])
def test_notebook_snapshot_rejects_real_excessively_nested_cells(depth):
    frame = pd.DataFrame({"value": [_nested_lists(depth)]})

    with pytest.raises(EngineError, match=r"nested (?:payload levels|too deeply)"):
        notebook.build_payload(frame, backend="pandas")


def test_notebook_snapshot_keeps_polars_lazyframe_native_and_collects_only_bounded_results(monkeypatch):
    lazy = pl.DataFrame({"value": list(range(20)), "unused": ["x"] * 20}).lazy()
    collected_heights = []
    original_collect = pl.LazyFrame.collect

    def guarded_collect(frame, *args, **kwargs):
        result = original_collect(frame, *args, **kwargs)
        assert isinstance(result, pl.DataFrame)
        collected_heights.append(result.height)
        return result

    monkeypatch.setattr(pl.LazyFrame, "collect", guarded_collect)
    monkeypatch.setattr(
        PolarsEngine,
        "normalize",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("A notebook LazyFrame must not use eager normalize")
        ),
    )

    payload = notebook.build_payload(lazy, backend="polars", page_size=3)

    assert payload["metadata"]["shape"] == {"rows": 20, "columns": 2}
    assert payload["metadata"]["filteredShape"] == {"rows": 20, "columns": 2}
    assert payload["page"]["totalRows"] == 20
    assert len(payload["page"]["rows"]) == 3
    assert [row["values"][0]["display"] for row in payload["page"]["rows"]] == ["0", "1", "2"]
    assert collected_heights == [1, 3]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_notebook_snapshot_does_not_eagerly_profile_full_data(backend, monkeypatch):
    engine_type = PandasEngine if backend == "pandas" else PolarsEngine
    monkeypatch.setattr(
        engine_type,
        "header_stats",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Notebook output must profile progressively")),
    )
    monkeypatch.setattr(
        engine_type,
        "summaries",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Notebook output must profile progressively")),
    )

    payload = notebook.build_payload(_frame(backend, 2, 1), backend=backend)

    assert "stats" not in payload["metadata"]
    assert payload["summaries"] == []


def test_notebook_snapshot_preserves_backend_detection_faults(monkeypatch):
    def broken_factory():
        raise RuntimeError("factory exploded")

    monkeypatch.setattr(notebook, "default_engine_registry", lambda: EngineRegistry((("broken", broken_factory),)))

    with pytest.raises(EngineError, match=r"broken.*factory exploded") as caught:
        notebook.build_payload(object())
    assert isinstance(caught.value.__cause__, RuntimeError)


def test_notebook_snapshot_translates_only_an_unsupported_value():
    with pytest.raises(EngineError, match="supports Pandas and Polars"):
        notebook.build_payload(object())


class FakeFormatter:
    def __init__(self):
        self.registered = {}

    def for_type(self, value_type, formatter):
        self.registered[value_type] = formatter


def test_formatter_registration_emits_v2_for_both_engines():
    formatter = FakeFormatter()
    shell = type(
        "FakeShell",
        (),
        {"display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})()},
    )()
    assert notebook.register_formatters(shell) is True

    pandas_bundle = formatter.registered[pd.DataFrame](pd.DataFrame({"value": [1]}))
    polars_bundle = formatter.registered[pl.DataFrame](pl.DataFrame({"value": [1]}))
    assert pandas_bundle[notebook.MIME_TYPE_V2]["mimeVersion"] == 2
    assert polars_bundle[notebook.MIME_TYPE_V2]["mimeVersion"] == 2


def test_formatter_reduces_wide_capture_rows_to_the_cell_budget():
    formatter = FakeFormatter()
    shell = type(
        "FakeShell",
        (),
        {"display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})()},
    )()
    assert notebook.register_formatters(shell) is True
    frame = pd.DataFrame({f"c{column}": range(200) for column in range(501)})

    payload = formatter.registered[pd.DataFrame](frame)[notebook.MIME_TYPE_V2]

    assert payload["page"]["limit"] == notebook.MAX_SAVED_CELLS // 501
    assert len(payload["page"]["rows"]) == notebook.MAX_SAVED_CELLS // 501
    assert payload["page"]["totalRows"] == 200


def _frame(backend: str, rows: int, columns: int):
    values = {f"c{column}": list(range(rows)) for column in range(columns)}
    return pd.DataFrame(values) if backend == "pandas" else pl.DataFrame(values)


def _text_frame(backend: str, column: str, value: str):
    values = {column: [value]}
    return pd.DataFrame(values) if backend == "pandas" else pl.DataFrame(values)


def _nested_lists(depth: int):
    value = "leaf"
    for _ in range(depth):
        value = [value]
    return value
