import type { ColumnSummary, GridPage, SessionMetadata } from "./protocol";
import { isOpenWranglerResponse } from "./protocolValidation";

export const OPEN_WRANGLER_MIME_V2 = "application/vnd.openwrangler.viewer.v2+json";

export const NOTEBOOK_OUTPUT_LIMITS = {
  rows: 10_000,
  columns: 2_048,
  cells: 100_000,
  bytes: 16_777_216,
  labelCharacters: 256,
  columnCharacters: 512,
  cellCharacters: 65_536
} as const;
const MAX_SAVED_PAYLOAD_NODES = 1_000_000;
const MAX_SAVED_PAYLOAD_DEPTH = 64;

export interface NotebookOutputPayload {
  mimeVersion: 2;
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
}

export function normalizeNotebookOutputPayload(value: unknown): NotebookOutputPayload | undefined {
  if (!isRecord(value) || value.mimeVersion !== 2) return undefined;
  if (!hasBoundedSavedOutputContainers(value.metadata, value.page, value.summaries, true)) return undefined;
  const page = migrateLegacyFullWidthPage(value.metadata, value.page);
  if (!hasBoundedSavedOutputContainers(value.metadata, page, value.summaries)) return undefined;
  const candidate = { mimeVersion: 2, metadata: value.metadata, page, summaries: value.summaries };
  if (!isWithinPayloadBudget(candidate)) return undefined;
  const opened = {
    kind: "sessionOpened",
    metadata: value.metadata,
    page,
    // Saved profiles are never trusted. SnapshotBridge recomputes every
    // summary from the captured typed rows under the active view.
    summaries: []
  };
  if (!isOpenWranglerResponse(opened) || opened.kind !== "sessionOpened") return undefined;
  if (!isCanonicalSavedOutput(opened.metadata, opened.page)) return undefined;
  if (!isWithinSavedOutputBudget(opened.metadata, opened.page)) return undefined;
  if (!hasBoundedSavedOutputFields(opened.metadata, opened.page, opened.summaries)) return undefined;
  if (
    opened.page.offset !== 0 ||
    opened.page.rows.length > opened.page.totalRows ||
    (opened.page.totalRows > 0 && opened.page.rows.length === 0) ||
    !hasCanonicalCapturedRows(opened.page) ||
    !hasCanonicalCapturedCells(opened.page)
  ) {
    return undefined;
  }
  if (
    opened.page.columnIds.length !== opened.metadata.schema.length ||
    !opened.page.columnIds.every((columnId, position) => columnId === opened.metadata.schema[position]?.id)
  ) {
    // Saved notebook outputs are self-contained snapshots. Unlike live pages,
    // they have no runtime session from which a missing horizontal block can be
    // fetched, so accept only a complete schema-aligned page.
    return undefined;
  }
  const { stats: _savedStats, ...metadata } = opened.metadata;
  return {
    mimeVersion: 2,
    metadata,
    page: opened.page,
    summaries: []
  };
}

function hasCanonicalCapturedCells(page: GridPage): boolean {
  return page.rows.every((row) =>
    row.values.every((cell) => {
      if (cell.isNull || cell.kind === "null") {
        return (
          cell.kind === "null" &&
          cell.isNull &&
          !cell.isNaN &&
          cell.raw === null &&
          cell.display === "" &&
          cell.sign === undefined
        );
      }
      if (cell.isNaN || cell.kind === "nan") {
        return (
          cell.kind === "nan" &&
          cell.isNaN &&
          !cell.isNull &&
          cell.raw === null &&
          cell.display === "NaN" &&
          cell.sign === undefined
        );
      }
      if (cell.kind === "infinity" || cell.sign !== undefined) {
        return (
          cell.kind === "infinity" &&
          !cell.isNull &&
          !cell.isNaN &&
          cell.raw === null &&
          (cell.sign === -1 || cell.sign === 1) &&
          cell.display === (cell.sign === -1 ? "-Infinity" : "Infinity")
        );
      }
      return !cell.isNull && !cell.isNaN && cell.sign === undefined;
    })
  );
}

function hasCanonicalCapturedRows(page: GridPage): boolean {
  const rowIds = new Set<string>();
  return page.rows.every((row, position) => {
    if (row.id.length === 0 || rowIds.has(row.id) || row.rowNumber !== position) return false;
    rowIds.add(row.id);
    return true;
  });
}

function isCanonicalSavedOutput(metadata: SessionMetadata, page: GridPage): boolean {
  const source = metadata.source;
  const capabilities = metadata.capabilities;
  return (
    metadata.revision === 0 &&
    (metadata.backend === "pandas" || metadata.backend === "polars") &&
    metadata.mode === "viewing" &&
    source.kind === "notebookOutput" &&
    source.path === undefined &&
    source.uri === undefined &&
    source.importOptions === undefined &&
    (source.variableName === undefined || isPythonIdentifier(source.variableName)) &&
    !capabilities.editable &&
    !capabilities.lazy &&
    !capabilities.cancel &&
    !capabilities.exportCsv &&
    !capabilities.exportParquet &&
    !capabilities.notebookInsert &&
    metadata.steps.length === 0 &&
    metadata.draftStep === undefined &&
    metadata.draftReplacesStepId === undefined &&
    metadata.latestStepInputSchema === undefined &&
    metadata.filterModel.filters.length === 0 &&
    metadata.filterModel.sort.length === 0 &&
    metadata.shape.rows === metadata.filteredShape.rows &&
    metadata.filteredShape.rows === page.totalRows &&
    metadata.shape.columns === metadata.schema.length &&
    metadata.filteredShape.columns === metadata.schema.length
  );
}

export function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function isWithinSavedOutputBudget(metadata: SessionMetadata, page: GridPage): boolean {
  if (
    !Number.isSafeInteger(metadata.shape.rows) ||
    !Number.isSafeInteger(metadata.shape.columns) ||
    !Number.isSafeInteger(page.totalRows) ||
    page.limit > NOTEBOOK_OUTPUT_LIMITS.rows ||
    page.rows.length > NOTEBOOK_OUTPUT_LIMITS.rows ||
    metadata.schema.length > NOTEBOOK_OUTPUT_LIMITS.columns ||
    page.rows.length * metadata.schema.length > NOTEBOOK_OUTPUT_LIMITS.cells
  ) {
    return false;
  }
  return true;
}

function hasBoundedSavedOutputFields(metadata: SessionMetadata, page: GridPage, summaries: ColumnSummary[]): boolean {
  if (
    exceedsCodePointLimit(metadata.source.label, NOTEBOOK_OUTPUT_LIMITS.labelCharacters) ||
    (metadata.source.variableName !== undefined &&
      exceedsCodePointLimit(metadata.source.variableName, NOTEBOOK_OUTPUT_LIMITS.labelCharacters))
  ) {
    return false;
  }
  const boundedColumnText = (value: string): boolean =>
    !exceedsCodePointLimit(value, NOTEBOOK_OUTPUT_LIMITS.columnCharacters);
  if (
    !metadata.schema.every(
      (column) => boundedColumnText(column.id) && boundedColumnText(column.name) && boundedColumnText(column.rawType)
    ) ||
    !page.columnIds.every(boundedColumnText) ||
    !page.rows.every(
      (row) =>
        boundedColumnText(row.id) &&
        row.values.every((cell) => !exceedsCodePointLimit(cell.display, NOTEBOOK_OUTPUT_LIMITS.cellCharacters))
    ) ||
    !summaries.every(
      (summary) =>
        boundedColumnText(summary.column) &&
        boundedColumnText(summary.rawType) &&
        summary.topValues.every((item) => !exceedsCodePointLimit(item.value, NOTEBOOK_OUTPUT_LIMITS.cellCharacters))
    )
  ) {
    return false;
  }
  return true;
}

function hasBoundedSavedOutputContainers(
  metadata: unknown,
  page: unknown,
  summaries: unknown,
  allowLegacyColumnIds = false
): boolean {
  if (!isRecord(metadata) || !Array.isArray(metadata.schema) || !isRecord(page)) return false;
  if (!Array.isArray(page.rows) || !Array.isArray(summaries)) return false;
  if (!Array.isArray(page.columnIds) && !(allowLegacyColumnIds && page.columnIds === undefined)) return false;
  const columnIdCount = Array.isArray(page.columnIds) ? page.columnIds.length : metadata.schema.length;
  if (
    metadata.schema.length > NOTEBOOK_OUTPUT_LIMITS.columns ||
    columnIdCount > NOTEBOOK_OUTPUT_LIMITS.columns ||
    page.rows.length > NOTEBOOK_OUTPUT_LIMITS.rows ||
    typeof page.limit !== "number" ||
    page.limit > NOTEBOOK_OUTPUT_LIMITS.rows ||
    summaries.length > metadata.schema.length ||
    page.rows.length * metadata.schema.length > NOTEBOOK_OUTPUT_LIMITS.cells
  ) {
    return false;
  }
  let capturedCells = 0;
  for (const row of page.rows) {
    if (!isRecord(row) || !Array.isArray(row.values) || row.values.length > metadata.schema.length) return false;
    capturedCells += row.values.length;
    if (capturedCells > NOTEBOOK_OUTPUT_LIMITS.cells) return false;
  }
  for (const summary of summaries) {
    if (!isRecord(summary)) return false;
    if (Array.isArray(summary.topValues) && summary.topValues.length > 10) return false;
    const visualization = summary.visualization;
    if (!isRecord(visualization)) continue;
    if (Array.isArray(visualization.bins) && visualization.bins.length > 20) return false;
    if (Array.isArray(visualization.categories) && visualization.categories.length > 6) return false;
  }
  return true;
}

function isWithinPayloadBudget(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const encoder = new TextEncoder();
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_SAVED_PAYLOAD_DEPTH) return false;
    nodes += 1;
    if (nodes > MAX_SAVED_PAYLOAD_NODES) return false;
    const item = current.value;
    if (typeof item === "string") {
      if (exceedsCodePointLimit(item, NOTEBOOK_OUTPUT_LIMITS.cellCharacters)) return false;
      if (item.length > NOTEBOOK_OUTPUT_LIMITS.bytes - bytes) return false;
      bytes += encoder.encode(item).byteLength;
    } else if (typeof item === "number") {
      bytes += 8;
    } else if (typeof item === "boolean") {
      bytes += 1;
    } else if (item === null) {
      bytes += 4;
    } else if (Array.isArray(item)) {
      if (seen.has(item)) return false;
      seen.add(item);
      bytes += 2;
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
    } else if (isRecord(item)) {
      if (seen.has(item)) return false;
      seen.add(item);
      bytes += 2;
      for (const [key, nested] of Object.entries(item)) {
        if (exceedsCodePointLimit(key, NOTEBOOK_OUTPUT_LIMITS.cellCharacters)) return false;
        if (key.length > NOTEBOOK_OUTPUT_LIMITS.bytes - bytes) return false;
        bytes += encoder.encode(key).byteLength;
        stack.push({ value: nested, depth: current.depth + 1 });
      }
    } else {
      return false;
    }
    if (bytes > NOTEBOOK_OUTPUT_LIMITS.bytes) return false;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= NOTEBOOK_OUTPUT_LIMITS.bytes;
  } catch {
    return false;
  }
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function migrateLegacyFullWidthPage(metadata: unknown, page: unknown): unknown {
  if (!isRecord(metadata) || !isRecord(page) || Object.prototype.hasOwnProperty.call(page, "columnIds")) {
    return page;
  }
  if (!Array.isArray(metadata.schema) || !Array.isArray(page.rows)) return page;
  const columnIds = metadata.schema.map((column) => (isRecord(column) ? column.id : undefined));
  if (!columnIds.every((columnId): columnId is string => typeof columnId === "string" && columnId.length > 0)) {
    return page;
  }
  const isFullWidth = page.rows.every(
    (row) => isRecord(row) && Array.isArray(row.values) && row.values.length === columnIds.length
  );
  return isFullWidth ? { ...page, columnIds } : page;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
