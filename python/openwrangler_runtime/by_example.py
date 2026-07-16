from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from itertools import permutations
from typing import Any


class SynthesisError(ValueError):
    """Raised when examples cannot produce a deterministic supported program."""


_DELIMITERS = (" ", "-", "_", "/", ".", ",", ":")
_REGEX_PATTERNS = (r"(\d+)", r"([A-Za-z]+)", r"([A-Za-z0-9]+)")
_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%Y/%m/%d",
    "%d-%m-%Y",
    "%m-%d-%Y",
    "%Y%m%d",
    "%d %B %Y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%Y",
    "%m/%Y",
)
_SCALAR_TYPES = (str, int, float, bool, type(None))


def normalize_by_example(params: Mapping[str, Any]) -> dict[str, Any]:
    source_columns = params.get("sourceColumns")
    new_column = params.get("newColumn")
    raw_examples = params.get("examples")
    if (
        not isinstance(source_columns, list | tuple)
        or not source_columns
        or not all(isinstance(item, str) and item for item in source_columns)
    ):
        raise SynthesisError("byExample.sourceColumns must be a non-empty array of column names.")
    columns = [str(item) for item in source_columns]
    if not isinstance(new_column, str) or not new_column:
        raise SynthesisError("byExample.newColumn must be a non-empty string.")
    if not isinstance(raw_examples, list) or len(raw_examples) < 2:
        raise SynthesisError("byExample.examples must contain at least two input/output examples.")

    examples: list[dict[str, Any]] = []
    for raw in raw_examples:
        if not isinstance(raw, Mapping) or not isinstance(raw.get("inputs"), Mapping) or "output" not in raw:
            raise SynthesisError("Each by-example item must contain an inputs object and output value.")
        inputs = raw["inputs"]
        if any(column not in inputs for column in columns):
            raise SynthesisError("Every by-example input must contain all selected source columns.")
        if any(not isinstance(inputs[column], _SCALAR_TYPES) for column in columns) or not isinstance(
            raw["output"], _SCALAR_TYPES
        ):
            raise SynthesisError("By-example inputs and outputs must be JSON scalar values.")
        examples.append(
            {
                "inputs": {column: inputs[column] for column in columns},
                "output": raw["output"],
            }
        )

    program = params.get("program")
    warnings: list[str]
    candidate_count: int
    if program is None:
        program, warnings, candidate_count = synthesize_program(columns, examples)
    else:
        if not isinstance(program, Mapping) or not _program_matches(program, examples, columns):
            raise SynthesisError("The saved by-example program is invalid or no longer satisfies every example.")
        raw_warnings = params.get("warnings", [])
        warnings = [str(item) for item in raw_warnings] if isinstance(raw_warnings, list) else []
        raw_count = params.get("candidateCount", 1)
        candidate_count = raw_count if isinstance(raw_count, int) and raw_count > 0 else 1

    return {
        "sourceColumns": columns,
        "newColumn": new_column,
        "examples": examples,
        "program": dict(program),
        "warnings": warnings,
        "candidateCount": candidate_count,
    }


def synthesize_program(
    source_columns: Sequence[str], examples: Sequence[Mapping[str, Any]]
) -> tuple[dict[str, Any], list[str], int]:
    candidates: dict[str, tuple[int, dict[str, Any]]] = {}

    def add(program: dict[str, Any], cost: int) -> None:
        if not _program_matches(program, examples, source_columns):
            return
        key = json.dumps(program, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        candidates[key] = min(candidates.get(key, (cost, program)), (cost, program), key=lambda item: item[0])

    outputs = [example["output"] for example in examples]
    if all(_equal(output, outputs[0]) for output in outputs[1:]):
        add({"kind": "literal", "value": outputs[0]}, 1)

    for column in source_columns:
        direct = {"kind": "column", "column": column}
        add(direct, 1)
        for style in ("lower", "upper", "capitalize"):
            add({"kind": "case", "style": style, "input": direct}, 2)
        _add_slice_candidates(add, column, examples)
        _add_split_candidates(add, column)
        _add_regex_candidates(add, column, examples)
        _add_datetime_candidates(add, column)
        _add_constant_arithmetic_candidates(add, column, examples)

    _add_column_arithmetic_candidates(add, source_columns)
    _add_concat_candidates(add, source_columns, examples)

    ranked = sorted(candidates.values(), key=lambda item: (item[0], json.dumps(item[1], sort_keys=True)))
    if not ranked:
        raise SynthesisError(
            "No deterministic slicing, splitting, concatenation, literal, regex, casing, datetime, or arithmetic "
            "program satisfies every example. Add or correct examples."
        )
    best_cost, best = ranked[0]
    equally_simple = sum(cost == best_cost for cost, _ in ranked)
    warnings = []
    if equally_simple > 1:
        warnings.append(
            f"Ambiguous examples: {equally_simple} equally simple programs match. "
            "Preview the selected result carefully."
        )
    elif len(ranked) > 1:
        warnings.append(f"{len(ranked)} programs match; Open Wrangler selected the simplest deterministic program.")
    return best, warnings, len(ranked)


def evaluate_program(program: Mapping[str, Any], inputs: Mapping[str, Any], source_columns: Sequence[str]) -> Any:
    kind = program.get("kind")
    if kind == "column":
        column = program.get("column")
        if not isinstance(column, str) or column not in source_columns or column not in inputs:
            raise SynthesisError("By-example program references an unavailable column.")
        return inputs[column]
    if kind == "literal":
        value = program.get("value")
        if not isinstance(value, _SCALAR_TYPES):
            raise SynthesisError("By-example literal must be a JSON scalar.")
        return value
    if kind == "slice":
        value = str(evaluate_program(_child(program, "input"), inputs, source_columns))
        start = _integer(program, "start")
        stop = program.get("stop")
        if stop is not None and not isinstance(stop, int):
            raise SynthesisError("Slice stop must be an integer or null.")
        return value[start:stop]
    if kind == "split":
        value = str(evaluate_program(_child(program, "input"), inputs, source_columns))
        delimiter = _string(program, "delimiter")
        index = _integer(program, "index")
        parts = value.split(delimiter)
        return parts[index] if -len(parts) <= index < len(parts) else None
    if kind == "concat":
        parts = program.get("parts")
        if not isinstance(parts, list) or not parts:
            raise SynthesisError("Concat requires at least one part.")
        return "".join(str(evaluate_program(_mapping(part), inputs, source_columns)) for part in parts)
    if kind == "regexExtract":
        value = str(evaluate_program(_child(program, "input"), inputs, source_columns))
        match = re.search(_string(program, "pattern"), value)
        group = _integer(program, "group")
        return match.group(group) if match else None
    if kind == "regexReplace":
        value = str(evaluate_program(_child(program, "input"), inputs, source_columns))
        return re.sub(_string(program, "pattern"), _string(program, "replacement"), value)
    if kind == "case":
        value = str(evaluate_program(_child(program, "input"), inputs, source_columns))
        style = program.get("style")
        if style == "lower":
            return value.lower()
        if style == "upper":
            return value.upper()
        if style == "capitalize":
            return value.capitalize()
        raise SynthesisError("Unsupported by-example case style.")
    if kind == "datetimeFormat":
        value = str(evaluate_program(_child(program, "input"), inputs, source_columns))
        return datetime.strptime(value, _string(program, "inputFormat")).strftime(_string(program, "outputFormat"))
    if kind == "arithmetic":
        left = _number(evaluate_program(_child(program, "left"), inputs, source_columns))
        right = _number(evaluate_program(_child(program, "right"), inputs, source_columns))
        operator = program.get("operator")
        if operator == "add":
            return left + right
        if operator == "subtract":
            return left - right
        if operator == "multiply":
            return left * right
        if operator == "divide":
            return left / right
        raise SynthesisError("Unsupported by-example arithmetic operator.")
    raise SynthesisError(f"Unsupported by-example program kind: {kind!r}.")


def _add_slice_candidates(add, column: str, examples: Sequence[Mapping[str, Any]]) -> None:
    value = str(examples[0]["inputs"][column])[:128]
    output = str(examples[0]["output"])
    base = {"kind": "column", "column": column}
    for start in range(len(value) + 1):
        for stop in range(start, len(value) + 1):
            if value[start:stop] == output:
                add({"kind": "slice", "input": base, "start": start, "stop": stop}, 2)


def _add_split_candidates(add, column: str) -> None:
    base = {"kind": "column", "column": column}
    for delimiter in _DELIMITERS:
        for index in range(4):
            add({"kind": "split", "input": base, "delimiter": delimiter, "index": index}, 2)


def _add_regex_candidates(add, column: str, examples: Sequence[Mapping[str, Any]]) -> None:
    base = {"kind": "column", "column": column}
    for pattern in _REGEX_PATTERNS:
        add({"kind": "regexExtract", "input": base, "pattern": pattern, "group": 1}, 3)
    replacements = []
    for example in examples:
        before = str(example["inputs"][column])
        after = str(example["output"])
        prefix = 0
        while prefix < min(len(before), len(after)) and before[prefix] == after[prefix]:
            prefix += 1
        suffix = 0
        while (
            suffix < min(len(before) - prefix, len(after) - prefix)
            and before[len(before) - suffix - 1] == after[len(after) - suffix - 1]
        ):
            suffix += 1
        end_before = len(before) - suffix if suffix else len(before)
        end_after = len(after) - suffix if suffix else len(after)
        replacements.append((before[prefix:end_before], after[prefix:end_after]))
    if replacements and all(item == replacements[0] for item in replacements) and replacements[0][0]:
        find, replacement = replacements[0]
        add(
            {
                "kind": "regexReplace",
                "input": base,
                "pattern": re.escape(find),
                "replacement": replacement,
            },
            3,
        )


def _add_datetime_candidates(add, column: str) -> None:
    base = {"kind": "column", "column": column}
    for input_format in _DATE_FORMATS:
        for output_format in _DATE_FORMATS:
            if input_format != output_format:
                add(
                    {
                        "kind": "datetimeFormat",
                        "input": base,
                        "inputFormat": input_format,
                        "outputFormat": output_format,
                    },
                    3,
                )


def _add_constant_arithmetic_candidates(add, column: str, examples: Sequence[Mapping[str, Any]]) -> None:
    first_input = examples[0]["inputs"][column]
    first_output = examples[0]["output"]
    if not _is_number(first_input) or not _is_number(first_output):
        return
    base = {"kind": "column", "column": column}
    add(_arithmetic(base, "add", _literal(float(first_output) - float(first_input))), 2)
    add(_arithmetic(base, "subtract", _literal(float(first_input) - float(first_output))), 2)
    if float(first_input) != 0:
        add(_arithmetic(base, "multiply", _literal(float(first_output) / float(first_input))), 2)
    if float(first_output) != 0:
        add(_arithmetic(base, "divide", _literal(float(first_input) / float(first_output))), 2)


def _add_column_arithmetic_candidates(add, source_columns: Sequence[str]) -> None:
    for left, right in permutations(source_columns, 2):
        for operator in ("add", "subtract", "multiply", "divide"):
            add(
                _arithmetic({"kind": "column", "column": left}, operator, {"kind": "column", "column": right}),
                2,
            )


def _add_concat_candidates(add, source_columns: Sequence[str], examples: Sequence[Mapping[str, Any]]) -> None:
    for length in (2, 3):
        if len(source_columns) < length:
            continue
        for columns in permutations(source_columns, length):
            literal_sets = [_concat_literals(columns, example) for example in examples]
            if not literal_sets or literal_sets[0] is None or any(item != literal_sets[0] for item in literal_sets):
                continue
            literals = literal_sets[0]
            parts: list[dict[str, Any]] = []
            for index, column in enumerate(columns):
                if literals[index]:
                    parts.append(_literal(literals[index]))
                parts.append({"kind": "column", "column": column})
            if literals[-1]:
                parts.append(_literal(literals[-1]))
            add({"kind": "concat", "parts": parts}, 1 + len(parts))


def _concat_literals(columns: Sequence[str], example: Mapping[str, Any]) -> list[str] | None:
    output = str(example["output"])
    cursor = 0
    literals = []
    for column in columns:
        token = str(example["inputs"][column])
        position = output.find(token, cursor)
        if position < 0:
            return None
        literals.append(output[cursor:position])
        cursor = position + len(token)
    literals.append(output[cursor:])
    return literals


def _program_matches(
    program: Mapping[str, Any], examples: Sequence[Mapping[str, Any]], source_columns: Sequence[str]
) -> bool:
    try:
        return all(
            _equal(evaluate_program(program, example["inputs"], source_columns), example["output"])
            for example in examples
        )
    except (SynthesisError, ValueError, TypeError, ZeroDivisionError, IndexError, re.error):
        return False


def _equal(left: Any, right: Any) -> bool:
    if _is_number(left) and _is_number(right):
        return math.isclose(float(left), float(right), rel_tol=1e-9, abs_tol=1e-9)
    return left == right or str(left) == str(right)


def _arithmetic(left: dict[str, Any], operator: str, right: dict[str, Any]) -> dict[str, Any]:
    return {"kind": "arithmetic", "left": left, "operator": operator, "right": right}


def _literal(value: Any) -> dict[str, Any]:
    return {"kind": "literal", "value": value}


def _child(program: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    return _mapping(program.get(key))


def _mapping(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SynthesisError("By-example expression must be an object.")
    return value


def _string(program: Mapping[str, Any], key: str) -> str:
    value = program.get(key)
    if not isinstance(value, str):
        raise SynthesisError(f"By-example {key} must be a string.")
    return value


def _integer(program: Mapping[str, Any], key: str) -> int:
    value = program.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise SynthesisError(f"By-example {key} must be an integer.")
    return value


def _number(value: Any) -> float:
    if not _is_number(value):
        raise SynthesisError("By-example arithmetic inputs must be numeric.")
    return float(value)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(float(value))


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list | tuple) and bool(value) and all(isinstance(item, str) and item for item in value)
