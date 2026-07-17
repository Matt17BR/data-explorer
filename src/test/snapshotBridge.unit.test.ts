import { describe, expect, it, vi } from "vitest";
import type {
  CellValue,
  FilterModel,
  OpenSessionRequest,
  PageRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata
} from "../shared/protocol";
import type { NotebookOutputPayload } from "../shared/notebookOutput";
import { isOpenWranglerResponse } from "../shared/protocolValidation";
import * as snapshotModel from "../shared/snapshotModel";
import { SnapshotBridge } from "../extension/notebooks/snapshotBridge";

const HOST_SESSION_ID = "host-snapshot-session";

describe("SnapshotBridge", () => {
  it("publishes only captured-row truth under a host-owned read-only session", async () => {
    const payload = savedPayload();
    const bridge = new SnapshotBridge(payload, () => HOST_SESSION_ID);
    payload.metadata.sessionId = "mutated-payload-session";
    payload.page.rows[0]!.values[0]!.display = "Mutated after capture";

    const initialized = await canonical(bridge.request({ kind: "initialize" }));
    expect(initialized).toEqual({
      kind: "initialized",
      protocolVersion: 2,
      runtimeVersion: "snapshot",
      capabilities: readOnlyCapabilities()
    });

    const opened = await canonical(
      bridge.request(openRequest({ requestedSessionId: "payload-session", mode: "editing" }))
    );
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the saved snapshot to open.");
    expect(opened.metadata).toMatchObject({
      protocolVersion: 2,
      sessionId: HOST_SESSION_ID,
      revision: 0,
      backend: "pandas",
      mode: "viewing",
      source: { kind: "notebookOutput", label: "captured frame" },
      capabilities: readOnlyCapabilities(),
      shape: { rows: 4, columns: 3 },
      filteredShape: { rows: 4, columns: 3 },
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    });
    expect(Object.keys(opened.metadata.source).sort()).toEqual(["kind", "label"]);
    expect(opened.metadata).not.toHaveProperty("draftStep");
    expect(opened.metadata).not.toHaveProperty("draftReplacesStepId");
    expect(opened.metadata).not.toHaveProperty("latestStepInputSchema");
    expect(opened.metadata).not.toHaveProperty("stats");
    expect(opened.page).toMatchObject({
      offset: 0,
      limit: 2,
      totalRows: 4,
      columnIds: ["c:sales"]
    });
    expect(opened.page.rows.map((row) => row.rowNumber)).toEqual([0, 1]);
    expect(opened.page.rows.map((row) => row.values[0]?.display)).toEqual(["12", "10"]);
    expect(opened.summaries).toEqual([]);
  });

  it("correlates filtered and sorted pages with the exact requested two-dimensional window", async () => {
    const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    const opened = await open(bridge);
    const filterModel: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "equals", value: "Berlin" }]
        }
      ],
      sort: [{ column: "sales", direction: "asc", nulls: "last" }]
    };

    const response = await canonical(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "filtered-projection",
        offset: 0,
        limit: 1,
        columnOffset: 1,
        columnLimit: 2,
        filterModel
      })
    );

    expect(response.kind).toBe("page");
    if (response.kind !== "page") throw new Error("Expected a snapshot page response.");
    expect(response.revision).toBe(0);
    expect(response.viewRequestId).toBe("filtered-projection");
    expect(response.metadata.filterModel).toEqual(filterModel);
    expect(response.metadata.shape).toEqual({ rows: 4, columns: 3 });
    expect(response.metadata.filteredShape).toEqual({ rows: 2, columns: 3 });
    expect(response.page).toMatchObject({
      offset: 0,
      limit: 1,
      totalRows: 2,
      columnIds: ["c:sales", "c:tag"]
    });
    expect(response.page.rows).toEqual([
      {
        id: "r:13",
        rowNumber: 0,
        values: [numberCell(8), nanCell()]
      }
    ]);

    const sorted = await canonical(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: 0,
        viewRequestId: "null-placement",
        offset: 1,
        limit: 2,
        columnOffset: 0,
        columnLimit: 2,
        filterModel: {
          filters: [],
          sort: [{ column: "sales", direction: "desc", nulls: "first" }]
        }
      })
    );
    expect(sorted).toMatchObject({
      kind: "page",
      viewRequestId: "null-placement",
      page: { totalRows: 4, columnIds: ["c:city", "c:sales"] }
    });
    if (sorted.kind !== "page") throw new Error("Expected a sorted snapshot page response.");
    expect(sorted.page.rows.map((row) => [row.rowNumber, row.id])).toEqual([
      [1, "r:10"],
      [2, "r:11"]
    ]);
  });

  it("runs each page filter and sort through one snapshot-model page pass", async () => {
    const pageSpy = vi.spyOn(snapshotModel, "snapshotPage");
    const directFilterSpy = vi.spyOn(snapshotModel, "applySnapshotFilters");
    try {
      const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
      await open(bridge);
      pageSpy.mockClear();
      directFilterSpy.mockClear();

      const response = await canonical(
        bridge.request({
          ...pageRequest(HOST_SESSION_ID, 0, "single-page-pass"),
          filterModel: {
            filters: [
              {
                column: "city",
                type: "string",
                predicates: [{ kind: "predicate", operator: "equals", value: "Berlin" }]
              }
            ],
            sort: [{ column: "sales", direction: "asc", nulls: "last" }]
          }
        })
      );

      expect(response).toMatchObject({
        kind: "page",
        viewRequestId: "single-page-pass",
        page: { totalRows: 2 }
      });
      expect(pageSpy).toHaveBeenCalledTimes(1);
      expect(directFilterSpy).not.toHaveBeenCalled();
    } finally {
      pageSpy.mockRestore();
      directFilterSpy.mockRestore();
    }
  });

  it("lets an interactive page overtake default-background snapshot profiling", async () => {
    const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    await open(bridge);
    const completionOrder: string[] = [];

    const background = bridge
      .request({
        kind: "getSummary",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "background-summary",
        filterModel: { filters: [], sort: [] }
      })
      .then((response) => {
        completionOrder.push("background");
        return response;
      });
    const foreground = bridge
      .request(pageRequest(HOST_SESSION_ID, 0, "foreground-page"), { priority: "interactive" })
      .then((response) => {
        completionOrder.push("foreground");
        return response;
      });

    await expect(
      Promise.race([background.then(() => "background"), foreground.then(() => "foreground")])
    ).resolves.toBe("foreground");
    const [backgroundResponse, foregroundResponse] = await Promise.all([background, foreground]);
    expect(completionOrder).toEqual(["foreground", "background"]);
    expect(backgroundResponse).toMatchObject({
      kind: "summary",
      revision: 0,
      viewRequestId: "background-summary"
    });
    expect(foregroundResponse).toMatchObject({
      kind: "page",
      revision: 0,
      viewRequestId: "foreground-page"
    });
  });

  it("rechecks cancellation and session correlation after a background yield", async () => {
    const cancelledBridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    await open(cancelledBridge);
    let cancelled = false;
    const cancellation = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose: () => undefined })
    };
    const cancelledRequest = cancelledBridge.request(
      {
        kind: "getDatasetStats",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "cancelled-background",
        filterModel: { filters: [], sort: [] }
      },
      { cancellation }
    );
    cancelled = true;
    await expect(canonical(cancelledRequest)).resolves.toMatchObject({
      kind: "error",
      code: "snapshot_cancellation_unsupported",
      sessionId: HOST_SESSION_ID,
      viewRequestId: "cancelled-background"
    });

    const closedBridge = new SnapshotBridge(savedPayload(), () => "closed-during-profile");
    await open(closedBridge);
    const pendingProfile = closedBridge.request({
      kind: "getSummary",
      sessionId: "closed-during-profile",
      revision: 0,
      viewRequestId: "closed-background",
      filterModel: { filters: [], sort: [] }
    });
    await expect(
      canonical(closedBridge.request({ kind: "closeSession", sessionId: "closed-during-profile", revision: 0 }))
    ).resolves.toEqual({ kind: "sessionClosed", sessionId: "closed-during-profile" });
    await expect(canonical(pendingProfile)).resolves.toMatchObject({
      kind: "error",
      code: "snapshot_session_closed",
      sessionId: "closed-during-profile",
      viewRequestId: "closed-background"
    });
  });

  it("recomputes summaries, statistics, and bounded values from the filtered captured rows", async () => {
    const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    const opened = await open(bridge);
    const berlinOnly: FilterModel = {
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "equals", value: "Berlin" }]
        }
      ],
      sort: []
    };

    const summary = await canonical(
      bridge.request({
        kind: "getSummary",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "summary-berlin",
        filterModel: berlinOnly,
        columns: ["sales"]
      })
    );
    expect(summary).toEqual({
      kind: "summary",
      revision: 0,
      viewRequestId: "summary-berlin",
      summaries: [
        expect.objectContaining({
          column: "sales",
          totalCount: 2,
          nullCount: 0,
          nanCount: 0,
          numeric: expect.objectContaining({ min: 8, max: 12, mean: 10, median: 10, std: Math.sqrt(8) }),
          visualization: expect.objectContaining({ kind: "numeric", bins: expect.any(Array) })
        })
      ]
    });

    const stats = await canonical(
      bridge.request({
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: 0,
        viewRequestId: "stats-captured",
        filterModel: { filters: [], sort: [] }
      })
    );
    expect(stats).toEqual({
      kind: "datasetStats",
      revision: 0,
      viewRequestId: "stats-captured",
      stats: {
        missingCells: 3,
        missingRows: 3,
        duplicateRows: 0,
        missingValuesByColumn: [
          { column: "city", count: 0 },
          { column: "sales", count: 1 },
          { column: "tag", count: 2 }
        ]
      }
    });

    const values = await canonical(
      bridge.request({
        kind: "getColumnValues",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "values-limited",
        column: "city",
        filterModel: { filters: [], sort: [] },
        limit: 2
      })
    );
    expect(values).toEqual({
      kind: "columnValues",
      revision: 0,
      viewRequestId: "values-limited",
      column: "city",
      values: [
        { value: "Berlin", count: 2 },
        { value: "Milan", count: 1 }
      ],
      hasMore: true
    });
  });

  it("enforces session, revision, request, source, and lifecycle correlation", async () => {
    const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    const beforeOpen = await canonical(bridge.request(pageRequest("not-open", 0, "before-open")));
    expect(beforeOpen).toMatchObject({
      kind: "error",
      code: "snapshot_session_not_open",
      sessionId: "not-open",
      viewRequestId: "before-open"
    });

    const sourceMismatch = await canonical(
      bridge.request(openRequest({ source: { kind: "notebookOutput", label: "another output" } }))
    );
    expect(sourceMismatch).toMatchObject({ kind: "error", code: "snapshot_source_mismatch" });

    const backendMismatch = await canonical(bridge.request(openRequest({ backend: "polars" })));
    expect(backendMismatch).toMatchObject({ kind: "error", code: "snapshot_backend_mismatch" });

    const opened = await open(bridge);
    const duplicateOpen = await canonical(bridge.request(openRequest()));
    expect(duplicateOpen).toMatchObject({ kind: "error", code: "snapshot_session_exists" });

    const unknown = await canonical(bridge.request(pageRequest("wrong-session", 0, "wrong-session-view")));
    expect(unknown).toMatchObject({
      kind: "error",
      code: "unknown_session",
      sessionId: "wrong-session",
      viewRequestId: "wrong-session-view"
    });

    const stale = await canonical(bridge.request(pageRequest(HOST_SESSION_ID, 9, "stale-view")));
    expect(stale).toMatchObject({
      kind: "error",
      code: "stale_request",
      sessionId: HOST_SESSION_ID,
      viewRequestId: "stale-view"
    });

    const malformed = await canonical(
      bridge.request({ ...pageRequest(HOST_SESSION_ID, 0, "malformed-view"), extra: true } as OpenWranglerRequest)
    );
    expect(malformed).toMatchObject({
      kind: "error",
      code: "invalid_request",
      sessionId: HOST_SESSION_ID,
      viewRequestId: "malformed-view"
    });

    const staleClose = await canonical(
      bridge.request({ kind: "closeSession", sessionId: HOST_SESSION_ID, revision: 1 })
    );
    expect(staleClose).toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });

    const afterClose = await canonical(bridge.request(pageRequest(HOST_SESSION_ID, 0, "after-close")));
    expect(afterClose).toMatchObject({ kind: "error", code: "snapshot_session_closed" });
    const wrongAfterClose = await canonical(bridge.request(pageRequest("wrong-after-close", 0, "wrong-closed")));
    expect(wrongAfterClose).toMatchObject({ kind: "error", code: "unknown_session" });
    const reopen = await canonical(bridge.request(openRequest()));
    expect(reopen).toMatchObject({ kind: "error", code: "snapshot_session_closed" });
  });

  it("fails closed for operations, inspection, export, and cancellation", async () => {
    const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    await open(bridge);
    const requests: Array<[OpenWranglerRequest, string]> = [
      [
        {
          kind: "previewStep",
          sessionId: HOST_SESSION_ID,
          revision: 0,
          step: { id: "draft", kind: "dropMissingRows", params: {} },
          offset: 0,
          limit: 10,
          columnOffset: 0,
          columnLimit: 3
        },
        "snapshot_read_only"
      ],
      [
        {
          kind: "inspectStep",
          sessionId: HOST_SESSION_ID,
          revision: 0,
          stepId: "saved-step",
          offset: 0,
          limit: 10,
          columnOffset: 0,
          columnLimit: 3
        },
        "snapshot_inspection_unsupported"
      ],
      [
        {
          kind: "applyDraft",
          sessionId: HOST_SESSION_ID,
          revision: 0,
          offset: 0,
          limit: 10,
          columnOffset: 0,
          columnLimit: 3
        },
        "snapshot_read_only"
      ],
      [
        {
          kind: "discardDraft",
          sessionId: HOST_SESSION_ID,
          revision: 0,
          offset: 0,
          limit: 10,
          columnOffset: 0,
          columnLimit: 3
        },
        "snapshot_read_only"
      ],
      [
        {
          kind: "undoStep",
          sessionId: HOST_SESSION_ID,
          revision: 0,
          offset: 0,
          limit: 10,
          columnOffset: 0,
          columnLimit: 3
        },
        "snapshot_read_only"
      ],
      [
        {
          kind: "exportData",
          sessionId: HOST_SESSION_ID,
          revision: 0,
          path: "/tmp/captured.csv",
          format: "csv"
        },
        "snapshot_export_unsupported"
      ],
      [{ kind: "cancelRequest", targetRequestId: "snapshot-read" }, "snapshot_cancellation_unsupported"]
    ];

    for (const [request, code] of requests) {
      const response = await canonical(bridge.request(request));
      expect(response).toMatchObject({ kind: "error", code, recoverable: false });
    }

    const cancelledOption = await canonical(
      bridge.request(pageRequest(HOST_SESSION_ID, 0, "pre-cancelled"), {
        cancellation: {
          isCancellationRequested: true,
          onCancellationRequested: () => ({ dispose: () => undefined })
        }
      })
    );
    expect(cancelledOption).toMatchObject({
      kind: "error",
      code: "snapshot_cancellation_unsupported",
      sessionId: HOST_SESSION_ID,
      viewRequestId: "pre-cancelled"
    });
  });

  it("returns structured unknown-column errors and keeps published response mutation isolated", async () => {
    const bridge = new SnapshotBridge(savedPayload(), () => HOST_SESSION_ID);
    const opened = await open(bridge);
    opened.metadata.schema[0]!.name = "mutated schema";
    opened.page.rows[0]!.values[0]!.display = "mutated response";

    const unknownSummary = await canonical(
      bridge.request({
        kind: "getSummary",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "unknown-summary",
        filterModel: { filters: [], sort: [] },
        columns: ["missing"]
      })
    );
    expect(unknownSummary).toMatchObject({
      kind: "error",
      code: "snapshot_query_failed",
      viewRequestId: "unknown-summary"
    });

    const unknownValues = await canonical(
      bridge.request({
        kind: "getColumnValues",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "unknown-values",
        column: "missing",
        filterModel: { filters: [], sort: [] },
        limit: 10
      })
    );
    expect(unknownValues).toMatchObject({
      kind: "error",
      code: "snapshot_query_failed",
      viewRequestId: "unknown-values"
    });

    const page = await canonical(bridge.request(pageRequest(HOST_SESSION_ID, 0, "isolated-page")));
    expect(page.kind).toBe("page");
    if (page.kind !== "page") throw new Error("Expected an isolated snapshot page response.");
    expect(page.metadata.schema[0]?.name).toBe("city");
    expect(page.page.rows[0]?.values[0]?.display).toBe("Berlin");
    expect(page.page.rows[0]?.values[1]?.display).toBe("12");
  });

  it("fails closed when view queries cannot address exactly one type-compatible column", async () => {
    const duplicatePayload = savedPayload();
    duplicatePayload.metadata.schema[1] = { ...duplicatePayload.metadata.schema[1]!, name: "city" };
    const duplicateBridge = new SnapshotBridge(duplicatePayload, () => HOST_SESSION_ID);
    await open(duplicateBridge);

    const ambiguousPage = await canonical(
      duplicateBridge.request({
        ...pageRequest(HOST_SESSION_ID, 0, "ambiguous-filter"),
        filterModel: {
          filters: [
            {
              column: "city",
              type: "string",
              predicates: [{ kind: "predicate", operator: "equals", value: "Berlin" }]
            }
          ],
          sort: []
        }
      })
    );
    expect(ambiguousPage).toMatchObject({
      kind: "error",
      code: "snapshot_query_failed",
      viewRequestId: "ambiguous-filter"
    });

    const ambiguousSummary = await canonical(
      duplicateBridge.request({
        kind: "getSummary",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "ambiguous-summary",
        filterModel: { filters: [], sort: [] },
        columns: ["city"]
      })
    );
    expect(ambiguousSummary).toMatchObject({ kind: "error", code: "snapshot_query_failed" });

    const uniqueSummary = await canonical(
      duplicateBridge.request({
        kind: "getSummary",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "unique-summary",
        filterModel: { filters: [], sort: [] },
        columns: ["tag"]
      })
    );
    expect(uniqueSummary).toMatchObject({
      kind: "summary",
      viewRequestId: "unique-summary",
      summaries: [{ column: "tag" }]
    });

    const ambiguousValues = await canonical(
      duplicateBridge.request({
        kind: "getColumnValues",
        sessionId: HOST_SESSION_ID,
        revision: 0,
        viewRequestId: "ambiguous-values",
        column: "city",
        filterModel: { filters: [], sort: [] },
        limit: 10
      })
    );
    expect(ambiguousValues).toMatchObject({ kind: "error", code: "snapshot_query_failed" });

    const ordinaryBridge = new SnapshotBridge(savedPayload(), () => "ordinary-snapshot-session");
    await open(ordinaryBridge);
    const wrongType = await canonical(
      ordinaryBridge.request({
        ...pageRequest("ordinary-snapshot-session", 0, "wrong-filter-type"),
        filterModel: {
          filters: [{ column: "city", type: "float", predicates: [] }],
          sort: []
        }
      })
    );
    expect(wrongType).toMatchObject({ kind: "error", code: "snapshot_query_failed" });
    const unknownSort = await canonical(
      ordinaryBridge.request({
        ...pageRequest("ordinary-snapshot-session", 0, "unknown-sort"),
        filterModel: {
          filters: [],
          sort: [{ column: "missing", direction: "asc", nulls: "last" }]
        }
      })
    );
    expect(unknownSort).toMatchObject({ kind: "error", code: "snapshot_query_failed" });
  });

  it("rejects malformed payloads and invalid host session identities before serving requests", () => {
    expect(() => new SnapshotBridge({ ...savedPayload(), mimeVersion: 1 } as unknown as NotebookOutputPayload)).toThrow(
      /malformed notebook output payload/u
    );
    expect(() => new SnapshotBridge(savedPayload(), () => "")).toThrow(/invalid identifier/u);
  });
});

async function open(bridge: SnapshotBridge) {
  const response = await canonical(bridge.request(openRequest()));
  if (response.kind !== "sessionOpened") throw new Error("Expected a snapshot session to open.");
  return response;
}

function openRequest(overrides: Partial<OpenSessionRequest> = {}): OpenSessionRequest {
  return {
    kind: "openSession",
    source: { kind: "notebookOutput", label: "captured frame" },
    backend: "pandas",
    mode: "viewing",
    pageSize: 2,
    columnOffset: 1,
    columnLimit: 1,
    ...overrides
  };
}

function pageRequest(sessionId: string, revision: number, viewRequestId: string): PageRequest {
  return {
    kind: "getPage",
    sessionId,
    revision,
    viewRequestId,
    offset: 0,
    limit: 2,
    columnOffset: 0,
    columnLimit: 3,
    filterModel: { filters: [], sort: [] }
  };
}

async function canonical(responsePromise: Promise<OpenWranglerResponse>): Promise<OpenWranglerResponse> {
  const response = await responsePromise;
  expect(isOpenWranglerResponse(response)).toBe(true);
  return response;
}

function savedPayload(): NotebookOutputPayload {
  const schema: SessionMetadata["schema"] = [
    { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:sales", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true },
    { id: "c:tag", name: "tag", position: 2, rawType: "String", type: "string", nullable: true }
  ];
  return {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "payload-session",
      revision: 0,
      backend: "pandas",
      mode: "viewing",
      source: {
        kind: "notebookOutput",
        label: "captured frame",
        variableName: "payload_variable"
      },
      capabilities: readOnlyCapabilities(),
      shape: { rows: 999, columns: 3 },
      filteredShape: { rows: 999, columns: 3 },
      schema,
      filterModel: { filters: [], sort: [] },
      steps: [],
      stats: {
        missingCells: 999,
        missingRows: 999,
        duplicateRows: 999,
        missingValuesByColumn: [{ column: "city", count: 999 }]
      }
    },
    page: {
      offset: 0,
      limit: 200,
      totalRows: 999,
      columnIds: schema.map((column) => column.id),
      rows: [
        dataRow("r:10", 0, stringCell("Berlin"), numberCell(12), stringCell("x")),
        dataRow("r:11", 1, stringCell("Milan"), numberCell(10), nullCell()),
        dataRow("r:12", 2, stringCell("Paris"), nullCell(), stringCell("x")),
        dataRow("r:13", 3, stringCell("Berlin"), numberCell(8), nanCell())
      ]
    },
    summaries: []
  };
}

function dataRow(id: string, rowNumber: number, ...values: CellValue[]) {
  return { id, rowNumber, values };
}

function stringCell(value: string): CellValue {
  return { kind: "string", raw: value, display: value, isNull: false, isNaN: false };
}

function numberCell(value: number): CellValue {
  return { kind: "number", raw: value, display: String(value), isNull: false, isNaN: false };
}

function nullCell(): CellValue {
  return { kind: "null", raw: null, display: "", isNull: true, isNaN: false };
}

function nanCell(): CellValue {
  return { kind: "nan", raw: null, display: "NaN", isNull: false, isNaN: true };
}

function readOnlyCapabilities() {
  return {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  };
}
