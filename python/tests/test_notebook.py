from __future__ import annotations

import pandas as pd
import polars as pl
import pytest

import data_wrangler_runtime.notebook as notebook
from data_wrangler_runtime.engines import EngineError


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
    assert snapshot["page"]["rows"][1]["values"][0]["display"] == "2"


def test_legacy_mime_v1_output_remains_available(monkeypatch):
    captured = []
    monkeypatch.setattr(notebook, "display", lambda payload, raw: captured.append(payload))
    notebook.show(pd.DataFrame({"value": [1]}), mime_version=1)

    snapshot = captured[0][notebook.MIME_TYPE_V1]
    assert "mimeVersion" not in snapshot
    assert "protocolVersion" not in snapshot["metadata"]
    assert snapshot["metadata"]["shape"] == {"rows": 1, "columns": 1}


def test_notebook_snapshot_validates_options():
    with pytest.raises(EngineError, match="variable_name"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), variable_name="not valid")
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), page_size=0)


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
