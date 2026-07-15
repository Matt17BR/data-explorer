from __future__ import annotations

from collections.abc import Iterable, Mapping
from math import isfinite
from pathlib import Path
from typing import Any, Literal

from .base import (
    INTERNAL_ROW_ID_PREFIX,
    DataFrameEngine,
    EngineError,
    boolean_visualization,
    categorical_visualization,
    datetime_visualization,
    ensure_output_columns_available,
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
        df = self._visible_frame(self.normalize(frame))
        if format_name == "csv":
            df.to_csv(path, index=False)
            return
        if format_name == "parquet":
            df.to_parquet(path, index=False)
            return
        raise EngineError(f"Unsupported Pandas export format: {format_name}")

    def shape(self, frame: Any) -> dict[str, int]:
        df = self.normalize(frame)
        return {"rows": int(df.shape[0]), "columns": len(self._visible_positions(df))}

    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        df = self.normalize(frame)
        if self._row_id_column(df) is not None:
            return df
        result = df.copy()
        result[f"{INTERNAL_ROW_ID_PREFIX}{token}"] = [f"r:{token}:{index}" for index in range(len(result))]
        return result

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        return [
            {
                "id": f"c:{position}",
                "name": str(column),
                "position": position,
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(df.iloc[:, frame_position].isna().any()),
            }
            for position, frame_position in enumerate(self._visible_positions(df))
            for column, dtype in [(df.columns[frame_position], df.dtypes.iloc[frame_position])]
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        df = self.normalize(frame)
        column_masks = []
        for column_filter in model.get("filters", []):
            position = self._resolve_visible_position(df, column_filter.get("column"))
            if position is None:
                continue
            series = df.iloc[:, position]
            conditions = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = series.astype(str).isin(selected)
                if value_filter.get("includeNulls") or value_filter.get("includeNaN"):
                    current = current | series.isna()
                conditions.append(current)

            for predicate in column_filter.get("predicates", []):
                conditions.append(self._predicate_mask(series, predicate))

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
            resolved_rules = [
                (self._resolve_visible_column(df, rule["column"]), rule)
                for rule in sort_rules
                if self._resolve_visible_position(df, rule["column"]) is not None
            ]
            if resolved_rules:
                for column, rule in reversed(resolved_rules):
                    filtered = filtered.sort_values(
                        by=column,
                        ascending=rule.get("direction", "asc") == "asc",
                        na_position=rule.get("nulls", "last"),
                        kind="stable",
                    )
        return filtered

    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
        df = self.normalize(frame)
        sliced = df.iloc[offset : offset + limit]
        positions = self._visible_positions(df)
        row_id_position = self._row_id_position(df)
        rows = []
        for row_number, (_, row) in enumerate(sliced.iterrows(), start=offset):
            rows.append(
                {
                    "id": str(row.iloc[row_id_position]) if row_id_position is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(row.iloc[position]) for position in positions],
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
        positions = (
            self._resolve_visible_positions(df, [str(column) for column in columns])
            if columns is not None
            else self._visible_positions(df)
        )
        summaries = []
        for position in positions:
            column = df.columns[position]
            series = df.iloc[:, position]
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
            if semantic_type in {"integer", "float", "decimal"}:
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
        df = self._visible_frame(self.normalize(frame))
        missing_by_column = []
        for position, column in enumerate(df.columns):
            missing_by_column.append({"column": str(column), "count": int(df.iloc[:, position].isna().sum())})
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
        position = self._resolve_visible_position(df, column)
        if position is None:
            raise EngineError(f"Unknown Pandas column: {column}")
        series = df.iloc[:, position].dropna()
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
        import numpy as np
        import pandas as pd

        df = self.normalize(frame).copy()
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            return self.apply_filter_model(df, {"filters": [], "sort": params["rules"]})
        if kind == "filterRows":
            return self.apply_filter_model(df, params["filterModel"])
        if kind == "dropMissingRows":
            return df.dropna(subset=params.get("columns") or self._visible_columns(df), how=params.get("how", "any"))
        if kind == "dropDuplicates":
            keep = params.get("keep", "first")
            return df.drop_duplicates(
                subset=params.get("columns") or self._visible_columns(df), keep=False if keep == "none" else keep
            )
        if kind == "selectColumns":
            row_id = self._row_id_column(df)
            return df.loc[:, [*([row_id] if row_id else []), *params["columns"]]]
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
            encoded = encoded.loc[:, encoded.ne(0).any(axis=0)]
            encoded = encoded.loc[:, sorted(encoded.columns, key=str)]
            base = df.drop(columns=columns) if params.get("dropOriginal", True) else df
            ensure_output_columns_available(base.columns, encoded.columns, "One-hot encoding")
            return pd.concat([base, encoded], axis=1)
        if kind == "multiLabelBinarize":
            column = params["column"]
            encoded = df[column].fillna("").astype(str).str.get_dummies(sep=params["delimiter"])
            encoded = encoded.loc[:, [str(name) != "" for name in encoded.columns]]
            encoded = encoded.loc[:, sorted(encoded.columns, key=str)]
            encoded = encoded.add_prefix(params.get("prefix", f"{column}_")).astype("int8")
            base = df.drop(columns=[column]) if params.get("dropOriginal", False) else df
            ensure_output_columns_available(base.columns, encoded.columns, "Multi-label binarization")
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
                result = series.map(str.capitalize, na_action="ignore")
            elif kind == "lowerText":
                result = series.map(str.lower, na_action="ignore")
            else:
                result = series.map(str.upper, na_action="ignore")
            df[target] = result
            return df
        if kind == "minMaxScale":
            column = params["column"]
            series: Any = pd.to_numeric(df[column], errors="coerce")
            finite = series.where(np.isfinite(series))
            span = finite.max() - finite.min()
            df[params.get("newColumn", column)] = (
                (finite - finite.min()) / span if pd.notna(span) and span != 0 else finite.where(finite.isna(), 0.0)
            )
            return df
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            target = params.get("newColumn", column)
            series: Any = pd.to_numeric(df[column], errors="coerce")
            if kind == "roundNumber":
                df[target] = series.round(params.get("decimals", 0))
            elif kind == "floorNumber":
                df[target] = np.floor(series)
            else:
                df[target] = np.ceil(series)
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
            return df.groupby(params["keys"], dropna=False, sort=False).agg(**named).reset_index()
        if kind == "byExample":
            df[params["newColumn"]] = _pandas_by_example_expression(df, params["program"])
            return df
        if kind == "customCode":
            namespace = {"df": self._visible_frame(df.copy()), "pd": pd}
            try:
                exec(params["code"], namespace, namespace)
            except Exception as error:
                raise EngineError(f"Custom Pandas code failed: {error}") from error
            result = namespace.get("result")
            if not self.detect(result):
                raise EngineError("Custom Pandas code must assign a Pandas DataFrame or Series to result.")
            return self.normalize(result)
        raise EngineError(f"Pandas does not implement transformation: {kind}")

    def _row_id_column(self, frame: Any) -> Any | None:
        return next((column for column in frame.columns if str(column).startswith(INTERNAL_ROW_ID_PREFIX)), None)

    def _row_id_position(self, frame: Any) -> int | None:
        return next(
            (
                position
                for position, column in enumerate(frame.columns)
                if str(column).startswith(INTERNAL_ROW_ID_PREFIX)
            ),
            None,
        )

    def _visible_positions(self, frame: Any) -> list[int]:
        return [
            position
            for position, column in enumerate(frame.columns)
            if not str(column).startswith(INTERNAL_ROW_ID_PREFIX)
        ]

    def _visible_columns(self, frame: Any) -> list[Any]:
        return [frame.columns[position] for position in self._visible_positions(frame)]

    def _visible_frame(self, frame: Any) -> Any:
        row_id = self._row_id_column(frame)
        return frame.drop(columns=[row_id]) if row_id is not None else frame

    def _resolve_visible_position(self, frame: Any, requested: Any) -> int | None:
        requested_name = str(requested)
        return next(
            (position for position in self._visible_positions(frame) if str(frame.columns[position]) == requested_name),
            None,
        )

    def _resolve_visible_positions(self, frame: Any, requested: list[str]) -> list[int]:
        available: dict[str, list[int]] = {}
        for position in self._visible_positions(frame):
            available.setdefault(str(frame.columns[position]), []).append(position)
        resolved = []
        for name in requested:
            positions = available.get(str(name), [])
            if positions:
                resolved.append(positions.pop(0))
        return resolved

    def _resolve_visible_column(self, frame: Any, requested: Any) -> Any:
        position = self._resolve_visible_position(frame, requested)
        return frame.columns[position] if position is not None else requested

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        lines = [
            "from collections import Counter",
            "",
            "import numpy as np",
            "import pandas as pd",
            "",
            "",
            "def clean_data(df):",
            "    df = df.copy()",
        ]
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
            lines = []
            for rule in reversed(rules):
                lines.append(
                    f"{prefix}df = df.sort_values(by={rule['column']!r}, "
                    f"ascending={rule.get('direction', 'asc') == 'asc'!r}, "
                    f"na_position={rule.get('nulls', 'last')!r}, kind='stable')"
                )
            return lines
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
            base = f"_base_{index}"
            generated = f"_generated_{index}"
            collisions = f"_collisions_{index}"
            return [
                (
                    f"{prefix}{name} = pd.get_dummies(df[{columns!r}], "
                    f"prefix_sep={params.get('prefixSeparator', '_')!r}, dtype='int8')"
                ),
                f"{prefix}{name} = {name}.loc[:, {name}.ne(0).any(axis=0)]",
                f"{prefix}{name} = {name}.loc[:, sorted({name}.columns, key=str)]",
                f"{prefix}{base} = df.drop(columns={columns!r}) if {params.get('dropOriginal', True)!r} else df",
                f"{prefix}{generated} = [str(column) for column in {name}.columns]",
                (
                    f"{prefix}{collisions} = sorted((set(map(str, {base}.columns)) & set({generated})) | "
                    f"{{column for column, count in Counter({generated}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('One-hot encoding would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}df = pd.concat([{base}, {name}], axis=1)",
            ]
        if kind == "multiLabelBinarize":
            column = params["column"]
            name = f"_encoded_{index}"
            base = f"_base_{index}"
            generated = f"_generated_{index}"
            collisions = f"_collisions_{index}"
            return [
                f"{prefix}{name} = df[{column!r}].fillna('').astype(str).str.get_dummies(sep={params['delimiter']!r})",
                f"{prefix}{name} = {name}.loc[:, [str(column) != '' for column in {name}.columns]]",
                f"{prefix}{name} = {name}.loc[:, sorted({name}.columns, key=str)]",
                f"{prefix}{name} = {name}.add_prefix({params.get('prefix', f'{column}_')!r}).astype('int8')",
                f"{prefix}{base} = df.drop(columns={[column]!r}) if {params.get('dropOriginal', False)!r} else df",
                f"{prefix}{generated} = [str(column) for column in {name}.columns]",
                (
                    f"{prefix}{collisions} = sorted((set(map(str, {base}.columns)) & set({generated})) | "
                    f"{{column for column, count in Counter({generated}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('Multi-label binarization would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}df = pd.concat([{base}, {name}], axis=1)",
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
                expression = f"df[{column!r}].astype('string').map(str.{method}, na_action='ignore')"
            return [f"{prefix}df[{target!r}] = {expression}"]
        if kind == "minMaxScale":
            column = params["column"]
            target = params.get("newColumn", column)
            name = f"_series_{index}"
            return [
                f"{prefix}{name} = pd.to_numeric(df[{column!r}], errors='coerce')",
                f"{prefix}{name} = {name}.where(np.isfinite({name}))",
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
            return [
                f"{prefix}df = df.groupby({params['keys']!r}, dropna=False, sort=False).agg(**{named!r}).reset_index()"
            ]
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
        for rule in reversed(rules):
            lines.append(
                f"    df = df.sort_values(by={rule['column']!r}, "
                f"ascending={rule.get('direction', 'asc') == 'asc'!r}, "
                f"na_position={rule.get('nulls', 'last')!r}, kind='stable')"
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
