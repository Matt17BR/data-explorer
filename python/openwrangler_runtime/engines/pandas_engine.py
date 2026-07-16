from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from copy import deepcopy
from datetime import date, datetime, timedelta
from decimal import MAX_EMAX, MIN_EMIN, Decimal, localcontext
from math import isfinite, isnan
from numbers import Integral, Real
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
    bound_column_position,
    categorical_visualization,
    datetime_visualization,
    ensure_output_columns_available,
    infer_semantic_type,
    is_internal_row_id_label,
    normalize_cell,
    normalize_page_projection,
    numeric_visualization,
)

_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_TO_LOWER = str.maketrans(_ASCII_UPPER, _ASCII_LOWER)
_ASCII_TO_UPPER = str.maketrans(_ASCII_LOWER, _ASCII_UPPER)
_INT64_MIN = -(2**63)
_INT64_MAX = (2**63) - 1
_PORTABLE_INTEGER_LIMIT = 10**38


class PandasEngine(DataFrameEngine):
    name = "pandas"
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"file", "notebookVariable", "notebookOutput"}),
        supports_editing=True,
        lazy_file_extensions=frozenset(),
        export_formats=frozenset({"csv", "parquet"}),
        supports_shutdown_interrupt=False,
        supports_request_cancellation=False,
    )

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
            requested_encoding = str(options.get("encoding") or "utf-8").lower()
            lossy_utf8 = requested_encoding == "utf8-lossy"
            return pd.read_csv(
                path,
                sep=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                encoding="utf-8" if lossy_utf8 else requested_encoding,
                encoding_errors="replace" if lossy_utf8 else "strict",
                quotechar=options.get("quoteChar", '"'),
                header=0 if options.get("hasHeader", True) else None,
            )
        if extension == ".parquet":
            return pd.read_parquet(path)
        if extension == ".jsonl":
            return pd.read_json(path, lines=True)
        if extension == ".xlsx":
            return pd.read_excel(path, sheet_name=options.get("sheet", 0), engine="openpyxl")
        if extension == ".xls":
            return pd.read_excel(path, sheet_name=options.get("sheet", 0), engine="xlrd")
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
            _pandas_parquet_frame(df).to_parquet(path, index=False)
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
                "type": _pandas_semantic_type(df.iloc[:, frame_position]),
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
                if value_filter.get("includeNulls"):
                    current = current | _null_mask(series)
                if value_filter.get("includeNaN"):
                    current = current | _nan_mask(series)
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

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        df = self.normalize(frame)
        visible_positions = self._visible_positions(df)
        projection = normalize_page_projection(len(visible_positions), column_projection)
        positions = [visible_positions[position] for position, _identifier in projection]
        column_ids = [identifier for _position, identifier in projection]
        row_id_position = self._row_id_position(df)
        selected_positions = [*([row_id_position] if row_id_position is not None else []), *positions]
        sliced = df.iloc[offset : offset + limit, selected_positions]
        value_offset = 1 if row_id_position is not None else 0
        rows = []
        for row_number, row in enumerate(sliced.itertuples(index=False, name=None), start=offset):
            rows.append(
                {
                    "id": str(row[0]) if row_id_position is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(row[value_offset + index]) for index in range(len(positions))],
                }
            )
        return {
            "offset": offset,
            "limit": limit,
            "totalRows": int(df.shape[0]) if total_rows is None else int(total_rows),
            "columnIds": column_ids,
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
            semantic_type = _pandas_semantic_type(series)
            null_count, nan_count = _missing_value_counts(series, raw_type)
            top_values = [
                {"value": str(index), "count": int(value)}
                for index, value in series.value_counts(dropna=True).head(10).items()
            ]
            summary: dict[str, Any] = {
                "column": str(column),
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": int(len(series)),
                "nullCount": null_count,
                "nanCount": nan_count,
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
        counts = sorted(series.value_counts(sort=False).items(), key=lambda item: (-int(item[1]), str(item[0])))
        values = [{"value": str(index), "count": int(value)} for index, value in counts[:limit]]
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
            return _null_mask(series)
        if operator == "isNotNull":
            return ~_null_mask(series)
        if operator == "isNaN":
            return _nan_mask(series)
        if operator == "isNotNaN":
            return ~_nan_mask(series)
        return ~_null_mask(series)

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        import numpy as np
        import pandas as pd

        df = self.normalize(frame).copy()
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            return self._apply_bound_sort_rules(df, params["rules"], kind)
        if kind == "filterRows":
            return self._apply_bound_filter_model(df, params["filterModel"])
        if kind == "dropMissingRows":
            positions = self._bound_or_all_visible_positions(df, params.get("columns"), kind)
            if not positions:
                return df
            valid = [df.iloc[:, position].notna() for position in positions]
            keep = valid[0]
            for current in valid[1:]:
                keep = keep | current if params.get("how", "any") == "all" else keep & current
            return df.iloc[keep.fillna(False).to_numpy(dtype=bool)]
        if kind == "dropDuplicates":
            keep = params.get("keep", "first")
            positions = self._bound_or_all_visible_positions(df, params.get("columns"), kind)
            if not positions:
                return df
            duplicated = df.iloc[:, positions].duplicated(keep=False if keep == "none" else keep)
            return df.iloc[(~duplicated).to_numpy(dtype=bool)]
        if kind == "selectColumns":
            selected = [self._bound_frame_position(df, column, kind) for column in params["columns"]]
            row_id_position = self._row_id_position(df)
            positions = [*([row_id_position] if row_id_position is not None else []), *selected]
            return df.iloc[:, positions].copy()
        if kind == "dropColumns":
            removed = {self._bound_frame_position(df, column, kind) for column in params["columns"]}
            return df.iloc[:, [position for position in range(df.shape[1]) if position not in removed]].copy()
        if kind == "renameColumn":
            position = self._bound_frame_position(df, params["column"], kind)
            columns = list(df.columns)
            columns[position] = params["newName"]
            df.columns = columns
            return df
        if kind == "cloneColumn":
            position = self._bound_frame_position(df, params["column"], kind)
            return pd.concat([df, df.iloc[:, position].rename(params["newName"])], axis=1)
        if kind == "castColumn":
            position = self._bound_frame_position(df, params["column"], kind)
            series = df.iloc[:, position]
            dtype = params["dtype"]
            if dtype == "date":
                result = pd.to_datetime(series, errors="coerce").dt.date
            elif dtype == "datetime":
                result = pd.to_datetime(series, errors="coerce")
            else:
                result = series.astype(
                    {"string": "string", "integer": "Int64", "float": "Float64", "boolean": "boolean"}[dtype]
                )
            df.isetitem(position, result)
            return df
        if kind == "formula":
            left = df.iloc[:, self._bound_frame_position(df, params["leftColumn"], kind)]
            right = (
                df.iloc[:, self._bound_frame_position(df, params["rightColumn"], kind)]
                if params.get("rightColumn")
                else params["value"]
            )
            result = _pandas_formula(left, right, params["operator"])
            return pd.concat([df, result.rename(params["newColumn"])], axis=1)
        if kind == "textLength":
            position = self._bound_frame_position(df, params["column"], kind)
            result = df.iloc[:, position].astype("string").str.len()
            return pd.concat([df, result.rename(params["newColumn"])], axis=1)
        if kind == "oneHotEncode":
            positions = [self._bound_frame_position(df, column, kind) for column in params["columns"]]
            names = [bound_column_name(column, kind) for column in params["columns"]]
            separator = params.get("prefixSeparator", "_")
            encoded_parts = []
            for position, name in zip(positions, names, strict=True):
                series = df.iloc[:, position]
                values = sorted(pd.unique(series[series.notna()]), key=str)
                encoded_parts.extend(
                    series.eq(value).fillna(False).astype("int8").rename(f"{name}{separator}{value}")
                    for value in values
                    if str(value)
                )
            encoded = pd.concat(encoded_parts, axis=1) if encoded_parts else pd.DataFrame(index=df.index)
            encoded = encoded.iloc[
                :, sorted(range(encoded.shape[1]), key=lambda position: str(encoded.columns[position]))
            ]
            base = (
                df.iloc[:, [position for position in range(df.shape[1]) if position not in set(positions)]].copy()
                if params.get("dropOriginal", True)
                else df
            )
            ensure_output_columns_available(base.columns, encoded.columns, "One-hot encoding")
            return pd.concat([base, encoded], axis=1)
        if kind == "multiLabelBinarize":
            position = self._bound_frame_position(df, params["column"], kind)
            column = bound_column_name(params["column"], kind)
            encoded = df.iloc[:, position].astype("string").fillna("").str.get_dummies(sep=params["delimiter"])
            encoded = encoded.loc[:, [str(name) != "" for name in encoded.columns]]
            encoded = encoded.iloc[:, sorted(range(encoded.shape[1]), key=lambda item: str(encoded.columns[item]))]
            encoded = encoded.add_prefix(params.get("prefix", f"{column}_")).astype("int8")
            base = (
                df.iloc[:, [item for item in range(df.shape[1]) if item != position]].copy()
                if params.get("dropOriginal", False)
                else df
            )
            ensure_output_columns_available(base.columns, encoded.columns, "Multi-label binarization")
            return pd.concat([base, encoded], axis=1)
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            position = self._bound_frame_position(df, params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            series = df.iloc[:, position].astype("string")
            if kind == "findReplace":
                result = series.str.replace(params["find"], params["replacement"], regex=params.get("regex", False))
            elif kind == "stripText":
                result = series.str.strip(params.get("characters") or DEFAULT_STRIP_CHARACTERS)
            elif kind == "splitText":
                result = series.str.split(params["delimiter"], regex=False).str.get(params["index"])
            elif kind == "capitalizeText":
                result = series.map(str.capitalize, na_action="ignore")
            elif kind == "lowerText":
                result = series.map(str.lower, na_action="ignore")
            else:
                result = series.map(str.upper, na_action="ignore")
            if target is None or target == column:
                df.isetitem(position, result)
                return df
            return pd.concat([df, result.rename(target)], axis=1)
        if kind == "minMaxScale":
            position = self._bound_frame_position(df, params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            series: Any = pd.to_numeric(df.iloc[:, position], errors="coerce")
            finite = series.where(np.isfinite(series))
            span = finite.max() - finite.min()
            result = (
                (finite - finite.min()) / span if pd.notna(span) and span != 0 else finite.where(finite.isna(), 0.0)
            )
            if target is None or target == column:
                df.isetitem(position, result)
                return df
            return pd.concat([df, result.rename(target)], axis=1)
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            position = self._bound_frame_position(df, params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            series: Any = pd.to_numeric(df.iloc[:, position], errors="coerce")
            if kind == "roundNumber":
                result = series.round(params.get("decimals", 0))
            elif kind == "floorNumber":
                result = np.floor(series)
            else:
                result = np.ceil(series)
            if target is None or target == column:
                df.isetitem(position, result)
                return df
            return pd.concat([df, result.rename(target)], axis=1)
        if kind == "formatDatetime":
            position = self._bound_frame_position(df, params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            result = pd.to_datetime(df.iloc[:, position], errors="coerce").dt.strftime(params["format"])
            if target is None or target == column:
                df.isetitem(position, result)
                return df
            return pd.concat([df, result.rename(target)], axis=1)
        if kind == "groupBy":
            key_positions = [self._bound_frame_position(df, reference, kind) for reference in params["keys"]]
            aggregations = [
                (
                    self._bound_frame_position(df, aggregation["column"], kind),
                    aggregation["operation"],
                    aggregation["alias"],
                )
                for aggregation in params["aggregations"]
            ]
            return _pandas_group_by_positions(df, key_positions, aggregations)
        if kind == "byExample":
            result = _pandas_by_example_expression(
                df,
                params["program"],
                lambda reference: self._bound_frame_position(df, reference, kind),
            )
            return _pandas_append_result(df, result, params["newColumn"])
        if kind == "customCode":
            # Pandas' documented deep copy still shares Python objects stored in
            # object-dtype cells. Give arbitrary custom code a recursively
            # isolated visible frame so in-place list/dict mutations cannot alter
            # the immutable source, committed plan, or rollback snapshot.
            namespace = {"df": _isolated_object_frame(self._visible_frame(self.normalize(frame))), "pd": pd}
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
        return next((column for column in frame.columns if is_internal_row_id_label(column)), None)

    def _row_id_position(self, frame: Any) -> int | None:
        return next(
            (position for position, column in enumerate(frame.columns) if is_internal_row_id_label(column)),
            None,
        )

    def _visible_positions(self, frame: Any) -> list[int]:
        return [position for position, column in enumerate(frame.columns) if not is_internal_row_id_label(column)]

    def _visible_columns(self, frame: Any) -> list[Any]:
        return [frame.columns[position] for position in self._visible_positions(frame)]

    def _visible_frame(self, frame: Any) -> Any:
        row_id = self._row_id_column(frame)
        return frame.drop(columns=[row_id]) if row_id is not None else frame

    def _bound_frame_position(self, frame: Any, reference: Any, operation: str) -> int:
        visible_position = bound_column_position(reference, operation)
        visible_positions = self._visible_positions(frame)
        if visible_position >= len(visible_positions):
            raise EngineError(f"{operation} references a column outside its input schema.")
        frame_position = visible_positions[visible_position]
        expected_name = bound_column_name(reference, operation)
        if str(frame.columns[frame_position]) != expected_name:
            raise EngineError(f"{operation} column binding no longer matches its input schema.")
        return frame_position

    def _bound_or_all_visible_positions(
        self,
        frame: Any,
        references: Any,
        operation: str,
    ) -> list[int]:
        if not references:
            return self._visible_positions(frame)
        if not isinstance(references, list):
            raise EngineError(f"{operation} requires an array of bound column references.")
        return [self._bound_frame_position(frame, reference, operation) for reference in references]

    def _apply_bound_sort_rules(self, frame: Any, rules: Any, operation: str) -> Any:
        if not isinstance(rules, list) or not rules:
            raise EngineError(f"{operation} requires bound sort rules.")
        result = frame
        for rule in reversed(rules):
            if not isinstance(rule, Mapping):
                raise EngineError(f"{operation} requires bound sort rules.")
            position = self._bound_frame_position(result, rule.get("column"), operation)
            order = (
                result.iloc[:, position]
                .reset_index(drop=True)
                .sort_values(
                    ascending=rule.get("direction", "asc") == "asc",
                    na_position=rule.get("nulls", "last"),
                    kind="stable",
                )
                .index.to_numpy()
            )
            result = result.iloc[order]
        return result

    def _apply_bound_filter_model(self, frame: Any, model: Any) -> Any:
        if not isinstance(model, Mapping):
            raise EngineError("filterRows requires a bound filter model.")
        column_masks = []
        for column_filter in model.get("filters", []):
            if not isinstance(column_filter, Mapping):
                raise EngineError("filterRows requires bound column filters.")
            position = self._bound_frame_position(frame, column_filter.get("column"), "filterRows")
            series = frame.iloc[:, position]
            conditions = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = series.astype(str).isin(selected)
                if value_filter.get("includeNulls"):
                    current = current | _null_mask(series)
                if value_filter.get("includeNaN"):
                    current = current | _nan_mask(series)
                conditions.append(current)
            conditions.extend(self._predicate_mask(series, predicate) for predicate in column_filter["predicates"])
            if conditions:
                mask = conditions[0]
                for condition in conditions[1:]:
                    mask = mask | condition if column_filter.get("logic") == "or" else mask & condition
                column_masks.append(mask)

        filtered = frame
        if column_masks:
            mask = column_masks[0]
            for column_mask in column_masks[1:]:
                mask = mask | column_mask if model.get("logic") == "or" else mask & column_mask
            filtered = frame.iloc[mask.fillna(False).to_numpy(dtype=bool)]
        sort = model.get("sort", [])
        return self._apply_bound_sort_rules(filtered, sort, "filterRows") if sort else filtered

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
        plan = list(steps)
        needs_missing_helpers = any(step["kind"] == "filterRows" for step in plan)
        needs_object_isolation = any(step["kind"] == "customCode" for step in plan)
        needs_nullable_result_helpers = any(step["kind"] in {"groupBy", "byExample"} for step in plan)
        needs_group_helpers = any(step["kind"] == "groupBy" for step in plan)
        lines = ["from collections import Counter"]
        if needs_object_isolation:
            lines.append("from copy import deepcopy")
        if needs_nullable_result_helpers:
            lines.append(
                "from decimal import Decimal" + (", MAX_EMAX, MIN_EMIN, localcontext" if needs_group_helpers else "")
            )
        if needs_missing_helpers:
            lines.append("from numbers import Real")
        lines.extend(["", "import numpy as np", "import pandas as pd", "", ""])
        if needs_missing_helpers:
            lines.extend(
                [
                    "def _open_wrangler_is_null(value):",
                    "    return value is None or type(value).__name__ in {'NAType', 'NaTType'}",
                    "",
                    "",
                    "def _open_wrangler_is_nan(value):",
                    "    try:",
                    "        return (",
                    "            isinstance(value, Real)",
                    "            and not isinstance(value, (bool, np.bool_))",
                    "            and np.isnan(float(str(value)))",
                    "        )",
                    "    except (TypeError, ValueError, OverflowError):",
                    "        return False",
                    "",
                    "",
                    "def _open_wrangler_mask(series, predicate):",
                    (
                        "    return pd.Series([predicate(value) for value in series.array], "
                        "index=series.index, dtype=bool)"
                    ),
                    "",
                    "",
                ]
            )
        if needs_object_isolation:
            lines.extend(
                [
                    "def _open_wrangler_isolate_objects(df):",
                    "    isolated = df.copy(deep=True)",
                    "    memo = {}",
                    "    for position, dtype in enumerate(isolated.dtypes):",
                    "        if str(dtype) == 'object':",
                    "            values = [deepcopy(value, memo) for value in isolated.iloc[:, position].array]",
                    "            isolated.isetitem(position, values)",
                    "    return isolated",
                    "",
                    "",
                ]
            )
        if needs_nullable_result_helpers:
            lines.extend(
                [
                    "def _open_wrangler_float_nan_mask(series):",
                    "    return pd.Series(",
                    "        [isinstance(value, (float, np.floating)) and np.isnan(value) for value in series.array],",
                    "        index=series.index, dtype=bool)",
                    "",
                    "",
                    "def _open_wrangler_nullable_string_copy(series):",
                    "    if isinstance(series.dtype, pd.StringDtype):",
                    "        return series.astype('string')",
                    "    if (",
                    "        pd.api.types.is_object_dtype(series.dtype)",
                    "        or isinstance(series.dtype, pd.CategoricalDtype)",
                    "    ):",
                    "        null_mask = _open_wrangler_float_nan_mask(series)",
                    "        if null_mask.any():",
                    "            result = series.astype(object)",
                    "            result.loc[null_mask] = pd.NA",
                    "            return result",
                    "    return series",
                    "",
                    "",
                    "def _open_wrangler_ordered_aggregate_input(series):",
                    "    if isinstance(series.dtype, (pd.StringDtype, pd.CategoricalDtype)):",
                    "        return series.astype('string')",
                    "    if (",
                    "        pd.api.types.is_object_dtype(series.dtype)",
                    "        and pd.api.types.infer_dtype(series, skipna=True) in {'string', 'unicode', 'empty'}",
                    "    ):",
                    "        return series.astype('string')",
                    "    return series",
                    "",
                    "",
                    "def _open_wrangler_group_nulls(series, null_mask):",
                    "    mask = np.asarray(null_mask, dtype=bool)",
                    "    if not mask.any():",
                    "        return _open_wrangler_nullable_string_copy(series)",
                    "    if pd.api.types.is_float_dtype(series.dtype):",
                    "        values = series.to_numpy(dtype='float64', na_value=np.nan)",
                    "        return pd.Series(",
                    "            pd.arrays.FloatingArray(values, mask), index=series.index, name=series.name)",
                    "    result = _open_wrangler_nullable_string_copy(series)",
                    "    if (",
                    "        pd.api.types.is_object_dtype(result.dtype)",
                    "        or isinstance(result.dtype, pd.CategoricalDtype)",
                    "    ):",
                    "        result = result.astype(object)",
                    "    return result.mask(pd.Series(mask, index=result.index), pd.NA)",
                    "",
                    "",
                    "def _open_wrangler_group_key(series):",
                    "    return _open_wrangler_group_nulls(series, _open_wrangler_float_nan_mask(series))",
                    "",
                    "",
                    "def _open_wrangler_missing_scalar(value):",
                    "    return (",
                    "        value is None or type(value).__name__ in {'NAType', 'NaTType'} or",
                    "        (isinstance(value, (float, np.floating)) and np.isnan(value)) or",
                    "        (isinstance(value, Decimal) and value.is_nan())",
                    "    )",
                    "",
                    "",
                    "def _open_wrangler_integer_scalar(value):",
                    "    return (",
                    "        isinstance(value, (int, np.integer))",
                    "        and not isinstance(value, (bool, np.bool_))",
                    "        and type(value).__name__ != 'timedelta64'",
                    "    )",
                    "",
                    "",
                    "def _open_wrangler_prepare_group_key(series):",
                    "    if not _open_wrangler_is_integer_series(series):",
                    "        return series, None, False",
                    "    sentinel = (",
                    "        object() if any(_open_wrangler_missing_scalar(item) for item in series.array) else None",
                    "    )",
                    "    values = [",
                    "        sentinel if _open_wrangler_missing_scalar(item) else int(item)",
                    "        for item in series.array",
                    "    ]",
                    "    return pd.Series(values, index=series.index, name=series.name, dtype=object), sentinel, True",
                    "",
                    "",
                    "def _open_wrangler_restore_group_key(series, sentinel, integer_key):",
                    "    if not integer_key:",
                    "        return _open_wrangler_group_key(series)",
                    "    values = [pd.NA if item is sentinel else item for item in series.array]",
                    "    restored = pd.Series(values, index=series.index, name=series.name, dtype=object)",
                    "    return _open_wrangler_normalize_integer(restored, enforce_envelope=False)",
                    "",
                    "",
                    "def _open_wrangler_widen_integer(value):",
                    "    if not isinstance(value, pd.Series):",
                    "        return (",
                    "            int(value) if _open_wrangler_integer_scalar(value) else value)",
                    "    normalized = [",
                    "        pd.NA if _open_wrangler_missing_scalar(item) else",
                    "        int(item) if _open_wrangler_integer_scalar(item) else item",
                    "        for item in value.array",
                    "    ]",
                    "    return pd.Series(normalized, index=value.index, name=value.name, dtype=object)",
                    "",
                    "",
                    "def _open_wrangler_float_integer(value):",
                    "    return value.astype('Float64') if isinstance(value, pd.Series) else float(value)",
                    "",
                    "",
                    "def _open_wrangler_is_integer_series(value):",
                    "    if pd.api.types.is_integer_dtype(value.dtype):",
                    "        return True",
                    "    if not pd.api.types.is_object_dtype(value.dtype):",
                    "        return False",
                    "    present = [item for item in value.array if not _open_wrangler_missing_scalar(item)]",
                    "    return bool(present) and all(_open_wrangler_integer_scalar(item) for item in present)",
                    "",
                    "",
                    "def _open_wrangler_normalize_integer(value, enforce_envelope=True):",
                    "    if not isinstance(value, pd.Series):",
                    "        return value",
                    "    present = [item for item in value.array if not _open_wrangler_missing_scalar(item)]",
                    "    if not all(_open_wrangler_integer_scalar(item) for item in present):",
                    "        raise TypeError('Open Wrangler integer arithmetic produced a non-integer value.')",
                    "    normalized = [",
                    "        pd.NA if _open_wrangler_missing_scalar(item) else int(item) for item in value.array",
                    "    ]",
                    "    numbers = [item for item in normalized if item is not pd.NA]",
                    f"    if enforce_envelope and any(abs(item) >= {_PORTABLE_INTEGER_LIMIT!r} for item in numbers):",
                    "        raise OverflowError(",
                    "            'Open Wrangler integer result exceeds the portable 38-digit envelope.')",
                    f"    if not numbers or all({_INT64_MIN!r} <= item <= {_INT64_MAX!r} for item in numbers):",
                    "        return pd.Series(pd.array(normalized, dtype='Int64'), index=value.index, name=value.name)",
                    "    return pd.Series(normalized, index=value.index, name=value.name, dtype=object)",
                    "",
                    "",
                    "def _open_wrangler_integer_aggregate_input(series):",
                    "    values = [",
                    "        None if _open_wrangler_missing_scalar(item) else Decimal(int(item))",
                    "        for item in series.array",
                    "    ]",
                    "    return pd.Series(values, index=series.index, name=series.name, dtype=object)",
                    "",
                    "",
                    "def _open_wrangler_restore_integer_aggregate(series, null_mask):",
                    "    mask = np.asarray(null_mask, dtype=bool)",
                    "    values = []",
                    "    for index, item in enumerate(series.array):",
                    "        if mask[index] or _open_wrangler_missing_scalar(item):",
                    "            values.append(pd.NA)",
                    "        elif isinstance(item, Decimal) and item == item.to_integral_value():",
                    "            values.append(int(item))",
                    "        elif _open_wrangler_integer_scalar(item):",
                    "            values.append(int(item))",
                    "        else:",
                    "            raise TypeError('Open Wrangler integer aggregation produced a non-integer value.')",
                    "    restored = pd.Series(values, index=series.index, name=series.name, dtype=object)",
                    "    return _open_wrangler_normalize_integer(restored, enforce_envelope=False)",
                    "",
                    "",
                    "def _open_wrangler_is_decimal_series(series):",
                    "    present = [item for item in series.array if not _open_wrangler_missing_scalar(item)]",
                    "    return bool(present) and all(isinstance(item, Decimal) for item in present)",
                    "",
                    "",
                    "def _open_wrangler_exact_decimal_sum(series):",
                    "    values = [item for item in series.array if not _open_wrangler_missing_scalar(item)]",
                    "    if not values:",
                    "        return Decimal(0)",
                    "    if not all(isinstance(item, Decimal) for item in values):",
                    "        raise TypeError('Open Wrangler decimal sum received a non-decimal value.')",
                    "    finite = [item for item in values if item.is_finite()]",
                    "    integer_digits = max([max(item.adjusted() + 1, 0) for item in finite] or [1])",
                    "    fractional_digits = max([max(-int(item.as_tuple().exponent), 0) for item in finite] or [0])",
                    "    carry_digits = len(str(max(len(finite), 1))) + 1",
                    "    with localcontext() as context:",
                    "        context.prec = max(38, integer_digits + fractional_digits + carry_digits)",
                    "        context.Emax = MAX_EMAX",
                    "        context.Emin = MIN_EMIN",
                    "        return sum(values, Decimal(0))",
                    "",
                    "",
                    "def _open_wrangler_decimal_zero(series):",
                    "    values = [",
                    "        item for item in series.array",
                    "        if not _open_wrangler_missing_scalar(item)",
                    "        and isinstance(item, Decimal) and item.is_finite()",
                    "    ]",
                    "    exponent = min([int(item.as_tuple().exponent) for item in values] or [0])",
                    "    return Decimal((0, (0,), exponent))",
                    "",
                    "",
                    "def _open_wrangler_float_decimal_aggregate(series, null_mask):",
                    "    mask = np.asarray(null_mask, dtype=bool)",
                    "    values = [",
                    "        pd.NA if mask[index] or _open_wrangler_missing_scalar(item) else float(item)",
                    "        for index, item in enumerate(series.array)",
                    "    ]",
                    "    return pd.Series(pd.array(values, dtype='Float64'), index=series.index, name=series.name)",
                    "",
                    "",
                    "def _open_wrangler_normalize_decimal_sum(series, zero):",
                    "    values = []",
                    "    for item in series.array:",
                    "        if _open_wrangler_missing_scalar(item):",
                    "            values.append(zero)",
                    "        elif isinstance(item, Decimal):",
                    "            values.append(zero if item == 0 else item)",
                    "        elif (",
                    "            _open_wrangler_integer_scalar(item)",
                    "            and item == 0",
                    "        ):",
                    "            values.append(zero)",
                    "        else:",
                    "            raise TypeError('Open Wrangler decimal sum produced a non-decimal value.')",
                    "    return pd.Series(values, index=series.index, name=series.name, dtype=object)",
                    "",
                    "",
                ]
            )
        lines.extend(["def clean_data(df):", "    df = df.copy()"])
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
            lines = []
            for rule_index, rule in enumerate(reversed(rules)):
                position = bound_column_position(rule["column"], kind)
                order = f"_sort_order_{index}_{rule_index}"
                lines.extend(
                    [
                        f"{prefix}{order} = df.iloc[:, {position}].reset_index(drop=True).sort_values(",
                        f"{prefix}    ascending={rule.get('direction', 'asc') == 'asc'!r},",
                        f"{prefix}    na_position={rule.get('nulls', 'last')!r}, kind='stable').index.to_numpy()",
                        f"{prefix}df = df.iloc[{order}]",
                    ]
                )
            return lines
        if kind == "filterRows":
            return _compile_pandas_filter(params["filterModel"], index)
        if kind == "dropMissingRows":
            positions = (
                [bound_column_position(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            return [
                f"{prefix}_missing_positions_{index} = {positions!r} or list(range(df.shape[1]))",
                f"{prefix}if _missing_positions_{index}:",
                (
                    f"{prefix}    _missing_valid_{index} = "
                    f"[df.iloc[:, position].notna() for position in _missing_positions_{index}]"
                ),
                f"{prefix}    _missing_keep_{index} = _missing_valid_{index}[0]",
                f"{prefix}    for _missing_current_{index} in _missing_valid_{index}[1:]:",
                (
                    f"{prefix}        _missing_keep_{index} = _missing_keep_{index} "
                    f"{'|' if params.get('how', 'any') == 'all' else '&'} _missing_current_{index}"
                ),
                (f"{prefix}    df = df.iloc[_missing_keep_{index}.fillna(False).to_numpy(dtype=bool)]"),
            ]
        if kind == "dropDuplicates":
            keep = params.get("keep", "first")
            positions = (
                [bound_column_position(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            return [
                f"{prefix}_duplicate_positions_{index} = {positions!r} or list(range(df.shape[1]))",
                f"{prefix}if _duplicate_positions_{index}:",
                (
                    f"{prefix}    _duplicated_{index} = df.iloc[:, _duplicate_positions_{index}].duplicated("
                    f"keep={False if keep == 'none' else keep!r})"
                ),
                f"{prefix}    df = df.iloc[(~_duplicated_{index}).to_numpy(dtype=bool)]",
            ]
        if kind == "selectColumns":
            positions = [bound_column_position(column, kind) for column in params["columns"]]
            return [f"{prefix}df = df.iloc[:, {positions!r}].copy()"]
        if kind == "dropColumns":
            positions = sorted({bound_column_position(column, kind) for column in params["columns"]})
            return [
                f"{prefix}df = df.iloc[:, [position for position in range(df.shape[1]) "
                f"if position not in {positions!r}]].copy()"
            ]
        if kind == "renameColumn":
            position = bound_column_position(params["column"], kind)
            columns = f"_columns_{index}"
            return [
                f"{prefix}{columns} = list(df.columns)",
                f"{prefix}{columns}[{position}] = {params['newName']!r}",
                f"{prefix}df.columns = {columns}",
            ]
        if kind == "cloneColumn":
            position = bound_column_position(params["column"], kind)
            return [f"{prefix}df = pd.concat([df, df.iloc[:, {position}].rename({params['newName']!r})], axis=1)"]
        if kind == "castColumn":
            position = bound_column_position(params["column"], kind)
            dtype = params["dtype"]
            if dtype == "date":
                expression = f"pd.to_datetime(df.iloc[:, {position}], errors='coerce').dt.date"
                return [f"{prefix}df.isetitem({position}, {expression})"]
            if dtype == "datetime":
                expression = f"pd.to_datetime(df.iloc[:, {position}], errors='coerce')"
                return [f"{prefix}df.isetitem({position}, {expression})"]
            target = {"string": "string", "integer": "Int64", "float": "Float64", "boolean": "boolean"}[dtype]
            return [f"{prefix}df.isetitem({position}, df.iloc[:, {position}].astype({target!r}))"]
        if kind == "formula":
            left_position = bound_column_position(params["leftColumn"], kind)
            right = (
                f"df.iloc[:, {bound_column_position(params['rightColumn'], kind)}]"
                if params.get("rightColumn")
                else repr(params["value"])
            )
            symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%", "power": "**"}[
                params["operator"]
            ]
            return [
                f"{prefix}df = pd.concat([df, "
                f"(df.iloc[:, {left_position}] {symbol} {right}).rename({params['newColumn']!r})], axis=1)"
            ]
        if kind == "textLength":
            position = bound_column_position(params["column"], kind)
            return [
                f"{prefix}df = pd.concat([df, df.iloc[:, {position}].astype('string').str.len()"
                f".rename({params['newColumn']!r})], axis=1)"
            ]
        if kind == "oneHotEncode":
            positions = [bound_column_position(column, kind) for column in params["columns"]]
            names = [bound_column_name(column, kind) for column in params["columns"]]
            pairs = list(zip(positions, names, strict=True))
            parts = f"_encoded_parts_{index}"
            series = f"_encoded_series_{index}"
            values = f"_encoded_values_{index}"
            name = f"_encoded_{index}"
            base = f"_base_{index}"
            generated = f"_generated_{index}"
            collisions = f"_collisions_{index}"
            reserved = f"_reserved_{index}"
            order = f"_encoded_order_{index}"
            return [
                f"{prefix}{parts} = []",
                f"{prefix}for _position_{index}, _column_{index} in {pairs!r}:",
                f"{prefix}    {series} = df.iloc[:, _position_{index}]",
                f"{prefix}    {values} = sorted(pd.unique({series}[{series}.notna()]), key=str)",
                f"{prefix}    {parts}.extend(",
                f"{prefix}        {series}.eq(value).fillna(False).astype('int8')",
                (
                    f"{prefix}        .rename(str(_column_{index}) + "
                    f"{params.get('prefixSeparator', '_')!r} + str(value))"
                ),
                f"{prefix}        for value in {values} if str(value)",
                f"{prefix}    )",
                f"{prefix}{name} = pd.concat({parts}, axis=1) if {parts} else pd.DataFrame(index=df.index)",
                f"{prefix}{order} = sorted(range({name}.shape[1]), key=lambda position: str({name}.columns[position]))",
                f"{prefix}{name} = {name}.iloc[:, {order}]",
                (
                    f"{prefix}{base} = df.iloc[:, [position for position in range(df.shape[1]) "
                    f"if position not in {positions!r}]].copy() if {params.get('dropOriginal', True)!r} else df"
                ),
                f"{prefix}{generated} = [str(column) for column in {name}.columns]",
                (
                    f"{prefix}{reserved} = [column for column in {generated} "
                    f"if column.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    f'"One-hot encoding would create Open Wrangler\'s reserved private row-identity column.")'
                ),
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
            position = bound_column_position(params["column"], kind)
            column = bound_column_name(params["column"], kind)
            name = f"_encoded_{index}"
            base = f"_base_{index}"
            generated = f"_generated_{index}"
            collisions = f"_collisions_{index}"
            reserved = f"_reserved_{index}"
            order = f"_encoded_order_{index}"
            return [
                (
                    f"{prefix}{name} = df.iloc[:, {position}].astype('string').fillna('')"
                    f".str.get_dummies(sep={params['delimiter']!r})"
                ),
                f"{prefix}{name} = {name}.loc[:, [str(column) != '' for column in {name}.columns]]",
                f"{prefix}{order} = sorted(range({name}.shape[1]), key=lambda item: str({name}.columns[item]))",
                f"{prefix}{name} = {name}.iloc[:, {order}]",
                f"{prefix}{name} = {name}.add_prefix({params.get('prefix', f'{column}_')!r}).astype('int8')",
                (
                    f"{prefix}{base} = df.iloc[:, [item for item in range(df.shape[1]) if item != {position}]].copy() "
                    f"if {params.get('dropOriginal', False)!r} else df"
                ),
                f"{prefix}{generated} = [str(column) for column in {name}.columns]",
                (
                    f"{prefix}{reserved} = [column for column in {generated} "
                    f"if column.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    f'"Multi-label binarization would create Open Wrangler\'s reserved private row-identity column.")'
                ),
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
            position = bound_column_position(params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            base = f"df.iloc[:, {position}].astype('string').str"
            if kind == "findReplace":
                expression = (
                    f"{base}.replace({params['find']!r}, {params['replacement']!r}, "
                    f"regex={params.get('regex', False)!r})"
                )
            elif kind == "stripText":
                expression = f"{base}.strip({params.get('characters') or DEFAULT_STRIP_CHARACTERS!r})"
            elif kind == "splitText":
                expression = f"{base}.split({params['delimiter']!r}, regex=False).str.get({params['index']!r})"
            else:
                method = {"capitalizeText": "capitalize", "lowerText": "lower", "upperText": "upper"}[kind]
                expression = f"df.iloc[:, {position}].astype('string').map(str.{method}, na_action='ignore')"
            if target is None or target == column:
                return [f"{prefix}df.isetitem({position}, {expression})"]
            return [f"{prefix}df = pd.concat([df, ({expression}).rename({target!r})], axis=1)"]
        if kind == "minMaxScale":
            position = bound_column_position(params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            name = f"_series_{index}"
            result = f"_scaled_{index}"
            lines = [
                f"{prefix}{name} = pd.to_numeric(df.iloc[:, {position}], errors='coerce')",
                f"{prefix}{name} = {name}.where(np.isfinite({name}))",
                f"{prefix}_span_{index} = {name}.max() - {name}.min()",
                (
                    f"{prefix}{result} = (({name} - {name}.min()) / _span_{index} "
                    f"if pd.notna(_span_{index}) and _span_{index} != 0 "
                    f"else {name}.where({name}.isna(), 0.0))"
                ),
            ]
            if target is None or target == column:
                return [*lines, f"{prefix}df.isetitem({position}, {result})"]
            return [*lines, f"{prefix}df = pd.concat([df, {result}.rename({target!r})], axis=1)"]
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            position = bound_column_position(params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            expression = (
                f"pd.to_numeric(df.iloc[:, {position}], errors='coerce').round({params.get('decimals', 0)!r})"
                if kind == "roundNumber"
                else (
                    f"np.{'floor' if kind == 'floorNumber' else 'ceil'}("
                    f"pd.to_numeric(df.iloc[:, {position}], errors='coerce'))"
                )
            )
            if target is None or target == column:
                return [f"{prefix}df.isetitem({position}, {expression})"]
            return [f"{prefix}df = pd.concat([df, ({expression}).rename({target!r})], axis=1)"]
        if kind == "formatDatetime":
            position = bound_column_position(params["column"], kind)
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn")
            expression = f"pd.to_datetime(df.iloc[:, {position}], errors='coerce').dt.strftime({params['format']!r})"
            if target is None or target == column:
                return [f"{prefix}df.isetitem({position}, {expression})"]
            return [f"{prefix}df = pd.concat([df, ({expression}).rename({target!r})], axis=1)"]
        if kind == "groupBy":
            key_positions = [bound_column_position(reference, kind) for reference in params["keys"]]
            aggregations = [
                (
                    bound_column_position(aggregation["column"], kind),
                    aggregation["operation"],
                    aggregation["alias"],
                )
                for aggregation in params["aggregations"]
            ]
            source = f"_group_source_{index}"
            key_names = list(range(len(key_positions)))
            value_names = list(range(len(key_positions), len(key_positions) + len(aggregations)))
            temporary_names = [*key_names, *value_names]
            named = {
                alias: (value_names[ordinal], "nunique" if operation == "nUnique" else operation)
                for ordinal, (_position, operation, alias) in enumerate(aggregations)
            }
            output_labels = f"_group_labels_{index}"
            grouped = f"_grouped_{index}"
            named_name = f"_group_named_{index}"
            selected_positions = [*key_positions, *(position for position, _operation, _alias in aggregations)]
            lines = [
                f"{prefix}{output_labels} = [df.columns[position] for position in {key_positions!r}]",
                f"{prefix}{source} = pd.concat([df.iloc[:, position] for position in {selected_positions!r}], axis=1)",
                f"{prefix}{source}.columns = {temporary_names!r}",
                f"{prefix}{named_name} = {named!r}",
            ]
            key_states: list[tuple[str, str]] = []
            for key_index, key_name in enumerate(key_names):
                sentinel = f"_group_key_sentinel_{index}_{key_index}"
                integer_key = f"_group_key_integer_{index}_{key_index}"
                prepared = f"_group_key_prepared_{index}_{key_index}"
                key_states.append((sentinel, integer_key))
                lines.extend(
                    [
                        (
                            f"{prefix}{prepared}, {sentinel}, {integer_key} = "
                            f"_open_wrangler_prepare_group_key({source}[{key_name!r}])"
                        ),
                        f"{prefix}{source}.isetitem({key_name!r}, {prepared})",
                    ]
                )
            integer_sum_flags: dict[int, str] = {}
            integer_nullable_flags: dict[int, str] = {}
            decimal_sum_flags: dict[int, str] = {}
            decimal_sum_zeros: dict[int, str] = {}
            decimal_average_flags: dict[int, str] = {}
            for aggregation_index, (_position, operation, _alias) in enumerate(aggregations):
                value_name = value_names[aggregation_index]
                if operation in {"min", "max"}:
                    lines.append(
                        f"{prefix}{source}.isetitem({value_name!r}, "
                        f"_open_wrangler_ordered_aggregate_input({source}[{value_name!r}]))"
                    )
                if operation == "sum":
                    flag = f"_group_integer_sum_{index}_{aggregation_index}"
                    integer_sum_flags[aggregation_index] = flag
                    decimal_flag = f"_group_decimal_sum_{index}_{aggregation_index}"
                    decimal_sum_flags[aggregation_index] = decimal_flag
                    decimal_zero = f"_group_decimal_zero_{index}_{aggregation_index}"
                    decimal_sum_zeros[aggregation_index] = decimal_zero
                    lines.extend(
                        [
                            f"{prefix}{flag} = _open_wrangler_is_integer_series({source}[{value_name!r}])",
                            (
                                f"{prefix}{decimal_flag} = not {flag} and "
                                f"_open_wrangler_is_decimal_series({source}[{value_name!r}])"
                            ),
                            f"{prefix}if {decimal_flag}:",
                            (f"{prefix}    {decimal_zero} = _open_wrangler_decimal_zero({source}[{value_name!r}])"),
                            (
                                f"{prefix}    {named_name}[{_alias!r}] = "
                                f"({value_name!r}, _open_wrangler_exact_decimal_sum)"
                            ),
                            f"{prefix}if {flag}:",
                            (
                                f"{prefix}    {source}.isetitem({value_name!r}, "
                                f"_open_wrangler_widen_integer({source}[{value_name!r}]))"
                            ),
                        ]
                    )
                elif operation in {"min", "max", "first", "last"}:
                    flag = f"_group_integer_nullable_{index}_{aggregation_index}"
                    integer_nullable_flags[aggregation_index] = flag
                    lines.extend(
                        [
                            f"{prefix}{flag} = _open_wrangler_is_integer_series({source}[{value_name!r}])",
                            f"{prefix}if {flag}:",
                            (
                                f"{prefix}    {source}.isetitem({value_name!r}, "
                                f"_open_wrangler_integer_aggregate_input({source}[{value_name!r}]))"
                            ),
                        ]
                    )
                if operation in {"mean", "median"}:
                    flag = f"_group_decimal_average_{index}_{aggregation_index}"
                    decimal_average_flags[aggregation_index] = flag
                    lines.append(f"{prefix}{flag} = _open_wrangler_is_decimal_series({source}[{value_name!r}])")
            lines.extend(
                [
                    f"{prefix}{grouped} = {source}.groupby({key_names!r}, dropna=False, sort=False, observed=True)",
                    f"{prefix}df = {grouped}.agg(**{named_name}).reset_index()",
                    (
                        f"{prefix}df.columns = {output_labels} + "
                        f"{[alias for _position, _operation, alias in aggregations]!r}"
                    ),
                ]
            )
            for aggregation_index, flag in integer_sum_flags.items():
                output_position = len(key_positions) + aggregation_index
                lines.extend(
                    [
                        f"{prefix}if {flag}:",
                        (
                            f"{prefix}    df.isetitem({output_position}, "
                            f"_open_wrangler_normalize_integer(df.iloc[:, {output_position}]))"
                        ),
                    ]
                )
            for aggregation_index, flag in decimal_sum_flags.items():
                output_position = len(key_positions) + aggregation_index
                lines.extend(
                    [
                        f"{prefix}if {flag}:",
                        (
                            f"{prefix}    df.isetitem({output_position}, "
                            f"_open_wrangler_normalize_decimal_sum("
                            f"df.iloc[:, {output_position}], {decimal_sum_zeros[aggregation_index]}))"
                        ),
                    ]
                )
            for output_position, (sentinel, integer_key) in enumerate(key_states):
                lines.append(
                    f"{prefix}df.isetitem({output_position}, _open_wrangler_restore_group_key("
                    f"df.iloc[:, {output_position}], {sentinel}, {integer_key}))"
                )
            for aggregation_index, (_position, operation, _alias) in enumerate(aggregations):
                if operation not in {"mean", "median", "min", "max", "first", "last"}:
                    continue
                output_position = len(key_positions) + aggregation_index
                null_mask = f"_group_nulls_{index}_{aggregation_index}"
                lines.append(
                    f"{prefix}{null_mask} = {grouped}[{value_names[aggregation_index]!r}].count()"
                    ".reset_index(drop=True).eq(0)"
                )
                integer_flag = integer_nullable_flags.get(aggregation_index)
                decimal_flag = decimal_average_flags.get(aggregation_index)
                if integer_flag is not None:
                    lines.extend(
                        [
                            f"{prefix}if {integer_flag}:",
                            (
                                f"{prefix}    df.isetitem({output_position}, "
                                f"_open_wrangler_restore_integer_aggregate("
                                f"df.iloc[:, {output_position}], {null_mask}))"
                            ),
                            f"{prefix}else:",
                            (
                                f"{prefix}    df.isetitem({output_position}, "
                                f"_open_wrangler_group_nulls(df.iloc[:, {output_position}], {null_mask}))"
                            ),
                        ]
                    )
                elif decimal_flag is not None:
                    lines.extend(
                        [
                            f"{prefix}if {decimal_flag}:",
                            (
                                f"{prefix}    df.isetitem({output_position}, "
                                f"_open_wrangler_float_decimal_aggregate("
                                f"df.iloc[:, {output_position}], {null_mask}))"
                            ),
                            f"{prefix}else:",
                            (
                                f"{prefix}    df.isetitem({output_position}, "
                                f"_open_wrangler_group_nulls(df.iloc[:, {output_position}], {null_mask}))"
                            ),
                        ]
                    )
                else:
                    lines.append(
                        f"{prefix}df.isetitem({output_position}, "
                        f"_open_wrangler_group_nulls(df.iloc[:, {output_position}], {null_mask}))"
                    )
            return lines
        if kind == "byExample":
            expression = _compile_pandas_by_example(params["program"])
            result = f"_by_example_result_{index}"
            return [
                f"{prefix}{result} = {expression}",
                f"{prefix}if not isinstance({result}, pd.Series):",
                f"{prefix}    {result} = pd.Series({result}, index=df.index)",
                f"{prefix}df = pd.concat([df, {result}.rename({params['newColumn']!r})], axis=1)",
            ]
        if kind == "customCode":
            function_name = f"_custom_step_{index}"
            code_lines = str(params["code"]).splitlines()
            return [
                f"{prefix}df = _open_wrangler_isolate_objects(df)",
                f"{prefix}def {function_name}(df):",
                *[f"{prefix}    {line}" if line else f"{prefix}    " for line in code_lines],
                f"{prefix}    return result",
                f"{prefix}df = {function_name}(df)",
            ]
        raise EngineError(f"Pandas cannot compile transformation: {kind}")


def _pandas_group_by_positions(
    df: Any,
    key_positions: Sequence[int],
    aggregations: Sequence[tuple[int, str, str]],
) -> Any:
    import pandas as pd

    key_names = list(range(len(key_positions)))
    value_names = list(range(len(key_positions), len(key_positions) + len(aggregations)))
    selected_positions = [*key_positions, *(position for position, _operation, _alias in aggregations)]
    source = pd.concat([df.iloc[:, position] for position in selected_positions], axis=1)
    source.columns = [*key_names, *value_names]
    key_states: list[tuple[object | None, bool]] = []
    for key_name in key_names:
        prepared, sentinel, integer_key = _pandas_prepare_group_key(source[key_name])
        source.isetitem(key_name, prepared)
        key_states.append((sentinel, integer_key))
    integer_sum_indexes: list[int] = []
    integer_nullable_indexes: list[int] = []
    decimal_sum_indexes: list[int] = []
    decimal_sum_zeros: dict[int, Decimal] = {}
    decimal_average_indexes: list[int] = []
    for aggregation_index, (_source_position, operation, _alias) in enumerate(aggregations):
        value_name = value_names[aggregation_index]
        if operation in {"min", "max"}:
            source.isetitem(value_name, _pandas_ordered_aggregate_input(source[value_name]))
        semantic_type = _pandas_semantic_type(source[value_name])
        if operation == "sum" and semantic_type == "integer":
            integer_sum_indexes.append(aggregation_index)
            source.isetitem(value_name, _pandas_widen_integer(source[value_name]))
        elif operation == "sum" and semantic_type == "decimal":
            decimal_sum_indexes.append(aggregation_index)
            decimal_sum_zeros[aggregation_index] = _pandas_decimal_zero(source[value_name])
        elif operation in {"min", "max", "first", "last"} and semantic_type == "integer":
            integer_nullable_indexes.append(aggregation_index)
            source.isetitem(value_name, _pandas_integer_aggregate_input(source[value_name]))
        if operation in {"mean", "median"} and semantic_type == "decimal":
            decimal_average_indexes.append(aggregation_index)
    named: dict[str, tuple[int, str | Callable[[Any], Any]]] = {
        alias: (value_names[index], "nunique" if operation == "nUnique" else operation)
        for index, (_position, operation, alias) in enumerate(aggregations)
    }
    for aggregation_index in decimal_sum_indexes:
        _position, _operation, alias = aggregations[aggregation_index]
        named[alias] = (value_names[aggregation_index], _pandas_exact_decimal_sum)
    grouped = source.groupby(key_names, dropna=False, sort=False, observed=True)
    result = grouped.agg(**named).reset_index()
    result.columns = [df.columns[position] for position in key_positions] + [
        alias for _position, _operation, alias in aggregations
    ]
    for aggregation_index in integer_sum_indexes:
        output_position = len(key_positions) + aggregation_index
        result.isetitem(output_position, _pandas_normalize_integer_result(result.iloc[:, output_position]))
    for aggregation_index in decimal_sum_indexes:
        output_position = len(key_positions) + aggregation_index
        result.isetitem(
            output_position,
            _pandas_normalize_decimal_sum(result.iloc[:, output_position], decimal_sum_zeros[aggregation_index]),
        )
    for output_position, (sentinel, integer_key) in enumerate(key_states):
        result.isetitem(
            output_position,
            _pandas_restore_group_key(result.iloc[:, output_position], sentinel, integer_key),
        )
    for aggregation_index, (_source_position, operation, _alias) in enumerate(aggregations):
        if operation not in {"mean", "median", "min", "max", "first", "last"}:
            continue
        null_mask = grouped[value_names[aggregation_index]].count().reset_index(drop=True).eq(0)
        output_position = len(key_positions) + aggregation_index
        if aggregation_index in integer_nullable_indexes:
            normalized = _pandas_restore_integer_aggregate(result.iloc[:, output_position], null_mask)
        elif aggregation_index in decimal_average_indexes:
            normalized = _pandas_float_decimal_aggregate(result.iloc[:, output_position], null_mask)
        else:
            normalized = _pandas_group_nulls(result.iloc[:, output_position], null_mask)
        result.isetitem(output_position, normalized)
    return result


def _pandas_is_missing_scalar(value: Any) -> bool:
    import numpy as np

    return (
        value is None
        or type(value).__name__ in {"NAType", "NaTType"}
        or (isinstance(value, (float, np.floating)) and np.isnan(value))
        or (isinstance(value, Decimal) and value.is_nan())
    )


def _pandas_is_integer_scalar(value: Any) -> bool:
    return isinstance(value, Integral) and not isinstance(value, bool) and type(value).__name__ != "timedelta64"


def _pandas_integer_values(series: Any) -> list[int] | None:
    values = _pandas_present_values(series)
    if not all(_pandas_is_integer_scalar(value) for value in values):
        return None
    return [int(value) for value in values]


def _pandas_present_values(series: Any) -> list[Any]:
    return [value for value in series.array if not _pandas_is_missing_scalar(value)]


def _pandas_semantic_type(series: Any) -> str:
    import pandas as pd

    semantic_type = infer_semantic_type(str(series.dtype))
    if semantic_type == "string" and pd.api.types.is_object_dtype(series.dtype):
        # Pandas' native classifier is exhaustive but runs in its optimized C
        # path.  It avoids the prior Python materialization without making UI
        # capabilities depend on a potentially misleading sample.
        inferred = pd.api.types.infer_dtype(series, skipna=True)
        inferred_semantic = {
            "boolean": "boolean",
            "integer": "integer",
            "floating": "float",
            "mixed-integer-float": "float",
            "decimal": "decimal",
            "datetime": "datetime",
            "datetime64": "datetime",
            "timedelta": "duration",
            "timedelta64": "duration",
            "bytes": "binary",
        }.get(inferred)
        if inferred_semantic is not None:
            return inferred_semantic
        if inferred in {"mixed", "mixed-integer", "date"}:
            # infer_dtype intentionally groups homogeneous nested Python
            # containers under "mixed", and Pandas 3 can classify otherwise
            # valid object columns containing pd.NaT as mixed/mixed-integer or
            # collapse datetime to date.  Refine only those ambiguous cases
            # with the runtime's exact missing-value semantics.
            values = _pandas_present_values(series)
            if values and all(isinstance(value, bool) for value in values):
                return "boolean"
            if values and all(_pandas_is_integer_scalar(value) for value in values):
                return "integer"
            if values and all(isinstance(value, Real) and not isinstance(value, bool) for value in values):
                return "float"
            if values and all(isinstance(value, Decimal) for value in values):
                return "decimal"
            if values and all(isinstance(value, datetime) for value in values):
                return "datetime"
            if values and all(isinstance(value, date) for value in values):
                return "date"
            if values and all(isinstance(value, timedelta) for value in values):
                return "duration"
            if values and all(isinstance(value, bytes) for value in values):
                return "binary"
            if values and all(isinstance(value, list | tuple) for value in values):
                return "list"
            if values and all(isinstance(value, Mapping) for value in values):
                return "struct"
    return semantic_type


def _pandas_normalize_integer_series(value: Any, *, enforce_envelope: bool) -> Any:
    import pandas as pd

    if not isinstance(value, pd.Series):
        return value
    integer_values = _pandas_integer_values(value)
    if integer_values is None:
        raise EngineError("Pandas integer arithmetic produced a non-integer value.")
    if enforce_envelope and any(abs(number) >= _PORTABLE_INTEGER_LIMIT for number in integer_values):
        raise EngineError("Open Wrangler integer result exceeds the portable 38-digit envelope.")
    normalized = [pd.NA if _pandas_is_missing_scalar(item) else int(item) for item in value.array]
    if not integer_values or all(_INT64_MIN <= number <= _INT64_MAX for number in integer_values):
        array = pd.array(normalized, dtype="Int64")
        return pd.Series(array, index=value.index, name=value.name)
    return pd.Series(normalized, index=value.index, name=value.name, dtype=object)


def _pandas_normalize_integer_result(value: Any) -> Any:
    return _pandas_normalize_integer_series(value, enforce_envelope=True)


def _pandas_preserve_integer_result(value: Any) -> Any:
    return _pandas_normalize_integer_series(value, enforce_envelope=False)


def _pandas_parquet_frame(df: Any) -> Any:
    import pandas as pd

    result = df.copy()
    for position in range(result.shape[1]):
        series = result.iloc[:, position]
        if not pd.api.types.is_object_dtype(series.dtype) or _pandas_semantic_type(series) != "integer":
            continue
        integer_values = _pandas_integer_values(series)
        if not integer_values or all(_INT64_MIN <= number <= _INT64_MAX for number in integer_values):
            continue
        precision = max(len(str(abs(number))) for number in integer_values)
        if precision > 76:
            raise EngineError("Pandas Parquet export supports integer results up to 76 decimal digits.")
        try:
            import pyarrow as pa
        except ImportError as error:
            raise EngineError("Pandas Parquet export requires PyArrow for widened integer columns.") from error
        arrow_type = pa.decimal128(precision, 0) if precision <= 38 else pa.decimal256(precision, 0)
        decimal_values = [None if _pandas_is_missing_scalar(item) else Decimal(int(item)) for item in series.array]
        converted = pd.Series(
            pd.array(decimal_values, dtype=pd.ArrowDtype(arrow_type)),
            index=series.index,
            name=series.name,
        )
        result.isetitem(position, converted)
    return result


def _pandas_float_nan_mask(series: Any) -> Any:
    import numpy as np
    import pandas as pd

    return pd.Series(
        [isinstance(value, (float, np.floating)) and np.isnan(value) for value in series.array],
        index=series.index,
        dtype=bool,
    )


def _pandas_nullable_string_copy(series: Any) -> Any:
    import pandas as pd

    if isinstance(series.dtype, pd.StringDtype):
        return series.astype("string")
    if pd.api.types.is_object_dtype(series.dtype) or isinstance(series.dtype, pd.CategoricalDtype):
        null_mask = _pandas_float_nan_mask(series)
        if null_mask.any():
            result = series.astype(object)
            result.loc[null_mask] = pd.NA
            return result
    return series


def _pandas_ordered_aggregate_input(series: Any) -> Any:
    import pandas as pd

    if isinstance(series.dtype, (pd.StringDtype, pd.CategoricalDtype)):
        return series.astype("string")
    if pd.api.types.is_object_dtype(series.dtype) and pd.api.types.infer_dtype(series, skipna=True) in {
        "string",
        "unicode",
        "empty",
    }:
        return series.astype("string")
    return series


def _pandas_group_nulls(series: Any, null_mask: Any) -> Any:
    import numpy as np
    import pandas as pd

    mask = np.asarray(null_mask, dtype=bool)
    if not mask.any():
        return _pandas_nullable_string_copy(series)
    if pd.api.types.is_float_dtype(series.dtype):
        values = series.to_numpy(dtype="float64", na_value=np.nan)
        return pd.Series(pd.arrays.FloatingArray(values, mask), index=series.index, name=series.name)
    result = _pandas_nullable_string_copy(series)
    if pd.api.types.is_object_dtype(result.dtype) or isinstance(result.dtype, pd.CategoricalDtype):
        result = result.astype(object)
    return result.mask(pd.Series(mask, index=result.index), pd.NA)


def _pandas_group_key(series: Any) -> Any:
    return _pandas_group_nulls(series, _pandas_float_nan_mask(series))


def _pandas_prepare_group_key(series: Any) -> tuple[Any, object | None, bool]:
    import pandas as pd

    if _pandas_semantic_type(series) != "integer":
        return series, None, False
    sentinel = object() if any(_pandas_is_missing_scalar(item) for item in series.array) else None
    values = [sentinel if _pandas_is_missing_scalar(item) else int(item) for item in series.array]
    return pd.Series(values, index=series.index, name=series.name, dtype=object), sentinel, True


def _pandas_restore_group_key(series: Any, sentinel: object | None, integer_key: bool) -> Any:
    import pandas as pd

    if not integer_key:
        return _pandas_group_key(series)
    values = [pd.NA if item is sentinel else item for item in series.array]
    restored = pd.Series(values, index=series.index, name=series.name, dtype=object)
    return _pandas_preserve_integer_result(restored)


def _pandas_integer_aggregate_input(series: Any) -> Any:
    import pandas as pd

    values = [None if _pandas_is_missing_scalar(item) else Decimal(int(item)) for item in series.array]
    return pd.Series(values, index=series.index, name=series.name, dtype=object)


def _pandas_restore_integer_aggregate(series: Any, null_mask: Any) -> Any:
    import numpy as np
    import pandas as pd

    mask = np.asarray(null_mask, dtype=bool)
    values = []
    for index, item in enumerate(series.array):
        if mask[index] or _pandas_is_missing_scalar(item):
            values.append(pd.NA)
        elif (isinstance(item, Decimal) and item == item.to_integral_value()) or _pandas_is_integer_scalar(item):
            values.append(int(item))
        else:
            raise EngineError("Pandas integer aggregation produced a non-integer value.")
    restored = pd.Series(values, index=series.index, name=series.name, dtype=object)
    return _pandas_preserve_integer_result(restored)


def _pandas_float_decimal_aggregate(series: Any, null_mask: Any) -> Any:
    import numpy as np
    import pandas as pd

    mask = np.asarray(null_mask, dtype=bool)
    values = [
        pd.NA if mask[index] or _pandas_is_missing_scalar(item) else float(item)
        for index, item in enumerate(series.array)
    ]
    return pd.Series(pd.array(values, dtype="Float64"), index=series.index, name=series.name)


def _pandas_exact_decimal_sum(series: Any) -> Decimal:
    values = [item for item in series.array if not _pandas_is_missing_scalar(item)]
    if not values:
        return Decimal(0)
    if not all(isinstance(item, Decimal) for item in values):
        raise EngineError("Pandas decimal sum received a non-decimal value.")
    finite = [item for item in values if item.is_finite()]
    integer_digits = max([max(item.adjusted() + 1, 0) for item in finite] or [1])
    fractional_digits = max([max(-int(item.as_tuple().exponent), 0) for item in finite] or [0])
    carry_digits = len(str(max(len(finite), 1))) + 1
    with localcontext() as context:
        context.prec = max(38, integer_digits + fractional_digits + carry_digits)
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return sum(values, Decimal(0))


def _pandas_decimal_zero(series: Any) -> Decimal:
    values = [
        item
        for item in series.array
        if not _pandas_is_missing_scalar(item) and isinstance(item, Decimal) and item.is_finite()
    ]
    exponent = min([int(item.as_tuple().exponent) for item in values] or [0])
    return Decimal((0, (0,), exponent))


def _pandas_normalize_decimal_sum(series: Any, zero: Decimal) -> Any:
    import pandas as pd

    values = []
    for item in series.array:
        if _pandas_is_missing_scalar(item):
            values.append(zero)
        elif isinstance(item, Decimal):
            values.append(zero if item == 0 else item)
        elif _pandas_is_integer_scalar(item) and item == 0:
            values.append(zero)
        else:
            raise EngineError("Pandas decimal sum produced a non-decimal value.")
    return pd.Series(values, index=series.index, name=series.name, dtype=object)


def _pandas_widen_integer(value: Any) -> Any:
    import pandas as pd

    if not isinstance(value, pd.Series):
        return int(value) if _pandas_is_integer_scalar(value) else value
    normalized = [
        pd.NA if _pandas_is_missing_scalar(item) else int(item) if _pandas_is_integer_scalar(item) else item
        for item in value.array
    ]
    return pd.Series(normalized, index=value.index, name=value.name, dtype=object)


def _pandas_float_integer(value: Any) -> Any:
    import pandas as pd

    return value.astype("Float64") if isinstance(value, pd.Series) else float(value)


def _pandas_append_result(df: Any, result: Any, name: str) -> Any:
    import pandas as pd

    series = result if isinstance(result, pd.Series) else pd.Series(result, index=df.index)
    return pd.concat([df, series.rename(name)], axis=1)


def _pandas_by_example_expression(
    df: Any,
    program: Mapping[str, Any],
    resolve_position: Callable[[Any], int],
) -> Any:
    import pandas as pd

    kind = program["kind"]
    if kind == "column":
        return _pandas_nullable_string_copy(df.iloc[:, resolve_position(program["column"])])
    if kind == "literal":
        return program.get("value")
    if kind == "slice":
        value = _pandas_string_expression(df, program["input"], resolve_position)
        return value.str.slice(program["start"], program.get("stop"))
    if kind == "split":
        value = _pandas_string_expression(df, program["input"], resolve_position)
        return value.str.split(program["delimiter"], regex=False).str.get(program["index"])
    if kind == "concat":
        result: Any = pd.Series("", index=df.index, dtype="string")
        for part in program["parts"]:
            value = _pandas_by_example_expression(df, part, resolve_position)
            result = result + (value.astype("string") if hasattr(value, "astype") else str(value))
        return result
    if kind == "regexExtract":
        value = _pandas_string_expression(df, program["input"], resolve_position)
        return value.str.extract(program["pattern"], expand=False)
    if kind == "regexReplace":
        value = _pandas_string_expression(df, program["input"], resolve_position)
        replacement = program["replacement"]
        return value.str.replace(program["pattern"], lambda _match: replacement, regex=True)
    if kind == "case":
        value = _pandas_string_expression(df, program["input"], resolve_position)
        if program["style"] == "lower":
            return value.str.translate(_ASCII_TO_LOWER)
        if program["style"] == "upper":
            return value.str.translate(_ASCII_TO_UPPER)
        return value.str.slice(0, 1).str.translate(_ASCII_TO_UPPER) + value.str.slice(1).str.translate(_ASCII_TO_LOWER)
    if kind == "datetimeFormat":
        value = _pandas_by_example_expression(df, program["input"], resolve_position)
        return (
            pd.to_datetime(value, format=program["inputFormat"], errors="coerce")
            .dt.strftime(program["outputFormat"])
            .astype("string")
        )
    if kind == "arithmetic":
        left = _pandas_by_example_expression(df, program["left"], resolve_position)
        right = _pandas_by_example_expression(df, program["right"], resolve_position)
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer and program.get("_owLeftType") == "integer":
            left = _pandas_widen_integer(left)
        if widens_integer and program.get("_owRightType") == "integer":
            right = _pandas_widen_integer(right)
        if program.get("operator") == "divide" and program.get("_owLeftType") == "integer":
            left = _pandas_float_integer(left)
        if program.get("operator") == "divide" and program.get("_owRightType") == "integer":
            right = _pandas_float_integer(right)
        result = _pandas_formula(
            left,
            right,
            program["operator"],
        )
        return _pandas_normalize_integer_result(result) if widens_integer else result
    raise EngineError(f"Unsupported Pandas by-example expression: {kind}")


def _pandas_string_expression(
    df: Any,
    program: Mapping[str, Any],
    resolve_position: Callable[[Any], int],
) -> Any:
    import pandas as pd

    value = _pandas_by_example_expression(df, program, resolve_position)
    return value.astype("string") if hasattr(value, "astype") else pd.Series(value, index=df.index, dtype="string")


def _compile_pandas_by_example(program: Mapping[str, Any]) -> str:
    kind = program["kind"]
    if kind == "column":
        return (
            f"_open_wrangler_nullable_string_copy(df.iloc[:, {bound_column_position(program['column'], 'byExample')}])"
        )
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
            f"lambda _match: {program['replacement']!r}, regex=True)"
        )
    if kind == "case":
        value = _compile_pandas_string(program["input"])
        if program["style"] == "lower":
            return f"{value}.str.translate(str.maketrans({_ASCII_UPPER!r}, {_ASCII_LOWER!r}))"
        if program["style"] == "upper":
            return f"{value}.str.translate(str.maketrans({_ASCII_LOWER!r}, {_ASCII_UPPER!r}))"
        return (
            f"({value}.str.slice(0, 1).str.translate(str.maketrans({_ASCII_LOWER!r}, {_ASCII_UPPER!r})) + "
            f"{value}.str.slice(1).str.translate(str.maketrans({_ASCII_UPPER!r}, {_ASCII_LOWER!r})))"
        )
    if kind == "datetimeFormat":
        return (
            f"pd.to_datetime({_compile_pandas_by_example(program['input'])}, "
            f"format={program['inputFormat']!r}, errors='coerce').dt.strftime({program['outputFormat']!r})"
            ".astype('string')"
        )
    if kind == "arithmetic":
        symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/"}[program["operator"]]
        left = _compile_pandas_by_example(program["left"])
        right = _compile_pandas_by_example(program["right"])
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer and program.get("_owLeftType") == "integer":
            left = f"_open_wrangler_widen_integer({left})"
        if widens_integer and program.get("_owRightType") == "integer":
            right = f"_open_wrangler_widen_integer({right})"
        if program.get("operator") == "divide" and program.get("_owLeftType") == "integer":
            left = f"_open_wrangler_float_integer({left})"
        if program.get("operator") == "divide" and program.get("_owRightType") == "integer":
            right = f"_open_wrangler_float_integer({right})"
        result = f"({left} {symbol} {right})"
        return f"_open_wrangler_normalize_integer({result})" if widens_integer else result
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
        position = bound_column_position(column_filter["column"], "filterRows")
        series = f"df.iloc[:, {position}]"
        conditions: list[str] = []
        value_filter = column_filter.get("valueFilter")
        if value_filter and (
            value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
        ):
            parts = []
            if value_filter.get("selectedValues"):
                parts.append(f"{series}.astype(str).isin({[str(value) for value in value_filter['selectedValues']]!r})")
            if value_filter.get("includeNulls"):
                parts.append(f"_open_wrangler_mask({series}, _open_wrangler_is_null)")
            if value_filter.get("includeNaN"):
                parts.append(f"_open_wrangler_mask({series}, _open_wrangler_is_nan)")
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
        lines.append(f"    df = df.iloc[_filter_mask_{index}.fillna(False).to_numpy(dtype=bool)]")
    rules = model.get("sort", [])
    if rules:
        for rule_index, rule in enumerate(reversed(rules)):
            position = bound_column_position(rule["column"], "filterRows")
            order = f"_filter_sort_order_{index}_{rule_index}"
            lines.extend(
                [
                    f"    {order} = df.iloc[:, {position}].reset_index(drop=True).sort_values(",
                    f"        ascending={rule.get('direction', 'asc') == 'asc'!r},",
                    f"        na_position={rule.get('nulls', 'last')!r}, kind='stable').index.to_numpy()",
                    f"    df = df.iloc[{order}]",
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
    if operator == "isNull":
        return f"_open_wrangler_mask({series}, _open_wrangler_is_null)"
    if operator == "isNotNull":
        return f"~_open_wrangler_mask({series}, _open_wrangler_is_null)"
    if operator == "isNaN":
        return f"_open_wrangler_mask({series}, _open_wrangler_is_nan)"
    if operator == "isNotNaN":
        return f"~_open_wrangler_mask({series}, _open_wrangler_is_nan)"
    return f"~_open_wrangler_mask({series}, _open_wrangler_is_null)"


def _maybe_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _missing_value_counts(series: Any, raw_type: str) -> tuple[int, int]:
    del raw_type
    return int(_null_mask(series).sum()), int(_nan_mask(series).sum())


def _null_mask(series: Any) -> Any:
    return _scalar_mask(series, _is_null_value)


def _nan_mask(series: Any) -> Any:
    return _scalar_mask(series, _is_nan_value)


def _scalar_mask(series: Any, predicate: Any) -> Any:
    return type(series)([predicate(value) for value in series.array], index=series.index, dtype=bool)


def _is_null_value(value: Any) -> bool:
    return value is None or type(value).__name__ in {"NAType", "NaTType"}


def _is_nan_value(value: Any) -> bool:
    if not isinstance(value, Real) or isinstance(value, bool):
        return False
    try:
        return isnan(float(str(value)))
    except (TypeError, ValueError, OverflowError):
        return False


def _isolated_object_frame(frame: Any) -> Any:
    isolated = frame.copy(deep=True)
    memo: dict[int, Any] = {}
    for position, dtype in enumerate(isolated.dtypes):
        if str(dtype) != "object":
            continue
        try:
            values = [deepcopy(value, memo) for value in isolated.iloc[:, position].array]
        except Exception as error:
            column = isolated.columns[position]
            raise EngineError(f"Could not isolate Python objects in Pandas column {column!r}: {error}") from error
        isolated.isetitem(position, values)
    return isolated
