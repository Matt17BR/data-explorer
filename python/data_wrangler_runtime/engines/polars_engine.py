from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

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


class PolarsEngine(DataFrameEngine):
    name = "polars"

    def detect(self, value: Any) -> bool:
        try:
            import polars as pl
        except ImportError:
            return False
        return isinstance(value, (pl.DataFrame, pl.LazyFrame, pl.Series))

    def read_file(self, path: str) -> Any:
        import polars as pl

        extension = Path(path).suffix.lower()
        if extension == ".csv":
            return pl.read_csv(path)
        if extension == ".tsv":
            return pl.read_csv(path, separator="\t")
        if extension == ".parquet":
            return pl.read_parquet(path)
        if extension == ".jsonl":
            return pl.read_ndjson(path)
        if extension in {".xlsx", ".xls"}:
            return pl.read_excel(path)
        raise EngineError(f"Unsupported file extension for Polars backend: {extension}")

    def normalize(self, value: Any) -> Any:
        import polars as pl

        if isinstance(value, pl.Series):
            return value.to_frame()
        if isinstance(value, pl.LazyFrame):
            return value.collect()
        return value

    def shape(self, frame: Any) -> dict[str, int]:
        df = self.normalize(frame)
        rows, columns = df.shape
        return {"rows": int(rows), "columns": int(columns)}

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        null_counts = df.null_count().to_dicts()[0] if df.height else {column: 0 for column in df.columns}
        return [
            {
                "name": name,
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(null_counts.get(name, 0) > 0),
            }
            for name, dtype in df.schema.items()
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        import polars as pl

        df = self.normalize(frame)
        expressions = []
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in df.columns:
                continue

            column_expression = None
            value_filter = column_filter.get("valueFilter")
            if value_filter:
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = pl.col(column).cast(pl.Utf8).is_in(selected) if selected else pl.lit(False)
                if value_filter.get("includeNulls"):
                    current = current | pl.col(column).is_null()
                if value_filter.get("includeNaN"):
                    current = current | pl.col(column).is_nan()
                column_expression = current if column_expression is None else column_expression & current

            for predicate in column_filter.get("predicates", []):
                current = self._predicate_expr(column, predicate)
                column_expression = current if column_expression is None else column_expression & current

            if column_expression is not None:
                expressions.append(column_expression)

        if expressions:
            combined = expressions[0]
            for expression in expressions[1:]:
                combined = combined & expression
            df = df.filter(combined)

        sort_rules = [rule for rule in model.get("sort", []) if rule.get("column") in df.columns]
        if sort_rules:
            df = df.sort(
                [rule["column"] for rule in sort_rules],
                descending=[rule.get("direction", "asc") == "desc" for rule in sort_rules],
                nulls_last=sort_rules[0].get("nulls", "last") == "last",
            )
        return df

    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
        df = self.normalize(frame)
        sliced = df.slice(offset, limit)
        columns = list(df.columns)
        rows = []
        for row_number, row in enumerate(sliced.iter_rows(named=True), start=offset):
            rows.append(
                {
                    "rowNumber": row_number,
                    "values": [normalize_cell(row.get(column)) for column in columns],
                }
            )
        return {
            "offset": offset,
            "limit": limit,
            "totalRows": int(df.height),
            "rows": rows,
        }

    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        import polars as pl

        df = self.normalize(frame)
        selected = list(columns) if columns is not None else list(df.columns)
        null_counts = df.select([pl.col(column).null_count().alias(column) for column in selected]).to_dicts()[0]
        summaries = []
        for column in selected:
            series = df[column]
            raw_type = str(series.dtype)
            semantic_type = infer_semantic_type(raw_type)
            top_values = series.drop_nulls().value_counts(sort=True).head(10).iter_rows(named=True)
            summary: dict[str, Any] = {
                "column": column,
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": int(df.height),
                "nullCount": int(null_counts.get(column, 0)),
                "nanCount": self._nan_count(series),
                "distinctCount": int(series.n_unique()),
                "topValues": [
                    {"value": str(row[column]), "count": int(row["count"])}
                    for row in top_values
                    if row[column] is not None
                ],
            }
            if semantic_type in {"integer", "float"}:
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

    def header_stats(self, frame: Any) -> dict[str, Any]:
        import polars as pl

        df = self.normalize(frame)
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
            "duplicateRows": int(df.is_duplicated().sum()) if df.height else 0,
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        import polars as pl

        df = self.normalize(frame)
        series_df = df.select(pl.col(column).drop_nulls())
        if search:
            series_df = series_df.filter(pl.col(column).cast(pl.Utf8).str.contains(search, literal=True))
        counts = series_df[column].value_counts(sort=True).head(limit + 1)
        values = [
            {"value": str(row[column]), "count": int(row["count"])} for row in counts.head(limit).iter_rows(named=True)
        ]
        return values, counts.height > limit

    def _predicate_expr(self, column: str, predicate: Mapping[str, Any]) -> Any:
        import polars as pl

        operator = predicate.get("operator")
        value = predicate.get("value")
        expr = pl.col(column)
        if operator == "equals":
            return expr == value
        if operator == "notEquals":
            return expr != value
        if operator == "contains":
            return expr.cast(pl.Utf8).str.contains(str(value), literal=True)
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
        return expr.is_not_null()

    def _nan_count(self, series: Any) -> int:
        try:
            return int(series.is_nan().sum())
        except Exception:
            return 0


def _maybe_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None
