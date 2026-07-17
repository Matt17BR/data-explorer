import type {
  CellValue,
  ColumnSummary,
  DataRow,
  DatasetStats,
  GridPage,
  SessionMetadata,
  TypedSelectionToken,
  ValueCount,
  ValuesResponse
} from "./protocol";
import type { ColumnFilter, FilterModel, PredicateFilter } from "./filterModel";
import { supportsTypedViewComparison, supportsViewPredicate } from "./filterModel";

const MAX_PAGE_LIMIT = 10_000;
const MAX_COLUMN_LIMIT = 256;
const ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";
const INTEGER_VIEW_TEXT = /^[+-]?\d+$/;
const NUMBER_VIEW_TEXT = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const INFINITY_VIEW_TEXT = /^[+-]?Infinity$/;
const DATE_VIEW_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_VIEW_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const DURATION_SECONDS_TEXT = /^[+-]?(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/;
const DURATION_CLOCK_TEXT = /^(?:(-?\d+) days?, )?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const MAX_TYPED_SELECTION_TEXT_CHARACTERS = 65_536;
const MICROSECONDS_PER_DAY = 86_400_000_000n;
const MIN_PORTABLE_DURATION_MICROSECONDS = -999_999_999n * MICROSECONDS_PER_DAY;
const MAX_PORTABLE_DURATION_MICROSECONDS = 999_999_999n * MICROSECONDS_PER_DAY + 86_399_999_999n;

export interface SnapshotPageWindow {
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
}

export function applySnapshotFilters(metadata: SessionMetadata, rows: DataRow[], model: FilterModel): DataRow[] {
  assertFullSchemaRows(metadata, rows);
  const resolvedFilters = model.filters.map((filter) => {
    const position = resolveSnapshotColumn(metadata, filter.column, "filter", filter.type);
    validateSnapshotFilter(filter);
    return { filter, position };
  });
  const resolvedSorts = model.sort.map((rule) => {
    const position = resolveSnapshotColumn(metadata, rule.column, "sort");
    const type = metadata.schema[position]?.type;
    if (type && !supportsTypedViewComparison(type)) {
      throw new Error(`Snapshot sorting is unavailable for captured ${type} columns.`);
    }
    return { rule, position, type };
  });
  const filtered = rows.filter((row) => {
    const matches = resolvedFilters.map(({ filter, position }) => snapshotFilterMatches(row, filter, position));
    return (model.logic ?? "and") === "or" ? matches.length === 0 || matches.some(Boolean) : matches.every(Boolean);
  });
  const [firstSort, ...remainingSorts] = resolvedSorts;
  if (!firstSort) {
    return filtered;
  }

  return [...filtered].sort((left, right) => {
    for (const { rule, position, type } of [firstSort, ...remainingSorts]) {
      if (!type) throw new RangeError("A snapshot sort resolved outside the captured schema.");
      const comparison = compareCells(
        left.values[position],
        right.values[position],
        type,
        metadata.backend,
        rule.direction,
        rule.nulls
      );
      if (comparison !== 0) {
        return comparison;
      }
    }
    return left.rowNumber - right.rowNumber;
  });
}

export function snapshotPage(
  metadata: SessionMetadata,
  rows: DataRow[],
  model: FilterModel,
  window: SnapshotPageWindow
): GridPage {
  assertSnapshotPageWindow(window);
  assertFullSchemaRows(metadata, rows);
  const filteredRows = applySnapshotFilters(metadata, rows, model);
  const projectedSchema = metadata.schema.slice(window.columnOffset, window.columnOffset + window.columnLimit);
  const positions = projectedSchema.map((column) => column.position);
  const pageRows = filteredRows.slice(window.offset, window.offset + window.limit).map((row, index) => {
    const values = positions.map((position) => {
      const cell = row.values[position];
      return cell === undefined ? undefined : structuredClone(cell);
    });
    if (values.some((value) => value === undefined)) {
      throw new RangeError("A captured notebook row did not contain the complete saved schema.");
    }
    return {
      id: row.id,
      rowNumber: window.offset + index,
      values: values as CellValue[]
    };
  });

  return {
    offset: window.offset,
    limit: window.limit,
    totalRows: filteredRows.length,
    columnIds: projectedSchema.map((column) => column.id),
    rows: pageRows
  };
}

export function snapshotColumnValues(
  metadata: SessionMetadata,
  rows: DataRow[],
  model: FilterModel,
  column: string,
  search?: string,
  viewRequestId = "snapshot",
  limit = 100
): ValuesResponse {
  assertBoundedPositiveInteger(limit, MAX_PAGE_LIMIT, "Snapshot column-value limit");
  const position = resolveSnapshotColumn(metadata, column, "values");
  const type = metadata.schema[position]?.type;
  if (!type) throw new RangeError("A snapshot values request resolved outside the captured schema.");
  const searchText = asciiLower(search ?? "");
  const counts = new Map<string, ValueCount>();
  for (const row of applySnapshotFilters(metadata, rows, model)) {
    const cell = row.values[position];
    if (!cell || cell.isNull || cell.isNaN) {
      continue;
    }
    if (searchText && !asciiLower(cell.display).includes(searchText)) {
      continue;
    }
    const identity = cellIdentity(cell, type);
    const current = counts.get(identity);
    const selectionValue = current?.selectionValue ?? snapshotSelectionValue(cell, type);
    counts.set(identity, {
      value: current?.value ?? cell.display,
      count: (current?.count ?? 0) + 1,
      ...(selectionValue ? { selectionValue } : {})
    });
  }

  return {
    kind: "columnValues",
    revision: metadata.revision,
    viewRequestId,
    column,
    values: [...counts.values()]
      .sort((left, right) => right.count - left.count || compareStrings(left.value, right.value))
      .slice(0, limit),
    hasMore: counts.size > limit
  };
}

export function snapshotSummaries(
  metadata: SessionMetadata,
  rows: DataRow[],
  columns?: readonly string[]
): ColumnSummary[] {
  assertFullSchemaRows(metadata, rows);
  const positions =
    columns === undefined
      ? allSummaryPositions(metadata)
      : columns.map((column) => resolveSnapshotColumn(metadata, column, "summary"));
  return positions.map((index) => {
    const schema = metadata.schema[index];
    if (!schema) throw new RangeError("A snapshot summary resolved outside the captured schema.");
    const cells = rows.map((row) => row.values[index]).filter((cell): cell is CellValue => cell !== undefined);
    const values = cells.filter((cell) => !cell.isNull && !cell.isNaN);
    const counts = new Map<string, ValueCount>();
    for (const cell of values) {
      const identity = cellIdentity(cell, schema.type);
      const current = counts.get(identity);
      counts.set(identity, { value: current?.value ?? cell.display, count: (current?.count ?? 0) + 1 });
    }
    const numericValues = ["integer", "float", "decimal"].includes(schema.type)
      ? values
          .map((cell) => (typeof cell.raw === "number" ? cell.raw : Number(cell.display)))
          .filter((value) => !Number.isNaN(value))
      : [];
    const topValues: ValueCount[] = [...counts.values()]
      .sort((left, right) => right.count - left.count || compareStrings(left.value, right.value))
      .slice(0, 10)
      .map(({ value, count }) => ({ value, count }));

    const standardDeviation = sampleStandardDeviation(numericValues);
    const numeric =
      numericValues.length === 0
        ? undefined
        : finiteNumericSummary({
            min: Math.min(...numericValues),
            max: Math.max(...numericValues),
            mean: numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
            median: median(numericValues),
            std: standardDeviation
          });

    return {
      column: schema.name,
      type: schema.type,
      rawType: schema.rawType,
      totalCount: rows.length,
      nullCount: cells.filter((cell) => cell.isNull).length,
      nanCount: cells.filter((cell) => cell.isNaN).length,
      distinctCount: counts.size,
      topValues,
      ...(numeric ? { numeric } : {}),
      visualization: snapshotVisualization(schema.type, values, topValues, numericValues)
    };
  });
}

export function snapshotDatasetStats(
  metadata: SessionMetadata,
  rows: DataRow[],
  model: FilterModel = metadata.filterModel
): DatasetStats {
  assertFullSchemaRows(metadata, rows);
  const filteredRows = applySnapshotFilters(metadata, rows, model);
  const missingValuesByColumn = metadata.schema.map((column) => ({ column: column.name, count: 0 }));
  let missingCells = 0;
  let missingRows = 0;
  const uniqueRows = new Set<string>();

  for (const row of filteredRows) {
    let rowHasMissingValue = false;
    const cells = metadata.schema.map((column) => row.values[column.position]);
    for (const [position, cell] of cells.entries()) {
      if (cell !== undefined && !cell.isNull && !cell.isNaN) continue;
      missingCells += 1;
      rowHasMissingValue = true;
      const columnCount = missingValuesByColumn[position];
      if (columnCount) columnCount.count += 1;
    }
    if (rowHasMissingValue) missingRows += 1;
    uniqueRows.add(stableRowKey(cells, metadata.schema));
  }

  return {
    missingCells,
    missingRows,
    duplicateRows: metadata.schema.length === 0 ? 0 : filteredRows.length - uniqueRows.size,
    missingValuesByColumn
  };
}

function snapshotFilterMatches(row: DataRow, filter: ColumnFilter, position: number): boolean {
  const cell = row.values[position];
  if (!cell) {
    throw new RangeError("A captured notebook row did not contain the complete saved schema.");
  }
  const conditions: boolean[] = [];
  const valueFilter = filter.valueFilter;
  if (valueFilter && (valueFilter.selectedValues.length > 0 || valueFilter.includeNulls || valueFilter.includeNaN)) {
    if (valueFilter.selectedValues.length > 0 && !supportsTypedViewComparison(filter.type)) {
      throw new Error(`Snapshot value selection is unavailable for captured ${filter.type} columns.`);
    }
    const selected = new Set(valueFilter.selectedValues.map((value) => selectedValueIdentity(value, filter.type)));
    const selectedMatch = !cell.isNull && !cell.isNaN && selected.has(cellIdentity(cell, filter.type));
    const nullMatch = valueFilter.includeNulls && cell.isNull;
    const nanMatch = valueFilter.includeNaN && cell.isNaN;
    conditions.push(selectedMatch || nullMatch || nanMatch);
  }

  conditions.push(...filter.predicates.map((predicate) => predicateMatches(cell, predicate, filter.type)));
  return (filter.logic ?? "and") === "or"
    ? conditions.length === 0 || conditions.some(Boolean)
    : conditions.every(Boolean);
}

function validateSnapshotFilter(filter: ColumnFilter): void {
  const selectedValues = filter.valueFilter?.selectedValues ?? [];
  if (selectedValues.length > 0 && !supportsTypedViewComparison(filter.type)) {
    throw new Error(`Snapshot value selection is unavailable for captured ${filter.type} columns.`);
  }
  for (const value of selectedValues) {
    selectedValueIdentity(value, filter.type);
  }
  for (const predicate of filter.predicates) {
    validateSnapshotPredicate(predicate, filter.type);
  }
}

function validateSnapshotPredicate(predicate: PredicateFilter, type: SessionMetadata["schema"][number]["type"]): void {
  if (!supportsViewPredicate(type, predicate.operator)) {
    throw new Error(`Snapshot predicate ${predicate.operator} is unavailable for captured ${type} columns.`);
  }
  if (["isNull", "isNotNull", "isNaN", "isNotNaN"].includes(predicate.operator)) {
    return;
  }
  canonicalViewValue(predicate.value, type);
  if (predicate.operator === "between") {
    canonicalViewValue(predicate.secondValue, type);
  }
}

function resolveSnapshotColumn(
  metadata: SessionMetadata,
  name: string,
  purpose: "filter" | "sort" | "summary" | "values",
  declaredType?: ColumnFilter["type"]
): number {
  let matchedColumn: SessionMetadata["schema"][number] | undefined;
  let matchCount = 0;
  for (const column of metadata.schema) {
    if (column.name !== name) continue;
    matchCount += 1;
    matchedColumn = column;
  }

  const quotedName = JSON.stringify(name);
  if (matchCount === 0 || matchedColumn === undefined) {
    throw new Error(`Snapshot ${purpose} column ${quotedName} is not present in the captured schema.`);
  }
  if (matchCount > 1) {
    throw new Error(
      `Snapshot ${purpose} column ${quotedName} is ambiguous because ${matchCount} captured columns share that name.`
    );
  }

  if (declaredType !== undefined) {
    if (matchedColumn.type !== declaredType) {
      throw new Error(
        `Snapshot filter column ${quotedName} declares type ${JSON.stringify(declaredType)}, but the captured schema type is ${JSON.stringify(matchedColumn.type)}.`
      );
    }
  }
  return matchedColumn.position;
}

function allSummaryPositions(metadata: SessionMetadata): number[] {
  const columnCounts = new Map<string, number>();
  for (const column of metadata.schema) {
    columnCounts.set(column.name, (columnCounts.get(column.name) ?? 0) + 1);
  }
  for (const [name, count] of columnCounts) {
    if (count > 1) {
      throw new Error(
        `Snapshot summaries cannot address column ${JSON.stringify(name)} because ${count} captured columns share that name.`
      );
    }
  }
  return metadata.schema.map((column) => column.position);
}

function predicateMatches(
  cell: CellValue,
  predicate: PredicateFilter,
  type: SessionMetadata["schema"][number]["type"]
): boolean {
  const value = String(predicate.value ?? "");
  if (!supportsViewPredicate(type, predicate.operator)) {
    throw new Error(`Snapshot predicate ${predicate.operator} is unavailable for captured ${type} columns.`);
  }
  switch (predicate.operator) {
    case "isNull":
      return cell.isNull;
    case "isNotNull":
      return !cell.isNull;
    case "isNaN":
      return cell.isNaN;
    case "isNotNaN":
      return !cell.isNaN;
  }
  if (cell.isNull || cell.isNaN) {
    return false;
  }
  const compareValue = (): number => compareTypedCells(cell, predicateCell(predicate.value, type), type);
  const compareSecondValue = (): number => compareTypedCells(cell, predicateCell(predicate.secondValue, type), type);
  switch (predicate.operator) {
    case "equals":
      return type === "string" ? cell.display === value : compareValue() === 0;
    case "notEquals":
      return type === "string" ? cell.display !== value : compareValue() !== 0;
    case "contains":
      return asciiLower(cell.display).includes(asciiLower(value));
    case "startsWith":
      return cell.display.startsWith(value);
    case "endsWith":
      return cell.display.endsWith(value);
    case "gt":
      return compareValue() > 0;
    case "gte":
      return compareValue() >= 0;
    case "lt":
      return compareValue() < 0;
    case "lte":
      return compareValue() <= 0;
    case "between":
      return compareValue() >= 0 && compareSecondValue() <= 0;
    default:
      return true;
  }
}

function compareCells(
  left: CellValue | undefined,
  right: CellValue | undefined,
  type: SessionMetadata["schema"][number]["type"],
  backend: SessionMetadata["backend"],
  direction: "asc" | "desc",
  nulls: "first" | "last"
): number {
  // Pandas implements NaN through its missing-value ordering. Polars and
  // DuckDB keep NaN distinct from null and order it above every finite value.
  // Saved snapshots must preserve the engine semantics recorded in metadata.
  const nanIsMissing = backend === "pandas";
  const leftNull = !left || left.isNull || (nanIsMissing && left.isNaN);
  const rightNull = !right || right.isNull || (nanIsMissing && right.isNaN);
  if (leftNull && rightNull) {
    return 0;
  }
  if (leftNull) {
    return nulls === "first" ? -1 : 1;
  }
  if (rightNull) {
    return nulls === "first" ? 1 : -1;
  }
  if (left.isNaN || right.isNaN) {
    const comparison = left.isNaN === right.isNaN ? 0 : left.isNaN ? 1 : -1;
    return direction === "asc" ? comparison : -comparison;
  }
  const comparison = compareTypedCells(left, right, type);
  return direction === "asc" ? comparison : -comparison;
}

function predicateCell(value: unknown, type: SessionMetadata["schema"][number]["type"]): CellValue {
  value = canonicalViewValue(value, type);
  const kind =
    type === "float"
      ? "number"
      : type === "unknown" || type === "binary" || type === "list" || type === "struct"
        ? "string"
        : type;
  return {
    kind,
    raw: value,
    display: String(value ?? ""),
    isNull: value === null,
    isNaN: typeof value === "number" && Number.isNaN(value)
  };
}

function selectedValueCell(value: unknown, type: SessionMetadata["schema"][number]["type"]): CellValue {
  if (type === "float" && (typeof value === "number" ? Number.isNaN(value) : String(value) === "NaN")) {
    throw new TypeError("A snapshot NaN selection must use the explicit includeNaN option.");
  }
  return predicateCell(value, type);
}

function selectedValueIdentity(value: unknown, type: SessionMetadata["schema"][number]["type"]): string {
  if (isTypedSelectionToken(value)) {
    if (value.columnType !== type) {
      throw new TypeError(
        `A typed selection token for ${JSON.stringify(value.columnType)} cannot target a ${JSON.stringify(type)} column.`
      );
    }
    return cellIdentity(value.cell, type);
  }
  return cellIdentity(selectedValueCell(value, type), type);
}

function isTypedSelectionToken(value: unknown): value is TypedSelectionToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "typedSelection") return false;
  const keys = Object.keys(record);
  if (keys.length !== 4 || !keys.includes("version") || !keys.includes("columnType") || !keys.includes("cell")) {
    throw new TypeError("A typed selection token contains unexpected or missing fields.");
  }
  if (record.version !== 1) throw new TypeError("A typed selection token has an unsupported version.");
  if (
    typeof record.columnType !== "string" ||
    ![
      "string",
      "integer",
      "float",
      "decimal",
      "boolean",
      "datetime",
      "date",
      "duration",
      "binary",
      "list",
      "struct",
      "unknown"
    ].includes(record.columnType)
  ) {
    throw new TypeError("A typed selection token contains an invalid column type.");
  }
  assertSelectionCell(record.cell, record.columnType as SessionMetadata["schema"][number]["type"]);
  return true;
}

function assertSelectionCell(
  value: unknown,
  columnType: SessionMetadata["schema"][number]["type"]
): asserts value is CellValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("A typed selection token must contain a normalized scalar cell.");
  }
  const cell = value as Record<string, unknown>;
  const keys = Object.keys(cell);
  const allowed = new Set(["kind", "raw", "display", "isNull", "isNaN", "sign"]);
  if (
    !keys.every((key) => allowed.has(key)) ||
    !["kind", "raw", "display", "isNull", "isNaN"].every((key) => keys.includes(key))
  ) {
    throw new TypeError("A typed selection token contains a malformed scalar cell.");
  }
  if (
    cell.isNull !== false ||
    cell.isNaN !== false ||
    typeof cell.display !== "string" ||
    cell.display.length > MAX_TYPED_SELECTION_TEXT_CHARACTERS
  ) {
    throw new TypeError("A typed selection token cannot represent null, NaN, or unbounded text.");
  }
  if (typeof cell.raw === "string" && cell.raw.length > MAX_TYPED_SELECTION_TEXT_CHARACTERS) {
    throw new TypeError("A typed selection token contains unbounded raw text.");
  }

  const compatibleKinds: Readonly<Record<SessionMetadata["schema"][number]["type"], readonly string[]>> = {
    string: ["string", "integer", "number", "infinity", "boolean", "decimal", "datetime", "date", "duration"],
    integer: ["integer"],
    float: ["number", "infinity"],
    decimal: ["decimal"],
    boolean: ["boolean"],
    datetime: ["datetime"],
    date: ["date"],
    duration: ["duration"],
    binary: [],
    list: [],
    struct: [],
    unknown: []
  };
  if (typeof cell.kind !== "string" || !compatibleKinds[columnType].includes(cell.kind)) {
    throw new TypeError(
      `A ${JSON.stringify(cell.kind)} typed selection cell is incompatible with ${JSON.stringify(columnType)} columns.`
    );
  }
  if (cell.kind !== "infinity" && Object.prototype.hasOwnProperty.call(cell, "sign")) {
    throw new TypeError("Only an infinity selection cell may contain a sign.");
  }

  const typedCell = cell as unknown as CellValue;
  switch (typedCell.kind) {
    case "string":
      if (typeof typedCell.raw !== "string") throw new TypeError("A string selection cell requires string raw data.");
      return;
    case "integer":
      integerValue(typedCell);
      return;
    case "number":
      if (typeof typedCell.raw !== "number" || !Number.isFinite(typedCell.raw)) {
        throw new TypeError("A numeric selection cell requires a finite numeric raw value.");
      }
      return;
    case "infinity":
      if (typedCell.raw !== null || (typedCell.sign !== -1 && typedCell.sign !== 1)) {
        throw new TypeError("An infinity selection cell requires null raw data and an explicit sign.");
      }
      return;
    case "boolean":
      booleanValue(typedCell);
      return;
    case "decimal":
      decimalValue(typedCell);
      return;
    case "date":
      temporalValue(typedCell, "date");
      return;
    case "datetime":
      temporalValue(typedCell, "datetime");
      return;
    case "duration":
      durationValue(typedCell);
      return;
    default:
      throw new TypeError("A typed selection token must contain a comparable scalar cell.");
  }
}

function snapshotSelectionValue(
  cell: CellValue,
  type: SessionMetadata["schema"][number]["type"]
): TypedSelectionToken | undefined {
  if (
    type !== "string" ||
    !["integer", "number", "infinity", "boolean", "decimal", "datetime", "date", "duration"].includes(cell.kind)
  ) {
    return undefined;
  }
  assertSelectionCell(cell, type);
  return {
    kind: "typedSelection",
    version: 1,
    columnType: type,
    cell: structuredClone(cell)
  };
}

function canonicalViewValue(value: unknown, type: SessionMetadata["schema"][number]["type"]): unknown {
  if (type === "string") return String(value);
  if (type === "integer") {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new TypeError("A snapshot integer predicate must be exact.");
      return value;
    }
    const text = String(value);
    if (!INTEGER_VIEW_TEXT.test(text)) {
      throw new TypeError("A snapshot integer predicate requires an optional sign and decimal digits.");
    }
    return text;
  }
  if (type === "float") {
    if (typeof value === "boolean") throw new TypeError("A snapshot float predicate cannot be boolean.");
    if (typeof value === "number") {
      if (Number.isNaN(value)) throw new TypeError("A snapshot NaN predicate must use the explicit NaN operator.");
      return value;
    }
    const text = String(value);
    if (!NUMBER_VIEW_TEXT.test(text) && !INFINITY_VIEW_TEXT.test(text)) {
      throw new TypeError("A snapshot float predicate requires a decimal number or explicit Infinity.");
    }
    const number = Number(text);
    if (!Number.isFinite(number) && !INFINITY_VIEW_TEXT.test(text)) {
      throw new TypeError("A snapshot float predicate overflow must use explicit Infinity.");
    }
    return number;
  }
  if (type === "decimal") {
    const text = String(value);
    if (!NUMBER_VIEW_TEXT.test(text)) throw new TypeError("A snapshot decimal predicate requires a decimal number.");
    return text;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized !== "true" && normalized !== "false") {
      throw new TypeError("A snapshot boolean predicate must be true or false.");
    }
    return normalized === "true";
  }
  if (type === "date") {
    const text = String(value);
    if (!DATE_VIEW_TEXT.test(text)) throw new TypeError("A snapshot date predicate requires YYYY-MM-DD.");
    assertPortableYear(text);
    temporalValue({ kind: "date", raw: text, display: text, isNull: false, isNaN: false }, "date");
    return text;
  }
  if (type === "datetime") {
    const text = String(value);
    if (!DATETIME_VIEW_TEXT.test(text)) {
      throw new TypeError("A snapshot datetime predicate requires a portable ISO datetime.");
    }
    assertPortableYear(text);
    temporalValue({ kind: "datetime", raw: text, display: text, isNull: false, isNaN: false }, "datetime");
    return text;
  }
  if (type === "duration") {
    const text = String(value);
    if (!DURATION_SECONDS_TEXT.test(text) && !DURATION_CLOCK_TEXT.test(text)) {
      throw new TypeError("A snapshot duration predicate requires seconds or '[days, ]HH:MM:SS[.ffffff]'.");
    }
    assertPortableDuration(text);
    durationValue({ kind: "duration", raw: text, display: text, isNull: false, isNaN: false });
    return text;
  }
  return value;
}

function assertPortableYear(text: string): void {
  const year = Number(text.slice(0, 4));
  if (!Number.isInteger(year) || year < 1 || year > 9_999) {
    throw new TypeError("A snapshot temporal predicate year must be between 0001 and 9999.");
  }
}

function assertPortableDuration(text: string): void {
  let microseconds: bigint;
  if (DURATION_SECONDS_TEXT.test(text)) {
    const match = /^([+-]?)(?:(\d+)(?:\.(\d{0,6}))?|\.(\d{1,6}))$/.exec(text);
    if (!match) throw new TypeError("A snapshot duration predicate is malformed.");
    const sign = match[1] === "-" ? -1n : 1n;
    const whole = BigInt(match[2] ?? "0");
    const fraction = BigInt((match[3] ?? match[4] ?? "").padEnd(6, "0") || "0");
    microseconds = sign * (whole * 1_000_000n + fraction);
  } else {
    const match = DURATION_CLOCK_TEXT.exec(text);
    if (!match) throw new TypeError("A snapshot duration predicate is malformed.");
    const days = BigInt(match[1] ?? "0");
    const hours = BigInt(boundedInteger(match[2], 0, 23, "duration hour"));
    const minutes = BigInt(boundedInteger(match[3], 0, 59, "duration minute"));
    const seconds = BigInt(boundedInteger(match[4], 0, 59, "duration second"));
    const fraction = BigInt((match[5] ?? "").padEnd(6, "0") || "0");
    microseconds = days * MICROSECONDS_PER_DAY + (hours * 3_600n + minutes * 60n + seconds) * 1_000_000n + fraction;
  }
  if (microseconds < MIN_PORTABLE_DURATION_MICROSECONDS || microseconds > MAX_PORTABLE_DURATION_MICROSECONDS) {
    throw new TypeError("A snapshot duration predicate exceeds the portable timedelta range.");
  }
}

function compareTypedCells(left: CellValue, right: CellValue, type: SessionMetadata["schema"][number]["type"]): number {
  switch (type) {
    case "integer":
      return compareBigInts(integerValue(left), integerValue(right));
    case "float":
      return compareNumbers(numberValue(left), numberValue(right));
    case "decimal":
      return compareDecimals(decimalValue(left), decimalValue(right));
    case "boolean":
      return compareBooleans(booleanValue(left), booleanValue(right));
    case "datetime":
      return compareBigInts(temporalValue(left, "datetime"), temporalValue(right, "datetime"));
    case "date":
      return compareBigInts(temporalValue(left, "date"), temporalValue(right, "date"));
    case "duration":
      return compareDecimals(durationValue(left), durationValue(right));
    case "string":
      return compareStrings(stringValue(left), stringValue(right));
    default:
      return compareStrings(left.display, right.display);
  }
}

function integerValue(cell: CellValue): bigint {
  const value = cell.raw ?? cell.display;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("A snapshot integer cell must contain an exact integer.");
    return BigInt(value);
  }
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new TypeError("A snapshot integer cell must contain an exact integer.");
  return BigInt(text);
}

function numberValue(cell: CellValue): number {
  if (cell.kind === "infinity" && cell.sign) return cell.sign < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const value = typeof cell.raw === "number" ? cell.raw : Number(cell.raw ?? cell.display);
  if (Number.isNaN(value)) throw new TypeError("A snapshot numeric cell must contain a number.");
  return value;
}

interface DecimalValue {
  sign: -1 | 0 | 1;
  magnitude: number;
  digits: string;
}

function decimalValue(cell: CellValue): DecimalValue {
  return parseDecimal(cell.raw ?? cell.display);
}

function durationValue(cell: CellValue): DecimalValue {
  const value = cell.raw ?? cell.display;
  if (typeof value === "number" || /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(String(value))) {
    return parseDecimal(value);
  }
  const match = /^(?:(-?\d+) days?, )?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(String(value));
  if (match) {
    const days = BigInt(match[1] ?? "0");
    const hours = BigInt(boundedInteger(match[2], 0, 23, "duration hour"));
    const minutes = BigInt(boundedInteger(match[3], 0, 59, "duration minute"));
    const seconds = BigInt(boundedInteger(match[4], 0, 59, "duration second"));
    const fraction = BigInt((match[5] ?? "").padEnd(9, "0") || "0");
    const nanoseconds = (days * 86_400n + hours * 3_600n + minutes * 60n + seconds) * 1_000_000_000n + fraction;
    const negative = nanoseconds < 0n;
    const magnitude = negative ? -nanoseconds : nanoseconds;
    const whole = magnitude / 1_000_000_000n;
    const remainder = magnitude % 1_000_000_000n;
    const decimal =
      remainder === 0n ? whole.toString() : `${whole}.${remainder.toString().padStart(9, "0").replace(/0+$/u, "")}`;
    return parseDecimal(`${negative ? "-" : ""}${decimal}`);
  }
  throw new TypeError("A snapshot duration cell must contain an exact duration in seconds.");
}

function parseDecimal(value: unknown): DecimalValue {
  const text = String(value);
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError("A snapshot decimal cell must contain an exact decimal.");
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent))
    throw new TypeError("A snapshot decimal exponent is outside the supported range.");
  const whole = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const combined = whole + fraction;
  const firstNonZero = combined.search(/[1-9]/);
  if (firstNonZero < 0) return { sign: 0, magnitude: 0, digits: "" };
  return {
    sign: match[1] === "-" ? -1 : 1,
    magnitude: whole.length + exponent - firstNonZero,
    digits: combined.slice(firstNonZero).replace(/0+$/, "")
  };
}

function compareDecimals(left: DecimalValue, right: DecimalValue): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  let magnitudeComparison = compareNumbers(left.magnitude, right.magnitude);
  if (magnitudeComparison === 0) {
    const length = Math.max(left.digits.length, right.digits.length);
    for (let index = 0; index < length; index += 1) {
      const leftDigit = left.digits.charCodeAt(index) || 48;
      const rightDigit = right.digits.charCodeAt(index) || 48;
      if (leftDigit !== rightDigit) {
        magnitudeComparison = leftDigit < rightDigit ? -1 : 1;
        break;
      }
    }
  }
  return left.sign === 1 ? magnitudeComparison : -magnitudeComparison;
}

function booleanValue(cell: CellValue): boolean {
  if (typeof cell.raw !== "boolean") throw new TypeError("A snapshot boolean cell must contain a boolean.");
  return cell.raw;
}

function stringValue(cell: CellValue): string {
  return typeof cell.raw === "string" ? cell.raw : cell.display;
}

function compareBigInts(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBooleans(left: boolean, right: boolean): number {
  return left === right ? 0 : left ? 1 : -1;
}

function compareStrings(left: string, right: string): number {
  if (!containsSurrogate(left) && !containsSurrogate(right)) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftCharacter = leftIterator.next();
    const rightCharacter = rightIterator.next();
    if (leftCharacter.done || rightCharacter.done) {
      return leftCharacter.done === rightCharacter.done ? 0 : leftCharacter.done ? -1 : 1;
    }
    const leftPoint = leftCharacter.value.codePointAt(0) ?? 0;
    const rightPoint = rightCharacter.value.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
}

function asciiLower(value: string): string {
  let result = "";
  for (const character of value) {
    const index = ASCII_UPPER.indexOf(character);
    result += index < 0 ? character : ASCII_LOWER[index];
  }
  return result;
}

function containsSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function temporalValue(cell: CellValue, type: "date" | "datetime"): bigint {
  const text = String(cell.raw ?? cell.display);
  const dateMatch = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(text);
  if (type === "date" && dateMatch) {
    return datePartsToNanoseconds(dateMatch);
  }
  const dateTimeMatch =
    /^([+-]?\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (type === "datetime" && dateTimeMatch) {
    const dateNanoseconds = datePartsToNanoseconds(dateTimeMatch);
    const hour = boundedInteger(dateTimeMatch[4], 0, 23, "hour");
    const minute = boundedInteger(dateTimeMatch[5], 0, 59, "minute");
    const second = boundedInteger(dateTimeMatch[6] ?? "0", 0, 59, "second");
    const fractional = BigInt((dateTimeMatch[7] ?? "").padEnd(9, "0") || "0");
    const offset = timezoneOffsetMinutes(dateTimeMatch[8]);
    return dateNanoseconds + BigInt(hour * 3_600 + minute * 60 + second - offset * 60) * 1_000_000_000n + fractional;
  }
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (type === "datetime" && timeMatch) {
    const hour = boundedInteger(timeMatch[1], 0, 23, "hour");
    const minute = boundedInteger(timeMatch[2], 0, 59, "minute");
    const second = boundedInteger(timeMatch[3] ?? "0", 0, 59, "second");
    const fractional = BigInt((timeMatch[4] ?? "").padEnd(9, "0") || "0");
    const offset = timezoneOffsetMinutes(timeMatch[5]);
    return BigInt(hour * 3_600 + minute * 60 + second - offset * 60) * 1_000_000_000n + fractional;
  }
  throw new TypeError(`A snapshot ${type} cell must contain an ISO ${type} value.`);
}

function datePartsToNanoseconds(match: RegExpExecArray): bigint {
  const year = Number(match[1]);
  const month = boundedInteger(match[2], 1, 12, "month");
  const day = boundedInteger(match[3], 1, daysInMonth(year, month), "day");
  return BigInt(daysFromCivil(year, month, day)) * 86_400_000_000_000n;
}

function boundedInteger(text: string | undefined, minimum: number, maximum: number, label: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`A snapshot temporal cell contains an invalid ${label}.`);
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function timezoneOffsetMinutes(value: string | undefined): number {
  if (!value || value === "Z") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (!match) throw new TypeError("A snapshot datetime cell contains an invalid time-zone offset.");
  const hours = boundedInteger(match[2], 0, 23, "time-zone hour");
  const minutes = boundedInteger(match[3], 0, 59, "time-zone minute");
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function assertSnapshotPageWindow(window: SnapshotPageWindow): void {
  assertNonNegativeInteger(window.offset, "Snapshot page offset");
  assertBoundedPositiveInteger(window.limit, MAX_PAGE_LIMIT, "Snapshot page limit");
  assertNonNegativeInteger(window.columnOffset, "Snapshot column offset");
  assertBoundedPositiveInteger(window.columnLimit, MAX_COLUMN_LIMIT, "Snapshot column limit");
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer.`);
  }
}

function assertBoundedPositiveInteger(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
}

function assertFullSchemaRows(metadata: SessionMetadata, rows: DataRow[]): void {
  for (const row of rows) {
    if (row.values.length !== metadata.schema.length) {
      throw new RangeError("A captured notebook row did not contain the complete saved schema.");
    }
    for (let position = 0; position < metadata.schema.length; position += 1) {
      if (row.values[position] === undefined) {
        throw new RangeError("A captured notebook row did not contain the complete saved schema.");
      }
    }
  }
}

function cellIdentity(cell: CellValue, type: SessionMetadata["schema"][number]["type"]): string {
  return JSON.stringify(stableCellValue(cell, type));
}

function stableRowKey(cells: Array<CellValue | undefined>, schema: SessionMetadata["schema"]): string {
  return JSON.stringify(cells.map((cell, index) => stableCellValue(cell, schema[index]?.type)));
}

function stableCellValue(cell: CellValue | undefined, type?: SessionMetadata["schema"][number]["type"]): unknown {
  if (!cell) return ["missing"];
  if (cell.isNull) return ["null"];
  if (cell.isNaN) return ["nan"];
  if (type === "decimal") {
    const decimal = decimalValue(cell);
    return ["decimal", decimal.sign, decimal.magnitude, decimal.digits];
  }
  if (type === "duration") {
    const duration = durationValue(cell);
    return ["duration", duration.sign, duration.magnitude, duration.digits];
  }
  if (type === "date" || type === "datetime") {
    return [type, temporalValue(cell, type).toString()];
  }
  if (type === "integer") return ["integer", integerValue(cell).toString()];
  if (type === "float") {
    const value = numberValue(cell);
    if (!Number.isFinite(value)) return ["float", value < 0 ? "-infinity" : "infinity"];
    return ["float", Object.is(value, -0) ? 0 : value];
  }
  if (type === "boolean") return ["boolean", booleanValue(cell)];
  if (type === "string") {
    const numericIdentity = pandasObjectNumericIdentity(cell);
    return numericIdentity ?? ["string", cell.kind, stringValue(cell)];
  }
  const value = Object.prototype.hasOwnProperty.call(cell, "raw")
    ? stableJsonValue(cell.raw)
    : ["display", cell.display];
  return [cell.kind, cell.sign ?? null, value];
}

function pandasObjectNumericIdentity(cell: CellValue): unknown[] | undefined {
  if (cell.kind === "infinity") {
    if (cell.sign !== -1 && cell.sign !== 1) throw new TypeError("A snapshot infinity cell requires a sign.");
    return ["string", "numeric", cell.sign < 0 ? "-infinity" : "infinity"];
  }

  let value: FactoredNumericValue;
  switch (cell.kind) {
    case "boolean":
      value = factoredNumericValue(booleanValue(cell) ? 1 : 0);
      break;
    case "integer":
      value = factoredDecimalValue(parseDecimal(cell.raw ?? cell.display));
      break;
    case "decimal":
      value = factoredDecimalValue(decimalValue(cell));
      break;
    case "number": {
      const numeric = numberValue(cell);
      if (!Number.isFinite(numeric)) return ["string", "numeric", numeric < 0 ? "-infinity" : "infinity"];
      value = factoredNumberValue(numeric);
      break;
    }
    default:
      return undefined;
  }
  return ["string", "numeric", value.sign, value.coefficient, value.power2, value.power5];
}

interface FactoredNumericValue {
  sign: -1 | 0 | 1;
  coefficient: string;
  power2: number;
  power5: number;
}

function factoredNumericValue(value: number): FactoredNumericValue {
  return normalizeFactoredNumeric(value < 0 ? -1 : value > 0 ? 1 : 0, BigInt(Math.abs(value)), 0, 0);
}

function factoredDecimalValue(value: DecimalValue): FactoredNumericValue {
  if (value.sign === 0) return normalizeFactoredNumeric(0, 0n, 0, 0);
  // Cross-kind equality is bounded to prevent a hostile captured object from
  // turning value counting into thousands of arbitrary-precision divisions.
  if (value.digits.length > 1_024) {
    return {
      sign: value.sign,
      coefficient: value.digits,
      power2: value.magnitude - value.digits.length,
      power5: value.magnitude - value.digits.length
    };
  }
  const decimalPower = value.magnitude - value.digits.length;
  return normalizeFactoredNumeric(value.sign, BigInt(value.digits), decimalPower, decimalPower);
}

function factoredNumberValue(value: number): FactoredNumericValue {
  if (Object.is(value, -0) || value === 0) return normalizeFactoredNumeric(0, 0n, 0, 0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const sign = bits >> 63n === 0n ? 1 : -1;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000f_ffff_ffff_ffffn;
  const coefficient = exponentBits === 0 ? fraction : (1n << 52n) + fraction;
  const power2 = exponentBits === 0 ? -1_074 : exponentBits - 1_023 - 52;
  return normalizeFactoredNumeric(sign, coefficient, power2, 0);
}

function normalizeFactoredNumeric(
  sign: -1 | 0 | 1,
  initialCoefficient: bigint,
  initialPower2: number,
  initialPower5: number
): FactoredNumericValue {
  if (sign === 0 || initialCoefficient === 0n) return { sign: 0, coefficient: "0", power2: 0, power5: 0 };
  let coefficient = initialCoefficient;
  let power2 = initialPower2;
  let power5 = initialPower5;
  while (coefficient % 2n === 0n) {
    coefficient /= 2n;
    power2 += 1;
  }
  while (coefficient % 5n === 0n) {
    coefficient /= 5n;
    power5 += 1;
  }
  return { sign, coefficient: coefficient.toString(), power2, power5 };
}

function stableJsonValue(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ["number", "nan"];
    if (!Number.isFinite(value)) return ["number", value > 0 ? "infinity" : "-infinity"];
    return value;
  }
  if (Array.isArray(value)) return ["array", value.map(stableJsonValue)];
  if (typeof value === "object") {
    return [
      "object",
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stableJsonValue(item)])
    ];
  }
  return [typeof value, String(value)];
}

function snapshotVisualization(
  type: SessionMetadata["schema"][number]["type"],
  values: CellValue[],
  topValues: ValueCount[],
  numericValues: number[]
): NonNullable<ColumnSummary["visualization"]> {
  if (type === "integer" || type === "float" || type === "decimal") {
    return numericVisualization(numericValues);
  }
  if (type === "boolean") {
    let trueCount = 0;
    let falseCount = 0;
    for (const cell of values) {
      if (cell.raw === true) trueCount += 1;
      if (cell.raw === false) falseCount += 1;
    }
    return { kind: "boolean", trueCount, falseCount };
  }
  if (type === "datetime" || type === "date") {
    if (values.length === 0) return { kind: "datetime", min: null, max: null };
    let minimum = values[0];
    let maximum = values[0];
    for (const cell of values.slice(1)) {
      if (compareTypedCells(cell, minimum, type) < 0) minimum = cell;
      if (compareTypedCells(cell, maximum, type) > 0) maximum = cell;
    }
    return { kind: "datetime", min: minimum.display, max: maximum.display };
  }

  const categories = topValues.slice(0, 6);
  const shownCount = categories.reduce((sum, item) => sum + item.count, 0);
  return { kind: "categorical", categories, otherCount: Math.max(0, values.length - shownCount) };
}

function numericVisualization(
  values: number[]
): Extract<NonNullable<ColumnSummary["visualization"]>, { kind: "numeric" }> {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return { kind: "numeric", bins: [] };
  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  if (minimum === maximum) {
    return { kind: "numeric", bins: [{ min: minimum, max: maximum, count: finiteValues.length }] };
  }

  const binCount = Math.min(20, Math.max(1, new Set(finiteValues).size));
  const width = (maximum - minimum) / binCount;
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of finiteValues) {
    const index = Math.min(Math.floor((value - minimum) / width), binCount - 1);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return {
    kind: "numeric",
    bins: counts.map((count, index) => ({
      min: minimum + width * index,
      max: index === binCount - 1 ? maximum : minimum + width * (index + 1),
      count
    }))
  };
}

function sampleStandardDeviation(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squaredDifferenceTotal = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squaredDifferenceTotal / (values.length - 1));
}

function finiteNumericSummary(
  values: Record<"min" | "max" | "mean" | "median" | "std", number | undefined>
): NonNullable<ColumnSummary["numeric"]> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
