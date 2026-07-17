/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */

/**
 * Canonical standalone and Jupyter transport contract for Open Wrangler protocol v2.
 */
export type OpenWranglerTransportMessage = RuntimeRequestEnvelope | RuntimeResponseEnvelope;
export type ProtocolVersion = 2;
export type RequestPriority = "interactive" | "background";
export type OpenWranglerRequest =
  | InitializeRequest
  | OpenSessionRequest
  | PageRequest
  | SummaryRequest
  | DatasetStatsRequest
  | ValuesRequest
  | PreviewStepRequest
  | InspectStepRequest
  | ApplyDraftRequest
  | DiscardDraftRequest
  | UndoStepRequest
  | ExportDataRequest
  | CloseSessionRequest
  | CancelRequest;
export type DataBackend = "polars" | "duckdb" | "pandas";
export type SessionMode = "viewing" | "editing";
export type PageRequest = SessionRequestBase & {
  kind: "getPage";
  sessionId: string;
  revision: number;
  viewRequestId: string;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
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
export type TransformStep =
  | SortRowsTransformStep
  | FilterRowsTransformStep
  | DropMissingRowsTransformStep
  | DropDuplicatesTransformStep
  | SelectColumnsTransformStep
  | DropColumnsTransformStep
  | RenameColumnTransformStep
  | CloneColumnTransformStep
  | CastColumnTransformStep
  | FormulaTransformStep
  | TextLengthTransformStep
  | OneHotEncodeTransformStep
  | MultiLabelBinarizeTransformStep
  | FindReplaceTransformStep
  | StripTextTransformStep
  | SplitTextTransformStep
  | CapitalizeTextTransformStep
  | LowerTextTransformStep
  | UpperTextTransformStep
  | MinMaxScaleTransformStep
  | RoundNumberTransformStep
  | FloorNumberTransformStep
  | CeilNumberTransformStep
  | FormatDatetimeTransformStep
  | GroupByTransformStep
  | ByExampleTransformStep
  | CustomCodeTransformStep;
export type SortRowsTransformStep = TransformStepTemplate & {
  kind: "sortRows";
  params: SortRowsParams;
  [k: string]: unknown;
};
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
  | "byExample"
  | "customCode";
export type FilterRowsTransformStep = TransformStepTemplate & {
  kind: "filterRows";
  params: FilterRowsParams;
  [k: string]: unknown;
};
export type DropMissingRowsTransformStep = TransformStepTemplate & {
  kind: "dropMissingRows";
  params: DropMissingRowsParams;
  [k: string]: unknown;
};
export type DropDuplicatesTransformStep = TransformStepTemplate & {
  kind: "dropDuplicates";
  params: DropDuplicatesParams;
  [k: string]: unknown;
};
/**
 * @minItems 1
 */
export type NonEmptyColumnReferenceArray = [ColumnReference, ...ColumnReference[]];
export type SelectColumnsTransformStep = TransformStepTemplate & {
  kind: "selectColumns";
  params: ColumnsParams;
  [k: string]: unknown;
};
export type DropColumnsTransformStep = TransformStepTemplate & {
  kind: "dropColumns";
  params: ColumnsParams;
  [k: string]: unknown;
};
export type RenameColumnTransformStep = TransformStepTemplate & {
  kind: "renameColumn";
  params: RenameColumnParams;
  [k: string]: unknown;
};
export type CloneColumnTransformStep = TransformStepTemplate & {
  kind: "cloneColumn";
  params: RenameColumnParams;
  [k: string]: unknown;
};
export type CastColumnTransformStep = TransformStepTemplate & {
  kind: "castColumn";
  params: CastColumnParams;
  [k: string]: unknown;
};
export type FormulaTransformStep = TransformStepTemplate & {
  kind: "formula";
  params: FormulaParams;
  [k: string]: unknown;
};
export type FormulaParams = {
  leftColumn: ColumnReference;
  operator: "add" | "subtract" | "multiply" | "divide" | "modulo" | "power";
  newColumn: string;
  rightColumn?: ColumnReference;
  value?: number;
} & FormulaParams1;
export type FormulaParams1 = {
  [k: string]: unknown;
};
export type TextLengthTransformStep = TransformStepTemplate & {
  kind: "textLength";
  params: ColumnOutputParams;
  [k: string]: unknown;
};
export type OneHotEncodeTransformStep = TransformStepTemplate & {
  kind: "oneHotEncode";
  params: OneHotEncodeParams;
  [k: string]: unknown;
};
export type MultiLabelBinarizeTransformStep = TransformStepTemplate & {
  kind: "multiLabelBinarize";
  params: MultiLabelBinarizeParams;
  [k: string]: unknown;
};
export type FindReplaceTransformStep = TransformStepTemplate & {
  kind: "findReplace";
  params: FindReplaceParams;
  [k: string]: unknown;
};
export type StripTextTransformStep = TransformStepTemplate & {
  kind: "stripText";
  params: StripTextParams;
  [k: string]: unknown;
};
export type SplitTextTransformStep = TransformStepTemplate & {
  kind: "splitText";
  params: SplitTextParams;
  [k: string]: unknown;
};
export type CapitalizeTextTransformStep = TransformStepTemplate & {
  kind: "capitalizeText";
  params: ColumnOptionalOutputParams;
  [k: string]: unknown;
};
export type LowerTextTransformStep = TransformStepTemplate & {
  kind: "lowerText";
  params: ColumnOptionalOutputParams;
  [k: string]: unknown;
};
export type UpperTextTransformStep = TransformStepTemplate & {
  kind: "upperText";
  params: ColumnOptionalOutputParams;
  [k: string]: unknown;
};
export type MinMaxScaleTransformStep = TransformStepTemplate & {
  kind: "minMaxScale";
  params: ColumnOptionalOutputParams;
  [k: string]: unknown;
};
export type RoundNumberTransformStep = TransformStepTemplate & {
  kind: "roundNumber";
  params: RoundNumberParams;
  [k: string]: unknown;
};
export type FloorNumberTransformStep = TransformStepTemplate & {
  kind: "floorNumber";
  params: ColumnOptionalOutputParams;
  [k: string]: unknown;
};
export type CeilNumberTransformStep = TransformStepTemplate & {
  kind: "ceilNumber";
  params: ColumnOptionalOutputParams;
  [k: string]: unknown;
};
export type FormatDatetimeTransformStep = TransformStepTemplate & {
  kind: "formatDatetime";
  params: FormatDatetimeParams;
  [k: string]: unknown;
};
export type GroupByTransformStep = TransformStepTemplate & {
  kind: "groupBy";
  params: GroupByParams;
  [k: string]: unknown;
};
export type ByExampleTransformStep = TransformStepTemplate & {
  kind: "byExample";
  params: ByExampleParams;
  [k: string]: unknown;
};
export type JsonScalar = string | boolean | null | number;
export type ByExampleProgram =
  | {
      kind: "column";
      column: ColumnReference;
    }
  | {
      kind: "literal";
      value: JsonScalar;
    }
  | {
      kind: "slice";
      input: ByExampleProgram;
      start: number;
      stop?: number | null;
    }
  | {
      kind: "split";
      input: ByExampleProgram;
      delimiter: string;
      index: number;
    }
  | {
      kind: "concat";
      /**
       * @minItems 1
       * @maxItems 64
       */
      parts: [ByExampleProgram, ...ByExampleProgram[]];
    }
  | {
      kind: "regexExtract";
      input: ByExampleProgram;
      pattern: string;
      group: number;
    }
  | {
      kind: "regexReplace";
      input: ByExampleProgram;
      pattern: string;
      replacement: string;
    }
  | {
      kind: "case";
      style: "lower" | "upper" | "capitalize";
      input: ByExampleProgram;
    }
  | {
      kind: "datetimeFormat";
      input: ByExampleProgram;
      inputFormat: string;
      outputFormat: string;
    }
  | {
      kind: "arithmetic";
      left: ByExampleProgram;
      operator: "add" | "subtract" | "multiply" | "divide";
      right: ByExampleProgram;
    };
export type CustomCodeTransformStep = TransformStepTemplate & {
  kind: "customCode";
  params: CustomCodeParams;
  [k: string]: unknown;
};
export type OpenWranglerResponse =
  | InitializedResponse
  | SessionOpenedResponse
  | PageResponse
  | SummaryResponse
  | DatasetStatsResponse
  | ValuesResponse
  | StepPreviewResponse
  | StepInspectionResponse
  | PlanUpdatedResponse
  | DataExportedResponse
  | SessionClosedResponse
  | CancelledResponse
  | ErrorResponse;
export type RetainedTransformStep = TransformStep & {
  [k: string]: unknown;
};
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
  request: OpenWranglerRequest;
}
export interface InitializeRequest {
  kind: "initialize";
}
export interface OpenSessionRequest {
  kind: "openSession";
  source: SessionSource;
  requestedSessionId?: string;
  backend?: DataBackend;
  mode?: SessionMode;
  pageSize: number;
  columnOffset: number;
  columnLimit: number;
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
  sort: SortRule[];
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
export interface SortRule {
  column: string;
  direction: "asc" | "desc";
  nulls: "first" | "last";
}
export interface SummaryRequest {
  kind: "getSummary";
  sessionId: string;
  revision: number;
  viewRequestId: string;
  filterModel: FilterModel;
  columns?: string[];
}
export interface DatasetStatsRequest {
  kind: "getDatasetStats";
  sessionId: string;
  revision: number;
  viewRequestId: string;
  filterModel: FilterModel;
}
export interface ValuesRequest {
  kind: "getColumnValues";
  sessionId: string;
  revision: number;
  viewRequestId: string;
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
  columnOffset: number;
  columnLimit: number;
}
export interface TransformStepTemplate {
  id: string;
  kind: OperationKind;
  params: {
    [k: string]: unknown;
  };
}
export interface SortRowsParams {
  /**
   * @minItems 1
   */
  rules: [TransformSortRule, ...TransformSortRule[]];
}
export interface TransformSortRule {
  column: ColumnReference;
  direction: "asc" | "desc";
  nulls: "first" | "last";
}
export interface ColumnReference {
  id: string;
  name: string;
}
export interface FilterRowsParams {
  filterModel: TransformFilterModel;
}
export interface TransformFilterModel {
  logic?: "and" | "or";
  filters: TransformColumnFilter[];
  sort: TransformSortRule[];
}
export interface TransformColumnFilter {
  column: ColumnReference;
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
export interface DropMissingRowsParams {
  columns?: ColumnReference[];
  how?: "any" | "all";
}
export interface DropDuplicatesParams {
  columns?: NonEmptyColumnReferenceArray;
  keep?: "first" | "last" | "none";
}
export interface ColumnsParams {
  columns: NonEmptyColumnReferenceArray;
}
export interface RenameColumnParams {
  column: ColumnReference;
  newName: string;
}
export interface CastColumnParams {
  column: ColumnReference;
  dtype: "string" | "integer" | "float" | "boolean" | "date" | "datetime";
}
export interface ColumnOutputParams {
  column: ColumnReference;
  newColumn: string;
}
export interface OneHotEncodeParams {
  columns: NonEmptyColumnReferenceArray;
  prefixSeparator?: string;
  dropOriginal?: boolean;
}
export interface MultiLabelBinarizeParams {
  column: ColumnReference;
  delimiter: string;
  prefix?: string;
  dropOriginal?: boolean;
}
export interface FindReplaceParams {
  column: ColumnReference;
  find: string;
  replacement: string;
  regex?: boolean;
  newColumn?: string;
}
export interface StripTextParams {
  column: ColumnReference;
  characters?: string | null;
  newColumn?: string;
}
export interface SplitTextParams {
  column: ColumnReference;
  delimiter: string;
  index: number;
  newColumn: string;
}
export interface ColumnOptionalOutputParams {
  column: ColumnReference;
  newColumn?: string;
}
export interface RoundNumberParams {
  column: ColumnReference;
  decimals?: number;
  newColumn?: string;
}
export interface FormatDatetimeParams {
  column: ColumnReference;
  format: string;
  newColumn?: string;
}
export interface GroupByParams {
  keys: NonEmptyColumnReferenceArray;
  /**
   * @minItems 1
   */
  aggregations: [Aggregation, ...Aggregation[]];
}
export interface Aggregation {
  column: ColumnReference;
  operation: "sum" | "mean" | "min" | "max" | "median" | "count" | "nUnique" | "first" | "last";
  alias: string;
}
export interface ByExampleParams {
  /**
   * @minItems 1
   * @maxItems 16
   */
  sourceColumns:
    | [ColumnReference]
    | [ColumnReference, ColumnReference]
    | [ColumnReference, ColumnReference, ColumnReference]
    | [ColumnReference, ColumnReference, ColumnReference, ColumnReference]
    | [ColumnReference, ColumnReference, ColumnReference, ColumnReference, ColumnReference]
    | [ColumnReference, ColumnReference, ColumnReference, ColumnReference, ColumnReference, ColumnReference]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ]
    | [
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference,
        ColumnReference
      ];
  newColumn: string;
  /**
   * @minItems 2
   * @maxItems 64
   */
  examples: [ByExampleItem, ByExampleItem, ...ByExampleItem[]];
  program?: ByExampleProgram;
  /**
   * @maxItems 64
   */
  warnings?: string[];
  candidateCount?: number;
}
export interface ByExampleItem {
  /**
   * @minItems 1
   * @maxItems 16
   */
  inputs:
    | [JsonScalar]
    | [JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar]
    | [JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar, JsonScalar]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ]
    | [
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar,
        JsonScalar
      ];
  output: JsonScalar;
}
export interface CustomCodeParams {
  code: string;
}
export interface InspectStepRequest {
  kind: "inspectStep";
  sessionId: string;
  revision: number;
  stepId: string;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
}
export interface ApplyDraftRequest {
  kind: "applyDraft";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
}
export interface DiscardDraftRequest {
  kind: "discardDraft";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
}
export interface UndoStepRequest {
  kind: "undoStep";
  sessionId: string;
  revision: number;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
}
export interface ExportDataRequest {
  kind: "exportData";
  sessionId: string;
  revision: number;
  path: string;
  format: "csv" | "parquet";
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
  response: OpenWranglerResponse;
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
  steps: RetainedTransformStep[];
  latestStepInputSchema?: ColumnSchema[];
  draftStep?: RetainedTransformStep;
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
  /**
   * Ordered stable identities for projected row values.
   */
  columnIds: string[];
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
  selectionValue?: TypedSelectionToken;
}
/**
 * Typed representative for a distinct-value group whose display text alone is ambiguous.
 */
export interface TypedSelectionToken {
  kind: "typedSelection";
  version: 1;
  columnType: ColumnType;
  cell: CellValue;
}
export interface PageResponse {
  kind: "page";
  revision: number;
  viewRequestId: string;
  page: GridPage;
  metadata: SessionMetadata;
}
export interface SummaryResponse {
  kind: "summary";
  revision: number;
  viewRequestId: string;
  summaries: ColumnSummary[];
}
export interface DatasetStatsResponse {
  kind: "datasetStats";
  revision: number;
  viewRequestId: string;
  stats: DatasetStats;
}
export interface ValuesResponse {
  kind: "columnValues";
  revision: number;
  viewRequestId: string;
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
  columnId: string;
  column: string;
  before: CellValue | null;
  after: CellValue | null;
}
export interface StepInspectionResponse {
  kind: "stepInspection";
  revision: number;
  stepId: string;
  stepIndex: number;
  inputPage: GridPage;
  outputPage: GridPage;
  inputSchema: ColumnSchema[];
  outputSchema: ColumnSchema[];
  diff: DataDiff;
  code: string;
}
export interface PlanUpdatedResponse {
  kind: "planUpdated";
  action: "apply" | "discard" | "undo";
  revision: number;
  metadata: SessionMetadata;
  page: GridPage;
  code: string;
}
export interface DataExportedResponse {
  kind: "dataExported";
  revision: number;
  path: string;
  format: "csv" | "parquet";
  shape: DataShape;
}
export interface SessionClosedResponse {
  kind: "sessionClosed";
  sessionId: string;
}
export interface CancelledResponse {
  kind: "cancelled";
  targetRequestId: string;
  viewRequestId?: string;
}
export interface ErrorResponse {
  kind: "error";
  code: string;
  message: string;
  detail?: string;
  recoverable: boolean;
  sessionId?: string;
  viewRequestId?: string;
}
