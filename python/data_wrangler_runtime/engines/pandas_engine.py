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


class PandasEngine(DataFrameEngine):
    name = "pandas"

    def detect(self, value: Any) -> bool:
        try:
            import pandas as pd
        except ImportError:
            return False
        return isinstance(value, (pd.DataFrame, pd.Series))

    def read_file(self, path: str) -> Any:
        import pandas as pd

        extension = Path(path).suffix.lower()
        if extension == ".csv":
            return pd.read_csv(path)
        if extension == ".tsv":
            return pd.read_csv(path, sep="\t")
        if extension == ".parquet":
            return pd.read_parquet(path)
        if extension == ".jsonl":
            return pd.read_json(path, lines=True)
        if extension in {".xlsx", ".xls"}:
            return pd.read_excel(path)
        raise EngineError(f"Unsupported file extension for Pandas backend: {extension}")

    def normalize(self, value: Any) -> Any:
        import pandas as pd

        if isinstance(value, pd.Series):
            return value.to_frame()
        return value

    def shape(self, frame: Any) -> dict[str, int]:
        df = self.normalize(frame)
        return {"rows": int(df.shape[0]), "columns": int(df.shape[1])}

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        return [
            {
                "name": str(column),
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(df[column].isna().any()),
            }
            for column, dtype in df.dtypes.items()
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        df = self.normalize(frame)
        filtered = df
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in filtered.columns:
                continue
            mask = None
            value_filter = column_filter.get("valueFilter")
            if value_filter:
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = filtered[column].astype(str).isin(selected)
                if value_filter.get("includeNulls"):
                    current = current | filtered[column].isna()
                mask = current if mask is None else mask & current

            for predicate in column_filter.get("predicates", []):
                current = self._predicate_mask(filtered[column], predicate)
                mask = current if mask is None else mask & current

            if mask is not None:
                filtered = filtered[mask]

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
                    "rowNumber": row_number,
                    "values": [normalize_cell(row[column]) for column in columns],
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
            return series.astype(str).str.contains(str(value), case=False, na=False)
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
        return series.notna()


def _maybe_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None
