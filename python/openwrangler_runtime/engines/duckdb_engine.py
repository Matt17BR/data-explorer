from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from math import isfinite, isinf, isnan
from pathlib import Path
from threading import RLock
from typing import Any, Literal, cast

from .base import (
    INTERNAL_ROW_ID_PREFIX,
    DataFrameEngine,
    EngineCapabilities,
    EngineError,
    PageColumnProjection,
    bound_column_name,
    categorical_visualization,
    datetime_visualization,
    ensure_output_columns_available,
    normalize_cell,
    normalize_page_projection,
    numeric_visualization,
)

SUMMARY_VISUALIZATION_SAMPLE_LIMIT = 4096


class DuckDBEngine(DataFrameEngine):
    """Native, lazy DuckDB relation adapter.

    The engine-owned connection only constructs immutable relation plans. Every
    terminal read replays the relation's self-contained SQL on a fresh
    connection. File-backed sessions can therefore profile and page in parallel
    without sharing a DuckDB cursor or connection.
    """

    name = "duckdb"
    capabilities = EngineCapabilities(
        # A relation may be detected for custom-code validation, but notebook
        # ownership is deliberately not advertised until host/kernel lifecycle
        # semantics are implemented and accepted independently.
        source_kinds=frozenset({"file"}),
        supports_editing=True,
        lazy_file_extensions=frozenset({".csv", ".tsv", ".parquet", ".jsonl"}),
        export_formats=frozenset({"csv", "parquet"}),
        supports_shutdown_interrupt=True,
        supports_request_cancellation=False,
    )

    def __init__(self) -> None:
        self._connection: Any | None = None
        self._active_connections: set[Any] = set()
        self._lifecycle_lock = RLock()
        self._closed = False

    def detect(self, value: Any) -> bool:
        try:
            import duckdb
        except ImportError:
            return False
        return isinstance(value, duckdb.DuckDBPyRelation)

    def normalize(self, value: Any) -> Any:
        if not self.detect(value):
            raise EngineError("DuckDB sessions require a DuckDBPyRelation.")
        return value

    def interrupt(self) -> None:
        with self._lifecycle_lock:
            connections = [connection for connection in [self._connection, *self._active_connections] if connection]
        for connection in connections:
            try:
                connection.interrupt()
            except Exception:
                # Interrupt is best-effort. The correlated request remains the
                # authority for whether work completed or was cancelled.
                continue

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                return
            self._closed = True
            connection = self._connection
            self._connection = None
        if connection is not None:
            connection.close()

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        options = options or {}
        extension = Path(path).suffix.lower()
        connection = self._owned_connection()
        try:
            if extension in {".csv", ".tsv"}:
                encoding = str(options.get("encoding", "utf-8")).lower().replace("_", "-")
                if encoding not in {"utf-8", "utf8"}:
                    raise EngineError(
                        f"DuckDB supports UTF-8 CSV input, not {encoding}. Use the Pandas backend for this encoding."
                    )
                return connection.read_csv(
                    path,
                    delimiter=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                    encoding="utf-8",
                    quotechar=options.get("quoteChar", '"'),
                    header=options.get("hasHeader", True),
                )
            if extension == ".parquet":
                return connection.read_parquet(path)
            if extension == ".jsonl":
                try:
                    return connection.read_json(path, format="newline_delimited")
                except Exception as error:
                    raise EngineError(
                        "DuckDB JSON support is unavailable in this interpreter. "
                        "Install a compatible DuckDB build explicitly; Open Wrangler will not fetch extensions."
                    ) from error
            if extension in {".xlsx", ".xls"}:
                raise EngineError("DuckDB does not support Excel input. Use the Pandas or Polars backend.")
            raise EngineError(f"Unsupported file extension for DuckDB backend: {extension}")
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB could not open {path}: {error}") from error

    def shape(self, frame: Any) -> dict[str, int]:
        row_count = int(self._terminal_scalar(frame, "SELECT count(*) FROM ow") or 0)
        return {"rows": row_count, "columns": len(self._visible_columns(frame))}

    def validate_column_addressability(self, frame: Any) -> None:
        """DuckDB SQL identifiers cannot distinguish names by case alone."""

        by_casefold: dict[str, str] = {}
        for column in self._visible_columns(self.normalize(frame)):
            folded = column.casefold()
            previous = by_casefold.get(folded)
            if previous is not None:
                raise EngineError(
                    "DuckDB cannot safely address columns whose names differ only by case: "
                    f"{previous!r} and {column!r}. Rename one column or use Pandas/Polars."
                )
            by_casefold[folded] = column

    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        frame = self.normalize(frame)
        if self._row_id_column(frame) is not None:
            return frame
        row_id = f"{INTERNAL_ROW_ID_PREFIX}{token}"
        return self._relation(frame, f"SELECT *, row_number() OVER () - 1 AS {_quote_ident(row_id)} FROM ow")

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        type_by_column = dict(zip(self._columns(frame), frame.types, strict=True))
        return [
            {
                "id": f"c:{position}",
                "name": column,
                "position": position,
                "rawType": str(type_by_column[column]),
                "type": _semantic_type(str(type_by_column[column])),
                # DuckDB relation metadata does not carry reliable nullability.
                # Opening must remain metadata-only rather than profiling each
                # source column.
                "nullable": True,
            }
            for position, column in enumerate(visible)
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        frame = self.normalize(frame)
        query = _filter_query(self._columns(frame), model)
        return self._relation(frame, query)

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        frame = self.normalize(frame)
        if offset < 0 or limit < 0:
            raise EngineError("DuckDB page offset and limit must be non-negative.")
        visible = self._visible_columns(frame)
        projection = normalize_page_projection(len(visible), column_projection)
        selected_columns = [visible[position] for position, _identifier in projection]
        column_ids = [identifier for _position, identifier in projection]
        row_id = self._row_id_column(frame)
        terminal_columns = [*([row_id] if row_id is not None else []), *selected_columns]
        # DuckDB has no empty SELECT list. Session frames always have a private
        # row identity, while this literal preserves direct zero-column paging.
        select_list = _identifier_list(terminal_columns) if terminal_columns else "1 AS __ow_page_placeholder"
        with self._terminal_connection(frame) as (connection, source_sql):
            if total_rows is None:
                total_rows = int(_execute_scalar(connection, source_sql, "SELECT count(*) FROM ow") or 0)
            records = _execute_rows(
                connection,
                source_sql,
                f"SELECT {select_list} FROM ow LIMIT {int(limit)} OFFSET {int(offset)}",
            )
        rows = []
        for row_number, record in enumerate(records, start=offset):
            identity = record[0] if row_id is not None else row_number
            value_offset = 1 if row_id is not None else 0
            rows.append(
                {
                    "id": f"r:{row_id}:{identity}" if row_id is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(record[value_offset + index]) for index in range(len(selected_columns))],
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
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        selected = [str(column) for column in columns] if columns is not None else visible
        unknown = [column for column in selected if column not in visible]
        if unknown:
            raise EngineError(f"Unknown DuckDB column: {unknown[0]}")
        if not selected:
            return []

        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        summaries: list[dict[str, Any]] = []
        with self._terminal_connection(frame) as (connection, source_sql):
            total_count = int(_execute_scalar(connection, source_sql, "SELECT count(*) FROM ow") or 0)
            for column in selected:
                identifier = _quote_ident(column)
                raw_type = types[column]
                semantic_type = _semantic_type(raw_type)
                nan = _nan_predicate(identifier, raw_type)
                valid = _valid_predicate(identifier, raw_type)
                metrics = _execute_rows(
                    connection,
                    source_sql,
                    "SELECT "
                    f"count(*) FILTER (WHERE {identifier} IS NULL), "
                    f"count(*) FILTER (WHERE {nan}), "
                    f"count(DISTINCT {identifier}) FILTER (WHERE {valid}) "
                    "FROM ow",
                )[0]
                null_count, nan_count, distinct_count = (int(value or 0) for value in metrics)
                top_rows = _execute_rows(
                    connection,
                    source_sql,
                    f"SELECT {identifier}, count(*) AS value_count FROM ow "
                    f"WHERE {valid} GROUP BY {identifier} "
                    f"ORDER BY value_count DESC, CAST({identifier} AS VARCHAR) ASC LIMIT 10",
                )
                top_values = [
                    {"value": normalize_cell(value)["display"], "count": int(count)} for value, count in top_rows
                ]
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
                    numeric = _execute_rows(
                        connection,
                        source_sql,
                        f"SELECT min({identifier}), max({identifier}), avg({identifier}), "
                        f"median({identifier}), stddev_samp({identifier}) FROM ow WHERE {valid}",
                    )[0]
                    summary["numeric"] = {
                        "min": _finite_float(numeric[0]),
                        "max": _finite_float(numeric[1]),
                        "mean": _finite_float(numeric[2]),
                        "median": _finite_float(numeric[3]),
                        "std": _finite_float(numeric[4]),
                    }
                    sample_rows = _execute_rows(
                        connection,
                        source_sql,
                        f"SELECT {identifier} FROM ow WHERE {valid} LIMIT {SUMMARY_VISUALIZATION_SAMPLE_LIMIT}",
                    )
                    visualization = numeric_visualization(row[0] for row in sample_rows)
                    valid_count = total_count - null_count - nan_count
                    if valid_count > SUMMARY_VISUALIZATION_SAMPLE_LIMIT:
                        visualization["sampled"] = True
                        summary["sampled"] = True
                    summary["visualization"] = visualization
                elif semantic_type == "boolean":
                    counts = _execute_rows(
                        connection,
                        source_sql,
                        f"SELECT count(*) FILTER (WHERE {identifier} IS TRUE), "
                        f"count(*) FILTER (WHERE {identifier} IS FALSE) FROM ow",
                    )[0]
                    summary["visualization"] = {
                        "kind": "boolean",
                        "trueCount": int(counts[0] or 0),
                        "falseCount": int(counts[1] or 0),
                    }
                elif semantic_type in {"datetime", "date"}:
                    bounds = _execute_rows(
                        connection,
                        source_sql,
                        f"SELECT min({identifier}), max({identifier}) FROM ow WHERE {identifier} IS NOT NULL",
                    )[0]
                    summary["visualization"] = datetime_visualization(bounds[0], bounds[1])
                else:
                    summary["visualization"] = categorical_visualization(
                        top_values, total_count - null_count - nan_count
                    )
                summaries.append(summary)
        return summaries

    def header_stats(self, frame: Any) -> dict[str, Any]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        if not visible:
            rows = int(self._terminal_scalar(frame, "SELECT count(*) FROM ow") or 0)
            return {
                "missingCells": 0,
                "missingRows": 0,
                "duplicateRows": max(0, rows - 1),
                "missingValuesByColumn": [],
            }
        missing_expressions = [
            f"({_quote_ident(column)} IS NULL OR {_nan_predicate(_quote_ident(column), types[column])})"
            for column in visible
        ]
        projections = ", ".join(f"count(*) FILTER (WHERE {expression})" for expression in missing_expressions)
        missing_row_expression = " OR ".join(missing_expressions)
        group_columns = ", ".join(_quote_ident(column) for column in visible)
        with self._terminal_connection(frame) as (connection, source_sql):
            counts = _execute_rows(
                connection,
                source_sql,
                f"SELECT {projections}, count(*) FILTER (WHERE {missing_row_expression}) FROM ow",
            )[0]
            duplicate_rows = int(
                _execute_scalar(
                    connection,
                    source_sql,
                    "SELECT coalesce(sum(group_count - 1), 0) FROM "
                    f"(SELECT count(*) AS group_count FROM ow GROUP BY {group_columns}) AS groups",
                )
                or 0
            )
        per_column = [int(value or 0) for value in counts[:-1]]
        return {
            "missingCells": sum(per_column),
            "missingRows": int(counts[-1] or 0),
            "duplicateRows": duplicate_rows,
            "missingValuesByColumn": [
                {"column": column, "count": count} for column, count in zip(visible, per_column, strict=True)
            ],
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        if column not in visible:
            raise EngineError(f"Unknown DuckDB column: {column}")
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        identifier = _quote_ident(column)
        conditions = [_valid_predicate(identifier, types[column])]
        if search:
            conditions.append(f"contains(lower(CAST({identifier} AS VARCHAR)), lower({_sql_literal(str(search))}))")
        query = (
            f"SELECT {identifier}, count(*) AS value_count FROM ow WHERE {' AND '.join(conditions)} "
            f"GROUP BY {identifier} ORDER BY value_count DESC, CAST({identifier} AS VARCHAR) ASC "
            f"LIMIT {int(limit) + 1}"
        )
        rows = self._terminal_rows(frame, query)
        values = [{"value": normalize_cell(value)["display"], "count": int(count)} for value, count in rows[:limit]]
        return values, len(rows) > limit

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        frame = self.normalize(frame)
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            return self.apply_filter_model(frame, {"filters": [], "sort": params["rules"]})
        if kind == "filterRows":
            return self.apply_filter_model(frame, params["filterModel"])
        if kind == "dropMissingRows":
            return self._drop_missing(frame, params.get("columns"), params.get("how", "any"))
        if kind == "dropDuplicates":
            return self._drop_duplicates(frame, params.get("columns"), params.get("keep", "first"))
        if kind == "selectColumns":
            row_id = self._row_id_column(frame)
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            selected = [*([row_id] if row_id else []), *columns]
            return self._relation(frame, f"SELECT {_identifier_list(selected)} FROM ow")
        if kind == "dropColumns":
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            return self._relation(frame, f"SELECT * EXCLUDE ({_identifier_list(columns)}) FROM ow")
        if kind == "renameColumn":
            column = bound_column_name(params["column"], kind)
            return self._relation(
                frame,
                f"SELECT * RENAME ({_quote_ident(column)} AS {_quote_ident(params['newName'])}) FROM ow",
            )
        if kind == "cloneColumn":
            column = bound_column_name(params["column"], kind)
            return self._assign(frame, params["newName"], _quote_ident(column))
        if kind == "castColumn":
            target_type = {
                "string": "VARCHAR",
                "integer": "BIGINT",
                "float": "DOUBLE",
                "boolean": "BOOLEAN",
                "date": "DATE",
                "datetime": "TIMESTAMP",
            }[params["dtype"]]
            column = bound_column_name(params["column"], kind)
            return self._assign(frame, column, f"try_cast({_quote_ident(column)} AS {target_type})")
        if kind == "formula":
            right = (
                _quote_ident(bound_column_name(params["rightColumn"], kind))
                if params.get("rightColumn")
                else _sql_literal(params["value"])
            )
            left = bound_column_name(params["leftColumn"], kind)
            expression = _formula_expression(_quote_ident(left), right, params["operator"])
            return self._assign(frame, params["newColumn"], expression)
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return self._assign(
                frame,
                params["newColumn"],
                f"length(CAST({_quote_ident(column)} AS VARCHAR))",
            )
        if kind == "oneHotEncode":
            return self._one_hot(frame, params)
        if kind == "multiLabelBinarize":
            return self._multi_label(frame, params)
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            return self._text_transform(frame, kind, params)
        if kind == "minMaxScale":
            return self._min_max(frame, params["column"], params.get("newColumn", params["column"]))
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            target = params.get("newColumn", column)
            value = f"try_cast({_quote_ident(column)} AS DOUBLE)"
            if kind == "roundNumber":
                expression = f"round_even({value}, {int(params.get('decimals', 0))})"
            elif kind == "floorNumber":
                expression = f"floor({value})"
            else:
                expression = f"ceil({value})"
            return self._assign(frame, target, expression)
        if kind == "formatDatetime":
            column = params["column"]
            return self._assign(
                frame,
                params.get("newColumn", column),
                f"strftime(try_cast({_quote_ident(column)} AS TIMESTAMP), {_sql_literal(params['format'])})",
            )
        if kind == "groupBy":
            return self._group_by(frame, params)
        if kind == "byExample":
            return self._assign(frame, params["newColumn"], _by_example_expression(params["program"]))
        if kind == "customCode":
            visible = self._visible_relation(frame)
            import duckdb

            namespace: dict[str, Any] = {"df": visible, "duckdb": duckdb}
            try:
                exec(params["code"], namespace, namespace)
            except Exception as error:
                raise EngineError(f"Custom DuckDB code failed: {error}") from error
            result = namespace.get("result")
            if not self.detect(result):
                raise EngineError("Custom DuckDB code must assign a DuckDBPyRelation to result.")
            # Re-home the returned SQL on the engine connection so subsequent
            # plans stay portable even if custom code used duckdb.sql().
            return self._relation_from_sql(cast(Any, result).sql_query())
        raise EngineError(f"DuckDB does not implement transformation: {kind}")

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        lines = [_GENERATED_HELPERS.rstrip(), "", "", "def clean_data(df):"]
        for index, step in enumerate(steps):
            lines.extend(self._compile_step(step, index))
        lines.append("    return df")
        return "\n".join(lines) + "\n"

    def export_data(self, frame: Any, path: str, format_name: Literal["csv", "parquet"]) -> None:
        if format_name not in self.capabilities.export_formats:
            raise EngineError(f"Unsupported DuckDB export format: {format_name}")
        frame = self.normalize(frame)
        row_id = self._row_id_column(frame)
        query = "SELECT * FROM ow" if row_id is None else f"SELECT * EXCLUDE ({_quote_ident(row_id)}) FROM ow"
        try:
            with self._terminal_connection(frame) as (connection, source_sql):
                relation = connection.sql(_compose_sql(source_sql, query))
                if format_name == "csv":
                    relation.write_csv(path)
                else:
                    relation.write_parquet(path)
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB {format_name} export failed: {error}") from error

    def _compile_step(self, step: Mapping[str, Any], index: int) -> list[str]:
        kind = str(step["kind"])
        params = step["params"]
        prefix = "    "
        if kind == "sortRows":
            return [f"{prefix}df = _ow_query(df, {_filter_query([], {'filters': [], 'sort': params['rules']})!r})"]
        if kind == "filterRows":
            # The runtime helper receives the current columns so unknown saved
            # filters remain ignorable after an earlier drop/rename step.
            return [f"{prefix}df = _ow_filter(df, {dict(params['filterModel'])!r})"]
        if kind == "dropMissingRows":
            return [f"{prefix}df = _ow_drop_missing(df, {params.get('columns')!r}, {params.get('how', 'any')!r})"]
        if kind == "dropDuplicates":
            return [f"{prefix}df = _ow_drop_duplicates(df, {params.get('columns')!r}, {params.get('keep', 'first')!r})"]
        if kind == "selectColumns":
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            return [f"{prefix}df = _ow_select(df, {columns!r})"]
        if kind == "dropColumns":
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            return [f"{prefix}df = _ow_query(df, 'SELECT * EXCLUDE (' + _ow_identifiers({columns!r}) + ') FROM ow')"]
        if kind == "renameColumn":
            column = bound_column_name(params["column"], kind)
            return [
                f"{prefix}df = _ow_query(df, 'SELECT * RENAME (' + _ow_ident({column!r}) "
                f"+ ' AS ' + _ow_ident({params['newName']!r}) + ') FROM ow')"
            ]
        if kind == "cloneColumn":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = _ow_assign(df, {params['newName']!r}, _ow_ident({column!r}))"]
        if kind == "castColumn":
            target = {
                "string": "VARCHAR",
                "integer": "BIGINT",
                "float": "DOUBLE",
                "boolean": "BOOLEAN",
                "date": "DATE",
                "datetime": "TIMESTAMP",
            }[params["dtype"]]
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = _ow_assign(df, {column!r}, 'try_cast(' + _ow_ident({column!r}) + ' AS {target})')"]
        if kind == "formula":
            right = (
                f"_ow_ident({bound_column_name(params['rightColumn'], kind)!r})"
                if params.get("rightColumn")
                else f"_ow_literal({params['value']!r})"
            )
            left = bound_column_name(params["leftColumn"], kind)
            return [
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, "
                f"_ow_formula(_ow_ident({left!r}), {right}, {params['operator']!r}))"
            ]
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return [
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, "
                f"'length(CAST(' + _ow_ident({column!r}) + ' AS VARCHAR))')"
            ]
        if kind == "oneHotEncode":
            return [f"{prefix}df = _ow_one_hot(df, {dict(params)!r})"]
        if kind == "multiLabelBinarize":
            return [f"{prefix}df = _ow_multi_label(df, {dict(params)!r})"]
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            return [f"{prefix}df = _ow_text(df, {kind!r}, {dict(params)!r})"]
        if kind == "minMaxScale":
            return [
                f"{prefix}df = _ow_min_max(df, {params['column']!r}, {params.get('newColumn', params['column'])!r})"
            ]
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = params["column"]
            target = params.get("newColumn", column)
            value = f"try_cast({_quote_ident(column)} AS DOUBLE)"
            expression = (
                f"round_even({value}, {int(params.get('decimals', 0))})"
                if kind == "roundNumber"
                else f"{'floor' if kind == 'floorNumber' else 'ceil'}({value})"
            )
            return [f"{prefix}df = _ow_assign(df, {target!r}, {expression!r})"]
        if kind == "formatDatetime":
            column = params["column"]
            expression = f"strftime(try_cast({_quote_ident(column)} AS TIMESTAMP), {_sql_literal(params['format'])})"
            return [f"{prefix}df = _ow_assign(df, {params.get('newColumn', column)!r}, {expression!r})"]
        if kind == "groupBy":
            return [f"{prefix}df = _ow_group_by(df, {dict(params)!r})"]
        if kind == "byExample":
            return [
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, {_by_example_expression(params['program'])!r})"
            ]
        if kind == "customCode":
            function_name = f"_custom_step_{index}"
            code_lines = str(params["code"]).splitlines()
            return [
                f"{prefix}df = _ow_visible_relation(df)",
                f"{prefix}def {function_name}(df):",
                *[f"{prefix}    {line}" if line else f"{prefix}    " for line in code_lines],
                f"{prefix}    return result",
                f"{prefix}df = {function_name}(df)",
                f"{prefix}if not isinstance(df, duckdb.DuckDBPyRelation):",
                f"{prefix}    raise ValueError('Custom DuckDB code must assign a DuckDBPyRelation to result.')",
            ]
        raise EngineError(f"DuckDB cannot compile transformation: {kind}")

    def _owned_connection(self) -> Any:
        with self._lifecycle_lock:
            if self._closed:
                raise EngineError("The DuckDB engine is closed.")
            if self._connection is None:
                self._connection = _connect()
            return self._connection

    def _relation(self, frame: Any, query: str) -> Any:
        return self._relation_from_sql(_compose_sql(frame.sql_query(), query))

    def _relation_from_sql(self, sql: str) -> Any:
        try:
            return self._owned_connection().sql(sql)
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB query failed: {error}") from error

    @contextmanager
    def _terminal_connection(self, frame: Any) -> Iterator[tuple[Any, str]]:
        with self._lifecycle_lock:
            if self._closed:
                raise EngineError("The DuckDB engine is closed.")
        connection = _connect()
        with self._lifecycle_lock:
            if self._closed:
                connection.close()
                raise EngineError("The DuckDB engine is closed.")
            self._active_connections.add(connection)
        try:
            yield connection, frame.sql_query()
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB query failed: {error}") from error
        finally:
            with self._lifecycle_lock:
                self._active_connections.discard(connection)
            connection.close()

    def _terminal_rows(self, frame: Any, query: str) -> list[tuple[Any, ...]]:
        with self._terminal_connection(frame) as (connection, source_sql):
            return _execute_rows(connection, source_sql, query)

    def _terminal_scalar(self, frame: Any, query: str) -> Any:
        with self._terminal_connection(frame) as (connection, source_sql):
            return _execute_scalar(connection, source_sql, query)

    def _columns(self, frame: Any) -> list[str]:
        return [str(column) for column in frame.columns]

    def _row_id_column(self, frame: Any) -> str | None:
        return next((column for column in self._columns(frame) if column.startswith(INTERNAL_ROW_ID_PREFIX)), None)

    def _visible_columns(self, frame: Any) -> list[str]:
        return [column for column in self._columns(frame) if not column.startswith(INTERNAL_ROW_ID_PREFIX)]

    def _visible_relation(self, frame: Any) -> Any:
        row_id = self._row_id_column(frame)
        if row_id is None:
            return frame
        return self._relation(frame, f"SELECT * EXCLUDE ({_quote_ident(row_id)}) FROM ow")

    def _assign(self, frame: Any, target: str, expression: str) -> Any:
        modifier = (
            f"* REPLACE ({expression} AS {_quote_ident(target)})"
            if target in self._columns(frame)
            else f"*, {expression} AS {_quote_ident(target)}"
        )
        return self._relation(frame, f"SELECT {modifier} FROM ow")

    def _drop_missing(self, frame: Any, columns: Any, how: str) -> Any:
        selected = list(columns) if columns else self._visible_columns(frame)
        if not selected:
            return frame
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        valid = [_valid_predicate(_quote_ident(column), types[column]) for column in selected]
        operator = " AND " if how == "any" else " OR "
        return self._relation(frame, f"SELECT * FROM ow WHERE {operator.join(f'({item})' for item in valid)}")

    def _drop_duplicates(self, frame: Any, columns: Any, keep: str) -> Any:
        selected = list(columns) if columns else self._visible_columns(frame)
        if not selected:
            return frame
        order_name = _unique_internal(self._columns(frame), "__ow_dupe_order")
        rank_name = _unique_internal([*self._columns(frame), order_name], "__ow_dupe_rank")
        count_name = _unique_internal([*self._columns(frame), order_name, rank_name], "__ow_dupe_count")
        partition = _identifier_list(selected)
        direction = "DESC" if keep == "last" else "ASC"
        predicate = f"{_quote_ident(count_name)} = 1" if keep == "none" else f"{_quote_ident(rank_name)} = 1"
        query = (
            f"WITH numbered AS (SELECT *, row_number() OVER () AS {_quote_ident(order_name)} FROM ow), "
            f"ranked AS (SELECT *, row_number() OVER (PARTITION BY {partition} "
            f"ORDER BY {_quote_ident(order_name)} {direction}) AS {_quote_ident(rank_name)}, "
            f"count(*) OVER (PARTITION BY {partition}) AS {_quote_ident(count_name)} FROM numbered) "
            f"SELECT * EXCLUDE ({_identifier_list([order_name, rank_name, count_name])}) FROM ranked "
            f"WHERE {predicate} ORDER BY {_quote_ident(order_name)}"
        )
        return self._relation(frame, query)

    def _one_hot(self, frame: Any, params: Mapping[str, Any]) -> Any:
        columns = list(params["columns"])
        separator = params.get("prefixSeparator", "_")
        generated: list[tuple[str, Any, str]] = []
        for column in columns:
            for value in self._distinct_values(frame, column):
                generated.append((column, value, f"{column}{separator}{value}"))
        generated.sort(key=lambda item: item[2])
        base_columns = [
            column for column in self._columns(frame) if not params.get("dropOriginal", True) or column not in columns
        ]
        ensure_output_columns_available(base_columns, (name for _, _, name in generated), "One-hot encoding")
        projections = [_quote_ident(column) for column in base_columns]
        projections.extend(
            "CAST(CASE WHEN "
            f"{_quote_ident(column)} IS NOT DISTINCT FROM {_sql_literal(value)} THEN 1 ELSE 0 END AS TINYINT) "
            f"AS {_quote_ident(name)}"
            for column, value, name in generated
        )
        if not projections:
            raise EngineError("DuckDB cannot represent a dataframe with zero columns.")
        return self._relation(frame, f"SELECT {', '.join(projections)} FROM ow")

    def _multi_label(self, frame: Any, params: Mapping[str, Any]) -> Any:
        column = params["column"]
        delimiter = params["delimiter"]
        prefix = params.get("prefix", f"{column}_")
        identifier = _quote_ident(column)
        labels = [
            str(row[0])
            for row in self._terminal_rows(
                frame,
                "SELECT DISTINCT label FROM ow, "
                f"unnest(string_split(CAST({identifier} AS VARCHAR), {_sql_literal(delimiter)})) AS values(label) "
                "WHERE label IS NOT NULL AND label <> '' ORDER BY label",
            )
        ]
        base_columns = [
            name for name in self._columns(frame) if not params.get("dropOriginal", False) or name != column
        ]
        generated_names = [f"{prefix}{label}" for label in labels]
        ensure_output_columns_available(base_columns, generated_names, "Multi-label binarization")
        projections = [_quote_ident(name) for name in base_columns]
        projections.extend(
            "CAST(list_contains(string_split(coalesce(CAST("
            f"{identifier} AS VARCHAR), ''), {_sql_literal(delimiter)}), {_sql_literal(label)}) AS TINYINT) "
            f"AS {_quote_ident(name)}"
            for label, name in zip(labels, generated_names, strict=True)
        )
        if not projections:
            raise EngineError("DuckDB cannot represent a dataframe with zero columns.")
        return self._relation(frame, f"SELECT {', '.join(projections)} FROM ow")

    def _distinct_values(self, frame: Any, column: str) -> list[Any]:
        identifier = _quote_ident(column)
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        valid = _valid_predicate(identifier, types[column])
        rows = self._terminal_rows(
            frame,
            f"SELECT DISTINCT {identifier} FROM ow WHERE {valid} ORDER BY CAST({identifier} AS VARCHAR)",
        )
        return [row[0] for row in rows]

    def _text_transform(self, frame: Any, kind: str, params: Mapping[str, Any]) -> Any:
        column = params["column"]
        target = params.get("newColumn", column)
        value = f"CAST({_quote_ident(column)} AS VARCHAR)"
        if kind == "findReplace":
            function = "regexp_replace" if params.get("regex", False) else "replace"
            suffix = ", 'g'" if params.get("regex", False) else ""
            expression = (
                f"{function}({value}, {_sql_literal(params['find'])}, {_sql_literal(params['replacement'])}{suffix})"
            )
        elif kind == "stripText":
            characters = params.get("characters")
            expression = f"trim({value})" if characters is None else f"trim({value}, {_sql_literal(characters)})"
        elif kind == "splitText":
            expression = f"string_split({value}, {_sql_literal(params['delimiter'])})[{int(params['index']) + 1}]"
        elif kind == "capitalizeText":
            expression = f"upper(substr({value}, 1, 1)) || lower(substr({value}, 2))"
        elif kind == "lowerText":
            expression = f"lower({value})"
        else:
            expression = f"upper({value})"
        return self._assign(frame, target, expression)

    def _min_max(self, frame: Any, column: str, target: str) -> Any:
        value_name = _unique_internal(self._columns(frame), "__ow_scale_value")
        value = _quote_ident(value_name)
        source = _quote_ident(column)
        minimum = f"min({value}) FILTER (WHERE isfinite({value})) OVER ()"
        maximum = f"max({value}) FILTER (WHERE isfinite({value})) OVER ()"
        expression = (
            f"CASE WHEN {value} IS NULL OR NOT isfinite({value}) THEN NULL "
            f"WHEN {minimum} = {maximum} THEN 0.0 "
            f"ELSE ({value} - {minimum}) / ({maximum} - {minimum}) END"
        )
        modifier = (
            f"* EXCLUDE ({value}) REPLACE ({expression} AS {_quote_ident(target)})"
            if target in self._columns(frame)
            else f"* EXCLUDE ({value}), {expression} AS {_quote_ident(target)}"
        )
        return self._relation(
            frame,
            f"SELECT {modifier} FROM (SELECT *, try_cast({source} AS DOUBLE) AS {value} FROM ow)",
        )

    def _group_by(self, frame: Any, params: Mapping[str, Any]) -> Any:
        keys = list(params["keys"])
        order_name = _unique_internal(self._columns(frame), "__ow_group_order")
        projections = [_quote_ident(key) for key in keys]
        projections.extend(
            _aggregation_expression(frame, aggregation, _quote_ident(order_name))
            + f" AS {_quote_ident(aggregation['alias'])}"
            for aggregation in params["aggregations"]
        )
        query = (
            f"WITH ordered AS (SELECT *, row_number() OVER () AS {_quote_ident(order_name)} FROM ow) "
            f"SELECT {', '.join(projections)} FROM ordered GROUP BY {_identifier_list(keys)} "
            f"ORDER BY min({_quote_ident(order_name)})"
        )
        return self._relation(frame, query)


def _compose_sql(source_sql: str, query: str) -> str:
    stripped = query.lstrip()
    if stripped.upper().startswith("WITH "):
        return f"WITH ow AS ({source_sql}), {stripped[5:]}"
    return f"WITH ow AS ({source_sql}) {query}"


def _connect() -> Any:
    import duckdb

    # Open Wrangler never installs or autoloads DuckDB extensions. This keeps a
    # file open deterministic, offline, and confined to dependencies the user
    # explicitly installed in the selected interpreter.
    return duckdb.connect(
        config={
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "preserve_insertion_order": True,
        }
    )


def _execute_rows(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
    return list(connection.execute(_compose_sql(source_sql, query)).fetchall())


def _execute_scalar(connection: Any, source_sql: str, query: str) -> Any:
    row = connection.execute(_compose_sql(source_sql, query)).fetchone()
    return None if row is None else row[0]


def _quote_ident(value: Any) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _identifier_list(values: Iterable[Any]) -> str:
    return ", ".join(_quote_ident(value) for value in values)


def _sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if isnan(value):
            return "CAST('NaN' AS DOUBLE)"
        if isinf(value):
            return "CAST('-Infinity' AS DOUBLE)" if value < 0 else "CAST('Infinity' AS DOUBLE)"
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return f"TIMESTAMP {_sql_literal(value.isoformat(sep=' '))}"
    if isinstance(value, date):
        return f"DATE {_sql_literal(value.isoformat())}"
    if isinstance(value, timedelta):
        return f"INTERVAL {_sql_literal(str(value.total_seconds()) + ' seconds')}"
    if isinstance(value, bytes):
        return f"from_hex({_sql_literal(value.hex())})"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_sql_literal(item) for item in value) + "]"
    text = str(value).replace("'", "''")
    return f"'{text}'"


def _semantic_type(raw_type: str) -> str:
    lowered = raw_type.lower()
    if lowered.endswith("[]") or lowered.startswith(("list", "array")):
        return "list"
    if lowered.startswith(("struct", "map", "union")):
        return "struct"
    integer_tokens = (
        "tinyint",
        "smallint",
        "integer",
        "bigint",
        "hugeint",
        "utinyint",
        "usmallint",
        "uinteger",
        "ubigint",
    )
    if any(token in lowered for token in integer_tokens):
        return "integer"
    if "decimal" in lowered:
        return "decimal"
    if any(token in lowered for token in ("float", "double", "real")):
        return "float"
    if "bool" in lowered:
        return "boolean"
    if "timestamp" in lowered:
        return "datetime"
    if lowered == "date":
        return "date"
    if "interval" in lowered:
        return "duration"
    if lowered in {"blob", "bit"}:
        return "binary"
    if any(token in lowered for token in ("varchar", "char", "enum", "uuid")):
        return "string"
    return "unknown"


def _is_float_type(raw_type: str) -> bool:
    lowered = raw_type.lower()
    return any(token in lowered for token in ("float", "double", "real"))


def _nan_predicate(identifier: str, raw_type: str) -> str:
    return f"({identifier} IS NOT NULL AND isnan({identifier}))" if _is_float_type(raw_type) else "FALSE"


def _valid_predicate(identifier: str, raw_type: str) -> str:
    if _is_float_type(raw_type):
        return f"({identifier} IS NOT NULL AND NOT isnan({identifier}))"
    return f"{identifier} IS NOT NULL"


def _finite_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _unique_internal(existing: Iterable[str], base: str) -> str:
    names = set(existing)
    candidate = base
    index = 0
    while candidate in names:
        index += 1
        candidate = f"{base}_{index}"
    return candidate


def _filter_query(columns: Iterable[str], model: Mapping[str, Any]) -> str:
    available = set(columns)
    column_conditions: list[str] = []
    for column_filter in model.get("filters", []):
        column = column_filter.get("column")
        if available and column not in available:
            continue
        identifier = _quote_ident(column)
        conditions: list[str] = []
        value_filter = column_filter.get("valueFilter")
        if value_filter and (
            value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
        ):
            alternatives: list[str] = []
            selected = [str(value) for value in value_filter.get("selectedValues", [])]
            if selected:
                alternatives.append(
                    f"CAST({identifier} AS VARCHAR) IN ({', '.join(_sql_literal(value) for value in selected)})"
                )
            if value_filter.get("includeNulls"):
                alternatives.append(f"{identifier} IS NULL")
            if value_filter.get("includeNaN") and column_filter.get("type") == "float":
                alternatives.append(f"coalesce(isnan({identifier}), FALSE)")
            conditions.append("(" + " OR ".join(alternatives) + ")")
        conditions.extend(
            _predicate_expression(identifier, predicate, column_filter.get("type"))
            for predicate in column_filter.get("predicates", [])
        )
        if conditions:
            operator = " OR " if column_filter.get("logic") == "or" else " AND "
            column_conditions.append("(" + operator.join(conditions) + ")")

    where = ""
    if column_conditions:
        operator = " OR " if model.get("logic") == "or" else " AND "
        where = " WHERE " + operator.join(column_conditions)

    rules = [rule for rule in model.get("sort", []) if not available or rule.get("column") in available]
    if not rules:
        return f"SELECT * FROM ow{where}"
    order_name = _unique_internal(available, "__ow_sort_order")
    order = ", ".join(
        f"{_quote_ident(rule['column'])} {str(rule.get('direction', 'asc')).upper()} "
        f"NULLS {str(rule.get('nulls', 'last')).upper()}"
        for rule in rules
    )
    return (
        f"SELECT * EXCLUDE ({_quote_ident(order_name)}) FROM "
        f"(SELECT *, row_number() OVER () AS {_quote_ident(order_name)} FROM ow{where}) AS sorted "
        f"ORDER BY {order}, {_quote_ident(order_name)}"
    )


def _predicate_expression(identifier: str, predicate: Mapping[str, Any], column_type: str | None) -> str:
    operator = predicate.get("operator")
    value = predicate.get("value")
    if operator == "equals":
        return f"{identifier} = {_sql_literal(value)}"
    if operator == "notEquals":
        return f"{identifier} <> {_sql_literal(value)}"
    if operator == "contains":
        return f"contains(lower(CAST({identifier} AS VARCHAR)), lower({_sql_literal(str(value))}))"
    if operator == "startsWith":
        return f"starts_with(CAST({identifier} AS VARCHAR), {_sql_literal(str(value))})"
    if operator == "endsWith":
        return f"ends_with(CAST({identifier} AS VARCHAR), {_sql_literal(str(value))})"
    if operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[str(operator)]
        return f"{identifier} {symbol} {_sql_literal(value)}"
    if operator == "between":
        second = _sql_literal(predicate.get("secondValue"))
        return f"({identifier} >= {_sql_literal(value)} AND {identifier} <= {second})"
    if operator == "isNull":
        return f"{identifier} IS NULL"
    if operator == "isNotNull":
        return f"{identifier} IS NOT NULL"
    if operator == "isNaN":
        return f"coalesce(isnan({identifier}), FALSE)" if column_type == "float" else "FALSE"
    if operator == "isNotNaN":
        return f"coalesce(NOT isnan({identifier}), TRUE)" if column_type == "float" else "TRUE"
    return f"{identifier} IS NOT NULL"


def _formula_expression(left: str, right: str, operator: str) -> str:
    if operator == "power":
        return f"power({left}, {right})"
    symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%"}.get(operator)
    if symbol is None:
        raise EngineError(f"Unsupported formula operator: {operator}")
    return f"({left} {symbol} {right})"


def _aggregation_expression(frame: Any, aggregation: Mapping[str, Any], order: str) -> str:
    column = _quote_ident(aggregation["column"])
    operation = aggregation["operation"]
    if operation == "sum":
        return f"coalesce(sum({column}), 0)"
    if operation == "mean":
        return f"avg({column})"
    if operation in {"min", "max", "median"}:
        return f"{operation}({column})"
    if operation == "count":
        return f"count({column})"
    if operation == "nUnique":
        types = dict(zip((str(item) for item in frame.columns), (str(item) for item in frame.types), strict=True))
        return f"count(DISTINCT {column}) FILTER (WHERE {_valid_predicate(column, types[aggregation['column']])})"
    if operation in {"first", "last"}:
        direction = "ASC" if operation == "first" else "DESC"
        return f"first({column} ORDER BY {order} {direction}) FILTER (WHERE {column} IS NOT NULL)"
    raise EngineError(f"Unsupported DuckDB aggregation: {operation}")


def _by_example_expression(program: Mapping[str, Any]) -> str:
    kind = program["kind"]
    if kind == "column":
        return _quote_ident(program["column"])
    if kind == "literal":
        return _sql_literal(program.get("value"))
    if kind == "slice":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        start = int(program["start"])
        stop = program.get("stop")
        return f"substr({value}, {start + 1})" if stop is None else f"substr({value}, {start + 1}, {int(stop) - start})"
    if kind == "split":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        return f"string_split({value}, {_sql_literal(program['delimiter'])})[{int(program['index']) + 1}]"
    if kind == "concat":
        return " || ".join(f"CAST({_by_example_expression(part)} AS VARCHAR)" for part in program["parts"])
    if kind == "regexExtract":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        pattern = _sql_literal(program["pattern"])
        group = int(program["group"])
        return (
            f"CASE WHEN regexp_matches({value}, {pattern}) "
            f"THEN regexp_extract({value}, {pattern}, {group}) ELSE NULL END"
        )
    if kind == "regexReplace":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        return (
            f"regexp_replace({value}, {_sql_literal(program['pattern'])}, {_sql_literal(program['replacement'])}, 'g')"
        )
    if kind == "case":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        if program["style"] == "lower":
            return f"lower({value})"
        if program["style"] == "upper":
            return f"upper({value})"
        return f"upper(substr({value}, 1, 1)) || lower(substr({value}, 2))"
    if kind == "datetimeFormat":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        return (
            f"strftime(try_strptime({value}, {_sql_literal(program['inputFormat'])}), "
            f"{_sql_literal(program['outputFormat'])})"
        )
    if kind == "arithmetic":
        return _formula_expression(
            _by_example_expression(program["left"]),
            _by_example_expression(program["right"]),
            program["operator"],
        )
    raise EngineError(f"Unsupported DuckDB by-example expression: {kind}")


_GENERATED_HELPERS = r"""import math
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal

import duckdb


_OW_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_"


def _ow_ident(value):
    return '"' + str(value).replace('"', '""') + '"'


def _ow_identifiers(values):
    return ", ".join(_ow_ident(value) for value in values)


def _ow_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "CAST('NaN' AS DOUBLE)"
        if math.isinf(value):
            return "CAST('-Infinity' AS DOUBLE)" if value < 0 else "CAST('Infinity' AS DOUBLE)"
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return "TIMESTAMP " + _ow_literal(value.isoformat(sep=" "))
    if isinstance(value, date):
        return "DATE " + _ow_literal(value.isoformat())
    if isinstance(value, timedelta):
        return "INTERVAL " + _ow_literal(str(value.total_seconds()) + " seconds")
    if isinstance(value, bytes):
        return "from_hex(" + _ow_literal(value.hex()) + ")"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_ow_literal(item) for item in value) + "]"
    return "'" + str(value).replace("'", "''") + "'"


def _ow_query(df, query):
    stripped = query.lstrip()
    if stripped.upper().startswith("WITH "):
        sql = "WITH ow AS (" + df.sql_query() + "), " + stripped[5:]
    else:
        sql = "WITH ow AS (" + df.sql_query() + ") " + query
    return duckdb.sql(sql)


def _ow_columns(df):
    return [str(column) for column in df.columns]


def _ow_visible(df):
    return [column for column in _ow_columns(df) if not column.startswith(_OW_ROW_ID_PREFIX)]


def _ow_visible_relation(df):
    hidden = next((column for column in _ow_columns(df) if column.startswith(_OW_ROW_ID_PREFIX)), None)
    return df if hidden is None else _ow_query(df, "SELECT * EXCLUDE (" + _ow_ident(hidden) + ") FROM ow")


def _ow_assign(df, target, expression):
    projection = (
        "* REPLACE (" + expression + " AS " + _ow_ident(target) + ")"
        if target in _ow_columns(df)
        else "*, " + expression + " AS " + _ow_ident(target)
    )
    return _ow_query(df, "SELECT " + projection + " FROM ow")


def _ow_select(df, columns):
    hidden = next((column for column in _ow_columns(df) if column.startswith(_OW_ROW_ID_PREFIX)), None)
    selected = ([hidden] if hidden else []) + list(columns)
    return _ow_query(df, "SELECT " + _ow_identifiers(selected) + " FROM ow")


def _ow_unique(existing, base):
    candidate = base
    index = 0
    while candidate in set(existing):
        index += 1
        candidate = base + "_" + str(index)
    return candidate


def _ow_is_float(raw_type):
    lowered = str(raw_type).lower()
    return any(token in lowered for token in ("float", "double", "real"))


def _ow_valid(identifier, raw_type):
    if _ow_is_float(raw_type):
        return "(" + identifier + " IS NOT NULL AND NOT isnan(" + identifier + "))"
    return identifier + " IS NOT NULL"


def _ow_filter(df, model):
    available = set(_ow_columns(df))
    column_conditions = []
    for column_filter in model.get("filters", []):
        column = column_filter.get("column")
        if column not in available:
            continue
        identifier = _ow_ident(column)
        conditions = []
        values = column_filter.get("valueFilter")
        if values and (values.get("selectedValues") or values.get("includeNulls") or values.get("includeNaN")):
            alternatives = []
            selected = [str(value) for value in values.get("selectedValues", [])]
            if selected:
                alternatives.append(
                    "CAST(" + identifier + " AS VARCHAR) IN (" + ", ".join(_ow_literal(v) for v in selected) + ")"
                )
            if values.get("includeNulls"):
                alternatives.append(identifier + " IS NULL")
            if values.get("includeNaN") and column_filter.get("type") == "float":
                alternatives.append("coalesce(isnan(" + identifier + "), FALSE)")
            conditions.append("(" + " OR ".join(alternatives) + ")")
        for predicate in column_filter.get("predicates", []):
            conditions.append(_ow_predicate(identifier, predicate, column_filter.get("type")))
        if conditions:
            operator = " OR " if column_filter.get("logic") == "or" else " AND "
            column_conditions.append("(" + operator.join(conditions) + ")")
    where = ""
    if column_conditions:
        where = " WHERE " + (" OR " if model.get("logic") == "or" else " AND ").join(column_conditions)
    rules = [rule for rule in model.get("sort", []) if rule.get("column") in available]
    if not rules:
        return _ow_query(df, "SELECT * FROM ow" + where)
    order_name = _ow_unique(available, "__ow_sort_order")
    order = ", ".join(
        _ow_ident(rule["column"]) + " " + rule.get("direction", "asc").upper()
        + " NULLS " + rule.get("nulls", "last").upper()
        for rule in rules
    )
    return _ow_query(
        df,
        "SELECT * EXCLUDE (" + _ow_ident(order_name) + ") FROM (SELECT *, row_number() OVER () AS "
        + _ow_ident(order_name) + " FROM ow" + where + ") AS sorted ORDER BY " + order + ", " + _ow_ident(order_name),
    )


def _ow_predicate(identifier, predicate, column_type):
    operator = predicate.get("operator")
    value = predicate.get("value")
    if operator == "equals":
        return identifier + " = " + _ow_literal(value)
    if operator == "notEquals":
        return identifier + " <> " + _ow_literal(value)
    if operator == "contains":
        return "contains(lower(CAST(" + identifier + " AS VARCHAR)), lower(" + _ow_literal(str(value)) + "))"
    if operator == "startsWith":
        return "starts_with(CAST(" + identifier + " AS VARCHAR), " + _ow_literal(str(value)) + ")"
    if operator == "endsWith":
        return "ends_with(CAST(" + identifier + " AS VARCHAR), " + _ow_literal(str(value)) + ")"
    if operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
        return identifier + " " + symbol + " " + _ow_literal(value)
    if operator == "between":
        return (
            "(" + identifier + " >= " + _ow_literal(value) + " AND " + identifier
            + " <= " + _ow_literal(predicate.get("secondValue")) + ")"
        )
    if operator == "isNull":
        return identifier + " IS NULL"
    if operator == "isNotNull":
        return identifier + " IS NOT NULL"
    if operator == "isNaN":
        return "coalesce(isnan(" + identifier + "), FALSE)" if column_type == "float" else "FALSE"
    if operator == "isNotNaN":
        return "coalesce(NOT isnan(" + identifier + "), TRUE)" if column_type == "float" else "TRUE"
    return identifier + " IS NOT NULL"


def _ow_drop_missing(df, columns, how):
    selected = list(columns) if columns else _ow_visible(df)
    if not selected:
        return df
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    valid = [_ow_valid(_ow_ident(column), types[column]) for column in selected]
    operator = " AND " if how == "any" else " OR "
    return _ow_query(df, "SELECT * FROM ow WHERE " + operator.join("(" + item + ")" for item in valid))


def _ow_drop_duplicates(df, columns, keep):
    selected = list(columns) if columns else _ow_visible(df)
    if not selected:
        return df
    order_name = _ow_unique(_ow_columns(df), "__ow_dupe_order")
    rank_name = _ow_unique(_ow_columns(df) + [order_name], "__ow_dupe_rank")
    count_name = _ow_unique(_ow_columns(df) + [order_name, rank_name], "__ow_dupe_count")
    partition = _ow_identifiers(selected)
    direction = "DESC" if keep == "last" else "ASC"
    predicate = _ow_ident(count_name) + " = 1" if keep == "none" else _ow_ident(rank_name) + " = 1"
    query = (
        "WITH numbered AS (SELECT *, row_number() OVER () AS " + _ow_ident(order_name) + " FROM ow), "
        "ranked AS (SELECT *, row_number() OVER (PARTITION BY " + partition + " ORDER BY "
        + _ow_ident(order_name) + " " + direction + ") AS " + _ow_ident(rank_name)
        + ", count(*) OVER (PARTITION BY " + partition + ") AS " + _ow_ident(count_name)
        + " FROM numbered) SELECT * EXCLUDE (" + _ow_identifiers([order_name, rank_name, count_name])
        + ") FROM ranked WHERE " + predicate + " ORDER BY " + _ow_ident(order_name)
    )
    return _ow_query(df, query)


def _ow_check_outputs(existing, generated, operation):
    generated = [str(name) for name in generated]
    duplicates = {name for name, count in Counter(generated).items() if count > 1}
    collisions = sorted(duplicates | (set(map(str, existing)) & set(generated)))
    if collisions:
        raise ValueError(operation + " would create duplicate column names: " + ", ".join(collisions))


def _ow_one_hot(df, params):
    columns = list(params["columns"])
    separator = params.get("prefixSeparator", "_")
    generated = []
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    for column in columns:
        identifier = _ow_ident(column)
        values = _ow_query(
            df,
            "SELECT DISTINCT " + identifier + " FROM ow WHERE "
            + _ow_valid(identifier, types[column]) + " ORDER BY CAST(" + identifier + " AS VARCHAR)",
        ).fetchall()
        generated.extend((column, row[0], str(column) + separator + str(row[0])) for row in values)
    generated.sort(key=lambda item: item[2])
    base = [name for name in _ow_columns(df) if not params.get("dropOriginal", True) or name not in columns]
    _ow_check_outputs(base, [name for _, _, name in generated], "One-hot encoding")
    projections = [_ow_ident(name) for name in base]
    projections.extend(
        "CAST(CASE WHEN " + _ow_ident(column) + " IS NOT DISTINCT FROM " + _ow_literal(value)
        + " THEN 1 ELSE 0 END AS TINYINT) AS " + _ow_ident(name)
        for column, value, name in generated
    )
    if not projections:
        raise ValueError("DuckDB cannot represent a dataframe with zero columns.")
    return _ow_query(df, "SELECT " + ", ".join(projections) + " FROM ow")


def _ow_multi_label(df, params):
    column = params["column"]
    delimiter = params["delimiter"]
    prefix = params.get("prefix", column + "_")
    identifier = _ow_ident(column)
    rows = _ow_query(
        df,
        "SELECT DISTINCT label FROM ow, unnest(string_split(CAST(" + identifier + " AS VARCHAR), "
        + _ow_literal(delimiter) + ")) AS values(label) WHERE label IS NOT NULL AND label <> '' ORDER BY label",
    ).fetchall()
    labels = [str(row[0]) for row in rows]
    base = [name for name in _ow_columns(df) if not params.get("dropOriginal", False) or name != column]
    names = [prefix + label for label in labels]
    _ow_check_outputs(base, names, "Multi-label binarization")
    projections = [_ow_ident(name) for name in base]
    projections.extend(
        "CAST(list_contains(string_split(coalesce(CAST(" + identifier + " AS VARCHAR), ''), "
        + _ow_literal(delimiter) + "), " + _ow_literal(label) + ") AS TINYINT) AS " + _ow_ident(name)
        for label, name in zip(labels, names)
    )
    if not projections:
        raise ValueError("DuckDB cannot represent a dataframe with zero columns.")
    return _ow_query(df, "SELECT " + ", ".join(projections) + " FROM ow")


def _ow_text(df, kind, params):
    column = params["column"]
    target = params.get("newColumn", column)
    value = "CAST(" + _ow_ident(column) + " AS VARCHAR)"
    if kind == "findReplace":
        if params.get("regex", False):
            expression = (
                "regexp_replace(" + value + ", " + _ow_literal(params["find"])
                + ", " + _ow_literal(params["replacement"]) + ", 'g')"
            )
        else:
            expression = (
                "replace(" + value + ", " + _ow_literal(params["find"])
                + ", " + _ow_literal(params["replacement"]) + ")"
            )
    elif kind == "stripText":
        expression = (
            "trim(" + value + ")"
            if params.get("characters") is None
            else "trim(" + value + ", " + _ow_literal(params["characters"]) + ")"
        )
    elif kind == "splitText":
        expression = (
            "string_split(" + value + ", " + _ow_literal(params["delimiter"])
            + ")[" + str(params["index"] + 1) + "]"
        )
    elif kind == "capitalizeText":
        expression = "upper(substr(" + value + ", 1, 1)) || lower(substr(" + value + ", 2))"
    elif kind == "lowerText":
        expression = "lower(" + value + ")"
    else:
        expression = "upper(" + value + ")"
    return _ow_assign(df, target, expression)


def _ow_min_max(df, column, target):
    value_name = _ow_unique(_ow_columns(df), "__ow_scale_value")
    value = _ow_ident(value_name)
    minimum = "min(" + value + ") FILTER (WHERE isfinite(" + value + ")) OVER ()"
    maximum = "max(" + value + ") FILTER (WHERE isfinite(" + value + ")) OVER ()"
    expression = (
        "CASE WHEN " + value + " IS NULL OR NOT isfinite(" + value + ") THEN NULL WHEN "
        + minimum + " = " + maximum + " THEN 0.0 ELSE (" + value + " - " + minimum
        + ") / (" + maximum + " - " + minimum + ") END"
    )
    modifier = (
        "* EXCLUDE (" + value + ") REPLACE (" + expression + " AS " + _ow_ident(target) + ")"
        if target in _ow_columns(df)
        else "* EXCLUDE (" + value + "), " + expression + " AS " + _ow_ident(target)
    )
    return _ow_query(
        df,
        "SELECT " + modifier + " FROM (SELECT *, try_cast(" + _ow_ident(column)
        + " AS DOUBLE) AS " + value + " FROM ow)",
    )


def _ow_formula(left, right, operator):
    if operator == "power":
        return "power(" + left + ", " + right + ")"
    symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%"}[operator]
    return "(" + left + " " + symbol + " " + right + ")"


def _ow_group_by(df, params):
    keys = list(params["keys"])
    order_name = _ow_unique(_ow_columns(df), "__ow_group_order")
    order = _ow_ident(order_name)
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    projections = [_ow_ident(key) for key in keys]
    for aggregation in params["aggregations"]:
        column = _ow_ident(aggregation["column"])
        operation = aggregation["operation"]
        if operation == "sum":
            expression = "coalesce(sum(" + column + "), 0)"
        elif operation == "mean":
            expression = "avg(" + column + ")"
        elif operation in {"min", "max", "median"}:
            expression = operation + "(" + column + ")"
        elif operation == "count":
            expression = "count(" + column + ")"
        elif operation == "nUnique":
            expression = (
                "count(DISTINCT " + column + ") FILTER (WHERE "
                + _ow_valid(column, types[aggregation["column"]]) + ")"
            )
        else:
            direction = "ASC" if operation == "first" else "DESC"
            expression = (
                "first(" + column + " ORDER BY " + order + " " + direction
                + ") FILTER (WHERE " + column + " IS NOT NULL)"
            )
        projections.append(expression + " AS " + _ow_ident(aggregation["alias"]))
    query = (
        "WITH ordered AS (SELECT *, row_number() OVER () AS " + order + " FROM ow) SELECT "
        + ", ".join(projections) + " FROM ordered GROUP BY " + _ow_identifiers(keys)
        + " ORDER BY min(" + order + ")"
    )
    return _ow_query(df, query)
"""
