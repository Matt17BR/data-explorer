/* Generated from protocol/data-explorer.v2.schema.json. Do not edit. */

/**
 * Canonical standalone and Jupyter transport contract for Data Explorer protocol v2.
 */
export type DataExplorerTransportMessage = RuntimeRequestEnvelope | RuntimeResponseEnvelope;
export type ProtocolVersion = 2;
export type RequestPriority = "interactive" | "background";
export type DataExplorerRequest =
  | InitializeRequest
  | OpenSessionRequest
  | PageRequest
  | SummaryRequest
  | DatasetStatsRequest
  | ValuesRequest
  | PreviewStepRequest
  | ApplyDraftRequest
  | DiscardDraftRequest
  | UndoStepRequest
  | CloseSessionRequest
  | CancelRequest;
export type DataBackend = "polars" | "pandas";
export type SessionMode = "viewing" | "editing";
export type PageRequest = SessionRequestBase & {
  kind: "getPage";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
  filterModel: FilterModel;
};
export type ColumnType =
  | "string"
  | "integer"
  | "float"
  | "decimal"
  | "boolean"
  | "datetime"
  | "date"
  | "duration"
  | "binary"
  | "list"
  | "struct"
  | "unknown";
export type OperationKind =
  | "sortRows"
  | "filterRows"
  | "dropMissingRows"
  | "dropDuplicates"
  | "selectColumns"
  | "dropColumns"
  | "renameColumn"
  | "cloneColumn"
  | "castColumn"
  | "formula"
  | "textLength"
  | "oneHotEncode"
  | "multiLabelBinarize"
  | "findReplace"
  | "stripText"
  | "splitText"
  | "capitalizeText"
  | "lowerText"
  | "upperText"
  | "minMaxScale"
  | "roundNumber"
  | "floorNumber"
  | "ceilNumber"
  | "formatDatetime"
  | "groupBy"
  | "customCode";
export type DataExplorerResponse =
  | InitializedResponse
  | SessionOpenedResponse
  | PageResponse
  | SummaryResponse
  | DatasetStatsResponse
  | ValuesResponse
  | StepPreviewResponse
  | PlanUpdatedResponse
  | SessionClosedResponse
  | CancelledResponse
  | ErrorResponse;
export type TypedCellKind =
  | "null"
  | "nan"
  | "infinity"
  | "boolean"
  | "number"
  | "integer"
  | "string"
  | "decimal"
  | "datetime"
  | "date"
  | "duration"
  | "binary"
  | "list"
  | "struct"
  | "unknown";
export type ColumnVisualization =
  | {
      kind: "numeric";
      bins: NumericBin[];
      sampled?: boolean;
    }
  | {
      kind: "categorical";
      categories: ValueCount[];
      otherCount: number;
      sampled?: boolean;
    }
  | {
      kind: "boolean";
      trueCount: number;
      falseCount: number;
      sampled?: boolean;
    }
  | {
      kind: "datetime";
      min?: string | null;
      max?: string | null;
      sampled?: boolean;
    };

export interface RuntimeRequestEnvelope {
  protocolVersion: ProtocolVersion;
  requestId: string;
  priority: RequestPriority;
  request: DataExplorerRequest;
}
export interface InitializeRequest {
  kind: "initialize";
}
export interface OpenSessionRequest {
  kind: "openSession";
  source: SessionSource;
  backend?: DataBackend;
  mode?: SessionMode;
  pageSize: number;
}
export interface SessionSource {
  kind: "file" | "notebookVariable" | "notebookOutput";
  label: string;
  path?: string;
  uri?: string;
  variableName?: string;
  importOptions?: {
    delimiter?: string;
    encoding?: string;
    quoteChar?: string;
    hasHeader?: boolean;
    sheet?: string | number;
  };
}
export interface SessionRequestBase {
  sessionId: string;
  revision: number;
  [k: string]: unknown;
}
export interface FilterModel {
  logic?: "and" | "or";
  filters: ColumnFilter[];
  sort: {
    column: string;
    direction: "asc" | "desc";
    nulls: "first" | "last";
  }[];
}
export interface ColumnFilter {
  column: string;
  type: ColumnType;
  logic?: "and" | "or";
  valueFilter?: {
    kind: "values";
    selectedValues: unknown[];
    includeNulls: boolean;
    includeNaN: boolean;
    search?: string;
  };
  predicates: PredicateFilter[];
}
export interface PredicateFilter {
  kind: "predicate";
  operator:
    | "equals"
    | "notEquals"
    | "contains"
    | "startsWith"
    | "endsWith"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "between"
    | "isNull"
    | "isNotNull"
    | "isNaN"
    | "isNotNaN";
  value?: unknown;
  secondValue?: unknown;
}
export interface SummaryRequest {
  kind: "getSummary";
  sessionId: string;
  revision: number;
  filterModel: FilterModel;
  columns?: string[];
}
export interface DatasetStatsRequest {
  kind: "getDatasetStats";
  sessionId: string;
  revision: number;
  filterModel: FilterModel;
}
export interface ValuesRequest {
  kind: "getColumnValues";
  sessionId: string;
  revision: number;
  column: string;
  filterModel: FilterModel;
  search?: string;
  limit: number;
}
export interface PreviewStepRequest {
  kind: "previewStep";
  sessionId: string;
  revision: number;
  step: TransformStep;
  replaceStepId?: string;
  offset: number;
  limit: number;
}
export interface TransformStep {
  id: string;
  kind: OperationKind;
  params: {
    [k: string]: unknown;
  };
}
export interface ApplyDraftRequest {
  kind: "applyDraft";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
}
export interface DiscardDraftRequest {
  kind: "discardDraft";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
}
export interface UndoStepRequest {
  kind: "undoStep";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
}
export interface CloseSessionRequest {
  kind: "closeSession";
  sessionId: string;
  revision: number;
}
export interface CancelRequest {
  kind: "cancelRequest";
  targetRequestId: string;
}
export interface RuntimeResponseEnvelope {
  protocolVersion: ProtocolVersion;
  requestId: string;
  response: DataExplorerResponse;
}
export interface InitializedResponse {
  kind: "initialized";
  protocolVersion: ProtocolVersion;
  runtimeVersion: string;
  capabilities: SourceCapabilities;
}
export interface SourceCapabilities {
  editable: boolean;
  lazy: boolean;
  cancel: boolean;
  exportCsv: boolean;
  exportParquet: boolean;
  notebookInsert: boolean;
}
export interface SessionOpenedResponse {
  kind: "sessionOpened";
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
}
export interface SessionMetadata {
  protocolVersion: ProtocolVersion;
  sessionId: string;
  revision: number;
  backend: DataBackend;
  mode: SessionMode;
  source: SessionSource;
  capabilities: SourceCapabilities;
  shape: DataShape;
  filteredShape: DataShape;
  schema: ColumnSchema[];
  filterModel: FilterModel;
  steps: TransformStep[];
  latestStepInputSchema?: ColumnSchema[];
  draftStep?: TransformStep;
  draftReplacesStepId?: string;
  stats?: DatasetStats;
}
export interface DataShape {
  rows: number;
  columns: number;
}
export interface ColumnSchema {
  id: string;
  name: string;
  position: number;
  rawType: string;
  type: ColumnType;
  nullable: boolean;
}
export interface DatasetStats {
  missingCells: number;
  missingRows: number;
  duplicateRows: number;
  missingValuesByColumn: {
    column: string;
    count: number;
  }[];
}
export interface GridPage {
  offset: number;
  limit: number;
  totalRows: number;
  rows: DataRow[];
}
export interface DataRow {
  id: string;
  rowNumber: number;
  values: CellValue[];
}
export interface CellValue {
  kind: TypedCellKind;
  raw?: unknown;
  display: string;
  isNull: boolean;
  isNaN: boolean;
  sign?: -1 | 1;
}
export interface ColumnSummary {
  column: string;
  type: ColumnType;
  rawType: string;
  totalCount: number;
  nullCount: number;
  nanCount: number;
  distinctCount?: number;
  numeric?: NumericSummary;
  visualization?: ColumnVisualization;
  topValues: ValueCount[];
  sampled?: boolean;
}
export interface NumericSummary {
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std?: number;
}
export interface NumericBin {
  min: number;
  max: number;
  count: number;
}
export interface ValueCount {
  value: string;
  count: number;
}
export interface PageResponse {
  kind: "page";
  revision: number;
  page: GridPage;
  metadata: SessionMetadata;
}
export interface SummaryResponse {
  kind: "summary";
  revision: number;
  summaries: ColumnSummary[];
}
export interface DatasetStatsResponse {
  kind: "datasetStats";
  revision: number;
  stats: DatasetStats;
}
export interface ValuesResponse {
  kind: "columnValues";
  revision: number;
  column: string;
  values: ValueCount[];
  hasMore: boolean;
}
export interface StepPreviewResponse {
  kind: "stepPreview";
  revision: number;
  metadata: SessionMetadata;
  page: GridPage;
  diff: DataDiff;
  code: string;
  warnings?: string[];
}
export interface DataDiff {
  addedRows: number;
  removedRows: number;
  addedColumns: string[];
  removedColumns: string[];
  changedCells: number;
  cells: CellDiff[];
  truncated: boolean;
}
export interface CellDiff {
  rowNumber: number;
  column: string;
  before: CellValue | null;
  after: CellValue | null;
}
export interface PlanUpdatedResponse {
  kind: "planUpdated";
  action: "apply" | "discard" | "undo";
  revision: number;
  metadata: SessionMetadata;
  page: GridPage;
  code: string;
}
export interface SessionClosedResponse {
  kind: "sessionClosed";
  sessionId: string;
}
export interface CancelledResponse {
  kind: "cancelled";
  targetRequestId: string;
}
export interface ErrorResponse {
  kind: "error";
  code: string;
  message: string;
  detail?: string;
  recoverable: boolean;
  sessionId?: string;
}
