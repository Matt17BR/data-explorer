import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionBoundRequest,
  SessionMetadata,
  SessionOpenedResponse,
  TransformStep
} from "../shared/protocol";

const openRequest = {
  kind: "openSession",
  source: { kind: "file", label: "integrity.csv", path: "/workspace/integrity.csv" },
  backend: "polars",
  mode: "editing",
  pageSize: 100,
  columnOffset: 0,
  columnLimit: 16
} as const;

const columnWindow = { columnOffset: 0, columnLimit: 16 } as const;

const step: TransformStep = {
  id: "integrity-step",
  kind: "dropColumns",
  params: { columns: [{ id: "sales-column", name: "sales" }] }
};

describe("SessionCoordinator response integrity", () => {
  it("rejects kind, action, session, and view-correlation mismatches without publishing state", async () => {
    const update = vi.fn(async () => undefined);
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update,
      keys: vi.fn(() => [])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") {
        return {
          kind: "summary",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          summaries: []
        };
      }
      if (request.kind === "applyDraft") {
        return planResponse("discard", request.sessionId, 7);
      }
      if (request.kind === "getSummary") {
        return {
          kind: "summary",
          revision: request.revision,
          viewRequestId: "different-summary-request",
          summaries: []
        };
      }
      if (request.kind === "getColumnValues") {
        return {
          kind: "error",
          code: "engine_error",
          message: "mis-correlated runtime error",
          recoverable: true,
          sessionId: "different-runtime",
          viewRequestId: request.viewRequestId
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge);
    const baselineSnapshot = coordinator.activeSession();
    const baselineDiagnostics = coordinator.diagnostics();
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const requests: SessionBoundRequest[] = [
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: 0,
        viewRequestId: "wrong-kind-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      },
      {
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: 0,
        viewRequestId: "wrong-summary-correlation",
        filterModel: opened.metadata.filterModel
      },
      {
        kind: "getColumnValues",
        sessionId: opened.metadata.sessionId,
        revision: 0,
        viewRequestId: "wrong-error-session",
        column: "sales",
        filterModel: opened.metadata.filterModel,
        limit: 20
      },
      {
        kind: "applyDraft",
        sessionId: opened.metadata.sessionId,
        revision: 0,
        offset: 0,
        limit: 100,
        ...columnWindow
      }
    ];

    for (const request of requests) {
      await expect(bridge.request(request)).resolves.toMatchObject({
        kind: "error",
        code: "invalid_runtime_response"
      });
      expect(coordinator.activeSession()).toEqual(baselineSnapshot);
      expect(coordinator.diagnostics()).toEqual(baselineDiagnostics);
    }
    expect(update).not.toHaveBeenCalled();
    expect(activeChanges).not.toHaveBeenCalled();
  });

  it("returns stale errors for summaries, values, and statistics from superseded logical views", async () => {
    const pendingSummary = deferred<OpenWranglerResponse>();
    const pendingValues = deferred<OpenWranglerResponse>();
    const pendingStats = deferred<OpenWranglerResponse>();
    const dispatched: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        dispatched.push(request.kind);
        return pendingSummary.promise;
      }
      if (request.kind === "getColumnValues") {
        dispatched.push(request.kind);
        return pendingValues.promise;
      }
      if (request.kind === "getDatasetStats") {
        dispatched.push(request.kind);
        return pendingStats.promise;
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge);
    const base = {
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      filterModel: opened.metadata.filterModel
    };

    bridge.setViewContext?.(base.sessionId, "summary-view");
    const summary = bridge.request(
      {
        kind: "getSummary",
        ...base,
        viewRequestId: "stale-summary"
      },
      { viewContextId: "summary-view" }
    );
    await vi.waitFor(() => expect(dispatched).toEqual(["getSummary"]));
    bridge.setViewContext?.(base.sessionId, "after-summary-view");
    pendingSummary.resolve({ kind: "summary", revision: 0, viewRequestId: "stale-summary", summaries: [] });
    await expect(summary).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "stale-summary"
    });

    bridge.setViewContext?.(base.sessionId, "values-view");
    const values = bridge.request(
      {
        kind: "getColumnValues",
        ...base,
        viewRequestId: "stale-values",
        column: "sales",
        limit: 20
      },
      { viewContextId: "values-view" }
    );
    await vi.waitFor(() => expect(dispatched).toEqual(["getSummary", "getColumnValues"]));
    bridge.setViewContext?.(base.sessionId, "after-values-view");
    pendingValues.resolve({
      kind: "columnValues",
      revision: 0,
      viewRequestId: "stale-values",
      column: "sales",
      values: [],
      hasMore: false
    });
    await expect(values).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "stale-values"
    });

    bridge.setViewContext?.(base.sessionId, "stats-view");
    const stats = bridge.request(
      {
        kind: "getDatasetStats",
        ...base,
        viewRequestId: "stale-stats"
      },
      { viewContextId: "stats-view" }
    );
    await vi.waitFor(() => expect(dispatched).toEqual(["getSummary", "getColumnValues", "getDatasetStats"]));
    bridge.setViewContext?.(base.sessionId, "after-stats-view");
    pendingStats.resolve({
      kind: "datasetStats",
      revision: 0,
      viewRequestId: "stale-stats",
      stats: { missingCells: 3, missingRows: 2, duplicateRows: 1, missingValuesByColumn: [] }
    });
    await expect(stats).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "stale-stats"
    });
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
  });
});

describe("SessionCoordinator recovery boundaries", () => {
  it.each(["previewStep", "applyDraft", "exportData"] as const)(
    "does not replay or reissue an ambiguous %s transport failure",
    async (kind) => {
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return openedResponse();
        if (request.kind === kind) throw new Error(`${kind} transport failed after dispatch`);
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      });
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge({ request: delegateRequest });
      const opened = await open(bridge);
      const request = mutationOrExportRequest(kind, opened.metadata);

      await expect(bridge.request(request)).rejects.toThrow(`${kind} transport failed after dispatch`);

      expect(delegateRequest.mock.calls.map(([call]) => call.kind)).toEqual(["openSession", kind]);
      expect(coordinator.diagnostics()).toMatchObject({
        activeSessionId: opened.metadata.sessionId,
        sessionCount: 1,
        sessions: [{ runtimeId: "runtime-session", publicRevision: 0, runtimeRevision: 0 }]
      });
    }
  );

  it("restores the last confirmed runtime state before work following an ambiguous mutation", async () => {
    let openCount = 0;
    let previewCount = 0;
    const requests: OpenWranglerRequest[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      requests.push(request);
      if (request.kind === "openSession") {
        openCount += 1;
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "previewStep") {
        previewCount += 1;
        throw new Error("preview result was lost after dispatch");
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge);

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        step,
        offset: 0,
        limit: 100,
        ...columnWindow
      })
    ).rejects.toThrow("preview result was lost after dispatch");
    expect(previewCount).toBe(1);
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "previewStep"]);

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "after-ambiguous-preview",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "after-ambiguous-preview" });

    expect(openCount).toBe(2);
    expect(previewCount).toBe(1);
    expect(
      requests.filter((request) => request.kind === "getPage" && request.viewRequestId.startsWith("restore:"))
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.kind === "getPage" && request.viewRequestId === "after-ambiguous-preview")
    ).toHaveLength(1);
    await vi.waitFor(() =>
      expect(requests).toContainEqual({ kind: "closeSession", sessionId: "runtime-1", revision: 0 })
    );
    expect(coordinator.diagnostics().sessions[0]).toMatchObject({ runtimeId: "runtime-2", runtimeRevision: 0 });
  });

  it("replays and reissues an idempotent page after a transport failure", async () => {
    let openCount = 0;
    let livePageAttempts = 0;
    const requests: OpenWranglerRequest[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      requests.push(request);
      if (request.kind === "openSession") {
        openCount += 1;
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "getPage") {
        if (request.viewRequestId === "recoverable-page") {
          livePageAttempts += 1;
          if (livePageAttempts === 1) throw new Error("page transport failed");
        }
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "closeSession") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge);

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "recoverable-page",
        offset: 100,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "recoverable-page" });

    expect(requests.filter((request) => request.kind === "openSession")).toHaveLength(2);
    expect(
      requests.filter((request) => request.kind === "getPage" && request.viewRequestId === "recoverable-page")
    ).toHaveLength(2);
    expect(
      requests.filter((request) => request.kind === "getPage" && request.viewRequestId.startsWith("restore:"))
    ).toHaveLength(1);
    expect(requests).toContainEqual({ kind: "closeSession", sessionId: "runtime-1", revision: 0 });
    expect(coordinator.diagnostics().sessions[0]).toMatchObject({
      runtimeId: "runtime-2",
      publicRevision: 0,
      runtimeRevision: 0
    });
  });
});

describe("SessionCoordinator cleanup diagnostics", () => {
  it.each([
    {
      name: "wrong-session acknowledgement with no delegate reporter",
      firstClose: { kind: "sessionClosed", sessionId: "different-runtime" } as const,
      reporter: "missing" as const,
      expectedDetail: "runtime acknowledged session different-runtime instead of runtime-session"
    },
    {
      name: "cancelled close with a throwing delegate reporter",
      firstClose: { kind: "cancelled", targetRequestId: "cancelled-close" } as const,
      reporter: "throwing" as const,
      expectedDetail: "close was cancelled (cancelled-close)"
    }
  ])(
    "retries $name and routes the diagnostic through the fallback sink",
    async ({ firstClose, reporter, expectedDetail }) => {
      let closeCount = 0;
      const sink = vi.fn();
      const reportDiagnostic = vi.fn(() => {
        throw new Error("delegate diagnostic surface failed");
      });
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return openedResponse();
        if (request.kind === "closeSession") {
          closeCount += 1;
          return closeCount === 1 ? firstClose : { kind: "sessionClosed", sessionId: request.sessionId };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      });
      const delegate: OpenWranglerBridge = {
        request: delegateRequest,
        ...(reporter === "throwing" ? { reportDiagnostic } : {})
      };
      const coordinator = new SessionCoordinator(undefined, sink);
      const bridge = coordinator.createBridge(delegate);
      const opened = await open(bridge);

      await expect(
        bridge.request({
          kind: "closeSession",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_close_response" });

      expect(closeCount).toBe(2);
      expect(sink).toHaveBeenCalledWith(expect.stringContaining(expectedDetail));
      if (reporter === "throwing") expect(reportDiagnostic).toHaveBeenCalledOnce();
      else expect(reportDiagnostic).not.toHaveBeenCalled();
      expect(coordinator.diagnostics()).toMatchObject({ activeSessionId: undefined, sessionCount: 0, sessions: [] });
    }
  );

  it("contains a throwing fallback sink while retrying non-authoritative cleanup", async () => {
    let closeCount = 0;
    const sink = vi.fn(() => {
      throw new Error("fallback sink failed");
    });
    const reportDiagnostic = vi.fn(() => {
      throw new Error("delegate reporter failed");
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") {
        closeCount += 1;
        return closeCount === 1
          ? { kind: "cancelled", targetRequestId: "cancelled-close" }
          : { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(undefined, sink);
    const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
    const opened = await open(bridge);

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_close_response" });
    expect(closeCount).toBe(2);
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledOnce();
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });
});

async function open(bridge: OpenWranglerBridge): Promise<SessionOpenedResponse> {
  const response = await bridge.request(openRequest);
  if (response.kind !== "sessionOpened") throw new Error("Expected the coordinator fixture to open.");
  return response;
}

function openedResponse(sessionId = "runtime-session"): SessionOpenedResponse {
  const metadata = metadataFor(sessionId);
  return {
    kind: "sessionOpened",
    metadata,
    page: { offset: 0, limit: openRequest.pageSize, totalRows: 1, columnIds: ["sales-column"], rows: [] },
    summaries: []
  };
}

function metadataFor(sessionId: string, revision = 0): SessionMetadata {
  return {
    protocolVersion: 2,
    sessionId,
    revision,
    backend: "polars",
    mode: "editing",
    source: openRequest.source,
    capabilities: {
      editable: true,
      lazy: true,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 1, columns: 1 },
    filteredShape: { rows: 1, columns: 1 },
    schema: [
      {
        id: "sales-column",
        name: "sales",
        position: 0,
        rawType: "Int64",
        type: "integer",
        nullable: false
      }
    ],
    filterModel: { filters: [], sort: [] },
    steps: []
  };
}

function pageResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  runtimeSessionId: string
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata: {
      ...metadataFor(runtimeSessionId, request.revision),
      filterModel: request.filterModel
    },
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: 1,
      columnIds: metadataFor(runtimeSessionId)
        .schema.slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    }
  };
}

function planResponse(
  action: "apply" | "discard" | "undo",
  runtimeSessionId: string,
  revision: number
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  return {
    kind: "planUpdated",
    action,
    revision,
    metadata: metadataFor(runtimeSessionId, revision),
    page: { offset: 0, limit: 100, totalRows: 1, columnIds: ["sales-column"], rows: [] },
    code: "# updated"
  };
}

function mutationOrExportRequest(
  kind: "previewStep" | "applyDraft" | "exportData",
  metadata: SessionMetadata
): SessionBoundRequest {
  const base = { sessionId: metadata.sessionId, revision: metadata.revision };
  switch (kind) {
    case "previewStep":
      return { kind, ...base, step, offset: 0, limit: 100, ...columnWindow };
    case "applyDraft":
      return { kind, ...base, offset: 0, limit: 100, ...columnWindow };
    case "exportData":
      return { kind, ...base, path: "/workspace/clean.csv", format: "csv" };
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
