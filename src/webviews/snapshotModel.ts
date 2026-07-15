import type {
  CellValue,
  ColumnSummary,
  DataRow,
  SessionMetadata,
  ValueCount,
  ValuesResponse
} from "../shared/protocol";
import type { ColumnFilter, FilterModel, PredicateFilter } from "../shared/filterModel";

export function applySnapshotFilters(metadata: SessionMetadata, rows: DataRow[], model: FilterModel): DataRow[] {
  const filtered = rows.filter((row) => {
    const matches = model.filters.map((filter) => snapshotFilterMatches(metadata, row, filter));
    return (model.logic ?? "and") === "or" ? matches.length === 0 || matches.some(Boolean) : matches.every(Boolean);
  });
  const [firstSort, ...remainingSorts] = model.sort;
  if (!firstSort) {
    return filtered;
  }

  return [...filtered].sort((left, right) => {
    for (const rule of [firstSort, ...remainingSorts]) {
      const index = metadata.schema.findIndex((column) => column.name === rule.column);
      const comparison = compareCells(left.values[index], right.values[index], rule.direction, rule.nulls);
      if (comparison !== 0) {
        return comparison;
      }
    }
    return left.rowNumber - right.rowNumber;
  });
}

export function snapshotColumnValues(
  metadata: SessionMetadata,
  rows: DataRow[],
  model: FilterModel,
  column: string,
  search?: string
): ValuesResponse {
  const index = metadata.schema.findIndex((schema) => schema.name === column);
  const searchText = search?.toLowerCase() ?? "";
  const counts = new Map<string, number>();
  for (const row of applySnapshotFilters(metadata, rows, model)) {
    const cell = row.values[index];
    if (!cell || cell.isNull || cell.isNaN) {
      continue;
    }
    if (searchText && !cell.display.toLowerCase().includes(searchText)) {
      continue;
    }
    counts.set(cell.display, (counts.get(cell.display) ?? 0) + 1);
  }

  return {
    kind: "columnValues",
    revision: metadata.revision,
    column,
    values: [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 100)
      .map(([value, count]) => ({ value, count })),
    hasMore: counts.size > 100
  };
}

export function snapshotSummaries(metadata: SessionMetadata, rows: DataRow[]): ColumnSummary[] {
  return metadata.schema.map((schema, index) => {
    const cells = rows.map((row) => row.values[index]).filter(Boolean);
    const values = cells.filter((cell) => !cell.isNull && !cell.isNaN);
    const counts = new Map<string, number>();
    for (const cell of values) {
      counts.set(cell.display, (counts.get(cell.display) ?? 0) + 1);
    }
    const numericValues = values
      .map((cell) => (typeof cell.raw === "number" ? cell.raw : Number(cell.display)))
      .filter((value) => Number.isFinite(value));
    const topValues: ValueCount[] = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));

    return {
      column: schema.name,
      type: schema.type,
      rawType: schema.rawType,
      totalCount: rows.length,
      nullCount: cells.filter((cell) => cell.isNull).length,
      nanCount: cells.filter((cell) => cell.isNaN).length,
      distinctCount: counts.size,
      topValues,
      numeric:
        numericValues.length > 0
          ? {
              min: Math.min(...numericValues),
              max: Math.max(...numericValues),
              mean: numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
              median: median(numericValues)
            }
          : undefined
    };
  });
}

function snapshotFilterMatches(metadata: SessionMetadata, row: DataRow, filter: ColumnFilter): boolean {
  const index = metadata.schema.findIndex((column) => column.name === filter.column);
  if (index < 0) {
    return true;
  }
  const cell = row.values[index];
  const valueText = cell.display.toLowerCase();
  const conditions: boolean[] = [];
  const valueFilter = filter.valueFilter;
  if (valueFilter && (valueFilter.selectedValues.length > 0 || valueFilter.includeNulls || valueFilter.includeNaN)) {
    const selected = new Set(valueFilter.selectedValues.map(String));
    const selectedMatch = selected.has(cell.display);
    const nullMatch = valueFilter.includeNulls && cell.isNull;
    const nanMatch = valueFilter.includeNaN && cell.isNaN;
    conditions.push(selectedMatch || nullMatch || nanMatch);
  }

  conditions.push(...filter.predicates.map((predicate) => predicateMatches(cell, valueText, predicate)));
  return (filter.logic ?? "and") === "or"
    ? conditions.length === 0 || conditions.some(Boolean)
    : conditions.every(Boolean);
}

function predicateMatches(cell: CellValue, valueText: string, predicate: PredicateFilter): boolean {
  const value = String(predicate.value ?? "").toLowerCase();
  const raw = typeof cell.raw === "number" ? cell.raw : Number(cell.display);
  const predicateNumber = Number(predicate.value);
  const secondNumber = Number(predicate.secondValue);
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
  switch (predicate.operator) {
    case "equals":
      return valueText === value;
    case "notEquals":
      return valueText !== value;
    case "contains":
      return valueText.includes(value);
    case "startsWith":
      return valueText.startsWith(value);
    case "endsWith":
      return valueText.endsWith(value);
    case "gt":
      return raw > predicateNumber;
    case "gte":
      return raw >= predicateNumber;
    case "lt":
      return raw < predicateNumber;
    case "lte":
      return raw <= predicateNumber;
    case "between":
      return raw >= predicateNumber && raw <= secondNumber;
    default:
      return true;
  }
}

function compareCells(
  left: CellValue | undefined,
  right: CellValue | undefined,
  direction: "asc" | "desc",
  nulls: "first" | "last"
): number {
  const leftNull = !left || left.isNull;
  const rightNull = !right || right.isNull;
  if (leftNull && rightNull) {
    return 0;
  }
  if (leftNull) {
    return nulls === "first" ? -1 : 1;
  }
  if (rightNull) {
    return nulls === "first" ? 1 : -1;
  }
  let comparison: number;
  if (typeof left.raw === "number" && typeof right.raw === "number") {
    comparison = left.raw - right.raw;
  } else {
    comparison = left.display.localeCompare(right.display);
  }
  return direction === "asc" ? comparison : -comparison;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
