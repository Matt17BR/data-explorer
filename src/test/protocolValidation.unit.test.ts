import { describe, expect, it } from "vitest";
import type {
  GridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeResponseEnvelope,
  SessionMetadata
} from "../shared/protocol";
import {
  isOpenWranglerRequest,
  isOpenWranglerResponse,
  isRuntimeRequestEnvelope,
  isRuntimeResponseEnvelope,
  isTransformStep
} from "../shared/protocolValidation";

const capabilities = {
  editable: true,
  lazy: true,
  cancel: true,
  exportCsv: true,
  exportParquet: true,
  notebookInsert: false
};

const valueReference = { id: "column:0", name: "value" };
const otherReference = { id: "column:1", name: "other" };

const page: GridPage = {
  offset: 0,
  limit: 50,
  totalRows: 1,
  rows: [
    {
      id: "row:0",
      rowNumber: 0,
      values: [{ kind: "integer", raw: "9007199254740993", display: "9007199254740993", isNull: false, isNaN: false }]
    }
  ]
};

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session-1",
  revision: 3,
  backend: "polars",
  mode: "editing",
  source: {
    kind: "file",
    label: "fixture.csv",
    path: "/tmp/fixture.csv",
    importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true, sheet: 0 }
  },
  capabilities,
  shape: { rows: 1, columns: 1 },
  filteredShape: { rows: 1, columns: 1 },
  schema: [{ id: "column:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
  filterModel: {
    logic: "and",
    filters: [
      {
        column: "value",
        type: "integer",
        logic: "and",
        valueFilter: {
          kind: "values",
          selectedValues: [1],
          includeNulls: false,
          includeNaN: false,
          search: "1"
        },
        predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
      }
    ],
    sort: [{ column: "value", direction: "asc", nulls: "last" }]
  },
  steps: [{ id: "step-1", kind: "roundNumber", params: { column: "value", decimals: 0 } }],
  latestStepInputSchema: [
    { id: "column:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
  ],
  stats: {
    missingCells: 0,
    missingRows: 0,
    duplicateRows: 0,
    missingValuesByColumn: [{ column: "value", count: 0 }]
  }
};

const summaries = [
  {
    column: "value",
    type: "integer" as const,
    rawType: "Int64",
    totalCount: 1,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 1,
    numeric: { min: 1, max: 1, mean: 1, median: 1, std: 0 },
    visualization: { kind: "numeric" as const, bins: [{ min: 1, max: 1, count: 1 }], sampled: false },
    topValues: [{ value: "1", count: 1 }],
    sampled: false
  }
];

const responses: OpenWranglerResponse[] = [
  { kind: "initialized", protocolVersion: 2, runtimeVersion: "0.3.0", capabilities },
  { kind: "sessionOpened", metadata, page, summaries },
  { kind: "page", revision: 3, viewRequestId: "view-1", page, metadata },
  { kind: "summary", revision: 3, viewRequestId: "view-1", summaries },
  {
    kind: "datasetStats",
    revision: 3,
    viewRequestId: "view-1",
    stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
  },
  {
    kind: "columnValues",
    revision: 3,
    viewRequestId: "view-1",
    column: "value",
    values: [{ value: "1", count: 1 }],
    hasMore: false
  },
  {
    kind: "stepPreview",
    revision: 3,
    metadata: { ...metadata, draftStep: { id: "draft-1", kind: "floorNumber", params: { column: "value" } } },
    page,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 1,
      cells: [
        {
          rowNumber: 0,
          column: "value",
          before: { kind: "number", raw: 1.2, display: "1.2", isNull: false, isNaN: false },
          after: { kind: "number", raw: 1, display: "1", isNull: false, isNaN: false }
        }
      ],
      truncated: false
    },
    code: "df.with_columns(...)\n",
    warnings: []
  },
  {
    kind: "stepInspection",
    revision: 3,
    stepId: "step-1",
    stepIndex: 0,
    inputPage: page,
    outputPage: page,
    inputSchema: metadata.schema,
    outputSchema: metadata.schema,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code: "def clean_data(df):\n    return df\n"
  },
  { kind: "planUpdated", action: "apply", revision: 4, metadata, page, code: "df\n" },
  { kind: "dataExported", revision: 3, path: "/tmp/export.parquet", format: "parquet", shape: { rows: 1, columns: 1 } },
  { kind: "sessionClosed", sessionId: "session-1" },
  { kind: "cancelled", targetRequestId: "request-1", viewRequestId: "view-1" },
  {
    kind: "error",
    code: "source_changed",
    message: "The source changed.",
    detail: "Reopen the source.",
    recoverable: true,
    sessionId: "session-1",
    viewRequestId: "view-1"
  }
];

describe("protocol-v2 response validation", () => {
  it.each(responses.map((response) => [response.kind, response] as const))(
    "accepts a structurally complete %s response",
    (_kind, response) => {
      expect(isOpenWranglerResponse(response)).toBe(true);
      expect(isRuntimeResponseEnvelope({ protocolVersion: 2, requestId: `request-${response.kind}`, response })).toBe(
        true
      );
    }
  );

  it.each([
    {},
    { protocolVersion: 2, requestId: "request-1", response: {} },
    { protocolVersion: 2, requestId: "request-1", response: { kind: "futureResponse" } },
    { protocolVersion: 2, requestId: "", response: responses[0] },
    { protocolVersion: 1, requestId: "request-1", response: responses[0] },
    { protocolVersion: 2, requestId: "request-1", response: responses[0], unexpected: true }
  ])("rejects a malformed envelope: %j", (candidate) => {
    expect(isRuntimeResponseEnvelope(candidate)).toBe(false);
  });

  it("rejects malformed metadata before it can enter session state", () => {
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: { ...metadata, schema: [{ ...metadata.schema[0], nullable: "sometimes" }] },
        page,
        summaries
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "page",
        revision: 3,
        viewRequestId: "view-1",
        metadata: { ...metadata, capabilities: {} },
        page
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "page",
        revision: 3,
        viewRequestId: "view-1",
        metadata: { ...metadata, unknownField: true },
        page
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: {
          ...metadata,
          steps: [{ id: "cross-kind", kind: "renameColumn", params: { columns: ["value"] } }]
        },
        page,
        summaries
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: {
          ...metadata,
          draftStep: {
            id: "bad-program",
            kind: "byExample",
            params: {
              sourceColumns: ["value"],
              newColumn: "clean",
              examples: [
                { inputs: { value: "a" }, output: "A" },
                { inputs: { value: "b" }, output: "B" }
              ],
              program: { kind: "case", style: "sideways", input: { kind: "column", column: "value" } }
            }
          }
        },
        page,
        summaries
      })
    ).toBe(false);
  });

  it("rejects empty, duplicate, or positionally ambiguous schema identities", () => {
    const otherColumn = {
      id: "column:1",
      name: "other",
      position: 1,
      rawType: "String",
      type: "string" as const,
      nullable: false
    };
    const malformedSchemas = [
      [{ ...metadata.schema[0], id: "" }],
      [metadata.schema[0], { ...otherColumn, id: metadata.schema[0].id }],
      [metadata.schema[0], { ...otherColumn, position: 0 }],
      [metadata.schema[0], { ...otherColumn, position: 2 }],
      [
        { ...metadata.schema[0], position: 1 },
        { ...otherColumn, position: 0 }
      ]
    ];

    for (const schema of malformedSchemas) {
      expect(
        isOpenWranglerResponse({
          kind: "sessionOpened",
          metadata: { ...metadata, schema },
          page,
          summaries
        })
      ).toBe(false);
      expect(
        isOpenWranglerResponse({
          kind: "sessionOpened",
          metadata: { ...metadata, latestStepInputSchema: schema },
          page,
          summaries
        })
      ).toBe(false);
    }

    const inspection = responses.find((response) => response.kind === "stepInspection");
    expect(inspection).toBeDefined();
    expect(
      isOpenWranglerResponse({
        ...inspection,
        outputSchema: [metadata.schema[0], { ...otherColumn, id: metadata.schema[0].id }]
      })
    ).toBe(false);
  });

  it("rejects malformed pages, rows, and typed cells", () => {
    const pageResponse = (invalidPage: unknown): unknown => ({
      kind: "page",
      revision: 3,
      viewRequestId: "view-1",
      metadata,
      page: invalidPage
    });
    expect(isOpenWranglerResponse(pageResponse({ ...page, limit: 0 }))).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, rows: [{ id: "row:0", rowNumber: -1, values: [] }] }))).toBe(
      false
    );
    expect(
      isOpenWranglerResponse(
        pageResponse({
          ...page,
          rows: [
            {
              id: "row:0",
              rowNumber: 0,
              values: [{ kind: "integer", display: 1, isNull: false, isNaN: false }]
            }
          ]
        })
      )
    ).toBe(false);
  });

  it("rejects incomplete and cross-variant response payloads", () => {
    expect(isOpenWranglerResponse({ kind: "summary", revision: 1, viewRequestId: "view-1" })).toBe(false);
    expect(isOpenWranglerResponse({ kind: "datasetStats", revision: 1, viewRequestId: "view-1", stats: {} })).toBe(
      false
    );
    expect(
      isOpenWranglerResponse({
        kind: "columnValues",
        revision: 1,
        viewRequestId: "view-1",
        column: "value",
        values: [{ value: "1", count: -1 }],
        hasMore: false
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({ kind: "planUpdated", action: "preview", revision: 1, metadata, page, code: "" })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "stepInspection",
        revision: 3,
        stepId: "step-1",
        stepIndex: 0,
        inputPage: page,
        outputPage: page,
        inputSchema: metadata.schema,
        outputSchema: [{ ...metadata.schema[0], position: -1 }],
        diff: {
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        code: "def clean_data(df):\n    return df\n"
      })
    ).toBe(false);
    expect(isOpenWranglerResponse({ kind: "error", code: "bad", message: "bad", recoverable: "yes" })).toBe(false);
  });

  it("does not accept a response as an envelope", () => {
    const responseEnvelope: RuntimeResponseEnvelope = {
      protocolVersion: 2,
      requestId: "request-1",
      response: responses[0]
    };
    expect(isOpenWranglerResponse(responseEnvelope)).toBe(false);
  });
});

const requests: OpenWranglerRequest[] = [
  { kind: "initialize" },
  {
    kind: "openSession",
    source: metadata.source,
    requestedSessionId: "runtime-candidate",
    backend: "polars",
    mode: "editing",
    pageSize: 200
  },
  {
    kind: "getPage",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "page-1",
    offset: 0,
    limit: 200,
    filterModel: metadata.filterModel
  },
  {
    kind: "getSummary",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "summary-1",
    filterModel: metadata.filterModel,
    columns: ["value"]
  },
  {
    kind: "getDatasetStats",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "stats-1",
    filterModel: metadata.filterModel
  },
  {
    kind: "getColumnValues",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "values-1",
    column: "value",
    filterModel: metadata.filterModel,
    search: "1",
    limit: 50
  },
  {
    kind: "previewStep",
    sessionId: "session-1",
    revision: 3,
    step: { id: "rename", kind: "renameColumn", params: { column: valueReference, newName: "amount" } },
    offset: 0,
    limit: 200
  },
  {
    kind: "inspectStep",
    sessionId: "session-1",
    revision: 3,
    stepId: "step-1",
    offset: 0,
    limit: 200
  },
  { kind: "applyDraft", sessionId: "session-1", revision: 3, offset: 0, limit: 200 },
  { kind: "discardDraft", sessionId: "session-1", revision: 3, offset: 0, limit: 200 },
  { kind: "undoStep", sessionId: "session-1", revision: 3, offset: 0, limit: 200 },
  { kind: "exportData", sessionId: "session-1", revision: 3, path: "/tmp/out.csv", format: "csv" },
  { kind: "closeSession", sessionId: "session-1", revision: 3 },
  { kind: "cancelRequest", targetRequestId: "request-1" }
];

describe("protocol-v2 request validation", () => {
  it.each(requests.map((request) => [request.kind, request] as const))(
    "accepts a structurally complete %s request",
    (_kind, request) => {
      expect(isOpenWranglerRequest(request)).toBe(true);
      expect(
        isRuntimeRequestEnvelope({
          protocolVersion: 2,
          requestId: `request-${request.kind}`,
          priority: "interactive",
          request
        })
      ).toBe(true);
    }
  );

  it("accepts DuckDB as a first-class file backend", () => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: metadata.source,
        backend: "duckdb",
        mode: "editing",
        pageSize: 200
      })
    ).toBe(true);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...metadata, backend: "duckdb" } })).toBe(true);
  });

  it.each([
    { id: "select", kind: "selectColumns", params: { columns: [valueReference, otherReference] } },
    { id: "drop", kind: "dropColumns", params: { columns: [valueReference] } },
    { id: "rename", kind: "renameColumn", params: { column: valueReference, newName: "amount" } },
    { id: "clone", kind: "cloneColumn", params: { column: valueReference, newName: "value_copy" } },
    { id: "cast", kind: "castColumn", params: { column: valueReference, dtype: "float" } },
    {
      id: "formula-value",
      kind: "formula",
      params: { leftColumn: valueReference, operator: "multiply", value: 2, newColumn: "doubled" }
    },
    {
      id: "formula-column",
      kind: "formula",
      params: { leftColumn: valueReference, operator: "add", rightColumn: otherReference, newColumn: "total" }
    },
    { id: "length", kind: "textLength", params: { column: { id: "column:2", name: "" }, newColumn: "length" } }
  ])("accepts canonical column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(true);
  });

  it.each([
    { id: "select-string", kind: "selectColumns", params: { columns: ["value"] } },
    { id: "drop-empty", kind: "dropColumns", params: { columns: [] } },
    { id: "rename-string", kind: "renameColumn", params: { column: "value", newName: "amount" } },
    { id: "clone-name-only", kind: "cloneColumn", params: { column: { name: "value" }, newName: "copy" } },
    { id: "cast-id-only", kind: "castColumn", params: { column: { id: "column:0" }, dtype: "float" } },
    {
      id: "formula-string",
      kind: "formula",
      params: { leftColumn: "value", operator: "add", rightColumn: "other", newColumn: "total" }
    },
    {
      id: "length-extra",
      kind: "textLength",
      params: { column: { ...valueReference, position: 0 }, newColumn: "length" }
    },
    { id: "length-empty-id", kind: "textLength", params: { column: { id: "", name: "value" }, newColumn: "length" } },
    {
      id: "length-non-string-name",
      kind: "textLength",
      params: { column: { id: "column:0", name: 42 }, newColumn: "length" }
    },
    {
      id: "rename-name-field",
      kind: "renameColumn",
      params: { columnName: "value", newName: "amount" }
    }
  ])("rejects legacy or malformed column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(false);
  });

  it.each([
    {
      kind: "openSession",
      source: metadata.source,
      requestedSessionId: "",
      backend: "polars",
      mode: "editing",
      pageSize: 200
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "renameColumn", params: { columns: ["value"] } },
      offset: 0,
      limit: 200
    },
    { kind: "inspectStep", sessionId: "session-1", revision: 3, stepId: "", offset: 0, limit: 200 },
    { kind: "inspectStep", sessionId: "session-1", revision: 3, stepId: "step-1", offset: -1, limit: 200 },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "customCode", params: { code: "   " } },
      offset: 0,
      limit: 200
    },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "", format: "csv" },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "/tmp/out.csv", format: "json" },
    { kind: "closeSession", sessionId: 17, revision: 3 },
    { kind: "closeSession", sessionId: "session-1", revision: -1 },
    { kind: "closeSession", sessionId: "session-1", revision: 3, force: true }
  ])("rejects malformed boundary input: %j", (request) => {
    expect(isOpenWranglerRequest(request)).toBe(false);
  });

  it("rejects unknown request kinds and malformed request envelopes", () => {
    expect(isOpenWranglerRequest({ kind: "futureRequest" })).toBe(false);
    expect(
      isRuntimeRequestEnvelope({
        protocolVersion: 2,
        requestId: "request-1",
        priority: "urgent",
        request: requests[0]
      })
    ).toBe(false);
    expect(
      isRuntimeRequestEnvelope({
        protocolVersion: 2,
        requestId: "request-1",
        priority: "interactive",
        request: requests[0],
        extra: true
      })
    ).toBe(false);
  });
});
