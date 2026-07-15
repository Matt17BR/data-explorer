from __future__ import annotations

import polars as pl
import pytest

from data_wrangler_runtime.engines import EngineError
from data_wrangler_runtime.session import SessionManager


def transform(step_id: str, kind: str, **params):
    return {"id": step_id, "kind": kind, "params": params}


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_draft_preview_apply_edit_and_undo_replays_the_immutable_source(tmp_path, backend, monkeypatch):
    source = "group,value\na,1\na,2\nb,3\n"
    path = tmp_path / "editing.csv"
    path.write_text(source, encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    assert opened["metadata"]["steps"] == []

    preview = manager.preview_step(
        session_id,
        0,
        transform("score", "formula", leftColumn="value", operator="multiply", value=2, newColumn="score"),
        0,
        10,
    )
    assert preview["revision"] == 1
    assert preview["metadata"]["draftStep"]["id"] == "score"
    assert preview["metadata"]["steps"] == []
    assert preview["diff"]["addedColumns"] == ["score"]
    assert preview["page"]["rows"][0]["values"][2]["display"] in {"2", "2.0"}
    assert "def clean_data(df):" in preview["code"]

    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["revision"] == 2
    assert applied["action"] == "apply"
    assert [item["id"] for item in applied["metadata"]["steps"]] == ["score"]
    assert "draftStep" not in applied["metadata"]

    edited_preview = manager.preview_step(
        session_id,
        2,
        transform("score-v2", "formula", leftColumn="value", operator="multiply", value=3, newColumn="score"),
        0,
        10,
        replace_step_id="score",
    )
    assert edited_preview["revision"] == 3
    assert edited_preview["diff"]["changedCells"] == 3
    assert edited_preview["page"]["rows"][2]["values"][2]["display"] in {"9", "9.0"}

    edited = manager.apply_draft(session_id, 3, 0, 10)
    assert [item["id"] for item in edited["metadata"]["steps"]] == ["score-v2"]
    assert edited["metadata"]["shape"] == {"rows": 3, "columns": 3}

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["revision"] == 5
    assert undone["metadata"]["steps"] == []
    assert undone["metadata"]["shape"] == {"rows": 3, "columns": 2}
    assert path.read_text(encoding="utf-8") == source


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_discard_restores_committed_plan_and_stale_revisions_are_rejected(tmp_path, backend):
    path = tmp_path / "discard.csv"
    path.write_text("name,value\na,1\nb,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    session_id = opened["metadata"]["sessionId"]

    preview = manager.preview_step(
        session_id,
        0,
        transform("drop", "dropColumns", columns=["name"]),
        0,
        10,
    )
    assert preview["metadata"]["shape"] == {"rows": 2, "columns": 1}
    with pytest.raises(EngineError, match="Stale"):
        manager.discard_draft(session_id, 0, 0, 10)

    discarded = manager.discard_draft(session_id, 1, 0, 10)
    assert discarded["action"] == "discard"
    assert discarded["revision"] == 2
    assert discarded["metadata"]["shape"] == {"rows": 2, "columns": 2}
    assert discarded["metadata"]["steps"] == []


def test_viewing_sessions_cannot_preview_transformations(tmp_path):
    path = tmp_path / "viewing.csv"
    path.write_text("value\n1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend="pandas", mode="viewing"
    )
    with pytest.raises(EngineError, match="viewing mode"):
        manager.preview_step(
            opened["metadata"]["sessionId"],
            0,
            transform("drop", "dropColumns", columns=["value"]),
            0,
            10,
        )


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_latest_structural_step_keeps_its_input_schema_for_editing(tmp_path, backend):
    path = tmp_path / "structural.csv"
    path.write_text("name,value\na,1\nb,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)}, backend=backend, page_size=10
    )
    session_id = opened["metadata"]["sessionId"]

    manager.preview_step(session_id, 0, transform("drop", "dropColumns", columns=["name"]), 0, 10)
    applied = manager.apply_draft(session_id, 1, 0, 10)

    assert [column["name"] for column in applied["metadata"]["schema"]] == ["value"]
    assert [column["name"] for column in applied["metadata"]["latestStepInputSchema"]] == ["name", "value"]

    edited = manager.preview_step(
        session_id,
        2,
        transform("drop-v2", "dropColumns", columns=["value"]),
        0,
        10,
        replace_step_id="drop",
    )
    assert [column["name"] for column in edited["metadata"]["schema"]] == ["name"]
