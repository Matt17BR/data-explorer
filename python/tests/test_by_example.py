from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

import openwrangler_runtime.by_example as by_example_module
from openwrangler_runtime.by_example import (
    MAX_BY_EXAMPLE_STRING_UTF8_BYTES,
    MAX_BY_EXAMPLE_TEXT_UTF8_BYTES,
    MAX_CONCAT_PARTS,
    MAX_EXAMPLES,
    MAX_PROGRAM_NODES,
    MAX_SOURCE_COLUMNS,
    MAX_WARNINGS,
    SynthesisError,
    evaluate_program,
    normalize_by_example,
    synthesize_program,
)


def column_reference(index: int, name: str = "value") -> dict[str, str]:
    return {"id": f"c:source:{index}", "name": name}


VALUE = column_reference(0)


def examples(pairs: list[tuple[object, object]]) -> list[dict[str, Any]]:
    return [{"inputs": [value], "output": output} for value, output in pairs]


def column_program(reference: dict[str, str] = VALUE) -> dict[str, Any]:
    return {"kind": "column", "column": dict(reference)}


@pytest.mark.parametrize(
    ("samples", "expected_kind", "expected_property"),
    [
        (examples([("one", "constant"), ("two", "constant")]), "literal", ("value", "constant")),
        (examples([("one", "one"), ("two", "two")]), "column", None),
        (examples([("ALPHA", "alpha"), ("BETA", "beta")]), "case", ("style", "lower")),
        (examples([("alpha", "ALPHA"), ("beta", "BETA")]), "case", ("style", "upper")),
        (examples([("aLPHA", "Alpha"), ("bETA", "Beta")]), "case", ("style", "capitalize")),
        (examples([("AA123ZZ", "123"), ("BB456ZZ", "456")]), "slice", ("start", 2)),
        (examples([("north-east", "east"), ("south-west", "west")]), "split", ("index", 1)),
        (examples([("A12Z", "12"), ("BB345X", "345")]), "regexExtract", ("group", 1)),
        (examples([("ID#12", "12"), ("ID#XYZ", "XYZ")]), "regexReplace", ("replacement", "")),
        (
            examples([("2024-01-02", "02/01/2024"), ("2025-12-31", "31/12/2025")]),
            "datetimeFormat",
            ("outputFormat", "%d/%m/%Y"),
        ),
        (examples([(1, 3), (2, 4)]), "arithmetic", ("operator", "add")),
    ],
)
def test_synthesis_supports_every_single_column_candidate_family(
    samples: list[dict[str, Any]],
    expected_kind: str,
    expected_property: tuple[str, object] | None,
) -> None:
    program, _warnings, _count = synthesize_program([VALUE], samples)

    assert program["kind"] == expected_kind
    if expected_property is not None:
        key, value = expected_property
        assert program[key] == value
    assert [evaluate_program(program, sample["inputs"], [VALUE]) for sample in samples] == [
        sample["output"] for sample in samples
    ]


def test_synthesis_supports_concatenation_and_column_arithmetic_with_stable_references() -> None:
    first = column_reference(0, "first")
    last = column_reference(1, "last")
    concatenated = [
        {"inputs": ["Ada", "Lovelace"], "output": "Ada Lovelace"},
        {"inputs": ["Grace", "Hopper"], "output": "Grace Hopper"},
    ]
    program, _, _ = synthesize_program([first, last], concatenated)
    assert program == {
        "kind": "concat",
        "parts": [
            column_program(first),
            {"kind": "literal", "value": " "},
            column_program(last),
        ],
    }

    left = column_reference(0, "left")
    right = column_reference(1, "right")
    arithmetic = [
        {"inputs": [2, 3], "output": 5},
        {"inputs": [10, 4], "output": 14},
    ]
    program, _, _ = synthesize_program([left, right], arithmetic)
    assert program == {
        "kind": "arithmetic",
        "left": column_program(left),
        "operator": "add",
        "right": column_program(right),
    }


def test_aligned_inputs_disambiguate_duplicate_display_names_by_identity() -> None:
    ignored = column_reference(0, "duplicate")
    selected = column_reference(1, "duplicate")
    samples = [
        {"inputs": ["unchanged-a", "alpha"], "output": "ALPHA"},
        {"inputs": ["unchanged-b", "beta"], "output": "BETA"},
    ]

    program, _, _ = synthesize_program([ignored, selected], samples)

    assert program == {"kind": "case", "style": "upper", "input": column_program(selected)}


@pytest.mark.parametrize(
    "params",
    [
        {
            "sourceColumns": ["value"],
            "newColumn": "clean",
            "examples": examples([("a", "A"), ("b", "B")]),
        },
        {
            "sourceColumns": [VALUE],
            "newColumn": "clean",
            "examples": [
                {"inputs": {"value": "a"}, "output": "A"},
                {"inputs": {"value": "b"}, "output": "B"},
            ],
        },
        {
            "sourceColumns": [VALUE],
            "newColumn": "clean",
            "examples": examples([("a", "A"), ("b", "B")]),
            "program": {"kind": "column", "column": "value"},
        },
    ],
)
def test_legacy_name_keyed_by_example_shapes_are_rejected(params: dict[str, Any]) -> None:
    with pytest.raises(SynthesisError):
        normalize_by_example(params)


@pytest.mark.parametrize(
    "reference",
    [
        {"id": "c:source:0", "name": "value", "position": 0},
        {"id": "", "name": "value"},
        {"id": "c:source:0", "name": 1},
    ],
)
def test_column_references_are_exact_and_well_formed(reference: dict[str, Any]) -> None:
    with pytest.raises(SynthesisError, match="column reference|non-empty id"):
        synthesize_program([reference], examples([("a", "A"), ("b", "B")]))


def test_saved_program_rejects_stale_column_references() -> None:
    normalized = normalize_by_example(
        {
            "sourceColumns": [VALUE],
            "newColumn": "clean",
            "examples": examples([("a", "A"), ("b", "B")]),
        }
    )
    normalized["program"] = {
        "kind": "case",
        "style": "capitalize",
        "input": column_program({"id": VALUE["id"], "name": "renamed"}),
    }

    with pytest.raises(SynthesisError, match="unavailable or stale"):
        normalize_by_example(normalized)


@pytest.mark.parametrize(
    "samples",
    [
        examples([(True, 1), (False, 0)]),
        examples([("1", 1), ("2", 2)]),
    ],
)
def test_synthesis_does_not_coerce_booleans_or_strings_into_numeric_equality(
    samples: list[dict[str, Any]],
) -> None:
    with pytest.raises(SynthesisError, match="No deterministic"):
        synthesize_program([VALUE], samples)


def test_numeric_equality_accepts_finite_int_float_equivalence_without_changing_values() -> None:
    samples = examples([(1, 1.0), (2, 2.0)])

    program, _, _ = synthesize_program([VALUE], samples)
    results = [evaluate_program(program, sample["inputs"], [VALUE]) for sample in samples]

    assert program == column_program()
    assert results == [1.0, 2.0]
    assert all(type(result) is int for result in results)


def test_large_numeric_examples_do_not_match_merely_by_relative_tolerance() -> None:
    samples = examples([(1_000_000_000, 1_000_000_001), (2_000_000_000, 2_000_000_001)])

    program, _, _ = synthesize_program([VALUE], samples)

    assert program == {
        "kind": "arithmetic",
        "left": column_program(),
        "operator": "add",
        "right": {"kind": "literal", "value": 1.0},
    }
    assert [evaluate_program(program, sample["inputs"], [VALUE]) for sample in samples] == [
        sample["output"] for sample in samples
    ]


def test_integer_neighbours_above_float_precision_synthesize_exactly() -> None:
    large = 2**53
    samples = examples([(large, large + 1), (large + 2, large + 3)])

    program, _, _ = synthesize_program([VALUE], samples)

    assert program == {
        "kind": "arithmetic",
        "left": column_program(),
        "operator": "add",
        "right": {"kind": "literal", "value": 1},
    }
    assert [evaluate_program(program, sample["inputs"], [VALUE]) for sample in samples] == [
        large + 1,
        large + 3,
    ]


def test_large_integer_column_arithmetic_stays_exact_without_float_coercion() -> None:
    left = column_reference(0, "left")
    right = column_reference(1, "right")
    large = 2**53
    samples = [
        {"inputs": [large, 1], "output": large + 1},
        {"inputs": [large + 2, 1], "output": large + 3},
    ]

    program, _, _ = synthesize_program([left, right], samples)

    assert program == {
        "kind": "arithmetic",
        "left": column_program(left),
        "operator": "add",
        "right": column_program(right),
    }
    assert [evaluate_program(program, sample["inputs"], [left, right]) for sample in samples] == [
        large + 1,
        large + 3,
    ]


def test_integer_constant_offsets_remain_integer_for_unseen_large_values() -> None:
    samples = examples([(1, 3), (2, 4)])

    program, _, _ = synthesize_program([VALUE], samples)

    assert program["right"] == {"kind": "literal", "value": 2}
    assert evaluate_program(program, [2**53 + 1], [VALUE]) == 2**53 + 3


def test_huge_integer_identity_examples_do_not_overflow_numeric_candidate_checks() -> None:
    huge = 10**4_000
    samples = examples([(huge, huge), (huge + 1, huge + 1)])

    program, _, _ = synthesize_program([VALUE], samples)

    assert program == column_program()


def test_null_is_propagated_in_synthesized_string_programs_instead_of_stringified() -> None:
    samples = examples([(None, None), ("alpha", "ALPHA")])

    program, _, _ = synthesize_program([VALUE], samples)

    assert program == {"kind": "case", "style": "upper", "input": column_program()}
    assert [evaluate_program(program, sample["inputs"], [VALUE]) for sample in samples] == [None, "ALPHA"]

    with pytest.raises(SynthesisError, match="No deterministic"):
        synthesize_program([VALUE], examples([(None, "NONE"), ("alpha", "ALPHA")]))


@pytest.mark.parametrize(
    "program",
    [
        {"kind": "slice", "input": column_program(), "start": 0, "stop": 1},
        {"kind": "split", "input": column_program(), "delimiter": "-", "index": 0},
        {"kind": "concat", "parts": [column_program(), {"kind": "literal", "value": "suffix"}]},
        {"kind": "regexExtract", "input": column_program(), "pattern": r"(\d+)", "group": 1},
        {"kind": "regexReplace", "input": column_program(), "pattern": "x", "replacement": "y"},
        {"kind": "case", "style": "upper", "input": column_program()},
        {
            "kind": "datetimeFormat",
            "input": column_program(),
            "inputFormat": "%Y-%m-%d",
            "outputFormat": "%d/%m/%Y",
        },
    ],
)
def test_nullable_string_candidate_nodes_propagate_null(program: dict[str, Any]) -> None:
    assert evaluate_program(program, [None], [VALUE]) is None


@pytest.mark.parametrize("non_finite", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("location", ["input", "output"])
def test_non_finite_example_scalars_are_rejected(non_finite: float, location: str) -> None:
    samples = examples([("a", "A"), ("b", "B")])
    if location == "input":
        samples[0]["inputs"] = [non_finite]
    else:
        samples[0]["output"] = non_finite

    with pytest.raises(SynthesisError, match="JSON scalar"):
        synthesize_program([VALUE], samples)


@pytest.mark.parametrize("non_finite", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_literal_programs_are_rejected(non_finite: float) -> None:
    with pytest.raises(SynthesisError, match="JSON scalar"):
        evaluate_program({"kind": "literal", "value": non_finite}, [], [])


def test_saved_program_must_be_the_current_deterministic_selection() -> None:
    params = {
        "sourceColumns": [VALUE],
        "newColumn": "clean",
        "examples": examples([("a", "A"), ("b", "B")]),
    }
    normalized = normalize_by_example(params)
    assert normalized["program"] == {"kind": "case", "style": "capitalize", "input": column_program()}
    assert normalized["candidateCount"] == 2
    assert normalized["warnings"] == [
        "Ambiguous examples: 2 equally simple programs match. Preview the selected result carefully."
    ]

    tampered = deepcopy(normalized)
    tampered["program"] = {"kind": "case", "style": "upper", "input": column_program()}
    assert [evaluate_program(tampered["program"], sample["inputs"], [VALUE]) for sample in params["examples"]] == [
        sample["output"] for sample in params["examples"]
    ]
    with pytest.raises(SynthesisError, match="deterministic program selected"):
        normalize_by_example(tampered)


def test_saved_program_metadata_is_recomputed_not_trusted() -> None:
    params = {
        "sourceColumns": [VALUE],
        "newColumn": "clean",
        "examples": examples([("a", "A"), ("b", "B")]),
    }
    canonical = normalize_by_example(params)
    supplied = deepcopy(canonical)
    supplied["warnings"] = ["caller-controlled warning"]
    supplied["candidateCount"] = 999

    assert normalize_by_example(supplied) == canonical


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("warnings", "warning", "array of strings"),
        ("warnings", [1], "array of strings"),
        ("candidateCount", True, "positive integer"),
        ("candidateCount", 0, "positive integer"),
        ("candidateCount", 1.5, "positive integer"),
    ],
)
def test_saved_program_metadata_types_are_validated(field: str, value: object, message: str) -> None:
    params = {
        "sourceColumns": [VALUE],
        "newColumn": "clean",
        "examples": examples([("a", "A"), ("b", "B")]),
        field: value,
    }

    with pytest.raises(SynthesisError, match=message):
        normalize_by_example(params)


@pytest.mark.parametrize(
    ("program", "message"),
    [
        ({"kind": "slice", "input": column_program(), "start": -1}, "non-negative"),
        ({"kind": "slice", "input": column_program(), "start": 2, "stop": 1}, "no smaller than start"),
        ({"kind": "split", "input": column_program(), "delimiter": "-", "index": -1}, "non-negative"),
    ],
)
def test_slice_and_split_indices_must_be_non_negative(program: dict[str, Any], message: str) -> None:
    with pytest.raises(SynthesisError, match=message):
        evaluate_program(program, ["a-b"], [VALUE])


def test_zero_slice_and_split_boundaries_are_valid() -> None:
    assert evaluate_program({"kind": "slice", "input": column_program(), "start": 0, "stop": 0}, ["a-b"], [VALUE]) == ""
    assert (
        evaluate_program({"kind": "split", "input": column_program(), "delimiter": "-", "index": 0}, ["a-b"], [VALUE])
        == "a"
    )


def test_by_example_resource_limits_are_pinned() -> None:
    assert (MAX_SOURCE_COLUMNS, MAX_EXAMPLES, MAX_PROGRAM_NODES, MAX_CONCAT_PARTS, MAX_WARNINGS) == (
        16,
        64,
        256,
        64,
        64,
    )
    assert (MAX_BY_EXAMPLE_STRING_UTF8_BYTES, MAX_BY_EXAMPLE_TEXT_UTF8_BYTES) == (8 * 1024, 64 * 1024)


@pytest.mark.parametrize("oversized_field", ["sources", "warnings", "concat", "nodes"])
def test_normalization_rejects_oversized_structures_before_text_walk_or_synthesis(
    monkeypatch: pytest.MonkeyPatch, oversized_field: str
) -> None:
    params: dict[str, Any] = {
        "sourceColumns": [dict(VALUE)],
        "newColumn": "clean",
        "examples": examples([("a", "A"), ("b", "B")]),
    }
    huge_length = 100_000
    leaf = {"kind": "column", "column": dict(VALUE)}
    if oversized_field == "sources":
        params["sourceColumns"] = [dict(VALUE)] * huge_length
        message = "sourceColumns"
    elif oversized_field == "warnings":
        params["warnings"] = [""] * huge_length
        message = "at most 64"
    elif oversized_field == "concat":
        params["program"] = {"kind": "concat", "parts": [leaf] * huge_length}
        message = "between 1 and 64"
    else:
        params["program"] = {
            "kind": "concat",
            "parts": [
                {"kind": "concat", "parts": [{"kind": "column", "column": dict(VALUE)} for _ in range(4)]}
                for _ in range(64)
            ],
        }
        message = "at most 256 nodes"

    def unexpected_work(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("container bounds must fail before the complete text walk or synthesis")

    monkeypatch.setattr(by_example_module, "_validate_text_budget", unexpected_work)
    monkeypatch.setattr(by_example_module, "synthesize_program", unexpected_work)
    with pytest.raises(SynthesisError, match=message):
        normalize_by_example(params)


def test_normalization_caps_saved_warning_count() -> None:
    params = {
        "sourceColumns": [dict(VALUE)],
        "newColumn": "clean",
        "examples": examples([("a", "A"), ("b", "B")]),
        "warnings": [""] * MAX_WARNINGS,
    }
    assert normalize_by_example(params)["candidateCount"] >= 1

    params["warnings"] = [""] * (MAX_WARNINGS + 1)
    with pytest.raises(SynthesisError, match="at most 64"):
        normalize_by_example(params)


@pytest.mark.parametrize(
    ("unit", "accepted_count"),
    [("x", 8_192), ("é", 4_096), ("😀", 2_048)],
)
def test_text_values_are_bounded_by_strict_utf8_bytes(unit: str, accepted_count: int) -> None:
    accepted = unit * accepted_count
    assert evaluate_program({"kind": "literal", "value": accepted}, [], []) == accepted

    with pytest.raises(SynthesisError, match="8,192 UTF-8 bytes"):
        evaluate_program({"kind": "literal", "value": accepted + unit}, [], [])


def test_text_budget_accepts_exactly_sixty_four_kib_and_rejects_one_more_byte() -> None:
    literal_lengths = [8_184] * 7 + [8_186]
    accepted = {
        "kind": "concat",
        "parts": [{"kind": "literal", "value": "x" * length} for length in literal_lengths],
    }
    assert len(evaluate_program(accepted, [], [])) == sum(literal_lengths)

    rejected = deepcopy(accepted)
    rejected["parts"][-1]["value"] += "x"
    with pytest.raises(SynthesisError, match="65,536 UTF-8 bytes"):
        evaluate_program(rejected, [], [])


def test_text_budget_rejects_lone_unicode_surrogates() -> None:
    with pytest.raises(SynthesisError, match="valid Unicode without lone surrogates"):
        evaluate_program({"kind": "literal", "value": "\ud800"}, [], [])


@pytest.mark.parametrize("oversized_field", ["source", "program", "warning"])
def test_normalization_rejects_oversized_text_anywhere_before_synthesis(
    monkeypatch: pytest.MonkeyPatch, oversized_field: str
) -> None:
    params: dict[str, Any] = {
        "sourceColumns": [dict(VALUE)],
        "newColumn": "clean",
        "examples": examples([("a", "A"), ("b", "B")]),
    }
    oversized = "x" * (MAX_BY_EXAMPLE_STRING_UTF8_BYTES + 1)
    if oversized_field == "source":
        params["sourceColumns"][0]["id"] = oversized
    elif oversized_field == "program":
        params["program"] = {"kind": "literal", "value": oversized}
    else:
        params["warnings"] = [oversized]

    def unexpected_synthesis(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("oversized params must fail before synthesis")

    monkeypatch.setattr(by_example_module, "synthesize_program", unexpected_synthesis)
    with pytest.raises(SynthesisError, match="8,192 UTF-8 bytes"):
        normalize_by_example(params)


def test_normalization_rechecks_runtime_generated_text(monkeypatch: pytest.MonkeyPatch) -> None:
    def oversized_synthesis(*_args: object, **_kwargs: object) -> tuple[dict[str, Any], list[str], int]:
        return (
            {"kind": "literal", "value": "constant"},
            ["x" * (MAX_BY_EXAMPLE_STRING_UTF8_BYTES + 1)],
            1,
        )

    monkeypatch.setattr(by_example_module, "synthesize_program", oversized_synthesis)
    with pytest.raises(SynthesisError, match="8,192 UTF-8 bytes"):
        normalize_by_example(
            {
                "sourceColumns": [VALUE],
                "newColumn": "clean",
                "examples": examples([("a", "constant"), ("b", "constant")]),
            }
        )


def test_non_string_scalars_do_not_consume_the_text_budget() -> None:
    normalized = normalize_by_example(
        {
            "sourceColumns": [VALUE],
            "newColumn": "constant",
            "examples": [{"inputs": [index], "output": 1} for index in range(MAX_EXAMPLES)],
        }
    )
    assert normalized["program"] == {"kind": "literal", "value": 1}


def test_source_column_limit_accepts_sixteen_and_rejects_seventeen() -> None:
    accepted = [column_reference(index, f"column-{index}") for index in range(MAX_SOURCE_COLUMNS)]
    samples = [
        {"inputs": [None] * MAX_SOURCE_COLUMNS, "output": "constant"},
        {"inputs": [None] * MAX_SOURCE_COLUMNS, "output": "constant"},
    ]
    program, _, _ = synthesize_program(accepted, samples)
    assert program == {"kind": "literal", "value": "constant"}

    with pytest.raises(SynthesisError, match="between 1 and 16 source columns"):
        synthesize_program(
            [*accepted, column_reference(MAX_SOURCE_COLUMNS, "one-too-many")],
            [
                {"inputs": [None] * (MAX_SOURCE_COLUMNS + 1), "output": "constant"},
                {"inputs": [None] * (MAX_SOURCE_COLUMNS + 1), "output": "constant"},
            ],
        )


def test_direct_synthesis_and_evaluation_reject_width_before_text_walk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_walk(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("collection and AST bounds must fail before UTF-8 traversal")

    monkeypatch.setattr(by_example_module, "_validate_text_budget", unexpected_walk)
    with pytest.raises(SynthesisError, match="between 1 and 16 source columns"):
        synthesize_program([dict(VALUE)] * 100_000, examples([("a", "A"), ("b", "B")]))
    with pytest.raises(SynthesisError, match="between 1 and 64"):
        evaluate_program(
            {"kind": "concat", "parts": [{"kind": "literal", "value": ""}] * 100_000},
            [],
            [],
        )


def test_example_limit_accepts_sixty_four_and_rejects_sixty_five() -> None:
    accepted = [{"inputs": [None], "output": "constant"} for _ in range(MAX_EXAMPLES)]
    program, _, _ = synthesize_program([VALUE], accepted)
    assert program == {"kind": "literal", "value": "constant"}

    with pytest.raises(SynthesisError, match="between 2 and 64"):
        synthesize_program([VALUE], [*accepted, {"inputs": [None], "output": "constant"}])


def wide_concat_program(literal_count: int) -> dict[str, Any]:
    quotient, remainder = divmod(literal_count, 4)
    bucket_sizes = [quotient + (1 if index < remainder else 0) for index in range(4)]
    return {
        "kind": "concat",
        "parts": [
            {"kind": "concat", "parts": [{"kind": "literal", "value": "x"} for _ in range(size)]}
            for size in bucket_sizes
        ],
    }


def test_program_node_limit_accepts_256_and_rejects_257() -> None:
    accepted = wide_concat_program(MAX_PROGRAM_NODES - 5)
    assert evaluate_program(accepted, [], []) == "x" * (MAX_PROGRAM_NODES - 5)

    with pytest.raises(SynthesisError, match="at most 256 nodes"):
        evaluate_program(wide_concat_program(MAX_PROGRAM_NODES - 4), [], [])


def test_concat_part_limit_accepts_sixty_four_and_rejects_sixty_five() -> None:
    accepted = {
        "kind": "concat",
        "parts": [{"kind": "literal", "value": "x"} for _ in range(MAX_CONCAT_PARTS)],
    }
    assert evaluate_program(accepted, [], []) == "x" * MAX_CONCAT_PARTS

    rejected = {
        "kind": "concat",
        "parts": [{"kind": "literal", "value": "x"} for _ in range(MAX_CONCAT_PARTS + 1)],
    }
    with pytest.raises(SynthesisError, match="between 1 and 64"):
        evaluate_program(rejected, [], [])


def nested_case_program(case_count: int) -> dict[str, Any]:
    program: dict[str, Any] = {"kind": "literal", "value": "x"}
    for _ in range(case_count):
        program = {"kind": "case", "style": "upper", "input": program}
    return program


def test_program_depth_limit_accepts_64_and_rejects_65() -> None:
    assert evaluate_program(nested_case_program(64), [], []) == "X"

    with pytest.raises(SynthesisError, match="no deeper than 64"):
        evaluate_program(nested_case_program(65), [], [])


@pytest.mark.parametrize(
    ("style", "value", "expected"),
    [
        ("lower", "ÉCOLE-İ", "École-İ"),
        ("upper", "straße", "STRAßE"),
        ("capitalize", "éCOLE", "école"),
    ],
)
def test_case_programs_use_portable_ascii_only_casing(style: str, value: str, expected: str) -> None:
    program = {"kind": "case", "style": style, "input": column_program()}
    assert evaluate_program(program, [value], [VALUE]) == expected


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ("$1", "ID-$1"),
        (r"\1", r"ID-\1"),
        (r"$&\tail", r"ID-$&\tail"),
    ],
)
def test_regex_replacement_is_always_literal(replacement: str, expected: str) -> None:
    program = {
        "kind": "regexReplace",
        "input": column_program(),
        "pattern": r"(\d+)",
        "replacement": replacement,
    }
    assert evaluate_program(program, ["ID-123"], [VALUE]) == expected


def test_synthesis_preserves_dollar_and_backslash_regex_replacements_literally() -> None:
    for replacement in ("$1", r"\1"):
        samples = examples([("ID#12", f"ID{replacement}12"), ("ID#34", f"ID{replacement}34")])
        program, _, _ = synthesize_program([VALUE], samples)

        assert program == {
            "kind": "regexReplace",
            "input": column_program(),
            "pattern": r"\#",
            "replacement": replacement,
        }
        assert [evaluate_program(program, sample["inputs"], [VALUE]) for sample in samples] == [
            sample["output"] for sample in samples
        ]


def test_synthesis_rejects_inconsistent_examples() -> None:
    with pytest.raises(SynthesisError, match="No deterministic"):
        synthesize_program([VALUE], examples([("same", "one"), ("same", "two")]))
