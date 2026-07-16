from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import pandas as pd
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.session import SessionManager


def ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "kind": kind, "params": params}


def open_session(tmp_path: Path, backend: str = "pandas") -> tuple[SessionManager, str, list[dict[str, Any]]]:
    path = tmp_path / f"bound-{backend}.csv"
    path.write_text("name,value\na,1\nb,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    return manager, opened["metadata"]["sessionId"], opened["metadata"]["schema"]


def contains_private_position(value: Any) -> bool:
    if isinstance(value, dict):
        return "position" in value or any(contains_private_position(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_private_position(item) for item in value)
    return False


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_bound_plan_survives_apply_replay_inspection_edit_and_undo(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    value = ref(schema[1]["id"], schema[1]["name"])

    rename = step("rename", "renameColumn", column=value, newName="amount")
    preview = manager.preview_step(session_id, 0, rename, 0, 10)
    runtime = manager.sessions[session_id]
    assert runtime.draft_bound_step is not None
    assert runtime.draft_bound_step["params"]["column"] == {**value, "position": 1}
    assert not contains_private_position(preview["metadata"]["draftStep"])

    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert runtime.plan == [rename]
    assert runtime.bound_plan[0]["params"]["column"] == {**value, "position": 1}
    assert not contains_private_position(applied["metadata"]["steps"])

    amount = ref(value["id"], "amount")
    formula = step(
        "double",
        "formula",
        leftColumn=amount,
        operator="multiply",
        value=2,
        newColumn="double",
    )
    manager.preview_step(session_id, 2, formula, 0, 10)
    manager.apply_draft(session_id, 3, 0, 10)

    inspected = manager.inspect_step(session_id, 4, "rename", 0, 10)
    assert [column["name"] for column in inspected["outputSchema"]] == ["name", "amount"]
    assert "def clean_data" in inspected["code"]

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["revision"] == 5
    assert [column["name"] for column in undone["metadata"]["schema"]] == ["name", "amount"]
    assert len(runtime.bound_plan) == len(runtime.plan) == 1

    edited = manager.preview_step(
        session_id,
        5,
        step("rename", "renameColumn", column=value, newName="measure"),
        0,
        10,
        replace_step_id="rename",
    )
    assert [column["name"] for column in edited["metadata"]["schema"]] == ["name", "measure"]


def test_edit_rejects_a_replacement_step_with_a_different_identity(tmp_path: Path) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])
    manager.preview_step(session_id, 0, step("clone", "cloneColumn", column=value, newName="copy"), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)

    with pytest.raises(EngineError, match="must retain the applied step ID"):
        manager.preview_step(
            session_id,
            2,
            step("replacement", "cloneColumn", column=value, newName="copy"),
            0,
            10,
            replace_step_id="clone",
        )


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_edited_output_identity_remains_replayable_by_later_steps(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    name = ref(schema[0]["id"], schema[0]["name"])
    manager.preview_step(session_id, 0, step("clone", "cloneColumn", column=name, newName="copy"), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)

    manager.preview_step(
        session_id,
        2,
        step("clone", "cloneColumn", column=name, newName="renamed_copy"),
        0,
        10,
        replace_step_id="clone",
    )
    edited = manager.apply_draft(session_id, 3, 0, 10)
    created = next(column for column in edited["metadata"]["schema"] if column["name"] == "renamed_copy")

    manager.preview_step(
        session_id,
        4,
        step("length", "textLength", column=ref(created["id"], created["name"]), newColumn="copy_length"),
        0,
        10,
    )
    manager.apply_draft(session_id, 5, 0, 10)
    undone = manager.undo_step(session_id, 6, 0, 10)

    assert [column["name"] for column in undone["metadata"]["schema"]] == ["name", "value", "renamed_copy"]
    assert [item["id"] for item in undone["metadata"]["steps"]] == ["clone"]


def test_stale_reference_is_rejected_before_adapter_dispatch(tmp_path: Path, monkeypatch) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])

    manager.preview_step(session_id, 0, step("drop", "dropColumns", columns=[value]), 0, 10)
    manager.apply_draft(session_id, 1, 0, 10)
    runtime = manager.sessions[session_id]

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("stale references must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="Unknown or stale column identity"):
        manager.preview_step(
            session_id,
            2,
            step("cast-stale", "castColumn", column=value, dtype="float"),
            0,
            10,
        )


def test_output_collision_is_rejected_before_adapter_dispatch(tmp_path: Path, monkeypatch) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])
    runtime = manager.sessions[session_id]

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("output collisions must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="collides with an existing column"):
        manager.preview_step(
            session_id,
            0,
            step("clone", "cloneColumn", column=value, newName="name"),
            0,
            10,
        )


def test_preview_failure_restores_private_bound_state(tmp_path: Path, monkeypatch) -> None:
    manager, session_id, schema = open_session(tmp_path)
    value = ref(schema[1]["id"], schema[1]["name"])
    runtime = manager.sessions[session_id]
    before = {
        "plan": deepcopy(runtime.plan),
        "boundPlan": deepcopy(runtime.bound_plan),
        "draft": deepcopy(runtime.draft_step),
        "boundDraft": deepcopy(runtime.draft_bound_step),
        "revision": runtime.revision,
    }

    def fail_compile(_steps: Any) -> str:
        raise EngineError("compile failed after draft publication")

    monkeypatch.setattr(runtime.engine, "compile_plan", fail_compile)
    with pytest.raises(EngineError, match="compile failed"):
        manager.preview_step(
            session_id,
            0,
            step("cast", "castColumn", column=value, dtype="float"),
            0,
            10,
        )

    assert {
        "plan": runtime.plan,
        "boundPlan": runtime.bound_plan,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "revision": runtime.revision,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("attack", ["overwrite", "aggregate"])
@pytest.mark.parametrize("case_variant", ["exact", "upper"])
def test_private_row_identity_cannot_be_named_by_legacy_operations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
    attack: str,
    case_variant: str,
) -> None:
    manager, session_id, _ = open_session(tmp_path, backend)
    runtime = manager.sessions[session_id]
    hidden = f"{INTERNAL_ROW_ID_PREFIX}{session_id}:source"
    if case_variant == "upper":
        hidden = hidden.upper()
    malicious = (
        step("attack", "roundNumber", column=ref("c:source:1", "value"), newColumn=hidden)
        if attack == "overwrite"
        else step(
            "attack",
            "groupBy",
            keys=["name"],
            aggregations=[{"column": hidden, "operation": "first", "alias": "leaked"}],
        )
    )
    before = {
        "revision": runtime.revision,
        "cache": deepcopy(runtime.page_cache),
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": deepcopy(runtime.committed_lineage),
    }

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("private namespace attacks must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="reserved private row-identity prefix"):
        manager.preview_step(session_id, 0, malicious, 0, 10)

    assert {
        "revision": runtime.revision,
        "cache": runtime.page_cache,
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": runtime.committed_lineage,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_drop_columns_must_retain_one_visible_column(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    runtime = manager.sessions[session_id]
    references = [ref(column["id"], column["name"]) for column in schema]
    before_cache = deepcopy(runtime.page_cache)

    with pytest.raises(EngineError, match="must leave at least one visible column"):
        manager.preview_step(session_id, 0, step("drop-all", "dropColumns", columns=references), 0, 10)

    assert runtime.revision == 0
    assert runtime.draft_step is None
    assert runtime.page_cache == before_cache


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("kind", ["oneHotEncode", "multiLabelBinarize"])
def test_every_transform_must_retain_one_visible_column(tmp_path: Path, backend: str, kind: str) -> None:
    path = tmp_path / f"zero-output-{backend}.csv"
    path.write_text("only\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    runtime = manager.sessions[session_id]
    operation = (
        step("empty-output", kind, columns=[ref("c:source:0", "only")], dropOriginal=True)
        if kind == "oneHotEncode"
        else step(
            "empty-output",
            kind,
            column=ref("c:source:0", "only"),
            delimiter="|",
            dropOriginal=True,
        )
    )
    before_cache = deepcopy(runtime.page_cache)

    with pytest.raises(EngineError, match="must leave at least one visible column"):
        manager.preview_step(session_id, 0, operation, 0, 10)

    assert runtime.revision == 0
    assert runtime.draft_step is None
    assert runtime.page_cache == before_cache


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_custom_code_must_retain_one_visible_column(tmp_path: Path, backend: str) -> None:
    manager, session_id, _ = open_session(tmp_path, backend)
    runtime = manager.sessions[session_id]
    code = "result = df.iloc[:, 0:0]" if backend == "pandas" else "result = df.select([])"
    before = {
        "revision": runtime.revision,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "cache": deepcopy(runtime.page_cache),
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": deepcopy(runtime.committed_lineage),
        "shape": deepcopy(runtime.committed_shape),
        "schema": deepcopy(runtime.committed_schema),
    }
    committed = runtime.committed

    with pytest.raises(EngineError, match="must leave at least one visible column"):
        manager.preview_step(session_id, 0, step("empty-custom", "customCode", code=code), 0, 10)

    assert runtime.committed is committed
    assert {
        "revision": runtime.revision,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "cache": runtime.page_cache,
        "cacheBytes": runtime.page_cache_bytes,
        "lineage": runtime.committed_lineage,
        "shape": runtime.committed_shape,
        "schema": runtime.committed_schema,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_existing_draft_cannot_be_replaced_by_another_preview(
    tmp_path: Path, backend: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    name = ref(schema[0]["id"], schema[0]["name"])
    manager.preview_step(session_id, 0, step("first", "cloneColumn", column=name, newName="copy"), 0, 10)
    runtime = manager.sessions[session_id]
    before = {
        "revision": runtime.revision,
        "draft": deepcopy(runtime.draft_step),
        "boundDraft": deepcopy(runtime.draft_bound_step),
        "cache": deepcopy(runtime.page_cache),
    }

    def unexpected_dispatch(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a second preview must fail before adapter dispatch")

    monkeypatch.setattr(runtime.engine, "apply_transform", unexpected_dispatch)
    with pytest.raises(EngineError, match="Apply or discard the current draft"):
        manager.preview_step(session_id, 1, step("second", "cloneColumn", column=name, newName="other"), 0, 10)

    assert {
        "revision": runtime.revision,
        "draft": runtime.draft_step,
        "boundDraft": runtime.draft_bound_step,
        "cache": runtime.page_cache,
    } == before


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_dynamic_latest_step_edit_keeps_output_identities_replay_stable(tmp_path: Path, backend: str) -> None:
    path = tmp_path / f"dynamic-edit-{backend}.csv"
    path.write_text("left,right\nx,u\ny,v\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    manager.preview_step(
        session_id,
        0,
        step("hot", "oneHotEncode", columns=[ref("c:source:1", "right")], dropOriginal=False),
        0,
        10,
    )
    manager.apply_draft(session_id, 1, 0, 10)

    preview = manager.preview_step(
        session_id,
        2,
        step(
            "hot",
            "oneHotEncode",
            columns=[ref("c:source:0", "left"), ref("c:source:1", "right")],
            dropOriginal=False,
        ),
        0,
        10,
        replace_step_id="hot",
    )
    schema = preview["metadata"]["schema"]
    identities = [column["id"] for column in schema]
    assert len(identities) == len(set(identities))
    value_output = next(column for column in schema if column["name"] == "right_u")

    manager.apply_draft(session_id, 3, 0, 10)
    manager.preview_step(
        session_id,
        4,
        step(
            "select-output",
            "selectColumns",
            columns=[ref(value_output["id"], value_output["name"])],
        ),
        0,
        10,
    )
    manager.apply_draft(session_id, 5, 0, 10)
    undone = manager.undo_step(session_id, 6, 0, 10)

    assert [(column["id"], column["name"]) for column in undone["metadata"]["schema"]] == [
        (column["id"], column["name"]) for column in schema
    ]
    assert [item["id"] for item in undone["metadata"]["steps"]] == ["hot"]


def test_duplicate_encoder_edit_replay_and_undo_preserve_the_exact_surviving_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import __main__

    source = pd.DataFrame(
        [["left-a", "right-u", 1.2], ["left-b", "right-v", 2.8]],
        columns=cast(Any, ["duplicate", "duplicate", 7]),
    )
    monkeypatch.setattr(__main__, "stable_value_duplicate_frame", source, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "stable_value_duplicate_frame",
            "variableName": "stable_value_duplicate_frame",
        },
        backend="pandas",
        mode="editing",
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    first = ref("c:source:0", "duplicate")
    second = ref("c:source:1", "duplicate")

    manager.preview_step(
        session_id,
        0,
        step("hot", "oneHotEncode", columns=[first], dropOriginal=True),
        0,
        10,
    )
    initial = manager.apply_draft(session_id, 1, 0, 10)
    assert [(column["id"], column["name"]) for column in initial["metadata"]["schema"][:2]] == [
        ("c:source:1", "duplicate"),
        ("c:source:2", "7"),
    ]

    manager.preview_step(
        session_id,
        2,
        step("hot", "oneHotEncode", columns=[second], dropOriginal=True),
        0,
        10,
        replace_step_id="hot",
    )
    edited = manager.apply_draft(session_id, 3, 0, 10)
    edited_schema = [(column["id"], column["name"]) for column in edited["metadata"]["schema"]]
    assert edited_schema[:2] == [("c:source:0", "duplicate"), ("c:source:2", "7")]
    assert any(name == "duplicate_right-u" for _, name in edited_schema)

    inspection = manager.inspect_step(session_id, 4, "hot", 0, 10)
    assert [(column["id"], column["name"]) for column in inspection["outputSchema"]] == edited_schema

    manager.preview_step(
        session_id,
        4,
        step("upper", "upperText", column=first, newColumn="upper_duplicate"),
        0,
        10,
    )
    manager.apply_draft(session_id, 5, 0, 10)
    undone = manager.undo_step(session_id, 6, 0, 10)

    assert [(column["id"], column["name"]) for column in undone["metadata"]["schema"]] == edited_schema
    pd.testing.assert_frame_equal(
        source,
        pd.DataFrame(
            [["left-a", "right-u", 1.2], ["left-b", "right-v", 2.8]],
            columns=cast(Any, ["duplicate", "duplicate", 7]),
        ),
    )
    manager.close_session(session_id, 7)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_cross_kind_latest_step_edit_does_not_reuse_a_live_source_identity(tmp_path: Path, backend: str) -> None:
    manager, session_id, schema = open_session(tmp_path, backend)
    name = ref(schema[0]["id"], schema[0]["name"])
    value = ref(schema[1]["id"], schema[1]["name"])
    manager.preview_step(
        session_id,
        0,
        step("edit", "renameColumn", column=value, newName="X"),
        0,
        10,
    )
    manager.apply_draft(session_id, 1, 0, 10)

    preview = manager.preview_step(
        session_id,
        2,
        step("edit", "cloneColumn", column=name, newName="X"),
        0,
        10,
        replace_step_id="edit",
    )
    identities = [column["id"] for column in preview["metadata"]["schema"]]

    assert len(identities) == len(set(identities))
    assert next(column for column in preview["metadata"]["schema"] if column["name"] == "X")["id"] not in {
        name["id"],
        value["id"],
    }


@pytest.mark.parametrize("kind", ["renameColumn", "cloneColumn", "formula", "textLength"])
def test_duckdb_rejects_case_folded_output_collisions_atomically(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "duckdb-case.csv"
    path.write_text("A,b\n1,2\n3,4\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="duckdb",
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    schema = opened["metadata"]["schema"]
    source = ref(schema[1]["id"], schema[1]["name"])
    params: dict[str, Any]
    if kind in {"renameColumn", "cloneColumn"}:
        params = {"column": source, "newName": "a"}
    elif kind == "formula":
        params = {"leftColumn": source, "operator": "add", "value": 0, "newColumn": "a"}
    else:
        params = {"column": source, "newColumn": "a"}
    runtime = manager.sessions[session_id]
    before_cache = deepcopy(runtime.page_cache)

    with pytest.raises(EngineError, match="differ only by case"):
        manager.preview_step(session_id, 0, step("casefold", kind, **params), 0, 10)

    assert runtime.revision == 0
    assert runtime.draft_step is None
    assert runtime.page_cache == before_cache
