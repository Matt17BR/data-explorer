from __future__ import annotations

from collections.abc import Iterable, Mapping
from math import isfinite
from pathlib import Path
from typing import Any, Literal

from .base import (
    DEFAULT_STRIP_CHARACTERS,
    INTERNAL_ROW_ID_PREFIX,
    DataFrameEngine,
    EngineCapabilities,
    EngineError,
    PageColumnProjection,
    boolean_visualization,
    bound_column_name,
    categorical_visualization,
    datetime_visualization,
    ensure_output_columns_available,
    infer_semantic_type,
    normalize_cell,
    normalize_page_projection,
    numeric_visualization,
)

SUMMARY_VISUALIZATION_SAMPLE_LIMIT = 4096
_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_PORTABLE_INTEGER_MAX = 10**38 - 1
_PORTABLE_INTEGER_MIN = -_PORTABLE_INTEGER_MAX
_POLARS_INTEGER_LIMB_BASE = 10**9
_POLARS_INTEGER_LIMB_COUNT = 5


class PolarsEngine(DataFrameEngine):
    name = "polars"
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"file", "notebookVariable", "notebookOutput"}),
        supports_editing=True,
        lazy_file_extensions=frozenset({".csv", ".tsv", ".parquet", ".jsonl"}),
        export_formats=frozenset({"csv", "parquet"}),
        supports_shutdown_interrupt=False,
        supports_request_cancellation=False,
    )

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
                return pl.read_excel(path, sheet_id=sheet + 1, engine="calamine")
            return pl.read_excel(path, sheet_name=sheet, engine="calamine")
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
            return [
                {
                    "id": f"c:{position}",
                    "name": name,
                    "position": position,
                    "rawType": str(dtype),
                    "type": infer_semantic_type(str(dtype)),
                    # A LazyFrame schema has no nullability metadata. Keep
                    # discovery metadata-only and report the conservative
                    # capability instead of profiling every column on open.
                    "nullable": True,
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

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        import polars as pl

        visible = self._visible_columns(frame)
        projection = normalize_page_projection(len(visible), column_projection)
        columns = [visible[position] for position, _identifier in projection]
        column_ids = [identifier for _position, identifier in projection]
        row_id = self._row_id_column(frame)
        selected = [*([row_id] if row_id is not None else []), *columns]
        # A direct engine call may request an empty projection before a private
        # row identity has been attached. Keep one bounded placeholder column
        # in that terminal plan rather than collecting every visible column.
        terminal_columns = selected or visible[:1]
        if isinstance(frame, pl.LazyFrame):
            if total_rows is None:
                total_rows = int(frame.select(pl.len()).collect(engine="streaming").item())
            # Projection must enter the lazy plan before its terminal slice and
            # collect so scan adapters can prune every unneeded output column.
            sliced = (
                frame.select(terminal_columns).slice(offset, limit).collect(engine="streaming")
                if terminal_columns
                else frame.slice(offset, limit).collect(engine="streaming")
            )
        else:
            df = self.normalize(frame)
            sliced = df.select(terminal_columns).slice(offset, limit) if terminal_columns else df.slice(offset, limit)
            if total_rows is None:
                total_rows = int(df.height)
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
            "totalRows": int(total_rows),
            "columnIds": column_ids,
            "rows": rows,
        }

    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            selected = list(columns) if columns is not None else self._visible_columns(frame)
            return self._lazy_summaries(frame, selected)

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
                numeric_series = series.drop_nulls()
                if semantic_type == "float":
                    numeric_series = numeric_series.drop_nans()
                numeric_values = numeric_series.to_list()
                summary["numeric"] = {
                    "min": _maybe_float(numeric_series.min()),
                    "max": _maybe_float(numeric_series.max()),
                    "mean": _maybe_float(numeric_series.mean()),
                    "median": _maybe_float(numeric_series.median()),
                    "std": _maybe_float(numeric_series.std()),
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

    def _lazy_summaries(self, frame: Any, selected: list[str]) -> list[dict[str, Any]]:
        import polars as pl

        if not selected:
            return []

        schema = frame.collect_schema()
        definitions = []
        metric_expressions = [pl.len().alias("__open_wrangler_total")]
        top_queries = []
        for index, column in enumerate(selected):
            raw_type = str(schema[column])
            semantic_type = infer_semantic_type(raw_type)
            prefix = f"__open_wrangler_{index}_"
            expression = pl.col(column)
            valid_expression = expression.drop_nulls()
            if semantic_type == "float":
                valid_expression = valid_expression.drop_nans()
            metric_expressions.extend(
                [
                    expression.null_count().alias(f"{prefix}null"),
                    (expression.is_nan().fill_null(False).sum() if semantic_type == "float" else pl.lit(0)).alias(
                        f"{prefix}nan"
                    ),
                ]
            )
            if semantic_type in {"integer", "float", "decimal"}:
                metric_expressions.extend(
                    [
                        valid_expression.min().alias(f"{prefix}min"),
                        valid_expression.max().alias(f"{prefix}max"),
                        valid_expression.mean().alias(f"{prefix}mean"),
                        valid_expression.median().alias(f"{prefix}median"),
                        valid_expression.std().alias(f"{prefix}std"),
                    ]
                )
            elif semantic_type == "boolean":
                metric_expressions.extend(
                    [
                        (expression == pl.lit(True)).fill_null(False).sum().alias(f"{prefix}true"),
                        (expression == pl.lit(False)).fill_null(False).sum().alias(f"{prefix}false"),
                    ]
                )
            elif semantic_type in {"datetime", "date"}:
                metric_expressions.extend(
                    [
                        expression.min().alias(f"{prefix}min"),
                        expression.max().alias(f"{prefix}max"),
                    ]
                )

            count_name = f"__open_wrangler_count_{index}"
            top_queries.append(
                frame.select(
                    [
                        valid_expression.n_unique().alias("distinct"),
                        valid_expression.value_counts(sort=True, name=count_name).head(10).implode().alias("top"),
                    ]
                )
            )
            definitions.append((column, raw_type, semantic_type, prefix, count_name))

        metrics = frame.select(metric_expressions).collect(engine="streaming").row(0, named=True)
        top_results = self._collect_lazy_top_results(definitions, top_queries)
        total_count = int(metrics["__open_wrangler_total"])

        numeric_sample_queries = []
        numeric_sample_columns = []
        numeric_sampled: dict[str, bool] = {}
        for column, _, semantic_type, prefix, _ in definitions:
            if semantic_type not in {"integer", "float", "decimal"}:
                continue
            valid_count = total_count - int(metrics[f"{prefix}null"]) - int(metrics[f"{prefix}nan"])
            stride = max(
                1, (valid_count + SUMMARY_VISUALIZATION_SAMPLE_LIMIT - 1) // SUMMARY_VISUALIZATION_SAMPLE_LIMIT
            )
            valid_expression = pl.col(column).drop_nulls()
            if semantic_type == "float":
                valid_expression = valid_expression.drop_nans()
            numeric_sample_queries.append(
                frame.select(valid_expression.alias(column))
                .gather_every(stride)
                .head(SUMMARY_VISUALIZATION_SAMPLE_LIMIT)
            )
            numeric_sample_columns.append(column)
            numeric_sampled[column] = valid_count > SUMMARY_VISUALIZATION_SAMPLE_LIMIT
        numeric_samples = {
            column: sample
            for column, sample in zip(
                numeric_sample_columns,
                pl.collect_all(numeric_sample_queries, engine="streaming") if numeric_sample_queries else [],
                strict=True,
            )
        }

        summaries = []
        for index, (column, raw_type, semantic_type, prefix, _) in enumerate(definitions):
            top_values, distinct_count = top_results[index]
            null_count = int(metrics[f"{prefix}null"])
            nan_count = int(metrics[f"{prefix}nan"])
            summary: dict[str, Any] = {
                "column": column,
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": total_count,
                "nullCount": null_count,
                "nanCount": nan_count,
                "distinctCount": distinct_count,
                "topValues": top_values,
            }
            if semantic_type in {"integer", "float", "decimal"}:
                summary["numeric"] = {
                    "min": _maybe_float(metrics[f"{prefix}min"]),
                    "max": _maybe_float(metrics[f"{prefix}max"]),
                    "mean": _maybe_float(metrics[f"{prefix}mean"]),
                    "median": _maybe_float(metrics[f"{prefix}median"]),
                    "std": _maybe_float(metrics[f"{prefix}std"]),
                }
                numeric_sample = numeric_samples.get(column)
                if numeric_sample is None:  # pragma: no cover - guarded by numeric_sample_queries
                    raise EngineError(f"The numeric profile sample for {column} is missing.")
                visualization = numeric_visualization(numeric_sample.get_column(column))
                if numeric_sampled[column]:
                    visualization["sampled"] = True
                    summary["sampled"] = True
                summary["visualization"] = visualization
            elif semantic_type == "boolean":
                summary["visualization"] = {
                    "kind": "boolean",
                    "trueCount": int(metrics[f"{prefix}true"]),
                    "falseCount": int(metrics[f"{prefix}false"]),
                }
            elif semantic_type in {"datetime", "date"}:
                summary["visualization"] = datetime_visualization(metrics[f"{prefix}min"], metrics[f"{prefix}max"])
            else:
                summary["visualization"] = categorical_visualization(top_values, total_count - null_count - nan_count)
            summaries.append(summary)
        return summaries

    def _collect_lazy_top_results(
        self,
        definitions: list[tuple[str, str, str, str, str]],
        queries: list[Any],
    ) -> list[tuple[list[dict[str, Any]], int]]:
        import polars as pl

        try:
            results = pl.collect_all(queries, engine="streaming")
        except Exception:
            results = []
            for definition, query in zip(definitions, queries, strict=True):
                try:
                    results.append(query.collect(engine="streaming"))
                except Exception as error:
                    raise EngineError(
                        f"Polars could not compute exact summary counts for {definition[0]}: {error}"
                    ) from error

        collected = []
        for definition, result in zip(definitions, results, strict=True):
            column, _, semantic_type, _, count_name = definition
            row = result.row(0, named=True)
            top_values = [
                {
                    "value": (
                        normalize_cell(item[column])["display"]
                        if semantic_type in {"list", "struct"}
                        else str(item[column])
                    ),
                    "count": int(item[count_name]),
                }
                for item in row["top"]
                if item[column] is not None
            ]
            collected.append((top_values, int(row["distinct"])))
        return collected

    def _summary_counts(self, series: Any, column: str, semantic_type: str) -> tuple[list[dict[str, Any]], int]:
        valid = series.drop_nulls()
        if semantic_type == "float":
            valid = valid.drop_nans()

        try:
            counts = valid.value_counts(sort=True)
            rows = counts.head(10).iter_rows(named=True)
            top_values = [
                {
                    "value": (
                        normalize_cell(row[column])["display"]
                        if semantic_type in {"list", "struct"}
                        else str(row[column])
                    ),
                    "count": int(row["count"]),
                }
                for row in rows
                if row[column] is not None
            ]
            return top_values, counts.height
        except Exception as error:
            raise EngineError(f"Polars could not compute exact summary counts for {column}: {error}") from error

    def header_stats(self, frame: Any) -> dict[str, Any]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            return self._lazy_header_stats(frame)

        df = self.normalize(frame)
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

    def _lazy_header_stats(self, frame: Any) -> dict[str, Any]:
        import polars as pl

        visible = self._visible_columns(frame)
        if not visible:
            return {"missingCells": 0, "missingRows": 0, "duplicateRows": 0, "missingValuesByColumn": []}

        schema = frame.collect_schema()
        missing_expressions = []
        missing_row_expressions = []
        aliases: list[tuple[str, str]] = []
        for index, column in enumerate(visible):
            alias = f"__open_wrangler_missing_{index}"
            expression = pl.col(column).is_null()
            count = pl.col(column).null_count()
            if infer_semantic_type(str(schema[column])) == "float":
                expression = expression | pl.col(column).is_nan().fill_null(False)
                count = count + pl.col(column).is_nan().fill_null(False).sum()
            missing_expressions.append(count.alias(alias))
            missing_row_expressions.append(expression.fill_null(False))
            aliases.append((column, alias))

        metrics_query = frame.select(
            [
                pl.len().alias("__open_wrangler_rows"),
                pl.any_horizontal(missing_row_expressions).sum().alias("__open_wrangler_missing_rows"),
                *missing_expressions,
            ]
        )
        unique_query = (
            frame.select(visible).unique(maintain_order=False).select(pl.len().alias("__open_wrangler_unique_rows"))
        )
        metrics_frame, unique_frame = pl.collect_all([metrics_query, unique_query], engine="streaming")
        metrics = metrics_frame.row(0, named=True)
        total_rows = int(metrics["__open_wrangler_rows"])
        missing_by_column = [{"column": column, "count": int(metrics[alias])} for column, alias in aliases]
        return {
            "missingCells": sum(item["count"] for item in missing_by_column),
            "missingRows": int(metrics["__open_wrangler_missing_rows"]),
            "duplicateRows": total_rows - int(unique_frame.item()),
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            schema = frame.collect_schema()
            if column not in schema:
                raise EngineError(f"Unknown Polars column: {column}")
            expression = pl.col(column).drop_nulls()
            if infer_semantic_type(str(schema[column])) == "float":
                expression = expression.drop_nans()
            series_df = frame.select(expression)
        else:
            df = self.normalize(frame)
            if column not in df.schema:
                raise EngineError(f"Unknown Polars column: {column}")
            expression = pl.col(column).drop_nulls()
            if infer_semantic_type(str(df.schema[column])) == "float":
                expression = expression.drop_nans()
            series_df = df.select(expression)
        if search:
            series_df = series_df.filter(pl.col(column).cast(pl.Utf8).str.contains(search, literal=True))
        counts = (
            series_df.group_by(column)
            .len(name="count")
            .sort([pl.col("count"), pl.col(column).cast(pl.String)], descending=[True, False])
            .head(limit + 1)
        )
        if isinstance(counts, pl.LazyFrame):
            counts = counts.collect(engine="streaming")
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
            return expr.is_nan().fill_null(False) if column_type == "float" else pl.lit(False)
        if operator == "isNotNaN":
            return expr.is_not_nan().fill_null(True) if column_type == "float" else pl.lit(True)
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
            rules = [{**rule, "column": bound_column_name(rule["column"], kind)} for rule in params["rules"]]
            return self.apply_filter_model(df, {"filters": [], "sort": rules})
        if kind == "filterRows":
            return self.apply_filter_model(df, _bound_polars_filter_model(params["filterModel"]))
        if kind == "dropMissingRows":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]]
                if params.get("columns")
                else self._visible_columns(df)
            )
            if not columns:
                return df
            valid = [_polars_valid_value(pl.col(column), schema[column]) for column in columns]
            expression = pl.any_horizontal(valid) if params.get("how", "any") == "all" else pl.all_horizontal(valid)
            return df.filter(expression)
        if kind == "dropDuplicates":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]]
                if params.get("columns")
                else self._visible_columns(df)
            )
            if not columns:
                return df
            return df.unique(
                subset=columns,
                keep=params.get("keep", "first"),
                maintain_order=True,
            )
        if kind == "selectColumns":
            row_id = self._row_id_column(df)
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            return df.select([*([row_id] if row_id else []), *columns])
        if kind == "dropColumns":
            return df.drop([bound_column_name(column, kind) for column in params["columns"]])
        if kind == "renameColumn":
            return df.rename({bound_column_name(params["column"], kind): params["newName"]})
        if kind == "cloneColumn":
            return df.with_columns(pl.col(bound_column_name(params["column"], kind)).alias(params["newName"]))
        if kind == "castColumn":
            dtype = {
                "string": pl.String,
                "integer": pl.Int64,
                "float": pl.Float64,
                "boolean": pl.Boolean,
                "date": pl.Date,
                "datetime": pl.Datetime,
            }[params["dtype"]]
            return df.with_columns(pl.col(bound_column_name(params["column"], kind)).cast(dtype, strict=False))
        if kind == "formula":
            right = (
                pl.col(bound_column_name(params["rightColumn"], kind))
                if params.get("rightColumn")
                else pl.lit(params["value"])
            )
            expression = _polars_formula(
                pl.col(bound_column_name(params["leftColumn"], kind)), right, params["operator"]
            )
            return df.with_columns(expression.alias(params["newColumn"]))
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return df.with_columns(pl.col(column).cast(pl.String).str.len_chars().alias(params["newColumn"]))
        if kind == "oneHotEncode":
            eager = df.collect(engine="streaming") if isinstance(df, pl.LazyFrame) else df
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            separator = params.get("prefixSeparator", "_")
            generated = [
                (column, value, f"{column}{separator}{value}")
                for column in columns
                for value in sorted(eager.get_column(column).drop_nulls().unique().to_list(), key=str)
                if str(value) and not (isinstance(value, float) and value != value)
            ]
            generated.sort(key=lambda item: item[2])
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
            column = bound_column_name(params["column"], kind)
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
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            expression = pl.col(column).cast(pl.String)
            if kind == "findReplace":
                expression = expression.str.replace_all(
                    params["find"], params["replacement"], literal=not params.get("regex", False)
                )
            elif kind == "stripText":
                expression = expression.str.strip_chars(params.get("characters") or DEFAULT_STRIP_CHARACTERS)
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
            column = bound_column_name(params["column"], kind)
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
            column = bound_column_name(params["column"], kind)
            expression = pl.col(column).cast(pl.Float64, strict=False)
            if kind == "roundNumber":
                expression = expression.round(params.get("decimals", 0))
            elif kind == "floorNumber":
                expression = expression.floor()
            else:
                expression = expression.ceil()
            return df.with_columns(expression.alias(params.get("newColumn", column)))
        if kind == "formatDatetime":
            column = bound_column_name(params["column"], kind)
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            expression = pl.col(column)
            if schema[column].base_type() not in {pl.Datetime, pl.Date}:
                expression = expression.cast(pl.String).str.to_datetime(strict=False)
            return df.with_columns(expression.dt.strftime(params["format"]).alias(params.get("newColumn", column)))
        if kind == "groupBy":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            keys = [bound_column_name(reference, kind) for reference in params["keys"]]
            normalized = df.with_columns(
                [pl.col(key).fill_nan(None).alias(key) if schema[key].is_float() else pl.col(key) for key in keys]
            )
            expressions = [
                _polars_aggregation(aggregation, schema[bound_column_name(aggregation["column"], kind)])
                for aggregation in params["aggregations"]
            ]
            return normalized.group_by(keys, maintain_order=True).agg(expressions)
        if kind == "byExample":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            scalar_checked_integers = _polars_program_uses_uint128(params["program"], schema)
            return df.with_columns(
                _polars_by_example_expression(
                    params["program"],
                    scalar_checked_integers=scalar_checked_integers,
                ).alias(params["newColumn"])
            )
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
        plan = list(steps)
        lines = [
            "from collections import Counter",
            "",
            "import polars as pl",
        ]
        if any(_polars_step_needs_checked_integer_helpers(step) for step in plan):
            lines.extend(
                [
                    "",
                    f"_OW_INTEGER_MAX = {_PORTABLE_INTEGER_MAX}",
                    "_OW_INTEGER_MIN = -_OW_INTEGER_MAX",
                    f"_OW_INTEGER_LIMB_BASE = {_POLARS_INTEGER_LIMB_BASE}",
                    f"_OW_INTEGER_LIMB_COUNT = {_POLARS_INTEGER_LIMB_COUNT}",
                    "",
                    "",
                    "def _ow_checked_integer_sum_parts(parts):",
                    "    total = sum(",
                    "        int(parts[f'_ow_limb_{index}'] or 0) * (_OW_INTEGER_LIMB_BASE ** index)",
                    "        for index in range(_OW_INTEGER_LIMB_COUNT)",
                    "    )",
                    "    if not _OW_INTEGER_MIN <= total <= _OW_INTEGER_MAX:",
                    "        raise ValueError('Open Wrangler integer result exceeds the portable 38-digit envelope.')",
                    "    return total",
                    "",
                    "",
                    "def _ow_checked_integer_sum(expression, dtype):",
                    "    native_type = pl.UInt128 if dtype == pl.UInt128 else pl.Int128",
                    "    remaining = expression if dtype == pl.UInt128 else expression.cast(pl.Int128)",
                    "    base = pl.lit(_OW_INTEGER_LIMB_BASE, dtype=native_type)",
                    "    limbs = []",
                    "    for index in range(_OW_INTEGER_LIMB_COUNT - 1):",
                    "        limbs.append(",
                    "            (remaining % base).cast(pl.Int128).sum().alias(f'_ow_limb_{index}')",
                    "        )",
                    "        remaining = remaining // base",
                    "    limbs.append(",
                    "        remaining.cast(pl.Int128).sum().alias(f'_ow_limb_{_OW_INTEGER_LIMB_COUNT - 1}')",
                    "    )",
                    "    return pl.struct(limbs).map_elements(",
                    "        _ow_checked_integer_sum_parts, return_dtype=pl.Int128, skip_nulls=False",
                    "    )",
                    "",
                    "",
                    "def _ow_checked_integer_value(left, right, operator):",
                    "    if left is None or right is None:",
                    "        return None",
                    "    if operator == 'add':",
                    "        result = int(left) + int(right)",
                    "    elif operator == 'subtract':",
                    "        result = int(left) - int(right)",
                    "    elif operator == 'multiply':",
                    "        result = int(left) * int(right)",
                    "    else:",
                    "        raise ValueError('Unsupported checked integer operator: ' + str(operator))",
                    "    if not _OW_INTEGER_MIN <= result <= _OW_INTEGER_MAX:",
                    "        raise ValueError('Open Wrangler integer result exceeds the portable 38-digit envelope.')",
                    "    return result",
                    "",
                    "",
                    "def _ow_checked_integer_formula_scalar(left, right, operator):",
                    "    return pl.struct(",
                    "        left.alias('_ow_left_operand'), right.alias('_ow_right_operand')",
                    "    ).map_elements(",
                    "        lambda operands: _ow_checked_integer_value(",
                    "            operands['_ow_left_operand'], operands['_ow_right_operand'], operator",
                    "        ),",
                    "        return_dtype=pl.Int128,",
                    "        skip_nulls=False,",
                    "    )",
                    "",
                    "",
                    "def _ow_checked_integer_formula(left, right, operator):",
                    "    integer_type = pl.Int128",
                    "    decimal_type = pl.Decimal(38, 0)",
                    "    left = left.cast(integer_type)",
                    "    right = right.cast(integer_type)",
                    "    zero = pl.lit(0, dtype=integer_type)",
                    "    maximum = pl.lit(_OW_INTEGER_MAX, dtype=integer_type)",
                    "    minimum = pl.lit(_OW_INTEGER_MIN, dtype=integer_type)",
                    "    if operator == 'add':",
                    "        positive = pl.when(right > 0).then(right).otherwise(zero)",
                    "        negative = pl.when(right < 0).then(right).otherwise(zero)",
                    "        safe = ((right <= 0) | (left <= maximum - positive)) & (",
                    "            (right >= 0) | (left >= minimum - negative)",
                    "        )",
                    "    elif operator == 'subtract':",
                    "        positive = pl.when(right > 0).then(right).otherwise(zero)",
                    "        negative = pl.when(right < 0).then(right).otherwise(zero)",
                    "        safe = ((right >= 0) | (left <= maximum + negative)) & (",
                    "            (right <= 0) | (left >= minimum + positive)",
                    "        )",
                    "    elif operator == 'multiply':",
                    "        left_in_range = left.is_between(minimum, maximum)",
                    "        right_in_range = right.is_between(minimum, maximum)",
                    "        left_magnitude = left.clip(_OW_INTEGER_MIN, _OW_INTEGER_MAX).abs()",
                    "        right_magnitude = right.clip(_OW_INTEGER_MIN, _OW_INTEGER_MAX).abs()",
                    "        nonzero = right_magnitude != 0",
                    "        divisor = pl.when(nonzero).then(right_magnitude).otherwise(pl.lit(1, dtype=integer_type))",
                    "        safe = (left == 0) | (right == 0) | (",
                    "            left_in_range & right_in_range & (left_magnitude <= maximum // divisor)",
                    "        )",
                    "    else:",
                    "        raise ValueError('Unsupported checked integer operator: ' + str(operator))",
                    "    safe = safe.fill_null(True)",
                    "    checked_left = pl.when(safe).then(left).otherwise(zero)",
                    "    checked_right = pl.when(safe).then(right).otherwise(zero)",
                    "    result = {",
                    "        'add': checked_left + checked_right,",
                    "        'subtract': checked_left - checked_right,",
                    "        'multiply': checked_left * checked_right,",
                    "    }[operator]",
                    "    return (",
                    "        pl.when(safe)",
                    "        .then(result.cast(pl.String))",
                    "        .otherwise(pl.lit(",
                    "            'Open Wrangler integer result exceeds the portable 38-digit envelope.'))",
                    "        .cast(decimal_type, strict=True)",
                    "        .cast(pl.Int128)",
                    "    )",
                ]
            )
        lines.extend(["", "", "def clean_data(df):"])
        for index, step in enumerate(plan):
            lines.extend(self._compile_step(step, index))
        lines.append("    return df")
        return "\n".join(lines) + "\n"

    def _compile_step(self, step: Mapping[str, Any], index: int) -> list[str]:
        kind = str(step["kind"])
        params = step["params"]
        prefix = "    "
        if kind == "sortRows":
            rules = params["rules"]
            columns = [bound_column_name(rule["column"], kind) for rule in rules]
            return [
                f"{prefix}df = df.sort({columns!r},",
                f"{prefix}    descending={[rule.get('direction', 'asc') == 'desc' for rule in rules]!r},",
                f"{prefix}    nulls_last={[rule.get('nulls', 'last') == 'last' for rule in rules]!r},",
                f"{prefix}    maintain_order=True)",
            ]
        if kind == "filterRows":
            return _compile_polars_filter(_bound_polars_filter_model(params["filterModel"]), index)
        if kind == "dropMissingRows":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            name = f"_columns_{index}"
            schema = f"_schema_{index}"
            horizontal = "all_horizontal" if params.get("how", "any") == "any" else "any_horizontal"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}{name} = {columns!r} or {schema}.names()",
                f"{prefix}if {name}:",
                (
                    f"{prefix}    _valid_{index} = [pl.col(column).is_not_null() & "
                    f"(~pl.col(column).is_nan() if {schema}[column].is_float() else pl.lit(True)) "
                    f"for column in {name}]"
                ),
                f"{prefix}    df = df.filter(pl.{horizontal}(_valid_{index}))",
            ]
        if kind == "dropDuplicates":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            name = f"_duplicate_columns_{index}"
            schema = f"_duplicate_schema_{index}"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}{name} = {columns!r} or {schema}.names()",
                f"{prefix}if {name}:",
                (
                    f"{prefix}    df = df.unique(subset={name}, "
                    f"keep={params.get('keep', 'first')!r}, maintain_order=True)"
                ),
            ]
        if kind == "selectColumns":
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            return [f"{prefix}df = df.select({columns!r})"]
        if kind == "dropColumns":
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            return [f"{prefix}df = df.drop({columns!r})"]
        if kind == "renameColumn":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = df.rename({{{column!r}: {params['newName']!r}}})"]
        if kind == "cloneColumn":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = df.with_columns(pl.col({column!r}).alias({params['newName']!r}))"]
        if kind == "castColumn":
            column = bound_column_name(params["column"], kind)
            dtype = {
                "string": "pl.String",
                "integer": "pl.Int64",
                "float": "pl.Float64",
                "boolean": "pl.Boolean",
                "date": "pl.Date",
                "datetime": "pl.Datetime",
            }[params["dtype"]]
            return [f"{prefix}df = df.with_columns(pl.col({column!r}).cast({dtype}, strict=False))"]
        if kind == "formula":
            left_column = bound_column_name(params["leftColumn"], kind)
            right = (
                f"pl.col({bound_column_name(params['rightColumn'], kind)!r})"
                if params.get("rightColumn")
                else f"pl.lit({params['value']!r})"
            )
            symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%", "power": "**"}[
                params["operator"]
            ]
            return [
                (
                    f"{prefix}df = df.with_columns((pl.col({left_column!r}) {symbol} {right})"
                    f".alias({params['newColumn']!r}))"
                )
            ]
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.String)"
                    f".str.len_chars().alias({params['newColumn']!r}))"
                )
            ]
        if kind == "oneHotEncode":
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            eager = f"_eager_{index}"
            generated = f"_generated_{index}"
            encoded = f"_encoded_{index}"
            base = f"_base_{index}"
            names = f"_generated_names_{index}"
            collisions = f"_collisions_{index}"
            reserved = f"_reserved_{index}"
            return [
                f"{prefix}{eager} = df.collect(engine='streaming') if isinstance(df, pl.LazyFrame) else df",
                (
                    f"{prefix}{generated} = [(column, value, str(column) + "
                    f"{params.get('prefixSeparator', '_')!r} + str(value)) for column in {columns!r} "
                    f"for value in sorted({eager}.get_column(column).drop_nulls().unique().to_list(), key=str) "
                    f"if str(value) and not (isinstance(value, float) and value != value)]"
                ),
                f"{prefix}{generated}.sort(key=lambda item: item[2])",
                f"{prefix}{base} = {eager}.drop({columns!r}) if {params.get('dropOriginal', True)!r} else {eager}",
                f"{prefix}{names} = [name for _, _, name in {generated}]",
                (
                    f"{prefix}{reserved} = [name for name in {names} "
                    f"if name.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    f'"One-hot encoding would create Open Wrangler\'s reserved private row-identity column.")'
                ),
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
            column = bound_column_name(params["column"], kind)
            delimiter = params["delimiter"]
            eager = f"_eager_{index}"
            labels = f"_labels_{index}"
            encoded = f"_encoded_{index}"
            base = f"_base_{index}"
            names = f"_generated_names_{index}"
            collisions = f"_collisions_{index}"
            reserved = f"_reserved_{index}"
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
                    f"{prefix}{reserved} = [name for name in {names} "
                    f"if name.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    f'"Multi-label binarization would create Open Wrangler\'s reserved private row-identity column.")'
                ),
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
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            base = f"pl.col({column!r}).cast(pl.String)"
            if kind == "findReplace":
                expression = (
                    f"{base}.str.replace_all({params['find']!r}, {params['replacement']!r}, "
                    f"literal={not params.get('regex', False)!r})"
                )
            elif kind == "stripText":
                expression = f"{base}.str.strip_chars({params.get('characters') or DEFAULT_STRIP_CHARACTERS!r})"
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
            column = bound_column_name(params["column"], kind)
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
            column = bound_column_name(params["column"], kind)
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
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.String)"
                    f".str.to_datetime(strict=False).dt.strftime({params['format']!r})"
                    f".alias({target!r}))"
                )
            ]
        if kind == "groupBy":
            keys = [bound_column_name(reference, kind) for reference in params["keys"]]
            schema = f"_group_schema_{index}"
            expressions = f"_group_expressions_{index}"
            lines = [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}df = df.with_columns([",
                *[
                    (
                        f"{prefix}    pl.col({key!r}).fill_nan(None).alias({key!r}) "
                        f"if {schema}[{key!r}].is_float() else pl.col({key!r}),"
                    )
                    for key in keys
                ],
                f"{prefix}])",
                f"{prefix}{expressions} = []",
            ]
            for aggregation_index, aggregation in enumerate(params["aggregations"]):
                column = bound_column_name(aggregation["column"], kind)
                value = f"_group_value_{index}_{aggregation_index}"
                lines.extend(
                    [
                        f"{prefix}{value} = pl.col({column!r})",
                        f"{prefix}if {schema}[{column!r}].is_float():",
                        f"{prefix}    {value} = {value}.fill_nan(None)",
                    ]
                )
                if aggregation["operation"] == "sum":
                    lines.extend(
                        [
                            f"{prefix}if {schema}[{column!r}].is_integer():",
                            (
                                f"{prefix}    {expressions}.append(_ow_checked_integer_sum("
                                f"{value}, {schema}[{column!r}])"
                                f".alias({aggregation['alias']!r}))"
                            ),
                            f"{prefix}else:",
                            f"{prefix}    {expressions}.append({_compile_polars_aggregation(aggregation, value)})",
                        ]
                    )
                else:
                    lines.append(f"{prefix}{expressions}.append({_compile_polars_aggregation(aggregation, value)})")
            lines.append(f"{prefix}df = df.group_by({keys!r}, maintain_order=True).agg({expressions})")
            return lines
        if kind == "byExample":
            program = params["program"]
            if not _polars_program_needs_checked_integer_helpers(program):
                expression = _compile_polars_by_example(program)
                return [f"{prefix}df = df.with_columns({expression}.alias({params['newColumn']!r}))"]
            schema = f"_by_example_schema_{index}"
            scalar = f"_by_example_scalar_integer_{index}"
            expression = f"_by_example_expression_{index}"
            column_names = _polars_program_column_names(program)
            native_expression = _compile_polars_by_example(program)
            scalar_expression = _compile_polars_by_example(program, scalar_checked_integers=True)
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                (f"{prefix}{scalar} = any({schema}[name] == pl.UInt128 for name in {column_names!r})"),
                f"{prefix}{expression} = {scalar_expression} if {scalar} else {native_expression}",
                f"{prefix}df = df.with_columns({expression}.alias({params['newColumn']!r}))",
            ]
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


def _polars_by_example_expression(
    program: Mapping[str, Any],
    *,
    scalar_checked_integers: bool = False,
) -> Any:
    import polars as pl

    def child(value: Mapping[str, Any]) -> Any:
        return _polars_by_example_expression(value, scalar_checked_integers=scalar_checked_integers)

    kind = program["kind"]
    if kind == "column":
        return pl.col(bound_column_name(program["column"], "byExample"))
    if kind == "literal":
        return pl.lit(program.get("value"))
    if kind == "slice":
        start = program["start"]
        stop = program.get("stop")
        length = None if stop is None else stop - start
        return child(program["input"]).cast(pl.String).str.slice(start, length)
    if kind == "split":
        return (
            child(program["input"])
            .cast(pl.String)
            .str.split(program["delimiter"])
            .list.get(program["index"], null_on_oob=True)
        )
    if kind == "concat":
        return pl.concat_str([child(part) for part in program["parts"]], separator="")
    if kind == "regexExtract":
        return child(program["input"]).cast(pl.String).str.extract(program["pattern"], group_index=program["group"])
    if kind == "regexReplace":
        replacement = str(program["replacement"]).replace("$", "$$")
        return child(program["input"]).cast(pl.String).str.replace_all(program["pattern"], replacement)
    if kind == "case":
        value = child(program["input"]).cast(pl.String)
        if program["style"] == "lower":
            return value.str.replace_many(list(_ASCII_UPPER), list(_ASCII_LOWER))
        if program["style"] == "upper":
            return value.str.replace_many(list(_ASCII_LOWER), list(_ASCII_UPPER))
        return value.str.slice(0, 1).str.replace_many(list(_ASCII_LOWER), list(_ASCII_UPPER)) + value.str.slice(
            1
        ).str.replace_many(list(_ASCII_UPPER), list(_ASCII_LOWER))
    if kind == "datetimeFormat":
        return (
            child(program["input"])
            .cast(pl.String)
            .str.strptime(pl.Datetime, format=program["inputFormat"], strict=False)
            .dt.strftime(program["outputFormat"])
        )
    if kind == "arithmetic":
        left = child(program["left"])
        right = child(program["right"])
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer:
            if scalar_checked_integers:
                return _polars_checked_integer_formula_scalar(left, right, str(program["operator"]))
            return _polars_checked_integer_formula(left, right, str(program["operator"]))
        return _polars_formula(
            left,
            right,
            program["operator"],
        )
    raise EngineError(f"Unsupported Polars by-example expression: {kind}")


def _compile_polars_by_example(
    program: Mapping[str, Any],
    *,
    scalar_checked_integers: bool = False,
) -> str:
    def child(value: Mapping[str, Any]) -> str:
        return _compile_polars_by_example(value, scalar_checked_integers=scalar_checked_integers)

    kind = program["kind"]
    if kind == "column":
        return f"pl.col({bound_column_name(program['column'], 'byExample')!r})"
    if kind == "literal":
        return f"pl.lit({program.get('value')!r})"
    if kind == "slice":
        start = program["start"]
        stop = program.get("stop")
        length = None if stop is None else stop - start
        return f"{child(program['input'])}.cast(pl.String).str.slice({start!r}, {length!r})"
    if kind == "split":
        return (
            f"{child(program['input'])}.cast(pl.String).str.split({program['delimiter']!r})"
            f".list.get({program['index']!r}, null_on_oob=True)"
        )
    if kind == "concat":
        parts = ", ".join(child(part) for part in program["parts"])
        return f"pl.concat_str([{parts}], separator='')"
    if kind == "regexExtract":
        return (
            f"{child(program['input'])}.cast(pl.String)"
            f".str.extract({program['pattern']!r}, group_index={program['group']!r})"
        )
    if kind == "regexReplace":
        replacement = str(program["replacement"]).replace("$", "$$")
        return f"{child(program['input'])}.cast(pl.String).str.replace_all({program['pattern']!r}, {replacement!r})"
    if kind == "case":
        value = f"{child(program['input'])}.cast(pl.String)"
        if program["style"] == "lower":
            return f"{value}.str.replace_many(list({_ASCII_UPPER!r}), list({_ASCII_LOWER!r}))"
        if program["style"] == "upper":
            return f"{value}.str.replace_many(list({_ASCII_LOWER!r}), list({_ASCII_UPPER!r}))"
        return (
            f"({value}.str.slice(0, 1).str.replace_many(list({_ASCII_LOWER!r}), list({_ASCII_UPPER!r})) + "
            f"{value}.str.slice(1).str.replace_many(list({_ASCII_UPPER!r}), list({_ASCII_LOWER!r})))"
        )
    if kind == "datetimeFormat":
        return (
            f"{child(program['input'])}.cast(pl.String)"
            f".str.strptime(pl.Datetime, format={program['inputFormat']!r}, strict=False)"
            f".dt.strftime({program['outputFormat']!r})"
        )
    if kind == "arithmetic":
        symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/"}[program["operator"]]
        left = child(program["left"])
        right = child(program["right"])
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer:
            if scalar_checked_integers:
                return f"_ow_checked_integer_formula_scalar({left}, {right}, {program['operator']!r})"
            return f"_ow_checked_integer_formula({left}, {right}, {program['operator']!r})"
        return f"({left} {symbol} {right})"
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


def _polars_step_needs_checked_integer_helpers(step: Mapping[str, Any]) -> bool:
    if step.get("kind") == "groupBy":
        params = step.get("params")
        return isinstance(params, Mapping) and any(
            isinstance(aggregation, Mapping) and aggregation.get("operation") == "sum"
            for aggregation in params.get("aggregations", [])
        )
    if step.get("kind") != "byExample":
        return False
    params = step.get("params")
    return isinstance(params, Mapping) and _polars_program_needs_checked_integer_helpers(params.get("program"))


def _polars_program_column_names(value: Any) -> list[str]:
    names: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, Mapping):
            if node.get("kind") == "column" and isinstance(node.get("column"), Mapping):
                name = node["column"].get("name")
                if isinstance(name, str) and name not in names:
                    names.append(name)
                return
            for item in node.values():
                visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(value)
    return names


def _polars_program_uses_uint128(program: Any, schema: Mapping[str, Any]) -> bool:
    import polars as pl

    return any(schema.get(name) == pl.UInt128 for name in _polars_program_column_names(program))


def _polars_program_needs_checked_integer_helpers(value: Any) -> bool:
    if isinstance(value, Mapping):
        if value.get("kind") == "arithmetic" and value.get("_owResultType") == "integer":
            return True
        return any(_polars_program_needs_checked_integer_helpers(item) for item in value.values())
    if isinstance(value, list):
        return any(_polars_program_needs_checked_integer_helpers(item) for item in value)
    return False


def _polars_checked_integer_sum_parts(parts: Mapping[str, Any]) -> int:
    total = sum(
        int(parts[f"_ow_limb_{index}"] or 0) * (_POLARS_INTEGER_LIMB_BASE**index)
        for index in range(_POLARS_INTEGER_LIMB_COUNT)
    )
    if not _PORTABLE_INTEGER_MIN <= total <= _PORTABLE_INTEGER_MAX:
        raise ValueError("Open Wrangler integer result exceeds the portable 38-digit envelope.")
    return total


def _polars_checked_integer_sum(expression: Any, dtype: Any) -> Any:
    """Build an exact, bounded-memory Polars integer sum expression.

    Polars' native Int128 accumulator wraps modulo 2**128, while Decimal(38,
    0) rejects native-wide values before opposite signs can cancel. Splitting
    each value into five base-1e9 limbs lets Polars aggregate a fixed amount of
    native state per group. A single Python finalizer combines those five
    scalars exactly; it never receives or materializes the group's rows.
    """

    import polars as pl

    native_type = pl.UInt128 if dtype == pl.UInt128 else pl.Int128
    remaining = expression if dtype == pl.UInt128 else expression.cast(pl.Int128)
    base = pl.lit(_POLARS_INTEGER_LIMB_BASE, dtype=native_type)
    limbs: list[Any] = []
    for index in range(_POLARS_INTEGER_LIMB_COUNT - 1):
        limbs.append((remaining % base).cast(pl.Int128).sum().alias(f"_ow_limb_{index}"))
        remaining = remaining // base
    limbs.append(remaining.cast(pl.Int128).sum().alias(f"_ow_limb_{_POLARS_INTEGER_LIMB_COUNT - 1}"))
    return pl.struct(limbs).map_elements(
        _polars_checked_integer_sum_parts,
        return_dtype=pl.Int128,
        skip_nulls=False,
    )


def _polars_checked_integer_value(left: Any, right: Any, operator: str) -> int | None:
    if left is None or right is None:
        return None
    if operator == "add":
        result = int(left) + int(right)
    elif operator == "subtract":
        result = int(left) - int(right)
    elif operator == "multiply":
        result = int(left) * int(right)
    else:
        raise EngineError(f"Unsupported checked Polars integer operator: {operator}")
    if not _PORTABLE_INTEGER_MIN <= result <= _PORTABLE_INTEGER_MAX:
        raise ValueError("Open Wrangler integer result exceeds the portable 38-digit envelope.")
    return result


def _polars_checked_integer_formula_scalar(left: Any, right: Any, operator: str) -> Any:
    """Use Python integers only when a UInt128 operand cannot narrow to Int128."""

    import polars as pl

    return pl.struct(
        left.alias("_ow_left_operand"),
        right.alias("_ow_right_operand"),
    ).map_elements(
        lambda operands: _polars_checked_integer_value(
            operands["_ow_left_operand"], operands["_ow_right_operand"], operator
        ),
        return_dtype=pl.Int128,
        skip_nulls=False,
    )


def _polars_checked_integer_formula(left: Any, right: Any, operator: str) -> Any:
    import polars as pl

    integer_type = pl.Int128
    decimal_type = pl.Decimal(38, 0)
    left = left.cast(integer_type)
    right = right.cast(integer_type)
    zero = pl.lit(0, dtype=integer_type)
    maximum = pl.lit(_PORTABLE_INTEGER_MAX, dtype=integer_type)
    minimum = pl.lit(_PORTABLE_INTEGER_MIN, dtype=integer_type)
    if operator == "add":
        positive = pl.when(right > 0).then(right).otherwise(zero)
        negative = pl.when(right < 0).then(right).otherwise(zero)
        safe = ((right <= 0) | (left <= maximum - positive)) & ((right >= 0) | (left >= minimum - negative))
    elif operator == "subtract":
        positive = pl.when(right > 0).then(right).otherwise(zero)
        negative = pl.when(right < 0).then(right).otherwise(zero)
        safe = ((right >= 0) | (left <= maximum + negative)) & ((right <= 0) | (left >= minimum + positive))
    elif operator == "multiply":
        left_in_range = left.is_between(minimum, maximum)
        right_in_range = right.is_between(minimum, maximum)
        left_magnitude = left.clip(_PORTABLE_INTEGER_MIN, _PORTABLE_INTEGER_MAX).abs()
        right_magnitude = right.clip(_PORTABLE_INTEGER_MIN, _PORTABLE_INTEGER_MAX).abs()
        nonzero = right_magnitude != 0
        divisor = pl.when(nonzero).then(right_magnitude).otherwise(pl.lit(1, dtype=integer_type))
        safe = (left == 0) | (right == 0) | (left_in_range & right_in_range & (left_magnitude <= maximum // divisor))
    else:
        raise EngineError(f"Unsupported checked Polars integer operator: {operator}")
    safe = safe.fill_null(True)
    checked_left = pl.when(safe).then(left).otherwise(zero)
    checked_right = pl.when(safe).then(right).otherwise(zero)
    result = {
        "add": checked_left + checked_right,
        "subtract": checked_left - checked_right,
        "multiply": checked_left * checked_right,
    }[operator]
    return (
        pl.when(safe)
        .then(result.cast(pl.String))
        .otherwise(pl.lit("Open Wrangler integer result exceeds the portable 38-digit envelope."))
        .cast(decimal_type, strict=True)
        .cast(pl.Int128)
    )


def _polars_aggregation(aggregation: Mapping[str, Any], dtype: Any) -> Any:
    import polars as pl

    expression = pl.col(bound_column_name(aggregation["column"], "groupBy"))
    if dtype.is_float():
        expression = expression.fill_nan(None)
    operation = aggregation["operation"]
    if operation == "sum" and dtype.is_integer():
        return _polars_checked_integer_sum(expression, dtype).alias(aggregation["alias"])
    if operation == "nUnique":
        result = expression.drop_nulls().n_unique()
    elif operation == "count":
        result = expression.count()
    elif operation in {"first", "last"}:
        result = getattr(expression.drop_nulls(), operation)()
    else:
        result = getattr(expression, operation)()
    return result.alias(aggregation["alias"])


def _compile_polars_aggregation(aggregation: Mapping[str, Any], expression: str | None = None) -> str:
    operation = aggregation["operation"]
    expression = expression or f"pl.col({bound_column_name(aggregation['column'], 'groupBy')!r})"
    if operation in {"nUnique", "first", "last"}:
        expression += ".drop_nulls()"
    method = "n_unique" if operation == "nUnique" else operation
    return f"{expression}.{method}().alias({aggregation['alias']!r})"


def _bound_polars_filter_model(model: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **model,
        "filters": [
            {**column_filter, "column": bound_column_name(column_filter["column"], "filterRows")}
            for column_filter in model.get("filters", [])
        ],
        "sort": [{**rule, "column": bound_column_name(rule["column"], "filterRows")} for rule in model.get("sort", [])],
    }


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
            if not parts:
                parts.append("pl.lit(False)")
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
        return f"{expression}.is_nan().fill_null(False)" if column_type == "float" else "pl.lit(False)"
    if operator == "isNotNaN":
        return f"{expression}.is_not_nan().fill_null(True)" if column_type == "float" else "pl.lit(True)"
    return f"{expression}.is_not_null()"


def _maybe_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError):
        return None
