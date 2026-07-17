import type {
  ColumnReference,
  ColumnSchema,
  FilterModel,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  SessionMetadata,
  TransformColumnFilter,
  TransformSortRule,
  TransformStep
} from "./protocol.generated";
import { PROTOCOL_VERSION } from "./protocol";

type UnknownRecord = Record<string, unknown>;
type ValueGuard = (value: unknown) => boolean;

const COLUMN_TYPES = new Set([
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
]);
const CELL_KINDS = new Set([
  "null",
  "nan",
  "infinity",
  "boolean",
  "number",
  "integer",
  "string",
  "decimal",
  "datetime",
  "date",
  "duration",
  "binary",
  "list",
  "struct",
  "unknown"
]);
const MAX_TYPED_SELECTION_TEXT_CHARACTERS = 65_536;
const OPERATION_KINDS = new Set([
  "sortRows",
  "filterRows",
  "dropMissingRows",
  "dropDuplicates",
  "selectColumns",
  "dropColumns",
  "renameColumn",
  "cloneColumn",
  "castColumn",
  "formula",
  "textLength",
  "oneHotEncode",
  "multiLabelBinarize",
  "findReplace",
  "stripText",
  "splitText",
  "capitalizeText",
  "lowerText",
  "upperText",
  "minMaxScale",
  "roundNumber",
  "floorNumber",
  "ceilNumber",
  "formatDatetime",
  "groupBy",
  "byExample",
  "customCode"
]);
const PREDICATE_OPERATORS = new Set([
  "equals",
  "notEquals",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isNull",
  "isNotNull",
  "isNaN",
  "isNotNaN"
]);
const CAST_DTYPES = new Set(["string", "integer", "float", "boolean", "date", "datetime"]);
const FORMULA_OPERATORS = new Set(["add", "subtract", "multiply", "divide", "modulo", "power"]);
const AGGREGATIONS = new Set(["sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"]);
const MAX_BY_EXAMPLE_SOURCE_COLUMNS = 16;
const MAX_BY_EXAMPLE_EXAMPLES = 64;
const MAX_BY_EXAMPLE_PROGRAM_NODES = 256;
const MAX_BY_EXAMPLE_PROGRAM_DEPTH = 64;
const MAX_BY_EXAMPLE_CONCAT_PARTS = 64;
const MAX_BY_EXAMPLE_WARNINGS = 64;
const MAX_BY_EXAMPLE_STRING_UTF8_BYTES = 8 * 1024;
const MAX_BY_EXAMPLE_TEXT_UTF8_BYTES = 64 * 1024;
const SIMPLE_COLUMN_OPERATIONS = new Set([
  "capitalizeText",
  "lowerText",
  "upperText",
  "minMaxScale",
  "floorNumber",
  "ceilNumber"
]);

/** Validates the canonical protocol-v2 request envelope at an untrusted transport boundary. */
export function isRuntimeRequestEnvelope(value: unknown): value is RuntimeRequestEnvelope {
  const candidate = exactRecord(value, ["protocolVersion", "requestId", "priority", "request"]);
  return (
    candidate !== undefined &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isNonEmptyString(candidate.requestId) &&
    isOneOf(candidate.priority, ["interactive", "background"]) &&
    isOpenWranglerRequest(candidate.request)
  );
}

/** Validates every canonical protocol-v2 request variant and its structural payload. */
export function isOpenWranglerRequest(value: unknown): value is OpenWranglerRequest {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "initialize": {
      const candidate = exactRecord(value, ["kind"]);
      return candidate !== undefined && candidate.kind === "initialize";
    }
    case "openSession": {
      const candidate = exactRecord(
        value,
        ["kind", "source", "pageSize", "columnOffset", "columnLimit"],
        ["requestedSessionId", "backend", "mode"]
      );
      return (
        candidate !== undefined &&
        candidate.kind === "openSession" &&
        isSessionSource(candidate.source) &&
        optional(candidate, "requestedSessionId", isNonEmptyString) &&
        optional(candidate, "backend", (backend) => isOneOf(backend, ["polars", "duckdb", "pandas"])) &&
        optional(candidate, "mode", (mode) => isOneOf(mode, ["viewing", "editing"])) &&
        isBoundedPageSize(candidate.pageSize) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "getPage": {
      const candidate = exactRecord(value, [
        "kind",
        "sessionId",
        "revision",
        "viewRequestId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit",
        "filterModel"
      ]);
      return (
        isSessionRequest(candidate, "getPage") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit) &&
        isFilterModel(candidate.filterModel)
      );
    }
    case "getSummary": {
      const candidate = exactRecord(
        value,
        ["kind", "sessionId", "revision", "viewRequestId", "filterModel"],
        ["columns"]
      );
      return (
        isSessionRequest(candidate, "getSummary") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isFilterModel(candidate.filterModel) &&
        optional(candidate, "columns", (columns) => isArrayOf(columns, isNonEmptyString))
      );
    }
    case "getDatasetStats": {
      const candidate = exactRecord(value, ["kind", "sessionId", "revision", "viewRequestId", "filterModel"]);
      return (
        isSessionRequest(candidate, "getDatasetStats") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isFilterModel(candidate.filterModel)
      );
    }
    case "getColumnValues": {
      const candidate = exactRecord(
        value,
        ["kind", "sessionId", "revision", "viewRequestId", "column", "filterModel", "limit"],
        ["search"]
      );
      return (
        isSessionRequest(candidate, "getColumnValues") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isNonEmptyString(candidate.column) &&
        isFilterModel(candidate.filterModel) &&
        optional(candidate, "search", isString) &&
        isBoundedPageSize(candidate.limit)
      );
    }
    case "previewStep": {
      const candidate = exactRecord(
        value,
        ["kind", "sessionId", "revision", "step", "offset", "limit", "columnOffset", "columnLimit"],
        ["replaceStepId"]
      );
      return (
        isSessionRequest(candidate, "previewStep") &&
        isTransformStep(candidate.step) &&
        optional(candidate, "replaceStepId", isNonEmptyString) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "inspectStep": {
      const candidate = exactRecord(value, [
        "kind",
        "sessionId",
        "revision",
        "stepId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit"
      ]);
      return (
        isSessionRequest(candidate, "inspectStep") &&
        isNonEmptyString(candidate.stepId) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "applyDraft":
    case "discardDraft":
    case "undoStep": {
      const candidate = exactRecord(value, [
        "kind",
        "sessionId",
        "revision",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit"
      ]);
      return (
        isSessionRequest(candidate, value.kind) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "exportData": {
      const candidate = exactRecord(value, ["kind", "sessionId", "revision", "path", "format"]);
      return (
        isSessionRequest(candidate, "exportData") &&
        isNonEmptyString(candidate.path) &&
        isOneOf(candidate.format, ["csv", "parquet"])
      );
    }
    case "closeSession": {
      const candidate = exactRecord(value, ["kind", "sessionId", "revision"]);
      return isSessionRequest(candidate, "closeSession");
    }
    case "cancelRequest": {
      const candidate = exactRecord(value, ["kind", "targetRequestId"]);
      return (
        candidate !== undefined && candidate.kind === "cancelRequest" && isNonEmptyString(candidate.targetRequestId)
      );
    }
    default:
      return false;
  }
}

/** Validates the canonical protocol-v2 response envelope at an untrusted transport boundary. */
export function isRuntimeResponseEnvelope(value: unknown): value is RuntimeResponseEnvelope {
  const candidate = exactRecord(value, ["protocolVersion", "requestId", "response"]);
  return (
    candidate !== undefined &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isNonEmptyString(candidate.requestId) &&
    isOpenWranglerResponse(candidate.response)
  );
}

/** Validates every canonical protocol-v2 response variant and its structural payload. */
export function isOpenWranglerResponse(value: unknown): value is OpenWranglerResponse {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "initialized":
      return isInitializedResponse(value);
    case "sessionOpened":
      return isSessionOpenedResponse(value);
    case "page":
      return isPageResponse(value);
    case "summary":
      return isSummaryResponse(value);
    case "datasetStats":
      return isDatasetStatsResponse(value);
    case "columnValues":
      return isValuesResponse(value);
    case "stepPreview":
      return isStepPreviewResponse(value);
    case "stepInspection":
      return isStepInspectionResponse(value);
    case "planUpdated":
      return isPlanUpdatedResponse(value);
    case "dataExported":
      return isDataExportedResponse(value);
    case "sessionClosed":
      return isSessionClosedResponse(value);
    case "cancelled":
      return isCancelledResponse(value);
    case "error":
      return isErrorResponse(value);
    default:
      return false;
  }
}

function isInitializedResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "protocolVersion", "runtimeVersion", "capabilities"]);
  return (
    candidate !== undefined &&
    candidate.kind === "initialized" &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isString(candidate.runtimeVersion) &&
    isSourceCapabilities(candidate.capabilities)
  );
}

function isSessionOpenedResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "metadata", "page", "summaries"]);
  return (
    candidate !== undefined &&
    candidate.kind === "sessionOpened" &&
    isSessionMetadata(candidate.metadata) &&
    isGridPage(candidate.page, candidate.metadata.schema) &&
    isArrayOf(candidate.summaries, isColumnSummary)
  );
}

function isPageResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "revision", "viewRequestId", "page", "metadata"]);
  return (
    candidate !== undefined &&
    candidate.kind === "page" &&
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isSessionMetadata(candidate.metadata) &&
    isGridPage(candidate.page, candidate.metadata.schema)
  );
}

function isSummaryResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "revision", "viewRequestId", "summaries"]);
  return (
    candidate !== undefined &&
    candidate.kind === "summary" &&
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isArrayOf(candidate.summaries, isColumnSummary)
  );
}

function isDatasetStatsResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "revision", "viewRequestId", "stats"]);
  return (
    candidate !== undefined &&
    candidate.kind === "datasetStats" &&
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isDatasetStats(candidate.stats)
  );
}

function isValuesResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "revision", "viewRequestId", "column", "values", "hasMore"]);
  return (
    candidate !== undefined &&
    candidate.kind === "columnValues" &&
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isString(candidate.column) &&
    isArrayOf(candidate.values, isValueCount) &&
    isBoolean(candidate.hasMore)
  );
}

function isStepPreviewResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "revision", "metadata", "page", "diff", "code"], ["warnings"]);
  return (
    candidate !== undefined &&
    candidate.kind === "stepPreview" &&
    isNonNegativeInteger(candidate.revision) &&
    isSessionMetadata(candidate.metadata) &&
    isGridPage(candidate.page, candidate.metadata.schema) &&
    isDataDiff(candidate.diff, candidate.metadata.schema) &&
    isString(candidate.code) &&
    optional(candidate, "warnings", (warnings) => isArrayOf(warnings, isString))
  );
}

function isStepInspectionResponse(value: unknown): boolean {
  const candidate = exactRecord(value, [
    "kind",
    "revision",
    "stepId",
    "stepIndex",
    "inputPage",
    "outputPage",
    "inputSchema",
    "outputSchema",
    "diff",
    "code"
  ]);
  return (
    candidate !== undefined &&
    candidate.kind === "stepInspection" &&
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.stepId) &&
    isNonNegativeInteger(candidate.stepIndex) &&
    isColumnSchemaArray(candidate.inputSchema) &&
    isColumnSchemaArray(candidate.outputSchema) &&
    isGridPage(candidate.inputPage, candidate.inputSchema) &&
    isGridPage(candidate.outputPage, candidate.outputSchema) &&
    isDataDiff(candidate.diff, candidate.outputSchema) &&
    isString(candidate.code)
  );
}

function isPlanUpdatedResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "action", "revision", "metadata", "page", "code"]);
  return (
    candidate !== undefined &&
    candidate.kind === "planUpdated" &&
    isOneOf(candidate.action, ["apply", "discard", "undo"]) &&
    isNonNegativeInteger(candidate.revision) &&
    isSessionMetadata(candidate.metadata) &&
    isGridPage(candidate.page, candidate.metadata.schema) &&
    isString(candidate.code)
  );
}

function isDataExportedResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "revision", "path", "format", "shape"]);
  return (
    candidate !== undefined &&
    candidate.kind === "dataExported" &&
    isNonNegativeInteger(candidate.revision) &&
    isString(candidate.path) &&
    isOneOf(candidate.format, ["csv", "parquet"]) &&
    isDataShape(candidate.shape)
  );
}

function isSessionClosedResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "sessionId"]);
  return candidate !== undefined && candidate.kind === "sessionClosed" && isString(candidate.sessionId);
}

function isCancelledResponse(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "targetRequestId"], ["viewRequestId"]);
  return (
    candidate !== undefined &&
    candidate.kind === "cancelled" &&
    isString(candidate.targetRequestId) &&
    optional(candidate, "viewRequestId", isNonEmptyString)
  );
}

function isErrorResponse(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    ["kind", "code", "message", "recoverable"],
    ["detail", "sessionId", "viewRequestId"]
  );
  return (
    candidate !== undefined &&
    candidate.kind === "error" &&
    isString(candidate.code) &&
    isString(candidate.message) &&
    isBoolean(candidate.recoverable) &&
    optional(candidate, "detail", isString) &&
    optional(candidate, "sessionId", isString) &&
    optional(candidate, "viewRequestId", isNonEmptyString)
  );
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  const candidate = exactRecord(
    value,
    [
      "protocolVersion",
      "sessionId",
      "revision",
      "backend",
      "mode",
      "source",
      "capabilities",
      "shape",
      "filteredShape",
      "schema",
      "filterModel",
      "steps"
    ],
    ["latestStepInputSchema", "draftStep", "draftReplacesStepId", "stats"]
  );
  return (
    candidate !== undefined &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isString(candidate.sessionId) &&
    isNonNegativeInteger(candidate.revision) &&
    isOneOf(candidate.backend, ["polars", "duckdb", "pandas"]) &&
    isOneOf(candidate.mode, ["viewing", "editing"]) &&
    isSessionSource(candidate.source) &&
    isSourceCapabilities(candidate.capabilities) &&
    isDataShape(candidate.shape) &&
    isDataShape(candidate.filteredShape) &&
    isColumnSchemaArray(candidate.schema) &&
    isFilterModel(candidate.filterModel) &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every(isRetainedTransformStep) &&
    (candidate.steps.length === 0 || Object.prototype.hasOwnProperty.call(candidate, "latestStepInputSchema")) &&
    optional(candidate, "latestStepInputSchema", isColumnSchemaArray) &&
    optional(candidate, "draftStep", isRetainedTransformStep) &&
    optional(candidate, "draftReplacesStepId", isString) &&
    optional(candidate, "stats", isDatasetStats)
  );
}

function isSessionSource(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "label"], ["path", "uri", "variableName", "importOptions"]);
  return (
    candidate !== undefined &&
    isOneOf(candidate.kind, ["file", "notebookVariable", "notebookOutput"]) &&
    isNonEmptyString(candidate.label) &&
    optional(candidate, "path", isString) &&
    optional(candidate, "uri", isString) &&
    optional(candidate, "variableName", isString) &&
    optional(candidate, "importOptions", isImportOptions)
  );
}

function isImportOptions(value: unknown): boolean {
  const candidate = exactRecord(value, [], ["delimiter", "encoding", "quoteChar", "hasHeader", "sheet"]);
  return (
    candidate !== undefined &&
    optional(candidate, "delimiter", isSingleCharacter) &&
    optional(candidate, "encoding", isString) &&
    optional(candidate, "quoteChar", isSingleCharacter) &&
    optional(candidate, "hasHeader", isBoolean) &&
    optional(candidate, "sheet", (sheet) => isString(sheet) || isNonNegativeInteger(sheet))
  );
}

function isSourceCapabilities(value: unknown): boolean {
  const candidate = exactRecord(value, ["editable", "lazy", "cancel", "exportCsv", "exportParquet", "notebookInsert"]);
  return (
    candidate !== undefined &&
    isBoolean(candidate.editable) &&
    isBoolean(candidate.lazy) &&
    isBoolean(candidate.cancel) &&
    isBoolean(candidate.exportCsv) &&
    isBoolean(candidate.exportParquet) &&
    isBoolean(candidate.notebookInsert)
  );
}

function isDataShape(value: unknown): boolean {
  const candidate = exactRecord(value, ["rows", "columns"]);
  return candidate !== undefined && isNonNegativeInteger(candidate.rows) && isNonNegativeInteger(candidate.columns);
}

function isColumnSchema(value: unknown): boolean {
  const candidate = exactRecord(value, ["id", "name", "position", "rawType", "type", "nullable"]);
  return (
    candidate !== undefined &&
    isNonEmptyString(candidate.id) &&
    isString(candidate.name) &&
    isNonNegativeInteger(candidate.position) &&
    isString(candidate.rawType) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    isBoolean(candidate.nullable)
  );
}

function isColumnSchemaArray(value: unknown): value is ColumnSchema[] {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  return value.every((column, position) => {
    if (!isColumnSchema(column)) return false;
    const candidate = column as { id: string; position: number };
    if (candidate.position !== position || identities.has(candidate.id)) return false;
    identities.add(candidate.id);
    return true;
  });
}

function isColumnReference(value: unknown): value is ColumnReference {
  const candidate = exactRecord(value, ["id", "name"]);
  return candidate !== undefined && isNonEmptyString(candidate.id) && isString(candidate.name);
}

function isUniqueColumnReferenceArray(value: unknown, allowEmpty: boolean): value is ColumnReference[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every(isColumnReference)) return false;
  return new Set(value.map((reference) => reference.id)).size === value.length;
}

export function isFilterModel(value: unknown): value is FilterModel {
  const candidate = exactRecord(value, ["filters", "sort"], ["logic"]);
  return (
    candidate !== undefined &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    isArrayOf(candidate.filters, isColumnFilter) &&
    isArrayOf(candidate.sort, isSortRule)
  );
}

function isColumnFilter(value: unknown): boolean {
  const candidate = exactRecord(value, ["column", "type", "predicates"], ["logic", "valueFilter"]);
  return (
    candidate !== undefined &&
    isNonEmptyString(candidate.column) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    optional(candidate, "valueFilter", isValueFilter) &&
    isArrayOf(candidate.predicates, isPredicateFilter)
  );
}

function isValueFilter(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "selectedValues", "includeNulls", "includeNaN"], ["search"]);
  return (
    candidate !== undefined &&
    candidate.kind === "values" &&
    isArrayOf(candidate.selectedValues, isJsonValue) &&
    isBoolean(candidate.includeNulls) &&
    isBoolean(candidate.includeNaN) &&
    optional(candidate, "search", isString)
  );
}

function isPredicateFilter(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "operator"], ["value", "secondValue"]);
  if (
    candidate === undefined ||
    candidate.kind !== "predicate" ||
    !isEnumMember(candidate.operator, PREDICATE_OPERATORS)
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "value") && !isJsonValue(candidate.value)) return false;
  if (Object.prototype.hasOwnProperty.call(candidate, "secondValue") && !isJsonValue(candidate.secondValue))
    return false;
  const nullary = new Set(["isNull", "isNotNull", "isNaN", "isNotNaN"]);
  if (!nullary.has(candidate.operator) && !Object.prototype.hasOwnProperty.call(candidate, "value")) return false;
  return candidate.operator !== "between" || Object.prototype.hasOwnProperty.call(candidate, "secondValue");
}

function isSortRule(value: unknown): boolean {
  const candidate = exactRecord(value, ["column", "direction", "nulls"]);
  return (
    candidate !== undefined &&
    isNonEmptyString(candidate.column) &&
    isOneOf(candidate.direction, ["asc", "desc"]) &&
    isOneOf(candidate.nulls, ["first", "last"])
  );
}

function isTransformSortRule(value: unknown): value is TransformSortRule {
  const candidate = exactRecord(value, ["column", "direction", "nulls"]);
  return (
    candidate !== undefined &&
    isColumnReference(candidate.column) &&
    isOneOf(candidate.direction, ["asc", "desc"]) &&
    isOneOf(candidate.nulls, ["first", "last"])
  );
}

function isTransformColumnFilter(value: unknown): value is TransformColumnFilter {
  const candidate = exactRecord(value, ["column", "type", "predicates"], ["logic", "valueFilter"]);
  return (
    candidate !== undefined &&
    isColumnReference(candidate.column) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    optional(candidate, "valueFilter", isValueFilter) &&
    isArrayOf(candidate.predicates, isPredicateFilter)
  );
}

function hasUniqueReferencedColumnIds(values: readonly { column: ColumnReference }[]): boolean {
  return new Set(values.map((value) => value.column.id)).size === values.length;
}

function isUniqueTransformSortRuleArray(value: unknown, allowEmpty: boolean): value is TransformSortRule[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(isTransformSortRule) &&
    hasUniqueReferencedColumnIds(value)
  );
}

function isUniqueTransformColumnFilterArray(value: unknown): value is TransformColumnFilter[] {
  return Array.isArray(value) && value.every(isTransformColumnFilter) && hasUniqueReferencedColumnIds(value);
}

function isTransformFilterModel(value: unknown): boolean {
  const candidate = exactRecord(value, ["filters", "sort"], ["logic"]);
  return (
    candidate !== undefined &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    isUniqueTransformColumnFilterArray(candidate.filters) &&
    isUniqueTransformSortRuleArray(candidate.sort, true)
  );
}

export function isTransformStep(value: unknown): value is TransformStep {
  const candidate = exactRecord(value, ["id", "kind", "params"]);
  if (
    candidate === undefined ||
    !isNonEmptyString(candidate.id) ||
    !isEnumMember(candidate.kind, OPERATION_KINDS) ||
    !isRecord(candidate.params)
  ) {
    return false;
  }

  const params = candidate.params;
  switch (candidate.kind) {
    case "sortRows": {
      const decoded = exactRecord(params, ["rules"]);
      return decoded !== undefined && isUniqueTransformSortRuleArray(decoded.rules, false);
    }
    case "filterRows": {
      const decoded = exactRecord(params, ["filterModel"]);
      return decoded !== undefined && isTransformFilterModel(decoded.filterModel);
    }
    case "dropMissingRows": {
      const decoded = exactRecord(params, [], ["columns", "how"]);
      return (
        decoded !== undefined &&
        optional(decoded, "columns", (columns) => isUniqueColumnReferenceArray(columns, true)) &&
        optional(decoded, "how", (how) => isOneOf(how, ["any", "all"]))
      );
    }
    case "dropDuplicates": {
      const decoded = exactRecord(params, [], ["columns", "keep"]);
      return (
        decoded !== undefined &&
        optional(decoded, "columns", (columns) => isUniqueColumnReferenceArray(columns, false)) &&
        optional(decoded, "keep", (keep) => isOneOf(keep, ["first", "last", "none"]))
      );
    }
    case "selectColumns":
    case "dropColumns": {
      const decoded = exactRecord(params, ["columns"]);
      return decoded !== undefined && isUniqueColumnReferenceArray(decoded.columns, false);
    }
    case "renameColumn":
    case "cloneColumn": {
      const decoded = exactRecord(params, ["column", "newName"]);
      return decoded !== undefined && isColumnReference(decoded.column) && isNonEmptyString(decoded.newName);
    }
    case "castColumn": {
      const decoded = exactRecord(params, ["column", "dtype"]);
      return decoded !== undefined && isColumnReference(decoded.column) && isEnumMember(decoded.dtype, CAST_DTYPES);
    }
    case "formula": {
      const decoded = exactRecord(params, ["leftColumn", "operator", "newColumn"], ["rightColumn", "value"]);
      if (
        decoded === undefined ||
        !isColumnReference(decoded.leftColumn) ||
        !isEnumMember(decoded.operator, FORMULA_OPERATORS) ||
        !isNonEmptyString(decoded.newColumn)
      ) {
        return false;
      }
      const hasColumn = Object.prototype.hasOwnProperty.call(decoded, "rightColumn");
      const hasValue = Object.prototype.hasOwnProperty.call(decoded, "value");
      return (
        hasColumn !== hasValue &&
        (!hasColumn || isColumnReference(decoded.rightColumn)) &&
        (!hasValue || isFiniteNumber(decoded.value))
      );
    }
    case "textLength": {
      const decoded = exactRecord(params, ["column", "newColumn"]);
      return decoded !== undefined && isColumnReference(decoded.column) && isNonEmptyString(decoded.newColumn);
    }
    case "oneHotEncode": {
      const decoded = exactRecord(params, ["columns"], ["prefixSeparator", "dropOriginal"]);
      return (
        decoded !== undefined &&
        isUniqueColumnReferenceArray(decoded.columns, false) &&
        optional(decoded, "prefixSeparator", isString) &&
        optional(decoded, "dropOriginal", isBoolean)
      );
    }
    case "multiLabelBinarize": {
      const decoded = exactRecord(params, ["column", "delimiter"], ["prefix", "dropOriginal"]);
      return (
        decoded !== undefined &&
        isColumnReference(decoded.column) &&
        isNonEmptyString(decoded.delimiter) &&
        optional(decoded, "prefix", isString) &&
        optional(decoded, "dropOriginal", isBoolean)
      );
    }
    case "findReplace": {
      const decoded = exactRecord(params, ["column", "find", "replacement"], ["regex", "newColumn"]);
      return (
        decoded !== undefined &&
        isColumnReference(decoded.column) &&
        isString(decoded.find) &&
        isString(decoded.replacement) &&
        optional(decoded, "regex", isBoolean) &&
        optional(decoded, "newColumn", isNonEmptyString)
      );
    }
    case "stripText": {
      const decoded = exactRecord(params, ["column"], ["characters", "newColumn"]);
      return (
        decoded !== undefined &&
        isColumnReference(decoded.column) &&
        optional(decoded, "characters", (characters) => characters === null || isNonEmptyString(characters)) &&
        optional(decoded, "newColumn", isNonEmptyString)
      );
    }
    case "splitText": {
      const decoded = exactRecord(params, ["column", "delimiter", "index", "newColumn"]);
      return (
        decoded !== undefined &&
        isColumnReference(decoded.column) &&
        isNonEmptyString(decoded.delimiter) &&
        isNonNegativeInteger(decoded.index) &&
        isNonEmptyString(decoded.newColumn)
      );
    }
    case "capitalizeText":
    case "lowerText":
    case "upperText":
    case "minMaxScale":
    case "floorNumber":
    case "ceilNumber": {
      if (!SIMPLE_COLUMN_OPERATIONS.has(candidate.kind)) return false;
      const decoded = exactRecord(params, ["column"], ["newColumn"]);
      return (
        decoded !== undefined && isColumnReference(decoded.column) && optional(decoded, "newColumn", isNonEmptyString)
      );
    }
    case "roundNumber": {
      const decoded = exactRecord(params, ["column"], ["decimals", "newColumn"]);
      return (
        decoded !== undefined &&
        isColumnReference(decoded.column) &&
        optional(decoded, "decimals", isInteger) &&
        optional(decoded, "newColumn", isNonEmptyString)
      );
    }
    case "formatDatetime": {
      const decoded = exactRecord(params, ["column", "format"], ["newColumn"]);
      return (
        decoded !== undefined &&
        isColumnReference(decoded.column) &&
        isNonEmptyString(decoded.format) &&
        optional(decoded, "newColumn", isNonEmptyString)
      );
    }
    case "groupBy": {
      const decoded = exactRecord(params, ["keys", "aggregations"]);
      if (
        decoded === undefined ||
        !isUniqueColumnReferenceArray(decoded.keys, false) ||
        !Array.isArray(decoded.aggregations)
      ) {
        return false;
      }
      const keyNames = new Set(decoded.keys.map((reference) => reference.name));
      const aliases: string[] = [];
      for (const aggregation of decoded.aggregations) {
        if (!isAggregation(aggregation)) return false;
        aliases.push(aggregation.alias);
      }
      if (aliases.length === 0) return false;
      return new Set(aliases).size === aliases.length && aliases.every((alias) => !keyNames.has(alias));
    }
    case "byExample":
      return isByExampleParams(params);
    case "customCode": {
      const decoded = exactRecord(params, ["code"]);
      return decoded !== undefined && isNonEmptyTrimmedString(decoded.code);
    }
    default:
      return false;
  }
}

/**
 * Runtime metadata and persisted cleaning state must retain the exact program
 * selected for a by-example step. New preview requests may omit it so the
 * runtime can synthesize a candidate, but replay must never synthesize again.
 */
export function isRetainedTransformStep(value: unknown): value is TransformStep {
  return isTransformStep(value) && (value.kind !== "byExample" || value.params.program !== undefined);
}

function isAggregation(value: unknown): value is { column: ColumnReference; operation: string; alias: string } {
  const candidate = exactRecord(value, ["column", "operation", "alias"]);
  return (
    candidate !== undefined &&
    isColumnReference(candidate.column) &&
    isEnumMember(candidate.operation, AGGREGATIONS) &&
    isNonEmptyString(candidate.alias)
  );
}

function isByExampleParams(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    ["sourceColumns", "newColumn", "examples"],
    ["program", "warnings", "candidateCount"]
  );
  if (candidate === undefined) return false;
  const sourceColumns = candidate.sourceColumns;
  const examples = candidate.examples;
  const hasProgram = Object.prototype.hasOwnProperty.call(candidate, "program");
  const hasWarnings = Object.prototype.hasOwnProperty.call(candidate, "warnings");
  if (
    !Array.isArray(sourceColumns) ||
    sourceColumns.length === 0 ||
    sourceColumns.length > MAX_BY_EXAMPLE_SOURCE_COLUMNS ||
    !isNonEmptyString(candidate.newColumn) ||
    !Array.isArray(examples) ||
    examples.length < 2 ||
    examples.length > MAX_BY_EXAMPLE_EXAMPLES ||
    (hasWarnings && (!Array.isArray(candidate.warnings) || candidate.warnings.length > MAX_BY_EXAMPLE_WARNINGS)) ||
    (hasProgram && !hasBoundedByExampleProgramShape(candidate.program))
  ) {
    return false;
  }
  if (!isUniqueColumnReferenceArray(sourceColumns, false)) return false;
  const budget: ByExampleValidationBudget = {
    remainingNodes: MAX_BY_EXAMPLE_PROGRAM_NODES,
    remainingTextBytes: MAX_BY_EXAMPLE_TEXT_UTF8_BYTES
  };
  if (
    !sourceColumns.every(
      (reference) => consumeByExampleString(reference.id, budget) && consumeByExampleString(reference.name, budget)
    ) ||
    !consumeByExampleString(candidate.newColumn, budget) ||
    !examples.every((example) => isByExampleItem(example, sourceColumns, budget))
  ) {
    return false;
  }
  const sourceById = new Map(sourceColumns.map((reference) => [reference.id, reference.name]));
  return (
    optional(candidate, "program", (program) => isByExampleProgram(program, 0, sourceById, budget)) &&
    optional(
      candidate,
      "warnings",
      (warnings) =>
        Array.isArray(warnings) &&
        warnings.length <= MAX_BY_EXAMPLE_WARNINGS &&
        warnings.every((warning) => isString(warning) && consumeByExampleString(warning, budget))
    ) &&
    optional(candidate, "candidateCount", isPositiveInteger)
  );
}

interface ByExampleValidationBudget {
  remainingNodes: number;
  remainingTextBytes: number;
}

function hasBoundedByExampleProgramShape(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) return false;
    nodes += 1;
    if (
      nodes > MAX_BY_EXAMPLE_PROGRAM_NODES ||
      current.depth > MAX_BY_EXAMPLE_PROGRAM_DEPTH ||
      !isRecord(current.value) ||
      typeof current.value.kind !== "string" ||
      visited.has(current.value)
    ) {
      return false;
    }
    visited.add(current.value);
    const nested = (child: unknown) => pending.push({ value: child, depth: current.depth + 1 });
    switch (current.value.kind) {
      case "column":
      case "literal":
        break;
      case "slice":
      case "split":
      case "regexExtract":
      case "regexReplace":
      case "case":
      case "datetimeFormat":
        nested(current.value.input);
        break;
      case "concat": {
        const parts = current.value.parts;
        if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_BY_EXAMPLE_CONCAT_PARTS) {
          return false;
        }
        for (const part of parts) nested(part);
        break;
      }
      case "arithmetic":
        nested(current.value.left);
        nested(current.value.right);
        break;
      default:
        return false;
    }
  }
  return true;
}

function isByExampleItem(
  value: unknown,
  sourceColumns: readonly ColumnReference[],
  budget: ByExampleValidationBudget
): boolean {
  const candidate = exactRecord(value, ["inputs", "output"]);
  return (
    candidate !== undefined &&
    Array.isArray(candidate.inputs) &&
    candidate.inputs.length === sourceColumns.length &&
    candidate.inputs.every((input) => isBoundedByExampleScalar(input, budget)) &&
    isBoundedByExampleScalar(candidate.output, budget)
  );
}

function isByExampleProgram(
  value: unknown,
  depth: number,
  sourceById: ReadonlyMap<string, string>,
  budget: ByExampleValidationBudget
): boolean {
  budget.remainingNodes -= 1;
  if (
    budget.remainingNodes < 0 ||
    depth > MAX_BY_EXAMPLE_PROGRAM_DEPTH ||
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !consumeByExampleString(value.kind, budget)
  ) {
    return false;
  }
  const nested = (candidate: unknown) => isByExampleProgram(candidate, depth + 1, sourceById, budget);
  switch (value.kind) {
    case "column": {
      const candidate = exactRecord(value, ["kind", "column"]);
      return (
        candidate !== undefined &&
        isColumnReference(candidate.column) &&
        consumeByExampleString(candidate.column.id, budget) &&
        consumeByExampleString(candidate.column.name, budget) &&
        sourceById.get(candidate.column.id) === candidate.column.name
      );
    }
    case "literal": {
      const candidate = exactRecord(value, ["kind", "value"]);
      return candidate !== undefined && isBoundedByExampleScalar(candidate.value, budget);
    }
    case "slice": {
      const candidate = exactRecord(value, ["kind", "input", "start"], ["stop"]);
      return (
        candidate !== undefined &&
        isNonNegativeInteger(candidate.start) &&
        optional(
          candidate,
          "stop",
          (stop) => stop === null || (isNonNegativeInteger(stop) && stop >= (candidate.start as number))
        ) &&
        nested(candidate.input)
      );
    }
    case "split": {
      const candidate = exactRecord(value, ["kind", "input", "delimiter", "index"]);
      return (
        candidate !== undefined &&
        isString(candidate.delimiter) &&
        consumeByExampleString(candidate.delimiter, budget) &&
        isNonNegativeInteger(candidate.index) &&
        nested(candidate.input)
      );
    }
    case "concat": {
      const candidate = exactRecord(value, ["kind", "parts"]);
      return (
        candidate !== undefined &&
        Array.isArray(candidate.parts) &&
        candidate.parts.length > 0 &&
        candidate.parts.length <= MAX_BY_EXAMPLE_CONCAT_PARTS &&
        candidate.parts.every(nested)
      );
    }
    case "regexExtract": {
      const candidate = exactRecord(value, ["kind", "input", "pattern", "group"]);
      return (
        candidate !== undefined &&
        isString(candidate.pattern) &&
        consumeByExampleString(candidate.pattern, budget) &&
        isInteger(candidate.group) &&
        nested(candidate.input)
      );
    }
    case "regexReplace": {
      const candidate = exactRecord(value, ["kind", "input", "pattern", "replacement"]);
      return (
        candidate !== undefined &&
        isString(candidate.pattern) &&
        consumeByExampleString(candidate.pattern, budget) &&
        isString(candidate.replacement) &&
        consumeByExampleString(candidate.replacement, budget) &&
        nested(candidate.input)
      );
    }
    case "case": {
      const candidate = exactRecord(value, ["kind", "style", "input"]);
      return (
        candidate !== undefined &&
        isString(candidate.style) &&
        isOneOf(candidate.style, ["lower", "upper", "capitalize"]) &&
        consumeByExampleString(candidate.style, budget) &&
        nested(candidate.input)
      );
    }
    case "datetimeFormat": {
      const candidate = exactRecord(value, ["kind", "input", "inputFormat", "outputFormat"]);
      return (
        candidate !== undefined &&
        isString(candidate.inputFormat) &&
        consumeByExampleString(candidate.inputFormat, budget) &&
        isString(candidate.outputFormat) &&
        consumeByExampleString(candidate.outputFormat, budget) &&
        nested(candidate.input)
      );
    }
    case "arithmetic": {
      const candidate = exactRecord(value, ["kind", "left", "operator", "right"]);
      return (
        candidate !== undefined &&
        isString(candidate.operator) &&
        isOneOf(candidate.operator, ["add", "subtract", "multiply", "divide"]) &&
        consumeByExampleString(candidate.operator, budget) &&
        nested(candidate.left) &&
        nested(candidate.right)
      );
    }
    default:
      return false;
  }
}

function isGridPage(value: unknown, schema?: readonly ColumnSchema[]): boolean {
  const candidate = exactRecord(value, ["offset", "limit", "totalRows", "columnIds", "rows"]);
  if (candidate === undefined) return false;
  const columnIds = candidate.columnIds;
  const rows = candidate.rows;
  if (
    !isNonNegativeInteger(candidate.offset) ||
    !isPositiveInteger(candidate.limit) ||
    !isNonNegativeInteger(candidate.totalRows) ||
    !isUniqueNonEmptyStringArray(columnIds) ||
    !Array.isArray(rows) ||
    rows.length > candidate.limit
  ) {
    return false;
  }
  if (schema !== undefined && !isOrderedSchemaProjection(columnIds, schema)) return false;
  return rows.every((row) => isDataRow(row, columnIds.length));
}

function isDataRow(value: unknown, expectedWidth?: number): boolean {
  const candidate = exactRecord(value, ["id", "rowNumber", "values"]);
  if (candidate === undefined) return false;
  const values = candidate.values;
  if (!Array.isArray(values) || !values.every(isCellValue)) return false;
  return (
    isString(candidate.id) &&
    isNonNegativeInteger(candidate.rowNumber) &&
    (expectedWidth === undefined || values.length === expectedWidth)
  );
}

function isOrderedSchemaProjection(columnIds: readonly string[], schema: readonly ColumnSchema[]): boolean {
  if (columnIds.length === 0) return true;
  const firstIndex = schema.findIndex((column) => column.id === columnIds[0]);
  return (
    firstIndex >= 0 &&
    firstIndex + columnIds.length <= schema.length &&
    columnIds.every((columnId, index) => schema[firstIndex + index]?.id === columnId)
  );
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return false;
  return new Set(value).size === value.length;
}

function isCellValue(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "display", "isNull", "isNaN"], ["raw", "sign"]);
  return (
    candidate !== undefined &&
    isEnumMember(candidate.kind, CELL_KINDS) &&
    isString(candidate.display) &&
    isBoolean(candidate.isNull) &&
    isBoolean(candidate.isNaN) &&
    optional(candidate, "sign", (sign) => sign === -1 || sign === 1)
  );
}

function isColumnSummary(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    ["column", "type", "rawType", "totalCount", "nullCount", "nanCount", "topValues"],
    ["distinctCount", "numeric", "visualization", "sampled"]
  );
  return (
    candidate !== undefined &&
    isString(candidate.column) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    isString(candidate.rawType) &&
    isNonNegativeInteger(candidate.totalCount) &&
    isNonNegativeInteger(candidate.nullCount) &&
    isNonNegativeInteger(candidate.nanCount) &&
    optional(candidate, "distinctCount", isNonNegativeInteger) &&
    optional(candidate, "numeric", isNumericSummary) &&
    optional(candidate, "visualization", isColumnVisualization) &&
    isArrayOf(candidate.topValues, isValueCount) &&
    optional(candidate, "sampled", isBoolean)
  );
}

function isNumericSummary(value: unknown): boolean {
  const candidate = exactRecord(value, [], ["min", "max", "mean", "median", "std"]);
  return (
    candidate !== undefined &&
    optional(candidate, "min", isFiniteNumber) &&
    optional(candidate, "max", isFiniteNumber) &&
    optional(candidate, "mean", isFiniteNumber) &&
    optional(candidate, "median", isFiniteNumber) &&
    optional(candidate, "std", isFiniteNumber)
  );
}

function isColumnVisualization(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "numeric": {
      const candidate = exactRecord(value, ["kind", "bins"], ["sampled"]);
      return (
        candidate !== undefined && isArrayOf(candidate.bins, isNumericBin) && optional(candidate, "sampled", isBoolean)
      );
    }
    case "categorical": {
      const candidate = exactRecord(value, ["kind", "categories", "otherCount"], ["sampled"]);
      return (
        candidate !== undefined &&
        isArrayOf(candidate.categories, isValueCount) &&
        isNonNegativeInteger(candidate.otherCount) &&
        optional(candidate, "sampled", isBoolean)
      );
    }
    case "boolean": {
      const candidate = exactRecord(value, ["kind", "trueCount", "falseCount"], ["sampled"]);
      return (
        candidate !== undefined &&
        isNonNegativeInteger(candidate.trueCount) &&
        isNonNegativeInteger(candidate.falseCount) &&
        optional(candidate, "sampled", isBoolean)
      );
    }
    case "datetime": {
      const candidate = exactRecord(value, ["kind"], ["min", "max", "sampled"]);
      return (
        candidate !== undefined &&
        optional(candidate, "min", isNullableString) &&
        optional(candidate, "max", isNullableString) &&
        optional(candidate, "sampled", isBoolean)
      );
    }
    default:
      return false;
  }
}

function isNumericBin(value: unknown): boolean {
  const candidate = exactRecord(value, ["min", "max", "count"]);
  return (
    candidate !== undefined &&
    isFiniteNumber(candidate.min) &&
    isFiniteNumber(candidate.max) &&
    isNonNegativeInteger(candidate.count)
  );
}

function isValueCount(value: unknown): boolean {
  const candidate = exactRecord(value, ["value", "count"], ["selectionValue"]);
  return (
    candidate !== undefined &&
    isString(candidate.value) &&
    isNonNegativeInteger(candidate.count) &&
    optional(candidate, "selectionValue", isTypedSelectionToken)
  );
}

function isTypedSelectionToken(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "version", "columnType", "cell"]);
  return (
    candidate !== undefined &&
    candidate.kind === "typedSelection" &&
    candidate.version === 1 &&
    isEnumMember(candidate.columnType, COLUMN_TYPES) &&
    isCellValue(candidate.cell) &&
    isCompatibleTypedSelectionCell(candidate.columnType as string, candidate.cell)
  );
}

function isCompatibleTypedSelectionCell(columnType: string, value: unknown): boolean {
  const cell = value as UnknownRecord;
  if (
    cell.isNull !== false ||
    cell.isNaN !== false ||
    typeof cell.display !== "string" ||
    cell.display.length > MAX_TYPED_SELECTION_TEXT_CHARACTERS ||
    !Object.prototype.hasOwnProperty.call(cell, "raw") ||
    !isJsonValue(cell.raw)
  ) {
    return false;
  }
  if (typeof cell.raw === "string" && cell.raw.length > MAX_TYPED_SELECTION_TEXT_CHARACTERS) return false;

  const compatibleKinds: Readonly<Record<string, readonly string[]>> = {
    string: ["string", "integer", "number", "infinity", "boolean", "decimal", "datetime", "date", "duration"],
    integer: ["integer"],
    float: ["number", "infinity"],
    decimal: ["decimal"],
    boolean: ["boolean"],
    date: ["date"],
    datetime: ["datetime"],
    duration: ["duration"],
    binary: [],
    list: [],
    struct: [],
    unknown: []
  };
  if (!compatibleKinds[columnType]?.includes(String(cell.kind))) return false;

  switch (cell.kind) {
    case "string":
    case "decimal":
    case "date":
    case "datetime":
      return typeof cell.raw === "string";
    case "integer":
      return (
        (typeof cell.raw === "number" && Number.isSafeInteger(cell.raw)) ||
        (typeof cell.raw === "string" && /^[+-]?\d+$/u.test(cell.raw))
      );
    case "number":
      return typeof cell.raw === "number" && Number.isFinite(cell.raw);
    case "infinity":
      return cell.raw === null && (cell.sign === -1 || cell.sign === 1);
    case "boolean":
      return typeof cell.raw === "boolean";
    case "duration":
      return (
        (typeof cell.raw === "number" && Number.isFinite(cell.raw)) ||
        (typeof cell.raw === "string" && cell.raw.length > 0)
      );
    default:
      return false;
  }
}

function isDatasetStats(value: unknown): boolean {
  const candidate = exactRecord(value, ["missingCells", "missingRows", "duplicateRows", "missingValuesByColumn"]);
  return (
    candidate !== undefined &&
    isNonNegativeInteger(candidate.missingCells) &&
    isNonNegativeInteger(candidate.missingRows) &&
    isNonNegativeInteger(candidate.duplicateRows) &&
    isArrayOf(candidate.missingValuesByColumn, isMissingValueCount)
  );
}

function isMissingValueCount(value: unknown): boolean {
  const candidate = exactRecord(value, ["column", "count"]);
  return candidate !== undefined && isString(candidate.column) && isNonNegativeInteger(candidate.count);
}

function isDataDiff(value: unknown, outputSchema?: readonly ColumnSchema[]): boolean {
  const candidate = exactRecord(value, [
    "addedRows",
    "removedRows",
    "addedColumns",
    "removedColumns",
    "changedCells",
    "cells",
    "truncated"
  ]);
  return (
    candidate !== undefined &&
    isNonNegativeInteger(candidate.addedRows) &&
    isNonNegativeInteger(candidate.removedRows) &&
    isArrayOf(candidate.addedColumns, isString) &&
    isArrayOf(candidate.removedColumns, isString) &&
    isNonNegativeInteger(candidate.changedCells) &&
    isArrayOf(candidate.cells, (cell) => isCellDiff(cell, outputSchema)) &&
    isBoolean(candidate.truncated)
  );
}

function isCellDiff(value: unknown, outputSchema?: readonly ColumnSchema[]): boolean {
  const candidate = exactRecord(value, ["rowNumber", "columnId", "column", "before", "after"]);
  if (!(
    candidate !== undefined &&
    isNonNegativeInteger(candidate.rowNumber) &&
    isNonEmptyString(candidate.columnId) &&
    isString(candidate.column) &&
    (candidate.before === null || isCellValue(candidate.before)) &&
    (candidate.after === null || isCellValue(candidate.after))
  )) {
    return false;
  }
  return (
    outputSchema === undefined ||
    outputSchema.some((column) => column.id === candidate.columnId && column.name === candidate.column)
  );
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optionalKeys: readonly string[] = []
): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([...required, ...optionalKeys]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return undefined;
  return value;
}

function isSessionRequest(candidate: UnknownRecord | undefined, kind: string): candidate is UnknownRecord {
  return (
    candidate !== undefined &&
    candidate.kind === kind &&
    isString(candidate.sessionId) &&
    isNonNegativeInteger(candidate.revision)
  );
}

function optional(record: UnknownRecord, key: string, guard: ValueGuard): boolean {
  return !Object.prototype.hasOwnProperty.call(record, key) || guard(record[key]);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSingleCharacter(value: unknown): boolean {
  return typeof value === "string" && [...value].length === 1;
}

function isNullableString(value: unknown): boolean {
  return value === null || isString(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

function isBoundedPageSize(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 10_000;
}

function isBoundedColumnLimit(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 256;
}

function isEnumMember(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === "string" && values.has(value);
}

function isOneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isArrayOf(value: unknown, guard: ValueGuard): boolean {
  return Array.isArray(value) && value.every(guard);
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || isString(value) || isBoolean(value) || isFiniteNumber(value);
}

function isSafeJsonNumber(value: unknown): value is number {
  return isFiniteNumber(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function isBoundedByExampleScalar(
  value: unknown,
  budget: ByExampleValidationBudget
): value is string | number | boolean | null {
  return (
    (value === null || isBoolean(value) || isSafeJsonNumber(value) || isString(value)) &&
    (typeof value !== "string" || consumeByExampleString(value, budget))
  );
}

function consumeByExampleString(value: string, budget: ByExampleValidationBudget): boolean {
  const byteLength = strictUtf8ByteLength(value, MAX_BY_EXAMPLE_STRING_UTF8_BYTES);
  if (
    byteLength === undefined ||
    byteLength > MAX_BY_EXAMPLE_STRING_UTF8_BYTES ||
    byteLength > budget.remainingTextBytes
  ) {
    return false;
  }
  budget.remainingTextBytes -= byteLength;
  return true;
}

function strictUtf8ByteLength(value: string, maximum: number): number | undefined {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return undefined;
      const lowSurrogate = value.charCodeAt(index + 1);
      if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return undefined;
      byteLength += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    } else {
      byteLength += 3;
    }
    if (byteLength > maximum) return byteLength;
  }
  return byteLength;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (isJsonScalar(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}
