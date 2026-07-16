from __future__ import annotations

import pytest

from openwrangler_runtime.by_example import SynthesisError, evaluate_program, normalize_by_example, synthesize_program


def examples(column, pairs):
    return [{"inputs": {column: value}, "output": output} for value, output in pairs]


@pytest.mark.parametrize(
    ("source_columns", "samples", "expected_kind"),
    [
        (["value"], examples("value", [("ALPHA", "alpha"), ("BETA", "beta")]), "case"),
        (["value"], examples("value", [("AA123ZZ", "123"), ("BB456ZZ", "456")]), "slice"),
        (["value"], examples("value", [("north-east", "east"), ("south-west", "west")]), "split"),
        (["value"], examples("value", [("A12Z", "12"), ("BB345X", "345")]), "regexExtract"),
        (["value"], examples("value", [("ID#12", "12"), ("ID#XYZ", "XYZ")]), "regexReplace"),
        (
            ["value"],
            examples("value", [("2024-01-02", "02/01/2024"), ("2025-12-31", "31/12/2025")]),
            "datetimeFormat",
        ),
        (["value"], examples("value", [(1, 3), (2, 4)]), "arithmetic"),
    ],
)
def test_synthesis_supports_deterministic_candidate_families(source_columns, samples, expected_kind):
    program, _warnings, _count = synthesize_program(source_columns, samples)
    assert program["kind"] == expected_kind
    assert [evaluate_program(program, sample["inputs"], source_columns) for sample in samples] == [
        sample["output"] for sample in samples
    ]


def test_synthesis_supports_concatenation_literals_and_column_arithmetic():
    concatenated = [
        {"inputs": {"first": "Ada", "last": "Lovelace"}, "output": "Ada Lovelace"},
        {"inputs": {"first": "Grace", "last": "Hopper"}, "output": "Grace Hopper"},
    ]
    program, _, _ = synthesize_program(["first", "last"], concatenated)
    assert program["kind"] == "concat"

    arithmetic = [
        {"inputs": {"left": 2, "right": 3}, "output": 5},
        {"inputs": {"left": 10, "right": 4}, "output": 14},
    ]
    program, _, _ = synthesize_program(["left", "right"], arithmetic)
    assert program == {
        "kind": "arithmetic",
        "left": {"kind": "column", "column": "left"},
        "operator": "add",
        "right": {"kind": "column", "column": "right"},
    }


def test_ambiguity_is_reported_and_saved_programs_are_revalidated():
    samples = examples("value", [("a", "A"), ("b", "B")])
    normalized = normalize_by_example({"sourceColumns": ["value"], "newColumn": "clean", "examples": samples})
    assert normalized["candidateCount"] >= 2
    assert normalized["warnings"] and normalized["warnings"][0].startswith("Ambiguous examples")

    normalized["program"] = {"kind": "literal", "value": "wrong"}
    with pytest.raises(SynthesisError, match="no longer satisfies"):
        normalize_by_example(normalized)


def test_synthesis_rejects_inconsistent_examples():
    with pytest.raises(SynthesisError, match="No deterministic"):
        synthesize_program(["value"], examples("value", [("same", "one"), ("same", "two")]))
