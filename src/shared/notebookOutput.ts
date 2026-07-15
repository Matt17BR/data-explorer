import type { ColumnSummary, GridPage, SessionMetadata, SessionOpenedResponse } from "./protocol";

export const DATA_EXPLORER_MIME_V1 = "application/vnd.data-explorer.viewer.v1+json";
export const DATA_EXPLORER_MIME_V2 = "application/vnd.data-explorer.viewer.v2+json";
export const DATA_EXPLORER_MIME = DATA_EXPLORER_MIME_V2;

export interface NotebookOutputPayload {
  mimeVersion: 1 | 2;
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
}

export function normalizeNotebookOutputPayload(value: unknown): NotebookOutputPayload | undefined {
  if (!isRecord(value) || !isRecord(value.metadata) || !isGridPage(value.page) || !Array.isArray(value.summaries)) {
    return undefined;
  }
  if (value.mimeVersion !== undefined && value.mimeVersion !== 2) return undefined;
  const raw = value.metadata;
  const backend = raw.backend === "pandas" || raw.backend === "polars" ? raw.backend : undefined;
  const shape = dataShape(raw.shape);
  const filteredShape = dataShape(raw.filteredShape) ?? shape;
  if (!backend || !shape || !filteredShape || !Array.isArray(raw.schema)) return undefined;

  const rawSource = isRecord(raw.source) ? raw.source : {};
  const sourceKind =
    rawSource.kind === "file" || rawSource.kind === "notebookVariable" || rawSource.kind === "notebookOutput"
      ? rawSource.kind
      : "notebookOutput";
  const label = typeof rawSource.label === "string" && rawSource.label ? rawSource.label : "dataframe";
  const source: SessionMetadata["source"] = {
    kind: sourceKind,
    label,
    ...(typeof rawSource.path === "string" ? { path: rawSource.path } : {}),
    ...(typeof rawSource.uri === "string" ? { uri: rawSource.uri } : {}),
    ...(typeof rawSource.variableName === "string" ? { variableName: rawSource.variableName } : {})
  };
  const rawFilter = isRecord(raw.filterModel) ? raw.filterModel : {};
  const filterModel = {
    ...(rawFilter.logic === "or" ? { logic: "or" as const } : {}),
    filters: Array.isArray(rawFilter.filters) ? rawFilter.filters : [],
    sort: Array.isArray(rawFilter.sort) ? rawFilter.sort : []
  } as SessionMetadata["filterModel"];
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : `notebook-output:${label}`,
    revision: nonNegativeInteger(raw.revision) ? raw.revision : 0,
    backend,
    mode: raw.mode === "editing" ? "editing" : "viewing",
    source,
    capabilities: isCapabilities(raw.capabilities)
      ? raw.capabilities
      : {
          editable: false,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false
        },
    shape,
    filteredShape,
    schema: raw.schema as SessionMetadata["schema"],
    filterModel,
    steps: Array.isArray(raw.steps) ? (raw.steps as SessionMetadata["steps"]) : [],
    ...(isDatasetStats(raw.stats) ? { stats: raw.stats } : {})
  };
  return {
    mimeVersion: value.mimeVersion === 2 ? 2 : 1,
    metadata,
    page: value.page,
    summaries: value.summaries as ColumnSummary[]
  };
}

export function notebookPayloadAsOpened(payload: NotebookOutputPayload): SessionOpenedResponse {
  return { kind: "sessionOpened", metadata: payload.metadata, page: payload.page, summaries: payload.summaries };
}

function isGridPage(value: unknown): value is GridPage {
  if (!isRecord(value)) return false;
  return (
    nonNegativeInteger(value.offset) &&
    nonNegativeInteger(value.totalRows) &&
    nonNegativeInteger(value.limit) &&
    value.limit > 0 &&
    Array.isArray(value.rows)
  );
}

function dataShape(value: unknown): SessionMetadata["shape"] | undefined {
  if (!isRecord(value) || !nonNegativeInteger(value.rows) || !nonNegativeInteger(value.columns)) return undefined;
  return { rows: value.rows, columns: value.columns };
}

function isCapabilities(value: unknown): value is SessionMetadata["capabilities"] {
  if (!isRecord(value)) return false;
  return ["editable", "lazy", "cancel", "exportCsv", "exportParquet", "notebookInsert"].every(
    (key) => typeof value[key] === "boolean"
  );
}

function isDatasetStats(value: unknown): value is NonNullable<SessionMetadata["stats"]> {
  return (
    isRecord(value) &&
    nonNegativeInteger(value.missingCells) &&
    nonNegativeInteger(value.missingRows) &&
    nonNegativeInteger(value.duplicateRows) &&
    Array.isArray(value.missingValuesByColumn)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
