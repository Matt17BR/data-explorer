from __future__ import annotations

from collections.abc import Iterable, Mapping
from math import ceil, floor, isfinite
from pathlib import Path
from typing import Any, Literal

from .base import (
    DataFrameEngine,
    EngineError,
    boolean_visualization,
    categorical_visualization,
    datetime_visualization,
    infer_semantic_type,
    normalize_cell,
    numeric_visualization,
)


class PandasEngine(DataFrameEngine):
    name = "pandas"

    def detect(self, value: Any) -> bool:
        try:
            import pandas as pd
        except ImportError:
            return False
        return isinstance(value, (pd.DataFrame, pd.Series))

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        import pandas as pd

        options = options or {}
        extension = Path(path).suffix.lower()
        if extension in {".csv", ".tsv"}:
            return pd.read_csv(
                path,
                sep=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                encoding=options.get("encoding", "utf-8"),
                quotechar=options.get("quoteChar", '"'),
                header=0 if options.get("hasHeader", True) else None,
            )
        if extension == ".parquet":
            return pd.read_parquet(path)
        if extension == ".jsonl":
            return pd.read_json(path, lines=True)
        if extension in {".xlsx", ".xls"}:
            return pd.read_excel(path, sheet_name=options.get("sheet", 0))
        raise EngineError(f"Unsupported file extension for Pandas backend: {extension}")

    def normalize(self, value: Any) -> Any:
        import pandas as pd

        if isinstance(value, pd.Series):
            return value.to_frame()
        return value

    def export_data(self, frame: Any, path: str, format_name: Literal["csv", "parquet"]) -> None:
        df = self.normalize(frame)
        if format_name == "csv":
            df.to_csv(path, index=False)
            return
        if format_name == "parquet":
            df.to_parquet(path, index=False)
            return
        raise EngineError(f"Unsupported Pandas export format: {format_name}")

    def shape(self, frame: Any) -> dict[str, int]:
        df = self.normalize(frame)
        return {"rows": int(df.shape[0]), "columns": int(df.shape[1])}

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        return [
            {
                "id": f"c:{position}",
                "name": str(column),
                "position": position,
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(df.iloc[:, position].isna().any()),
            }
            for position, (column, dtype) in enumerate(df.dtypes.items())
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        df = self.normalize(frame)
        column_masks = []
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in df.columns:
                continue
            conditions = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = df[column].astype(str).isin(selected)
                if value_filter.get("includeNulls") or value_filter.get("includeNaN"):
                    current = current | df[column].isna()
                conditions.append(current)

            for predicate in column_filter.get("predicates", []):
                conditions.append(self._predicate_mask(df[column], predicate))

            if conditions:
                mask = conditions[0]
                for condition in conditions[1:]:
                    mask = mask | condition if column_filter.get("logic") == "or" else mask & condition
                column_masks.append(mask)

        filtered = df
        if column_masks:
            mask = column_masks[0]
            for column_mask in column_masks[1:]:
                mask = mask | column_mask if model.get("logic") == "or" else mask & column_mask
            filtered = df[mask]

        sort_rules = model.get("sort", [])
        if sort_rules:
            filtered = filtered.sort_values(
                by=[rule["column"] for rule in sort_rules],
                ascending=[rule.get("direction", "asc") == "asc" for rule in sort_rules],
                na_position="first" if sort_rules[0].get("nulls") == "first" else "last",
            )
        return filtered

    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
        df = self.normalize(frame)
        sliced = df.iloc[offset : offset + limit]
        columns = list(df.columns)
        rows = []
        for row_number, (_, row) in enumerate(sliced.iterrows(), start=offset):
            rows.append(
                {
                    "id": f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(row.iloc[position]) for position, _ in enumerate(columns)],
                }
            )
        return {
            "offset": offset,
            "limit": limit,
            "totalRows": int(df.shape[0]),
            "rows": rows,
        }

    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        selected = list(columns) if columns is not None else list(df.columns)
        summaries = []
        for column in selected:
            series = df[column]
            raw_type = str(series.dtype)
            semantic_type = infer_semantic_type(raw_type)
            top_values = [
                {"value": str(index), "count": int(value)}
                for index, value in series.value_counts(dropna=True).head(10).items()
            ]
            summary: dict[str, Any] = {
                "column": str(column),
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": int(len(series)),
                "nullCount": int(series.isna().sum()),
                "nanCount": int(series.isna().sum()) if raw_type.startswith("float") else 0,
                "distinctCount": int(series.nunique(dropna=True)),
                "topValues": top_values,
            }
            if semantic_type in {"integer", "float"}:
                numeric = series.dropna()
                summary["numeric"] = {
                    "min": _maybe_float(numeric.min()),
                    "max": _maybe_float(numeric.max()),
                    "mean": _maybe_float(numeric.mean()),
                    "median": _maybe_float(numeric.median()),
                    "std": _maybe_float(numeric.std()),
                }
                summary["visualization"] = numeric_visualization(numeric.tolist())
            elif semantic_type == "boolean":
                summary["visualization"] = boolean_visualization(series.dropna().tolist())
            elif semantic_type in {"datetime", "date"}:
                values = series.dropna()
                summary["visualization"] = datetime_visualization(
                    values.min() if not values.empty else None,
                    values.max() if not values.empty else None,
                )
            else:
                summary["visualization"] = categorical_visualization(top_values, int(series.notna().sum()))
            summaries.append(summary)
        return summaries

    def header_stats(self, frame: Any) -> dict[str, Any]:
        df = self.normalize(frame)
        missing_by_column = []
        for column in df.columns:
            missing_by_column.append({"column": str(column), "count": int(df[column].isna().sum())})
        return {
            "missingCells": int(df.isna().sum().sum()),
            "missingRows": int(df.isna().any(axis=1).sum()),
            "duplicateRows": int(df.duplicated().sum()),
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        df = self.normalize(frame)
        series = df[column].dropna()
        if search:
            series = series[series.astype(str).str.contains(search, case=False, na=False)]
        counts = series.value_counts().head(limit + 1)
        values = [{"value": str(index), "count": int(value)} for index, value in counts.head(limit).items()]
        return values, len(counts) > limit

    def _predicate_mask(self, series: Any, predicate: Mapping[str, Any]) -> Any:
        operator = predicate.get("operator")
        value = predicate.get("value")
        if operator == "equals":
            return series == value
        if operator == "notEquals":
            return series != value
        if operator == "contains":
            return series.astype(str).str.contains(str(value), case=False, na=False, regex=False)
        if operator == "startsWith":
            return series.astype(str).str.startswith(str(value), na=False)
        if operator == "endsWith":
            return series.astype(str).str.endswith(str(value), na=False)
        if operator == "gt":
            return series > value
        if operator == "gte":
            return series >= value
        if operator == "lt":
            return series < value
        if operator == "lte":
            return series <= value
        if operator == "between":
            return (series >= value) & (series <= predicate.get("secondValue"))
        if operator == "isNull":
            return series.isna()
        if operator == "isNotNull":
            return series.notna()
        if operator == "isNaN":
            return series.isna()
        if operator == "isNotNaN":
            return series.notna()
        return series.notna()

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        import pandas as pd

        df = self.normalize(frame).copy()
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            return self.apply_filter_model(df, {"filters": [], "sort": params["rules"]})
        if kind == "filterRows":
            return self.apply_filter_model(df, params["filterModel"])
        if kind == "dropMissingRows":
            return df.dropna(subset=params.get("columns") or None, how=params.get("how", "any"))
        if kind == "dropDuplicates":
            keep = params.get("keep", "first")
            return df.drop_duplicates(subset=params.get("columns") or None, keep=False if keep == "none" else keep)
        if kind == "selectColumns":
            return df.loc[:, params["columns"]]
        if kind == "dropColumns":
            return df.drop(columns=params["columns"])
        if kind == "renameColumn":
            return df.rename(columns={params["column"]: params["newName"]})
        if kind == "cloneColumn":
            df[params["newName"]] = df[params["column"]]
            return df
        if kind == "castColumn":
            column = params["column"]
            dtype = params["dtype"]
            if dtype == "date":
                df[column] = pd.to_datetime(df[column], errors="coerce").dt.date
            elif dtype == "datetime":
                df[column] = pd.to_datetime(df[column], errors="coerce")
            else:
                df[column] = df[column].astype(
                    {"string": "string", "integer": "Int64", "float": "Float64", "boolean": "boolean"}[dtype]
                )
            return df
        if kind == "formula":
            right = df[params["rightColumn"]] if params.get("rightColumn") else params["value"]
            df[params["newColumn"]] = _pandas_formula(df[params["leftColumn"]], right, params["operator"])
            return df
        if kind == "textLength":
            df[params["newColumn"]] = df[params["column"]].astype("string").str.len()
            return df
        if kind == "oneHotEncode":
            columns = params["columns"]
            encoded = pd.get_dummies(df[columns], prefix_sep=params.get("prefixSeparator", "_"), dtype="int8")
            base = df.drop(columns=columns) if params.get("dropOriginal", True) else df
            return pd.concat([base, encoded], axis=1)
        if kind == "multiLabelBinarize":
            column = params["column"]
            encoded = df[column].fillna("").astype(str).str.get_dummies(sep=params["delimiter"])
            encoded = encoded.add_prefix(params.get("prefix", f"{column}_")).astype("int8")
            base = df.drop(columns=[column]) if params.get("dropOriginal", False) else df
            return pd.concat([base, encoded], axis=1)
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            column = params["column"]
            target = params.get("newColumn", column)
            series = df[column].astype("string")
            if kind == "findReplace":
                result = series.str.replace(params["find"], params["replacement"], regex=params.get("regex", False))
            elif kind == "stripText":
                result = series.str.strip(params.get("characters"))
            elif kind == "splitText":
                result = series.str.split(params["delimiter"], regex=False).str.get(params["index"])
            elif kind == "capitalizeText":
                result = series.str.capitalize()
            elif kind == "lowerText":
                result = series.str.lower()
            else:
                result = series.str.upper()
            df[target] = result
            return df
        if kind == "minMaxScale":
            column = params["column"]
            series: Any = pd.to_numeric(df[column], errors="coerce")
            span = series.max() - series.min()
            df[params.get("newColumn", column)] = (
                (series - series.min()) / span if pd.notna(span) and span != 0 else series.where(series.isna(), 0.0)
            )
            return df
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            target = params.get("newColumn", column)
            series: Any = pd.to_numeric(df[column], errors="coerce")
            if kind == "roundNumber":
                df[target] = series.round(params.get("decimals", 0))
            elif kind == "floorNumber":
                df[target] = series.map(lambda value: floor(value) if pd.notna(value) else value)
            else:
                df[target] = series.map(lambda value: ceil(value) if pd.notna(value) else value)
            return df
        if kind == "formatDatetime":
            target = params.get("newColumn", params["column"])
            df[target] = pd.to_datetime(df[params["column"]], errors="coerce").dt.strftime(params["format"])
            return df
        if kind == "groupBy":
            named = {
                aggregation["alias"]: (
                    aggregation["column"],
                    "nunique" if aggregation["operation"] == "nUnique" else aggregation["operation"],
                )
                for aggregation in params["aggregations"]
            }
            return df.groupby(params["keys"], dropna=False).agg(**named).reset_index()
        if kind == "byExample":
            df[params["newColumn"]] = _pandas_by_example_expression(df, params["program"])
            return df
        if kind == "customCode":
            namespace = {"df": df, "pd": pd}
            exec(params["code"], namespace, namespace)
            result = namespace.get("result")
            if not self.detect(result):
                raise EngineError("Custom Pandas code must assign a Pandas DataFrame or Series to result.")
            return self.normalize(result)
        raise EngineError(f"Pandas does not implement transformation: {kind}")

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        lines = ["import numpy as np", "import pandas as pd", "", "", "def clean_data(df):", "    df = df.copy()"]
        for index, step in enumerate(steps):
            lines.extend(self._compile_step(step, index))
        lines.append("    return df")
        return "\n".join(lines) + "\n"

    def _compile_step(self, step: Mapping[str, Any], index: int) -> list[str]:
        kind = str(step["kind"])
        params = step["params"]
        prefix = "    "
        if kind == "sortRows":
            rules = params["rules"]
            return [
                f"{prefix}df = df.sort_values(by={[rule['column'] for rule in rules]!r}, ",
                f"{prefix}    ascending={[rule.get('direction', 'asc') == 'asc' for rule in rules]!r},",
                f"{prefix}    na_position={rules[0].get('nulls', 'last')!r})",
            ]
        if kind == "filterRows":
            return _compile_pandas_filter(params["filterModel"], index)
        if kind == "dropMissingRows":
            return [
                f"{prefix}df = df.dropna(subset={params.get('columns') or None!r}, how={params.get('how', 'any')!r})"
            ]
        if kind == "dropDuplicates":
            keep = params.get("keep", "first")
            return [
                f"{prefix}df = df.drop_duplicates(subset={params.get('columns') or None!r}, "
                f"keep={False if keep == 'none' else keep!r})"
            ]
        if kind == "selectColumns":
            return [f"{prefix}df = df.loc[:, {params['columns']!r}]"]
        if kind == "dropColumns":
            return [f"{prefix}df = df.drop(columns={params['columns']!r})"]
        if kind == "renameColumn":
            return [f"{prefix}df = df.rename(columns={{{params['column']!r}: {params['newName']!r}}})"]
        if kind == "cloneColumn":
            return [f"{prefix}df[{params['newName']!r}] = df[{params['column']!r}]"]
        if kind == "castColumn":
            column = params["column"]
            dtype = params["dtype"]
            if dtype == "date":
                return [f"{prefix}df[{column!r}] = pd.to_datetime(df[{column!r}], errors='coerce').dt.date"]
            if dtype == "datetime":
                return [f"{prefix}df[{column!r}] = pd.to_datetime(df[{column!r}], errors='coerce')"]
            target = {"string": "string", "integer": "Int64", "float": "Float64", "boolean": "boolean"}[dtype]
            return [f"{prefix}df[{column!r}] = df[{column!r}].astype({target!r})"]
        if kind == "formula":
            right = f"df[{params['rightColumn']!r}]" if params.get("rightColumn") else repr(params["value"])
            symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%", "power": "**"}[
                params["operator"]
            ]
            return [f"{prefix}df[{params['newColumn']!r}] = df[{params['leftColumn']!r}] {symbol} {right}"]
        if kind == "textLength":
            return [f"{prefix}df[{params['newColumn']!r}] = df[{params['column']!r}].astype('string').str.len()"]
        if kind == "oneHotEncode":
            columns = params["columns"]
            name = f"_encoded_{index}"
            return [
                (
                    f"{prefix}{name} = pd.get_dummies(df[{columns!r}], "
                    f"prefix_sep={params.get('prefixSeparator', '_')!r}, dtype='int8')"
                ),
                (
                    f"{prefix}df = pd.concat([df.drop(columns={columns!r}) "
                    f"if {params.get('dropOriginal', True)!r} else df, {name}], axis=1)"
                ),
            ]
        if kind == "multiLabelBinarize":
            column = params["column"]
            name = f"_encoded_{index}"
            return [
                f"{prefix}{name} = df[{column!r}].fillna('').astype(str).str.get_dummies(sep={params['delimiter']!r})",
                f"{prefix}{name} = {name}.add_prefix({params.get('prefix', f'{column}_')!r}).astype('int8')",
                (
                    f"{prefix}df = pd.concat([df.drop(columns={[column]!r}) "
                    f"if {params.get('dropOriginal', False)!r} else df, {name}], axis=1)"
                ),
            ]
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            column = params["column"]
            target = params.get("newColumn", column)
            base = f"df[{column!r}].astype('string').str"
            if kind == "findReplace":
                expression = (
                    f"{base}.replace({params['find']!r}, {params['replacement']!r}, "
                    f"regex={params.get('regex', False)!r})"
                )
            elif kind == "stripText":
                expression = f"{base}.strip({params.get('characters')!r})"
            elif kind == "splitText":
                expression = f"{base}.split({params['delimiter']!r}, regex=False).str.get({params['index']!r})"
            else:
                method = {"capitalizeText": "capitalize", "lowerText": "lower", "upperText": "upper"}[kind]
                expression = f"{base}.{method}()"
            return [f"{prefix}df[{target!r}] = {expression}"]
        if kind == "minMaxScale":
            column = params["column"]
            target = params.get("newColumn", column)
            name = f"_series_{index}"
            return [
                f"{prefix}{name} = pd.to_numeric(df[{column!r}], errors='coerce')",
                f"{prefix}_span_{index} = {name}.max() - {name}.min()",
                (
                    f"{prefix}df[{target!r}] = (({name} - {name}.min()) / _span_{index} "
                    f"if pd.notna(_span_{index}) and _span_{index} != 0 "
                    f"else {name}.where({name}.isna(), 0.0))"
                ),
            ]
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            target = params.get("newColumn", column)
            expression = (
                f"pd.to_numeric(df[{column!r}], errors='coerce').round({params.get('decimals', 0)!r})"
                if kind == "roundNumber"
                else (
                    f"np.{'floor' if kind == 'floorNumber' else 'ceil'}(pd.to_numeric(df[{column!r}], errors='coerce'))"
                )
            )
            return [f"{prefix}df[{target!r}] = {expression}"]
        if kind == "formatDatetime":
            target = params.get("newColumn", params["column"])
            return [
                (
                    f"{prefix}df[{target!r}] = pd.to_datetime(df[{params['column']!r}], "
                    f"errors='coerce').dt.strftime({params['format']!r})"
                )
            ]
        if kind == "groupBy":
            named = {
                aggregation["alias"]: (
                    aggregation["column"],
                    "nunique" if aggregation["operation"] == "nUnique" else aggregation["operation"],
                )
                for aggregation in params["aggregations"]
            }
            return [f"{prefix}df = df.groupby({params['keys']!r}, dropna=False).agg(**{named!r}).reset_index()"]
        if kind == "byExample":
            expression = _compile_pandas_by_example(params["program"])
            return [f"{prefix}df[{params['newColumn']!r}] = {expression}"]
        if kind == "customCode":
            function_name = f"_custom_step_{index}"
            code_lines = str(params["code"]).splitlines()
            return [
                f"{prefix}def {function_name}(df):",
                *[f"{prefix}    {line}" if line else f"{prefix}    " for line in code_lines],
                f"{prefix}    return result",
                f"{prefix}df = {function_name}(df)",
            ]
        raise EngineError(f"Pandas cannot compile transformation: {kind}")


def _pandas_by_example_expression(df: Any, program: Mapping[str, Any]) -> Any:
    import pandas as pd

    kind = program["kind"]
    if kind == "column":
        return df[program["column"]]
    if kind == "literal":
        return program.get("value")
    if kind == "slice":
        value = _pandas_string_expression(df, program["input"])
        return value.str.slice(program["start"], program.get("stop"))
    if kind == "split":
        value = _pandas_string_expression(df, program["input"])
        return value.str.split(program["delimiter"], regex=False).str.get(program["index"])
    if kind == "concat":
        result: Any = pd.Series("", index=df.index, dtype="string")
        for part in program["parts"]:
            value = _pandas_by_example_expression(df, part)
            result = result + (value.astype("string") if hasattr(value, "astype") else str(value))
        return result
    if kind == "regexExtract":
        value = _pandas_string_expression(df, program["input"])
        return value.str.extract(program["pattern"], expand=False)
    if kind == "regexReplace":
        value = _pandas_string_expression(df, program["input"])
        return value.str.replace(program["pattern"], program["replacement"], regex=True)
    if kind == "case":
        value = _pandas_string_expression(df, program["input"])
        return getattr(value.str, program["style"])()
    if kind == "datetimeFormat":
        value = _pandas_by_example_expression(df, program["input"])
        return pd.to_datetime(value, format=program["inputFormat"], errors="coerce").dt.strftime(
            program["outputFormat"]
        )
    if kind == "arithmetic":
        return _pandas_formula(
            _pandas_by_example_expression(df, program["left"]),
            _pandas_by_example_expression(df, program["right"]),
            program["operator"],
        )
    raise EngineError(f"Unsupported Pandas by-example expression: {kind}")


def _pandas_string_expression(df: Any, program: Mapping[str, Any]) -> Any:
    import pandas as pd

    value = _pandas_by_example_expression(df, program)
    return value.astype("string") if hasattr(value, "astype") else pd.Series(str(value), index=df.index, dtype="string")


def _compile_pandas_by_example(program: Mapping[str, Any]) -> str:
    kind = program["kind"]
    if kind == "column":
        return f"df[{program['column']!r}]"
    if kind == "literal":
        return repr(program.get("value"))
    if kind == "slice":
        value = _compile_pandas_string(program["input"])
        return f"{value}.str.slice({program['start']!r}, {program.get('stop')!r})"
    if kind == "split":
        value = _compile_pandas_string(program["input"])
        return f"{value}.str.split({program['delimiter']!r}, regex=False).str.get({program['index']!r})"
    if kind == "concat":
        parts = [_compile_pandas_string(part) for part in program["parts"]]
        return " + ".join(f"({part})" for part in parts)
    if kind == "regexExtract":
        return f"{_compile_pandas_string(program['input'])}.str.extract({program['pattern']!r}, expand=False)"
    if kind == "regexReplace":
        return (
            f"{_compile_pandas_string(program['input'])}.str.replace({program['pattern']!r}, "
            f"{program['replacement']!r}, regex=True)"
        )
    if kind == "case":
        return f"{_compile_pandas_string(program['input'])}.str.{program['style']}()"
    if kind == "datetimeFormat":
        return (
            f"pd.to_datetime({_compile_pandas_by_example(program['input'])}, "
            f"format={program['inputFormat']!r}, errors='coerce').dt.strftime({program['outputFormat']!r})"
        )
    if kind == "arithmetic":
        symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/"}[program["operator"]]
        return (
            f"({_compile_pandas_by_example(program['left'])} {symbol} {_compile_pandas_by_example(program['right'])})"
        )
    raise EngineError(f"Unsupported Pandas by-example expression: {kind}")


def _compile_pandas_string(program: Mapping[str, Any]) -> str:
    expression = _compile_pandas_by_example(program)
    return (
        f"pd.Series({expression!s}, index=df.index, dtype='string')"
        if program["kind"] == "literal"
        else f"{expression}.astype('string')"
    )


def _pandas_formula(left: Any, right: Any, operator: str) -> Any:
    if operator == "add":
        return left + right
    if operator == "subtract":
        return left - right
    if operator == "multiply":
        return left * right
    if operator == "divide":
        return left / right
    if operator == "modulo":
        return left % right
    if operator == "power":
        return left**right
    raise EngineError(f"Unsupported formula operator: {operator}")


def _compile_pandas_filter(model: Mapping[str, Any], index: int) -> list[str]:
    column_masks: list[str] = []
    for column_filter in model.get("filters", []):
        column = column_filter["column"]
        series = f"df[{column!r}]"
        conditions: list[str] = []
        value_filter = column_filter.get("valueFilter")
        if value_filter and (
            value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
        ):
            parts = []
            if value_filter.get("selectedValues"):
                parts.append(f"{series}.astype(str).isin({[str(value) for value in value_filter['selectedValues']]!r})")
            if value_filter.get("includeNulls") or value_filter.get("includeNaN"):
                parts.append(f"{series}.isna()")
            conditions.append("(" + " | ".join(parts) + ")")
        for predicate in column_filter.get("predicates", []):
            conditions.append(_pandas_predicate_expression(series, predicate))
        if conditions:
            operator = " | " if column_filter.get("logic") == "or" else " & "
            column_masks.append("(" + operator.join(conditions) + ")")

    lines: list[str] = []
    if column_masks:
        operator = " | " if model.get("logic") == "or" else " & "
        lines.append(f"    _filter_mask_{index} = " + operator.join(column_masks))
        lines.append(f"    df = df[_filter_mask_{index}]")
    rules = model.get("sort", [])
    if rules:
        lines.extend(
            [
                f"    df = df.sort_values(by={[rule['column'] for rule in rules]!r},",
                f"        ascending={[rule.get('direction', 'asc') == 'asc' for rule in rules]!r},",
                f"        na_position={rules[0].get('nulls', 'last')!r})",
            ]
        )
    return lines


def _pandas_predicate_expression(series: str, predicate: Mapping[str, Any]) -> str:
    operator = predicate.get("operator")
    value = predicate.get("value")
    if operator == "equals":
        return f"({series} == {value!r})"
    if operator == "notEquals":
        return f"({series} != {value!r})"
    if operator == "contains":
        return f"{series}.astype(str).str.contains({str(value)!r}, case=False, na=False, regex=False)"
    if operator == "startsWith":
        return f"{series}.astype(str).str.startswith({str(value)!r}, na=False)"
    if operator == "endsWith":
        return f"{series}.astype(str).str.endswith({str(value)!r}, na=False)"
    if operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[str(operator)]
        return f"({series} {symbol} {value!r})"
    if operator == "between":
        return f"(({series} >= {value!r}) & ({series} <= {predicate.get('secondValue')!r}))"
    if operator in {"isNull", "isNaN"}:
        return f"{series}.isna()"
    if operator in {"isNotNull", "isNotNaN"}:
        return f"{series}.notna()"
    return f"{series}.notna()"


def _maybe_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError):
        return None
