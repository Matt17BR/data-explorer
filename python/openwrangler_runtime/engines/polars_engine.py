from __future__ import annotations

from collections import Counter
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


class PolarsEngine(DataFrameEngine):
    name = "polars"

    def detect(self, value: Any) -> bool:
        try:
            import polars as pl
        except ImportError:
            return False
        return isinstance(value, (pl.DataFrame, pl.LazyFrame, pl.Series))

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        import polars as pl

        options = options or {}
        extension = Path(path).suffix.lower()
        if extension in {".csv", ".tsv"}:
            requested_encoding = str(options.get("encoding", "utf8")).lower()
            if requested_encoding not in {"utf-8", "utf8", "utf8-lossy"}:
                raise EngineError(
                    f"Polars supports UTF-8 CSV input, not {requested_encoding}. "
                    "Use the Pandas backend for this encoding."
                )
            encoding: Literal["utf8", "utf8-lossy"] = "utf8-lossy" if requested_encoding == "utf8-lossy" else "utf8"
            return pl.scan_csv(
                path,
                separator=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                encoding=encoding,
                quote_char=options.get("quoteChar", '"'),
                has_header=options.get("hasHeader", True),
            )
        if extension == ".parquet":
            return pl.scan_parquet(path)
        if extension == ".jsonl":
            return pl.scan_ndjson(path)
        if extension in {".xlsx", ".xls"}:
            sheet = options.get("sheet")
            if isinstance(sheet, int):
                # The public import option is zero-based, while fastexcel's
                # sheet_id follows spreadsheet conventions and is one-based.
                return pl.read_excel(path, sheet_id=sheet + 1)
            return pl.read_excel(path, sheet_name=sheet)
        raise EngineError(f"Unsupported file extension for Polars backend: {extension}")

    def normalize(self, value: Any) -> Any:
        import polars as pl

        if isinstance(value, pl.Series):
            return value.to_frame()
        if isinstance(value, pl.LazyFrame):
            return value.collect()
        return value

    def export_data(self, frame: Any, path: str, format_name: Literal["csv", "parquet"]) -> None:
        import polars as pl

        row_id = self._row_id_column(frame)
        if row_id is not None:
            frame = frame.drop(row_id)
        if isinstance(frame, pl.LazyFrame):
            if format_name == "csv":
                frame.sink_csv(path)
                return
            if format_name == "parquet":
                frame.sink_parquet(path)
                return
        else:
            df = self.normalize(frame)
            if format_name == "csv":
                df.write_csv(path)
                return
            if format_name == "parquet":
                df.write_parquet(path)
                return
        raise EngineError(f"Unsupported Polars export format: {format_name}")

    def shape(self, frame: Any) -> dict[str, int]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            return {
                "rows": int(frame.select(pl.len()).collect(engine="streaming").item()),
                "columns": len(self._visible_columns(frame)),
            }
        df = self.normalize(frame)
        rows, _ = df.shape
        return {"rows": int(rows), "columns": len(self._visible_columns(df))}

    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        if self._row_id_column(frame) is not None:
            return frame
        return frame.with_row_index(f"{INTERNAL_ROW_ID_PREFIX}{token}")

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            schema = frame.collect_schema()
            visible = self._visible_columns(frame)
            if not visible:
                return []
            null_counts = (
                frame.select([pl.col(name).null_count() for name in visible]).collect(engine="streaming").to_dicts()[0]
            )
            return [
                {
                    "id": f"c:{position}",
                    "name": name,
                    "position": position,
                    "rawType": str(dtype),
                    "type": infer_semantic_type(str(dtype)),
                    "nullable": bool(null_counts.get(name, 0) > 0),
                }
                for position, name in enumerate(visible)
                for dtype in [schema[name]]
            ]
        df = self.normalize(frame)
        visible = self._visible_columns(df)
        if not visible:
            return []
        null_counts = df.select(visible).null_count().to_dicts()[0] if df.height else {column: 0 for column in visible}
        return [
            {
                "id": f"c:{position}",
                "name": name,
                "position": position,
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(null_counts.get(name, 0) > 0),
            }
            for position, name in enumerate(visible)
            for dtype in [df.schema[name]]
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        import polars as pl

        df = frame
        columns = df.collect_schema().names() if isinstance(df, pl.LazyFrame) else df.columns
        column_expressions = []
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in columns:
                continue

            conditions = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = pl.col(column).cast(pl.Utf8).is_in(selected) if selected else pl.lit(False)
                if value_filter.get("includeNulls"):
                    current = current | pl.col(column).is_null()
                if value_filter.get("includeNaN") and column_filter.get("type") == "float":
                    current = current | pl.col(column).is_nan()
                conditions.append(current)

            for predicate in column_filter.get("predicates", []):
                conditions.append(self._predicate_expr(column, predicate, column_filter.get("type")))

            if conditions:
                column_expression = conditions[0]
                for condition in conditions[1:]:
                    column_expression = (
                        column_expression | condition
                        if column_filter.get("logic") == "or"
                        else column_expression & condition
                    )
                column_expressions.append(column_expression)

        if column_expressions:
            combined = column_expressions[0]
            for expression in column_expressions[1:]:
                combined = combined | expression if model.get("logic") == "or" else combined & expression
            df = df.filter(combined)

        sort_rules = [rule for rule in model.get("sort", []) if rule.get("column") in columns]
        if sort_rules:
            df = df.sort(
                [rule["column"] for rule in sort_rules],
                descending=[rule.get("direction", "asc") == "desc" for rule in sort_rules],
                nulls_last=[rule.get("nulls", "last") == "last" for rule in sort_rules],
                maintain_order=True,
            )
        return df

    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            total_rows = int(frame.select(pl.len()).collect(engine="streaming").item())
            df = frame.slice(offset, limit).collect(engine="streaming")
            sliced = df
        else:
            df = self.normalize(frame)
            sliced = df.slice(offset, limit)
            total_rows = int(df.height)
        columns = self._visible_columns(df)
        row_id = self._row_id_column(df)
        rows = []
        for row_number, row in enumerate(sliced.iter_rows(named=True), start=offset):
            rows.append(
                {
                    "id": f"r:{row_id}:{row.get(row_id)}" if row_id is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(row.get(column)) for column in columns],
                }
            )
        return {
            "offset": offset,
            "limit": limit,
            "totalRows": total_rows,
            "rows": rows,
        }

    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            selected = list(columns) if columns is not None else self._visible_columns(frame)
            df = frame.select(selected).collect(engine="streaming")
        else:
            df = self.normalize(frame)
            selected = list(columns) if columns is not None else self._visible_columns(df)
        if not selected:
            return []
        null_counts = df.select([pl.col(column).null_count().alias(column) for column in selected]).to_dicts()[0]
        summaries = []
        for column in selected:
            series = df[column]
            raw_type = str(series.dtype)
            semantic_type = infer_semantic_type(raw_type)
            top_values, distinct_count = self._summary_counts(series, column, semantic_type)
            summary: dict[str, Any] = {
                "column": column,
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": int(df.height),
                "nullCount": int(null_counts.get(column, 0)),
                "nanCount": self._nan_count(series),
                "distinctCount": distinct_count,
                "topValues": top_values,
            }
            if semantic_type in {"integer", "float", "decimal"}:
                numeric_values = series.drop_nulls().to_list()
                summary["numeric"] = {
                    "min": _maybe_float(series.min()),
                    "max": _maybe_float(series.max()),
                    "mean": _maybe_float(series.mean()),
                    "median": _maybe_float(series.median()),
                    "std": _maybe_float(series.std()),
                }
                summary["visualization"] = numeric_visualization(numeric_values)
            elif semantic_type == "boolean":
                summary["visualization"] = boolean_visualization(series.drop_nulls().to_list())
            elif semantic_type in {"datetime", "date"}:
                summary["visualization"] = datetime_visualization(series.min(), series.max())
            else:
                summary["visualization"] = categorical_visualization(
                    summary["topValues"], int(df.height) - int(null_counts.get(column, 0)) - summary["nanCount"]
                )
            summaries.append(summary)
        return summaries

    def _summary_counts(self, series: Any, column: str, semantic_type: str) -> tuple[list[dict[str, Any]], int]:
        if semantic_type in {"list", "struct"}:
            displays = [normalize_cell(value)["display"] for value in series.drop_nulls().to_list()]
            counts = Counter(displays)
            return (
                [{"value": value, "count": count} for value, count in counts.most_common(10)],
                len(counts),
            )

        try:
            rows = series.drop_nulls().value_counts(sort=True).head(10).iter_rows(named=True)
            top_values = [
                {"value": str(row[column]), "count": int(row["count"])} for row in rows if row[column] is not None
            ]
            return top_values, int(series.n_unique())
        except Exception:
            # Some extension dtypes do not implement hash-based aggregations.
            # A bounded display-level fallback keeps profiling available.
            displays = [normalize_cell(value)["display"] for value in series.drop_nulls().to_list()]
            counts = Counter(displays)
            return (
                [{"value": value, "count": count} for value, count in counts.most_common(10)],
                len(counts),
            )

    def header_stats(self, frame: Any) -> dict[str, Any]:
        import polars as pl

        df = frame.collect(engine="streaming") if isinstance(frame, pl.LazyFrame) else self.normalize(frame)
        row_id = self._row_id_column(df)
        if row_id is not None:
            df = df.drop(row_id)
        if df.width == 0:
            return {"missingCells": 0, "missingRows": 0, "duplicateRows": 0, "missingValuesByColumn": []}

        missing_by_column = []
        missing_row_expression = None
        missing_cells = 0
        for column in df.columns:
            series = df[column]
            null_count = int(series.null_count())
            nan_count = self._nan_count(series)
            count = null_count + nan_count
            missing_cells += count
            missing_by_column.append({"column": column, "count": count})
            current = pl.col(column).is_null()
            if infer_semantic_type(str(series.dtype)) == "float":
                current = current | pl.col(column).is_nan()
            missing_row_expression = current if missing_row_expression is None else missing_row_expression | current

        missing_rows = (
            int(df.select(missing_row_expression.sum().alias("missingRows")).item())
            if missing_row_expression is not None and df.height
            else 0
        )
        return {
            "missingCells": missing_cells,
            "missingRows": missing_rows,
            "duplicateRows": int(df.height - df.unique(maintain_order=False).height) if df.height else 0,
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            series_df = frame.select(pl.col(column).drop_nulls())
        else:
            df = self.normalize(frame)
            series_df = df.select(pl.col(column).drop_nulls())
        if search:
            series_df = series_df.filter(pl.col(column).cast(pl.Utf8).str.contains(search, literal=True))
        if isinstance(series_df, pl.LazyFrame):
            counts = (
                series_df.group_by(column)
                .len(name="count")
                .sort("count", descending=True)
                .head(limit + 1)
                .collect(engine="streaming")
            )
        else:
            counts = series_df[column].value_counts(sort=True).head(limit + 1)
        values = [
            {"value": str(row[column]), "count": int(row["count"])} for row in counts.head(limit).iter_rows(named=True)
        ]
        return values, counts.height > limit

    def _predicate_expr(self, column: str, predicate: Mapping[str, Any], column_type: str | None = None) -> Any:
        import polars as pl

        operator = predicate.get("operator")
        value = predicate.get("value")
        expr = pl.col(column)
        if operator == "equals":
            return expr == value
        if operator == "notEquals":
            return expr != value
        if operator == "contains":
            return expr.cast(pl.Utf8).str.to_lowercase().str.contains(str(value).lower(), literal=True)
        if operator == "startsWith":
            return expr.cast(pl.Utf8).str.starts_with(str(value))
        if operator == "endsWith":
            return expr.cast(pl.Utf8).str.ends_with(str(value))
        if operator == "gt":
            return expr > value
        if operator == "gte":
            return expr >= value
        if operator == "lt":
            return expr < value
        if operator == "lte":
            return expr <= value
        if operator == "between":
            return (expr >= value) & (expr <= predicate.get("secondValue"))
        if operator == "isNull":
            return expr.is_null()
        if operator == "isNotNull":
            return expr.is_not_null()
        if operator == "isNaN":
            return expr.is_nan() if column_type == "float" else pl.lit(False)
        if operator == "isNotNaN":
            return expr.is_not_nan() if column_type == "float" else pl.lit(True)
        return expr.is_not_null()

    def _nan_count(self, series: Any) -> int:
        try:
            return int(series.is_nan().sum())
        except Exception:
            return 0

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        import polars as pl

        df = frame
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            return self.apply_filter_model(df, {"filters": [], "sort": params["rules"]})
        if kind == "filterRows":
            return self.apply_filter_model(df, params["filterModel"])
        if kind == "dropMissingRows":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            columns = params.get("columns") or self._visible_columns(df)
            valid = [_polars_valid_value(pl.col(column), schema[column]) for column in columns]
            expression = pl.any_horizontal(valid) if params.get("how", "any") == "all" else pl.all_horizontal(valid)
            return df.filter(expression)
        if kind == "dropDuplicates":
            return df.unique(
                subset=params.get("columns") or self._visible_columns(df),
                keep=params.get("keep", "first"),
                maintain_order=True,
            )
        if kind == "selectColumns":
            row_id = self._row_id_column(df)
            return df.select([*([row_id] if row_id else []), *params["columns"]])
        if kind == "dropColumns":
            return df.drop(params["columns"])
        if kind == "renameColumn":
            return df.rename({params["column"]: params["newName"]})
        if kind == "cloneColumn":
            return df.with_columns(pl.col(params["column"]).alias(params["newName"]))
        if kind == "castColumn":
            dtype = {
                "string": pl.String,
                "integer": pl.Int64,
                "float": pl.Float64,
                "boolean": pl.Boolean,
                "date": pl.Date,
                "datetime": pl.Datetime,
            }[params["dtype"]]
            return df.with_columns(pl.col(params["column"]).cast(dtype, strict=False))
        if kind == "formula":
            right = pl.col(params["rightColumn"]) if params.get("rightColumn") else pl.lit(params["value"])
            expression = _polars_formula(pl.col(params["leftColumn"]), right, params["operator"])
            return df.with_columns(expression.alias(params["newColumn"]))
        if kind == "textLength":
            return df.with_columns(pl.col(params["column"]).cast(pl.String).str.len_chars().alias(params["newColumn"]))
        if kind == "oneHotEncode":
            eager = df.collect(engine="streaming") if isinstance(df, pl.LazyFrame) else df
            columns = params["columns"]
            separator = params.get("prefixSeparator", "_")
            generated = [
                (column, value, f"{column}{separator}{value}")
                for column in columns
                for value in sorted(eager.get_column(column).drop_nulls().unique().to_list(), key=str)
            ]
            base = eager.drop(columns) if params.get("dropOriginal", True) else eager
            ensure_output_columns_available(base.columns, [name for _, _, name in generated], "One-hot encoding")
            if not generated:
                return base
            encoded = eager.select(
                [
                    (pl.col(column) == pl.lit(value)).fill_null(False).cast(pl.Int8).alias(name)
                    for column, value, name in generated
                ]
            )
            return base.hstack(encoded)
        if kind == "multiLabelBinarize":
            eager = df.collect(engine="streaming") if isinstance(df, pl.LazyFrame) else df
            column = params["column"]
            delimiter = params["delimiter"]
            labels = (
                eager.select(pl.col(column).cast(pl.String).str.split(delimiter).explode().drop_nulls().unique())
                .get_column(column)
                .to_list()
            )
            expressions = [
                pl.col(column)
                .fill_null("")
                .cast(pl.String)
                .str.split(delimiter)
                .list.contains(label)
                .cast(pl.Int8)
                .alias(f"{params.get('prefix', f'{column}_')}{label}")
                for label in sorted(str(label) for label in labels if str(label))
            ]
            base = eager.drop(column) if params.get("dropOriginal", False) else eager
            generated_names = [
                f"{params.get('prefix', f'{column}_')}{label}"
                for label in sorted(str(label) for label in labels if str(label))
            ]
            ensure_output_columns_available(base.columns, generated_names, "Multi-label binarization")
            if not expressions:
                return base
            return base.hstack(eager.select(expressions))
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            column = params["column"]
            target = params.get("newColumn", column)
            expression = pl.col(column).cast(pl.String)
            if kind == "findReplace":
                expression = expression.str.replace_all(
                    params["find"], params["replacement"], literal=not params.get("regex", False)
                )
            elif kind == "stripText":
                expression = expression.str.strip_chars(params.get("characters"))
            elif kind == "splitText":
                expression = expression.str.split(params["delimiter"]).list.get(params["index"], null_on_oob=True)
            elif kind == "capitalizeText":
                expression = expression.str.slice(0, 1).str.to_uppercase() + expression.str.slice(1).str.to_lowercase()
            elif kind == "lowerText":
                expression = expression.str.to_lowercase()
            else:
                expression = expression.str.to_uppercase()
            return df.with_columns(expression.alias(target))
        if kind == "minMaxScale":
            column = params["column"]
            expression = pl.col(column).cast(pl.Float64, strict=False)
            valid = pl.when(expression.is_finite()).then(expression).otherwise(None)
            scaled = (
                pl.when(valid.is_null())
                .then(None)
                .when(valid.max() == valid.min())
                .then(pl.lit(0.0))
                .otherwise((valid - valid.min()) / (valid.max() - valid.min()))
            )
            return df.with_columns(scaled.alias(params.get("newColumn", column)))
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            expression = pl.col(column).cast(pl.Float64, strict=False)
            if kind == "roundNumber":
                expression = expression.round(params.get("decimals", 0))
            elif kind == "floorNumber":
                expression = expression.floor()
            else:
                expression = expression.ceil()
            return df.with_columns(expression.alias(params.get("newColumn", column)))
        if kind == "formatDatetime":
            column = params["column"]
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            expression = pl.col(column)
            if schema[column].base_type() not in {pl.Datetime, pl.Date}:
                expression = expression.cast(pl.String).str.to_datetime(strict=False)
            return df.with_columns(expression.dt.strftime(params["format"]).alias(params.get("newColumn", column)))
        if kind == "groupBy":
            expressions = [_polars_aggregation(aggregation) for aggregation in params["aggregations"]]
            return df.group_by(params["keys"], maintain_order=True).agg(expressions)
        if kind == "byExample":
            return df.with_columns(_polars_by_example_expression(params["program"]).alias(params["newColumn"]))
        if kind == "customCode":
            row_id = self._row_id_column(df)
            namespace = {"df": df.drop(row_id) if row_id is not None else df, "pl": pl}
            try:
                exec(params["code"], namespace, namespace)
            except Exception as error:
                raise EngineError(f"Custom Polars code failed: {error}") from error
            result = namespace.get("result")
            if not self.detect(result):
                raise EngineError("Custom Polars code must assign a Polars DataFrame, LazyFrame, or Series to result.")
            return result.to_frame() if isinstance(result, pl.Series) else result
        raise EngineError(f"Polars does not implement transformation: {kind}")

    def _row_id_column(self, frame: Any) -> str | None:
        import polars as pl

        columns = frame.collect_schema().names() if isinstance(frame, pl.LazyFrame) else frame.columns
        return next((name for name in columns if name.startswith(INTERNAL_ROW_ID_PREFIX)), None)

    def _visible_columns(self, frame: Any) -> list[str]:
        import polars as pl

        columns = frame.collect_schema().names() if isinstance(frame, pl.LazyFrame) else frame.columns
        return [name for name in columns if not name.startswith(INTERNAL_ROW_ID_PREFIX)]

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        lines = ["from collections import Counter", "", "import polars as pl", "", "", "def clean_data(df):"]
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
                f"{prefix}df = df.sort({[rule['column'] for rule in rules]!r},",
                f"{prefix}    descending={[rule.get('direction', 'asc') == 'desc' for rule in rules]!r},",
                f"{prefix}    nulls_last={[rule.get('nulls', 'last') == 'last' for rule in rules]!r},",
                f"{prefix}    maintain_order=True)",
            ]
        if kind == "filterRows":
            return _compile_polars_filter(params["filterModel"], index)
        if kind == "dropMissingRows":
            columns = params.get("columns")
            name = f"_columns_{index}"
            schema = f"_schema_{index}"
            horizontal = "all_horizontal" if params.get("how", "any") == "any" else "any_horizontal"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}{name} = {columns!r} or {schema}.names()",
                (
                    f"{prefix}_valid_{index} = [pl.col(column).is_not_null() & "
                    f"(~pl.col(column).is_nan() if {schema}[column].is_float() else pl.lit(True)) "
                    f"for column in {name}]"
                ),
                f"{prefix}df = df.filter(pl.{horizontal}(_valid_{index}))",
            ]
        if kind == "dropDuplicates":
            return [
                (
                    f"{prefix}df = df.unique(subset={params.get('columns') or None!r}, "
                    f"keep={params.get('keep', 'first')!r}, maintain_order=True)"
                )
            ]
        if kind == "selectColumns":
            return [f"{prefix}df = df.select({params['columns']!r})"]
        if kind == "dropColumns":
            return [f"{prefix}df = df.drop({params['columns']!r})"]
        if kind == "renameColumn":
            return [f"{prefix}df = df.rename({{{params['column']!r}: {params['newName']!r}}})"]
        if kind == "cloneColumn":
            return [f"{prefix}df = df.with_columns(pl.col({params['column']!r}).alias({params['newName']!r}))"]
        if kind == "castColumn":
            dtype = {
                "string": "pl.String",
                "integer": "pl.Int64",
                "float": "pl.Float64",
                "boolean": "pl.Boolean",
                "date": "pl.Date",
                "datetime": "pl.Datetime",
            }[params["dtype"]]
            return [f"{prefix}df = df.with_columns(pl.col({params['column']!r}).cast({dtype}, strict=False))"]
        if kind == "formula":
            right = (
                f"pl.col({params['rightColumn']!r})" if params.get("rightColumn") else f"pl.lit({params['value']!r})"
            )
            symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%", "power": "**"}[
                params["operator"]
            ]
            return [
                (
                    f"{prefix}df = df.with_columns((pl.col({params['leftColumn']!r}) {symbol} {right})"
                    f".alias({params['newColumn']!r}))"
                )
            ]
        if kind == "textLength":
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({params['column']!r}).cast(pl.String)"
                    f".str.len_chars().alias({params['newColumn']!r}))"
                )
            ]
        if kind == "oneHotEncode":
            columns = params["columns"]
            eager = f"_eager_{index}"
            generated = f"_generated_{index}"
            encoded = f"_encoded_{index}"
            base = f"_base_{index}"
            names = f"_generated_names_{index}"
            collisions = f"_collisions_{index}"
            return [
                f"{prefix}{eager} = df.collect(engine='streaming') if isinstance(df, pl.LazyFrame) else df",
                (
                    f"{prefix}{generated} = [(column, value, str(column) + "
                    f"{params.get('prefixSeparator', '_')!r} + str(value)) for column in {columns!r} "
                    f"for value in sorted({eager}.get_column(column).drop_nulls().unique().to_list(), key=str)]"
                ),
                f"{prefix}{base} = {eager}.drop({columns!r}) if {params.get('dropOriginal', True)!r} else {eager}",
                f"{prefix}{names} = [name for _, _, name in {generated}]",
                (
                    f"{prefix}{collisions} = sorted((set({base}.columns) & set({names})) | "
                    f"{{name for name, count in Counter({names}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('One-hot encoding would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}if {generated}:",
                f"{prefix}    {encoded} = {eager}.select([",
                f"{prefix}        (pl.col(column) == pl.lit(value)).fill_null(False).cast(pl.Int8).alias(name)",
                f"{prefix}        for column, value, name in {generated}",
                f"{prefix}    ])",
                f"{prefix}    df = {base}.hstack({encoded})",
                f"{prefix}else:",
                f"{prefix}    df = {base}",
            ]
        if kind == "multiLabelBinarize":
            column = params["column"]
            delimiter = params["delimiter"]
            eager = f"_eager_{index}"
            labels = f"_labels_{index}"
            encoded = f"_encoded_{index}"
            base = f"_base_{index}"
            names = f"_generated_names_{index}"
            collisions = f"_collisions_{index}"
            return [
                f"{prefix}{eager} = df.collect(engine='streaming') if isinstance(df, pl.LazyFrame) else df",
                f"{prefix}{labels} = {eager}.select(",
                f"{prefix}    pl.col({column!r}).cast(pl.String).str.split({delimiter!r})",
                f"{prefix}    .explode().drop_nulls().unique()",
                f"{prefix}).get_column({column!r}).to_list()",
                f"{prefix}{labels} = sorted(str(label) for label in {labels} if str(label))",
                f"{prefix}{base} = {eager}.drop({column!r}) if {params.get('dropOriginal', False)!r} else {eager}",
                f"{prefix}{names} = [{params.get('prefix', f'{column}_')!r} + label for label in {labels}]",
                (
                    f"{prefix}{collisions} = sorted((set({base}.columns) & set({names})) | "
                    f"{{name for name, count in Counter({names}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('Multi-label binarization would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}if {labels}:",
                f"{prefix}    {encoded} = {eager}.select([",
                f"{prefix}        pl.col({column!r}).fill_null('').cast(pl.String)",
                f"{prefix}        .str.split({delimiter!r}).list.contains(label).cast(pl.Int8)",
                f"{prefix}        .alias({params.get('prefix', f'{column}_')!r} + label)",
                f"{prefix}        for label in {labels}",
                f"{prefix}    ])",
                f"{prefix}    df = {base}.hstack({encoded})",
                f"{prefix}else:",
                f"{prefix}    df = {base}",
            ]
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            column = params["column"]
            target = params.get("newColumn", column)
            base = f"pl.col({column!r}).cast(pl.String)"
            if kind == "findReplace":
                expression = (
                    f"{base}.str.replace_all({params['find']!r}, {params['replacement']!r}, "
                    f"literal={not params.get('regex', False)!r})"
                )
            elif kind == "stripText":
                expression = f"{base}.str.strip_chars({params.get('characters')!r})"
            elif kind == "splitText":
                expression = (
                    f"{base}.str.split({params['delimiter']!r}).list.get({params['index']!r}, null_on_oob=True)"
                )
            elif kind == "capitalizeText":
                expression = f"({base}.str.slice(0, 1).str.to_uppercase() + {base}.str.slice(1).str.to_lowercase())"
            elif kind == "lowerText":
                expression = f"{base}.str.to_lowercase()"
            else:
                expression = f"{base}.str.to_uppercase()"
            return [f"{prefix}df = df.with_columns({expression}.alias({target!r}))"]
        if kind == "minMaxScale":
            column = params["column"]
            target = params.get("newColumn", column)
            name = f"_value_{index}"
            valid = f"_valid_{index}"
            return [
                f"{prefix}{name} = pl.col({column!r}).cast(pl.Float64, strict=False)",
                f"{prefix}{valid} = pl.when({name}.is_finite()).then({name}).otherwise(None)",
                (
                    f"{prefix}df = df.with_columns(pl.when({valid}.is_null()).then(None)"
                    f".when({valid}.max() == {valid}.min()).then(pl.lit(0.0))"
                    f".otherwise(({valid} - {valid}.min()) / "
                    f"({valid}.max() - {valid}.min())).alias({target!r}))"
                ),
            ]
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            target = params.get("newColumn", column)
            method = (
                f"round({params.get('decimals', 0)!r})"
                if kind == "roundNumber"
                else "floor()"
                if kind == "floorNumber"
                else "ceil()"
            )
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.Float64, strict=False)"
                    f".{method}.alias({target!r}))"
                )
            ]
        if kind == "formatDatetime":
            column = params["column"]
            target = params.get("newColumn", column)
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.String)"
                    f".str.to_datetime(strict=False).dt.strftime({params['format']!r})"
                    f".alias({target!r}))"
                )
            ]
        if kind == "groupBy":
            expressions = ", ".join(_compile_polars_aggregation(aggregation) for aggregation in params["aggregations"])
            return [f"{prefix}df = df.group_by({params['keys']!r}, maintain_order=True).agg([{expressions}])"]
        if kind == "byExample":
            expression = _compile_polars_by_example(params["program"])
            return [f"{prefix}df = df.with_columns({expression}.alias({params['newColumn']!r}))"]
        if kind == "customCode":
            function_name = f"_custom_step_{index}"
            code_lines = str(params["code"]).splitlines()
            return [
                f"{prefix}def {function_name}(df):",
                *[f"{prefix}    {line}" if line else f"{prefix}    " for line in code_lines],
                f"{prefix}    return result",
                f"{prefix}df = {function_name}(df)",
            ]
        raise EngineError(f"Polars cannot compile transformation: {kind}")


def _polars_by_example_expression(program: Mapping[str, Any]) -> Any:
    import polars as pl

    kind = program["kind"]
    if kind == "column":
        return pl.col(program["column"])
    if kind == "literal":
        return pl.lit(program.get("value"))
    if kind == "slice":
        start = program["start"]
        stop = program.get("stop")
        length = None if stop is None else stop - start
        return _polars_by_example_expression(program["input"]).cast(pl.String).str.slice(start, length)
    if kind == "split":
        return (
            _polars_by_example_expression(program["input"])
            .cast(pl.String)
            .str.split(program["delimiter"])
            .list.get(program["index"], null_on_oob=True)
        )
    if kind == "concat":
        return pl.concat_str([_polars_by_example_expression(part) for part in program["parts"]], separator="")
    if kind == "regexExtract":
        return (
            _polars_by_example_expression(program["input"])
            .cast(pl.String)
            .str.extract(program["pattern"], group_index=program["group"])
        )
    if kind == "regexReplace":
        return (
            _polars_by_example_expression(program["input"])
            .cast(pl.String)
            .str.replace_all(program["pattern"], program["replacement"])
        )
    if kind == "case":
        value = _polars_by_example_expression(program["input"]).cast(pl.String)
        if program["style"] == "lower":
            return value.str.to_lowercase()
        if program["style"] == "upper":
            return value.str.to_uppercase()
        return value.str.slice(0, 1).str.to_uppercase() + value.str.slice(1).str.to_lowercase()
    if kind == "datetimeFormat":
        return (
            _polars_by_example_expression(program["input"])
            .cast(pl.String)
            .str.strptime(pl.Datetime, format=program["inputFormat"], strict=False)
            .dt.strftime(program["outputFormat"])
        )
    if kind == "arithmetic":
        return _polars_formula(
            _polars_by_example_expression(program["left"]),
            _polars_by_example_expression(program["right"]),
            program["operator"],
        )
    raise EngineError(f"Unsupported Polars by-example expression: {kind}")


def _compile_polars_by_example(program: Mapping[str, Any]) -> str:
    kind = program["kind"]
    if kind == "column":
        return f"pl.col({program['column']!r})"
    if kind == "literal":
        return f"pl.lit({program.get('value')!r})"
    if kind == "slice":
        start = program["start"]
        stop = program.get("stop")
        length = None if stop is None else stop - start
        return f"{_compile_polars_by_example(program['input'])}.cast(pl.String).str.slice({start!r}, {length!r})"
    if kind == "split":
        return (
            f"{_compile_polars_by_example(program['input'])}.cast(pl.String).str.split({program['delimiter']!r})"
            f".list.get({program['index']!r}, null_on_oob=True)"
        )
    if kind == "concat":
        parts = ", ".join(_compile_polars_by_example(part) for part in program["parts"])
        return f"pl.concat_str([{parts}], separator='')"
    if kind == "regexExtract":
        return (
            f"{_compile_polars_by_example(program['input'])}.cast(pl.String)"
            f".str.extract({program['pattern']!r}, group_index={program['group']!r})"
        )
    if kind == "regexReplace":
        return (
            f"{_compile_polars_by_example(program['input'])}.cast(pl.String)"
            f".str.replace_all({program['pattern']!r}, {program['replacement']!r})"
        )
    if kind == "case":
        value = f"{_compile_polars_by_example(program['input'])}.cast(pl.String)"
        if program["style"] == "lower":
            return f"{value}.str.to_lowercase()"
        if program["style"] == "upper":
            return f"{value}.str.to_uppercase()"
        return f"({value}.str.slice(0, 1).str.to_uppercase() + {value}.str.slice(1).str.to_lowercase())"
    if kind == "datetimeFormat":
        return (
            f"{_compile_polars_by_example(program['input'])}.cast(pl.String)"
            f".str.strptime(pl.Datetime, format={program['inputFormat']!r}, strict=False)"
            f".dt.strftime({program['outputFormat']!r})"
        )
    if kind == "arithmetic":
        symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/"}[program["operator"]]
        return (
            f"({_compile_polars_by_example(program['left'])} {symbol} {_compile_polars_by_example(program['right'])})"
        )
    raise EngineError(f"Unsupported Polars by-example expression: {kind}")


def _polars_valid_value(expression: Any, dtype: Any) -> Any:

    valid = expression.is_not_null()
    return valid & ~expression.is_nan() if dtype.is_float() else valid


def _polars_formula(left: Any, right: Any, operator: str) -> Any:
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


def _polars_aggregation(aggregation: Mapping[str, Any]) -> Any:
    import polars as pl

    expression = pl.col(aggregation["column"])
    operation = aggregation["operation"]
    if operation == "nUnique":
        result = expression.drop_nulls().n_unique()
    elif operation == "count":
        result = expression.count()
    elif operation in {"first", "last"}:
        result = getattr(expression.drop_nulls(), operation)()
    else:
        result = getattr(expression, operation)()
    return result.alias(aggregation["alias"])


def _compile_polars_aggregation(aggregation: Mapping[str, Any]) -> str:
    operation = aggregation["operation"]
    expression = f"pl.col({aggregation['column']!r})"
    if operation in {"nUnique", "first", "last"}:
        expression += ".drop_nulls()"
    method = "n_unique" if operation == "nUnique" else operation
    return f"{expression}.{method}().alias({aggregation['alias']!r})"


def _compile_polars_filter(model: Mapping[str, Any], index: int) -> list[str]:
    column_masks: list[str] = []
    for column_filter in model.get("filters", []):
        column = column_filter["column"]
        expression = f"pl.col({column!r})"
        conditions: list[str] = []
        value_filter = column_filter.get("valueFilter")
        if value_filter and (
            value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
        ):
            parts = []
            if value_filter.get("selectedValues"):
                selected = [str(value) for value in value_filter["selectedValues"]]
                parts.append(f"{expression}.cast(pl.String).is_in({selected!r})")
            if value_filter.get("includeNulls"):
                parts.append(f"{expression}.is_null()")
            if value_filter.get("includeNaN") and column_filter.get("type") == "float":
                parts.append(f"{expression}.is_nan()")
            conditions.append("(" + " | ".join(parts) + ")")
        for predicate in column_filter.get("predicates", []):
            conditions.append(_polars_predicate_expression(expression, predicate, column_filter.get("type")))
        if conditions:
            operator = " | " if column_filter.get("logic") == "or" else " & "
            column_masks.append("(" + operator.join(conditions) + ")")

    lines: list[str] = []
    if column_masks:
        operator = " | " if model.get("logic") == "or" else " & "
        lines.append(f"    _filter_expression_{index} = " + operator.join(column_masks))
        lines.append(f"    df = df.filter(_filter_expression_{index})")
    rules = model.get("sort", [])
    if rules:
        lines.extend(
            [
                f"    df = df.sort({[rule['column'] for rule in rules]!r},",
                f"        descending={[rule.get('direction', 'asc') == 'desc' for rule in rules]!r},",
                f"        nulls_last={[rule.get('nulls', 'last') == 'last' for rule in rules]!r},",
                "        maintain_order=True)",
            ]
        )
    return lines


def _polars_predicate_expression(expression: str, predicate: Mapping[str, Any], column_type: str | None) -> str:
    operator = predicate.get("operator")
    value = predicate.get("value")
    if operator == "equals":
        return f"({expression} == pl.lit({value!r}))"
    if operator == "notEquals":
        return f"({expression} != pl.lit({value!r}))"
    if operator == "contains":
        return f"{expression}.cast(pl.String).str.to_lowercase().str.contains({str(value).lower()!r}, literal=True)"
    if operator == "startsWith":
        return f"{expression}.cast(pl.String).str.starts_with({str(value)!r})"
    if operator == "endsWith":
        return f"{expression}.cast(pl.String).str.ends_with({str(value)!r})"
    if operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[str(operator)]
        return f"({expression} {symbol} pl.lit({value!r}))"
    if operator == "between":
        return f"(({expression} >= pl.lit({value!r})) & ({expression} <= pl.lit({predicate.get('secondValue')!r})))"
    if operator == "isNull":
        return f"{expression}.is_null()"
    if operator == "isNotNull":
        return f"{expression}.is_not_null()"
    if operator == "isNaN":
        return f"{expression}.is_nan()" if column_type == "float" else "pl.lit(False)"
    if operator == "isNotNaN":
        return f"{expression}.is_not_nan()" if column_type == "float" else "pl.lit(True)"
    return f"{expression}.is_not_null()"


def _maybe_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError):
        return None
