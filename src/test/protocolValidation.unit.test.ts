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
  isRetainedTransformStep,
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
  columnIds: ["column:0"],
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
  steps: [{ id: "step-1", kind: "roundNumber", params: { column: valueReference, decimals: 0 } }],
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
    metadata: {
      ...metadata,
      draftStep: { id: "draft-1", kind: "floorNumber", params: { column: valueReference } }
    },
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
          columnId: "column:0",
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
              sourceColumns: [{ id: "column:0", name: "value" }],
              newColumn: "clean",
              examples: [
                { inputs: ["a"], output: "A" },
                { inputs: ["b"], output: "B" }
              ],
              program: {
                kind: "case",
                style: "sideways",
                input: { kind: "column", column: { id: "column:0", name: "value" } }
              }
            }
          }
        },
        page,
        summaries
      })
    ).toBe(false);
    const unsynthesizedByExample = {
      id: "unsynthesized-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    expect(isTransformStep(unsynthesizedByExample)).toBe(true);
    expect(isRetainedTransformStep(unsynthesizedByExample)).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: { ...metadata, steps: [unsynthesizedByExample] },
        page,
        summaries
      })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: { ...metadata, draftStep: unsynthesizedByExample },
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

  it("requires a recorded latest-step input schema only when applied steps exist", () => {
    const metadataWithoutLatest = { ...metadata };
    delete metadataWithoutLatest.latestStepInputSchema;

    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: metadataWithoutLatest,
        page,
        summaries
      })
    ).toBe(false);

    expect(
      isOpenWranglerResponse({
        kind: "sessionOpened",
        metadata: {
          ...metadataWithoutLatest,
          steps: [],
          draftStep: { id: "first-draft", kind: "floorNumber", params: { column: valueReference } }
        },
        page,
        summaries
      })
    ).toBe(true);
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
    expect(isOpenWranglerResponse(pageResponse({ ...page, columnIds: ["column:0", "column:0"] }))).toBe(false);
    expect(isOpenWranglerResponse(pageResponse({ ...page, columnIds: ["unknown"] }))).toBe(false);
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

  it("requires projected columns to follow schema order with exact row widths", () => {
    const secondColumn = {
      id: "column:1",
      name: "other",
      position: 1,
      rawType: "String",
      type: "string" as const,
      nullable: false
    };
    const projectedMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 2 },
      filteredShape: { rows: 1, columns: 2 },
      schema: [metadata.schema[0], secondColumn]
    };
    const projectedResponse = (columnIds: string[], width = columnIds.length): unknown => ({
      kind: "page",
      revision: 3,
      viewRequestId: "view-1",
      metadata: projectedMetadata,
      page: {
        ...page,
        columnIds,
        rows: [{ ...page.rows[0], values: Array.from({ length: width }, () => page.rows[0].values[0]) }]
      }
    });

    expect(isOpenWranglerResponse(projectedResponse(["column:0", "column:1"]))).toBe(true);
    expect(isOpenWranglerResponse(projectedResponse(["column:1", "column:0"]))).toBe(false);
    expect(isOpenWranglerResponse(projectedResponse(["column:0", "column:1"], 1))).toBe(false);
  });

  it("binds changed-cell identities and labels to the output schema", () => {
    const preview = responses.find((response) => response.kind === "stepPreview");
    expect(preview?.kind).toBe("stepPreview");
    if (preview?.kind !== "stepPreview") return;
    const cell = preview.diff.cells[0];

    expect(
      isOpenWranglerResponse({ ...preview, diff: { ...preview.diff, cells: [{ ...cell, columnId: "unknown" }] } })
    ).toBe(false);
    expect(
      isOpenWranglerResponse({ ...preview, diff: { ...preview.diff, cells: [{ ...cell, column: "other" }] } })
    ).toBe(false);

    const inspection = responses.find((response) => response.kind === "stepInspection");
    expect(inspection?.kind).toBe("stepInspection");
    if (inspection?.kind !== "stepInspection") return;
    expect(
      isOpenWranglerResponse({
        ...inspection,
        diff: {
          ...inspection.diff,
          changedCells: 1,
          cells: [{ rowNumber: 0, columnId: "unknown", column: "value", before: null, after: null }]
        }
      })
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
    pageSize: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "getPage",
    sessionId: "session-1",
    revision: 3,
    viewRequestId: "page-1",
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16,
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
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "inspectStep",
    sessionId: "session-1",
    revision: 3,
    stepId: "step-1",
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "applyDraft",
    sessionId: "session-1",
    revision: 3,
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "discardDraft",
    sessionId: "session-1",
    revision: 3,
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
  {
    kind: "undoStep",
    sessionId: "session-1",
    revision: 3,
    offset: 0,
    limit: 200,
    columnOffset: 0,
    columnLimit: 16
  },
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
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(true);
    expect(isOpenWranglerResponse({ ...responses[1], metadata: { ...metadata, backend: "duckdb" } })).toBe(true);
  });

  it.each([
    {
      id: "sort-rows",
      kind: "sortRows",
      params: { rules: [{ column: valueReference, direction: "asc", nulls: "last" }] }
    },
    {
      id: "filter-rows",
      kind: "filterRows",
      params: {
        filterModel: {
          logic: "and",
          filters: [
            {
              column: valueReference,
              type: "integer",
              predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
            }
          ],
          sort: [{ column: valueReference, direction: "desc", nulls: "first" }]
        }
      }
    },
    { id: "drop-missing", kind: "dropMissingRows", params: { columns: [], how: "any" } },
    { id: "drop-duplicates", kind: "dropDuplicates", params: { columns: [valueReference], keep: "first" } },
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
    { id: "length", kind: "textLength", params: { column: { id: "column:2", name: "" }, newColumn: "length" } },
    {
      id: "one-hot",
      kind: "oneHotEncode",
      params: {
        columns: [valueReference, { id: "column:2", name: "value" }],
        prefixSeparator: "",
        dropOriginal: true
      }
    },
    {
      id: "multi-label",
      kind: "multiLabelBinarize",
      params: { column: valueReference, delimiter: ",", prefix: "label", dropOriginal: false }
    },
    {
      id: "find-replace",
      kind: "findReplace",
      params: { column: valueReference, find: "old", replacement: "new", regex: false }
    },
    { id: "strip-null", kind: "stripText", params: { column: valueReference, characters: null } },
    { id: "strip-omitted", kind: "stripText", params: { column: valueReference } },
    {
      id: "split",
      kind: "splitText",
      params: { column: valueReference, delimiter: ",", index: 0, newColumn: "first" }
    },
    { id: "capitalize", kind: "capitalizeText", params: { column: valueReference } },
    { id: "lower", kind: "lowerText", params: { column: valueReference, newColumn: "lower" } },
    { id: "upper", kind: "upperText", params: { column: valueReference } },
    { id: "scale", kind: "minMaxScale", params: { column: valueReference } },
    { id: "round", kind: "roundNumber", params: { column: valueReference, decimals: 2 } },
    { id: "floor", kind: "floorNumber", params: { column: valueReference } },
    { id: "ceil", kind: "ceilNumber", params: { column: valueReference } },
    { id: "format", kind: "formatDatetime", params: { column: valueReference, format: "%Y-%m-%d" } },
    {
      id: "group",
      kind: "groupBy",
      params: {
        keys: [valueReference],
        aggregations: [
          { column: otherReference, operation: "sum", alias: "total" },
          { column: otherReference, operation: "mean", alias: "average" }
        ]
      }
    },
    {
      id: "example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, otherReference],
        newColumn: "combined",
        examples: [
          { inputs: ["a", 1], output: "a1" },
          { inputs: ["b", 2], output: "b2" }
        ],
        program: {
          kind: "concat",
          parts: [
            { kind: "column", column: valueReference },
            { kind: "column", column: otherReference }
          ]
        },
        warnings: [],
        candidateCount: 1
      }
    }
  ])("accepts canonical column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(true);
  });

  it.each([
    {
      id: "sort-legacy-name",
      kind: "sortRows",
      params: { rules: [{ column: "value", direction: "asc", nulls: "last" }] }
    },
    {
      id: "filter-legacy-name",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [{ column: "value", type: "integer", predicates: [] }],
          sort: []
        }
      }
    },
    { id: "drop-missing-legacy", kind: "dropMissingRows", params: { columns: ["value"] } },
    { id: "drop-duplicates-empty", kind: "dropDuplicates", params: { columns: [] } },
    { id: "drop-duplicates-legacy", kind: "dropDuplicates", params: { columns: ["value"] } },
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
    },
    { id: "one-hot-string", kind: "oneHotEncode", params: { columns: ["value"] } },
    {
      id: "one-hot-duplicate-id",
      kind: "oneHotEncode",
      params: { columns: [valueReference, { id: valueReference.id, name: "renamed" }] }
    },
    {
      id: "sort-duplicate-id",
      kind: "sortRows",
      params: {
        rules: [
          { column: valueReference, direction: "asc", nulls: "last" },
          { column: { id: valueReference.id, name: "renamed" }, direction: "desc", nulls: "first" }
        ]
      }
    },
    {
      id: "filter-duplicate-id",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            { column: valueReference, type: "integer", predicates: [] },
            { column: { id: valueReference.id, name: "renamed" }, type: "integer", predicates: [] }
          ],
          sort: []
        }
      }
    },
    {
      id: "filter-sort-duplicate-id",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [],
          sort: [
            { column: valueReference, direction: "asc", nulls: "last" },
            { column: { id: valueReference.id, name: "renamed" }, direction: "desc", nulls: "first" }
          ]
        }
      }
    },
    { id: "multi-label-string", kind: "multiLabelBinarize", params: { column: "value", delimiter: "," } },
    {
      id: "find-replace-string",
      kind: "findReplace",
      params: { column: "value", find: "old", replacement: "new" }
    },
    { id: "strip-string", kind: "stripText", params: { column: "value" } },
    { id: "strip-empty-characters", kind: "stripText", params: { column: valueReference, characters: "" } },
    {
      id: "split-string",
      kind: "splitText",
      params: { column: "value", delimiter: ",", index: 0, newColumn: "first" }
    },
    { id: "capitalize-string", kind: "capitalizeText", params: { column: "value" } },
    { id: "lower-string", kind: "lowerText", params: { column: "value" } },
    { id: "upper-string", kind: "upperText", params: { column: "value" } },
    { id: "scale-string", kind: "minMaxScale", params: { column: "value" } },
    { id: "round-string", kind: "roundNumber", params: { column: "value" } },
    { id: "floor-string", kind: "floorNumber", params: { column: "value" } },
    { id: "ceil-string", kind: "ceilNumber", params: { column: "value" } },
    { id: "format-string", kind: "formatDatetime", params: { column: "value", format: "%Y" } },
    {
      id: "group-legacy",
      kind: "groupBy",
      params: { keys: ["value"], aggregations: [{ column: "other", operation: "sum", alias: "total" }] }
    },
    {
      id: "group-position",
      kind: "groupBy",
      params: {
        keys: [{ ...valueReference, position: 0 }],
        aggregations: [{ column: otherReference, operation: "sum", alias: "total" }]
      }
    },
    {
      id: "group-duplicate-key",
      kind: "groupBy",
      params: {
        keys: [valueReference, valueReference],
        aggregations: [{ column: otherReference, operation: "sum", alias: "total" }]
      }
    },
    {
      id: "group-alias-key",
      kind: "groupBy",
      params: {
        keys: [valueReference],
        aggregations: [{ column: otherReference, operation: "sum", alias: "value" }]
      }
    },
    {
      id: "example-legacy",
      kind: "byExample",
      params: {
        sourceColumns: ["value"],
        newColumn: "clean",
        examples: [
          { inputs: { value: "a" }, output: "A" },
          { inputs: { value: "b" }, output: "B" }
        ]
      }
    },
    {
      id: "example-duplicate-source",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a", "a"], output: "A" },
          { inputs: ["b", "b"], output: "B" }
        ]
      }
    },
    {
      id: "example-wrong-arity",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, otherReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    },
    {
      id: "example-outside-source",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "column", column: otherReference }
      }
    },
    {
      id: "example-negative-slice",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program: { kind: "slice", input: { kind: "column", column: valueReference }, start: -1 }
      }
    },
    {
      id: "example-negative-split",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program: { kind: "split", input: { kind: "column", column: valueReference }, delimiter: ",", index: -1 }
      }
    }
  ])("rejects legacy or malformed column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(false);
  });

  it("bounds by-example sources, examples, concat programs, depth, and scalar values", () => {
    const sources = Array.from({ length: 17 }, (_, index) => ({ id: `column:${index}`, name: `value_${index}` }));
    const example = (width: number) => ({ inputs: Array.from({ length: width }, () => "x"), output: "x" });
    const base = {
      id: "bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [example(1), example(1)]
      }
    };
    const oversizedProgram = {
      kind: "concat",
      parts: Array.from({ length: 64 }, () => ({
        kind: "concat",
        parts: Array.from({ length: 4 }, () => ({ kind: "column", column: valueReference }))
      }))
    };
    let deepProgram: unknown = { kind: "column", column: valueReference };
    for (let index = 0; index < 65; index += 1) deepProgram = { kind: "slice", input: deepProgram, start: 0 };

    const malformed = [
      { ...base, params: { ...base.params, sourceColumns: sources, examples: [example(17), example(17)] } },
      { ...base, params: { ...base.params, examples: Array.from({ length: 65 }, () => example(1)) } },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "concat",
            parts: Array.from({ length: 65 }, () => ({ kind: "column", column: valueReference }))
          }
        }
      },
      { ...base, params: { ...base.params, program: oversizedProgram } },
      { ...base, params: { ...base.params, program: deepProgram } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "slice", input: { kind: "column", column: valueReference }, start: 2, stop: 1 }
        }
      },
      { ...base, params: { ...base.params, examples: [{ inputs: [Number.NaN], output: "x" }, example(1)] } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "literal", value: Number.POSITIVE_INFINITY }
        }
      }
    ];

    for (const step of malformed) expect(isTransformStep(step)).toBe(false);
  });

  it("rejects over-wide by-example containers before traversing their contents", () => {
    const base = {
      id: "container-bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    const hugeLength = 100_000;
    const malformed = [
      {
        ...base,
        params: {
          ...base.params,
          sourceColumns: Array.from({ length: hugeLength }, () => valueReference)
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "concat",
            parts: Array.from({ length: hugeLength }, () => ({ kind: "column", column: valueReference }))
          }
        }
      },
      { ...base, params: { ...base.params, warnings: Array.from({ length: hugeLength }, () => "") } }
    ];

    for (const step of malformed) {
      expect(() => isTransformStep(step)).not.toThrow();
      expect(isTransformStep(step)).toBe(false);
    }
  });

  it("caps saved by-example warnings independently of their UTF-8 payload", () => {
    const base = {
      id: "warning-bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };

    expect(
      isTransformStep({ ...base, params: { ...base.params, warnings: Array.from({ length: 64 }, () => "") } })
    ).toBe(true);
    expect(
      isTransformStep({ ...base, params: { ...base.params, warnings: Array.from({ length: 65 }, () => "") } })
    ).toBe(false);
  });

  it("bounds every by-example string by strict UTF-8 bytes", () => {
    const stepWithInput = (input: string) => ({
      id: "utf8-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c", name: "" }],
        newColumn: "n",
        examples: [
          { inputs: [input], output: null },
          { inputs: [null], output: null }
        ]
      }
    });

    for (const accepted of ["a".repeat(8192), "é".repeat(4096), "🙂".repeat(2048)]) {
      expect(isTransformStep(stepWithInput(accepted))).toBe(true);
    }
    for (const rejected of ["a".repeat(8193), "é".repeat(4097), "🙂".repeat(2049), "\ud800"]) {
      expect(() => isTransformStep(stepWithInput(rejected))).not.toThrow();
      expect(isTransformStep(stepWithInput(rejected))).toBe(false);
    }
  });

  it("rejects by-example integer scalars that cannot survive the JSON transport exactly", () => {
    const stepWithValues = (input: number, output: number) => ({
      id: "numeric-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "result",
        examples: [
          { inputs: [input], output },
          { inputs: [1], output: 2 }
        ]
      }
    });

    expect(isTransformStep(stepWithValues(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER))).toBe(true);
    expect(isTransformStep(stepWithValues(Number.MAX_SAFE_INTEGER + 1, 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1, Number.MIN_SAFE_INTEGER - 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1.25, 2.5))).toBe(true);
  });

  it("caps the aggregate by-example text envelope at 64 KiB", () => {
    const stringsAtLimit = ["a".repeat(8190), ...Array.from({ length: 7 }, () => "b".repeat(8192))];
    const stepWithStrings = (strings: string[]) => ({
      id: "aggregate-utf8-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c", name: "" }],
        newColumn: "n",
        examples: Array.from({ length: 4 }, (_, index) => ({
          inputs: [strings[index * 2]],
          output: strings[index * 2 + 1]
        }))
      }
    });

    expect(isTransformStep(stepWithStrings(stringsAtLimit))).toBe(true);
    expect(isTransformStep(stepWithStrings([`x${stringsAtLimit[0]}`, ...stringsAtLimit.slice(1)]))).toBe(false);
  });

  it("counts references, program text, and warnings in the by-example envelope", () => {
    const column = { id: "c", name: "value" };
    const base = {
      id: "text-fields-example",
      kind: "byExample",
      params: {
        sourceColumns: [column],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    const oversized = "x".repeat(8193);
    const columnProgram = { kind: "column", column };
    const malformed = [
      { ...base, params: { ...base.params, sourceColumns: [{ id: "c", name: oversized }] } },
      { ...base, params: { ...base.params, newColumn: oversized } },
      { ...base, params: { ...base.params, program: { kind: "literal", value: oversized } } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "split", input: columnProgram, delimiter: oversized, index: 0 }
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "regexReplace", input: columnProgram, pattern: oversized, replacement: "" }
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "datetimeFormat",
            input: columnProgram,
            inputFormat: "%Y",
            outputFormat: oversized
          }
        }
      },
      { ...base, params: { ...base.params, warnings: [oversized] } },
      { ...base, params: { ...base.params, warnings: ["\udfff"] } }
    ];

    for (const step of malformed) {
      expect(() => isTransformStep(step)).not.toThrow();
      expect(isTransformStep(step)).toBe(false);
    }
  });

  it("rejects cyclic by-example programs without throwing", () => {
    const cyclic: Record<string, unknown> = { kind: "case", style: "upper" };
    cyclic.input = cyclic;
    const step = {
      id: "cyclic-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: cyclic
      }
    };

    expect(() => isTransformStep(step)).not.toThrow();
    expect(isTransformStep(step)).toBe(false);
  });

  it.each([
    {
      kind: "openSession",
      source: metadata.source,
      requestedSessionId: "",
      backend: "polars",
      mode: "editing",
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "renameColumn", params: { columns: ["value"] } },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "inspectStep",
      sessionId: "session-1",
      revision: 3,
      stepId: "",
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "inspectStep",
      sessionId: "session-1",
      revision: 3,
      stepId: "step-1",
      offset: -1,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "customCode", params: { code: "   " } },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "", format: "csv" },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "/tmp/out.csv", format: "json" },
    { kind: "closeSession", sessionId: 17, revision: 3 },
    { kind: "closeSession", sessionId: "session-1", revision: -1 },
    { kind: "closeSession", sessionId: "session-1", revision: 3, force: true }
  ])("rejects malformed boundary input: %j", (request) => {
    expect(isOpenWranglerRequest(request)).toBe(false);
  });

  it("rejects missing, fractional, negative, zero, and oversized column windows", () => {
    const getPage = requests.find((request) => request.kind === "getPage");
    expect(getPage?.kind).toBe("getPage");
    if (getPage?.kind !== "getPage") return;

    const { columnOffset: _columnOffset, ...withoutOffset } = getPage;
    expect(isOpenWranglerRequest(withoutOffset)).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnOffset: -1 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnOffset: 0.5 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnLimit: 0 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnLimit: 257 })).toBe(false);
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
