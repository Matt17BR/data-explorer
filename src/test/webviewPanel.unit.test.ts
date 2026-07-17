import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { workspace } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import { OpenWranglerPanel } from "../extension/webviewPanel";
import type {
  ColumnSummary,
  GridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse
} from "../shared/protocol";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 1 },
  filteredShape: { rows: 2, columns: 1 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [{ id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false }]
};

const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 2,
  columnIds: ["c:0"],
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [{ kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false }]
    }
  ]
};

const summary: ColumnSummary = {
  column: "city",
  type: "string",
  rawType: "String",
  totalCount: 2,
  nullCount: 0,
  nanCount: 0,
  distinctCount: 2,
  topValues: [{ value: "Berlin", count: 1 }]
};

const openedResponse: SessionOpenedResponse = { kind: "sessionOpened", metadata, page, summaries: [] };
const liveHarnesses: Array<{ dispose(): void }> = [];

describe("OpenWranglerPanel retained view state", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    while (liveHarnesses.length) liveHarnesses.pop()?.dispose();
  });

  it("loads the production webview as an ES module under a restrictive nonce CSP", async () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    const script = harness.html.match(/<script type="module" nonce="([A-Za-z0-9]+)" src="([^"]+)"><\/script>/u);
    expect(script).not.toBeNull();
    const nonce = script?.[1];
    expect(harness.html).toContain(`script-src mock-webview 'nonce-${nonce}';`);
    expect(harness.html).toContain("font-src mock-webview;");
    expect(harness.html).not.toContain("script-src 'unsafe-inline'");
    expect(script?.[2].replaceAll("\\", "/")).toBe("file:///extension/media/webview.js");
    expect(harness.html).toContain('data-fetch-column-block-size="16"');
  });

  it("clamps an out-of-range horizontal block setting before exposing or requesting it", async () => {
    vi.spyOn(workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: (key: string, fallback?: unknown): unknown => (key === "fetchColumnBlockSize" ? 999 : fallback)
        }) as vscode.WorkspaceConfiguration
    );
    const request = vi.fn(async (_request: OpenWranglerRequest): Promise<OpenWranglerResponse> => openedResponse);
    const harness = createPanelHarness({ request }, { delegateOpen: true });

    expect(harness.html).toContain('data-fetch-column-block-size="256"');
    expect(request).not.toHaveBeenCalled();
    await harness.open();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      kind: "openSession",
      columnOffset: 0,
      columnLimit: 256
    });
  });

  it("rejects a stale profile from an older opaque view even when metadata and filters match", async () => {
    let resolveStaleSummary: ((response: OpenWranglerResponse) => void) | undefined;
    let resolveStaleStats: ((response: OpenWranglerResponse) => void) | undefined;
    const bridge: OpenWranglerBridge = {
      request: vi.fn((request: OpenWranglerRequest) => {
        if (request.kind === "getSummary") {
          return new Promise<OpenWranglerResponse>((resolve) => {
            resolveStaleSummary = resolve;
          });
        }
        if (request.kind === "getDatasetStats") {
          return new Promise<OpenWranglerResponse>((resolve) => {
            resolveStaleStats = resolve;
          });
        }
        if (request.kind === "getPage") {
          return Promise.resolve<OpenWranglerResponse>({
            kind: "page",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            metadata,
            page
          });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }),
      setViewContext: vi.fn()
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "setViewContext", viewContextId: "view-a" });
    const stale = harness.send({
      kind: "runtimeRequest",
      viewContextId: "view-a",
      request: {
        kind: "getSummary",
        viewRequestId: "summary-a",
        filterModel: metadata.filterModel,
        columns: ["city"]
      }
    });
    const staleStats = harness.send({
      kind: "runtimeRequest",
      viewContextId: "view-a",
      request: {
        kind: "getDatasetStats",
        viewRequestId: "stats-a",
        filterModel: metadata.filterModel
      }
    });

    await harness.send(pageMessage("page-b", "view-b"));
    await harness.send({ kind: "setViewContext", viewContextId: "view-b" });
    await harness.send(pageMessage("page-a-again", "view-a-again"));
    await harness.send({ kind: "setViewContext", viewContextId: "view-a-again" });
    resolveStaleSummary?.({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: "summary-a",
      summaries: [summary]
    });
    resolveStaleStats?.({
      kind: "datasetStats",
      revision: metadata.revision,
      viewRequestId: "stats-a",
      stats: { missingCells: 1, missingRows: 1, duplicateRows: 0, missingValuesByColumn: [] }
    });
    await Promise.all([stale, staleStats]);

    await harness.send({ kind: "ready" });
    const retained = harness.posted.at(-1) as SessionOpenedResponse;
    expect(retained.kind).toBe("sessionOpened");
    expect(retained.summaries).toEqual([]);
    expect(retained.metadata.stats).toBeUndefined();
    expect(bridge.setViewContext).toHaveBeenLastCalledWith("session", "view-a-again");
  });

  it("retains profiles only while subsequent pages stay in the same opaque view", async () => {
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "getSummary") {
          return {
            kind: "summary",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            summaries: [summary]
          };
        }
        if (request.kind === "getDatasetStats") {
          return {
            kind: "datasetStats",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
          };
        }
        if (request.kind === "getPage") {
          return {
            kind: "page",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            metadata,
            page: { ...page, offset: 200 }
          };
        }
        throw new Error(`Unexpected request ${request.kind}`);
      })
    };
    const harness = createPanelHarness(bridge);
    await harness.open();
    await harness.send({ kind: "setViewContext", viewContextId: "current-view" });
    await harness.send({
      kind: "runtimeRequest",
      viewContextId: "current-view",
      request: {
        kind: "getSummary",
        viewRequestId: "current-summary",
        filterModel: metadata.filterModel,
        columns: ["city"]
      }
    });
    await harness.send({
      kind: "runtimeRequest",
      viewContextId: "current-view",
      request: {
        kind: "getDatasetStats",
        viewRequestId: "current-stats",
        filterModel: metadata.filterModel
      }
    });
    await harness.send(pageMessage("same-view-next-page", "current-view"));
    await harness.send({ kind: "ready" });

    const retained = harness.posted.at(-1) as SessionOpenedResponse;
    expect(retained.summaries).toEqual([summary]);
    expect(retained.metadata.stats?.missingCells).toBe(0);
    expect(retained.page.offset).toBe(200);
  });

  it("forwards only validated queued-view cancellation messages", async () => {
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      cancelViewRequests: vi.fn()
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "cancelViewRequests", viewRequestIds: ["summary-a", "stats-a"] });
    await harness.send({ kind: "cancelViewRequests", viewRequestIds: ["", 3] });

    expect(bridge.cancelViewRequests).toHaveBeenCalledTimes(1);
    expect(bridge.cancelViewRequests).toHaveBeenCalledWith("session", ["summary-a", "stats-a"]);
  });

  it("round-trips only validated host-owned grid presentation state", async () => {
    const state = {
      columnWidths: { "c:0": 260 },
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 1, scrollLeft: 44 }
    };
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      getViewState: vi.fn(() => state),
      updateViewState: vi.fn(async () => undefined)
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "ready" });
    expect(harness.posted.at(-1)).toEqual({ kind: "viewState", state });

    await harness.send({ kind: "updateViewState", state });
    await harness.send({
      kind: "updateViewState",
      state: { ...state, columnWidths: { "c:0": 20 } }
    });
    await harness.send({
      kind: "updateViewState",
      state: { ...state, viewport: { firstVisibleRow: Number.NaN, scrollLeft: 0 } }
    });

    expect(bridge.updateViewState).toHaveBeenCalledOnce();
    expect(bridge.updateViewState).toHaveBeenCalledWith("session", state);
  });

  it("forwards only validated applied-step inspection and host-clear messages with correlation", async () => {
    const inspectionPage = {
      ...page,
      offset: 200,
      rows: [{ ...page.rows[0], id: "r:200", rowNumber: 200 }]
    };
    const inspection: OpenWranglerResponse = {
      kind: "stepInspection",
      revision: 0,
      stepId: "round-sales",
      stepIndex: 0,
      inputPage: inspectionPage,
      outputPage: inspectionPage,
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
      code: "# selected prefix"
    };
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => inspection),
      clearStepInspection: vi.fn()
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({
      kind: "runtimeRequest",
      request: {
        kind: "inspectStep",
        stepId: "round-sales",
        offset: 200,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      }
    });
    await harness.send({ kind: "clearStepInspection" });
    await harness.send({ kind: "clearStepInspection", unexpected: true });
    await harness.send({
      kind: "runtimeRequest",
      request: { kind: "inspectStep", stepId: "", offset: 0, limit: 200, columnOffset: 0, columnLimit: 16 }
    });

    expect(bridge.request).toHaveBeenCalledOnce();
    expect(bridge.request).toHaveBeenCalledWith(
      {
        kind: "inspectStep",
        sessionId: "session",
        revision: 0,
        stepId: "round-sales",
        offset: 200,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      },
      undefined
    );
    expect(bridge.clearStepInspection).toHaveBeenCalledOnce();
    expect(bridge.clearStepInspection).toHaveBeenCalledWith("session");
    expect(harness.posted).toContainEqual({
      kind: "stepInspectionResult",
      stepId: "round-sales",
      offset: 200,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16,
      response: inspection
    });
  });

  it("clears retained and recreated inspection state when the active panel changes", async () => {
    const firstBridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      clearStepInspection: vi.fn(),
      setActiveSession: vi.fn()
    };
    const secondResponse: SessionOpenedResponse = {
      ...openedResponse,
      metadata: { ...metadata, sessionId: "second-session" }
    };
    const secondBridge: OpenWranglerBridge = {
      request: vi.fn(async () => secondResponse),
      clearStepInspection: vi.fn(),
      setActiveSession: vi.fn()
    };
    const first = createPanelHarness(firstBridge);
    await first.open();
    first.posted.length = 0;
    const second = createPanelHarness(secondBridge, { openResponse: secondResponse });
    await second.open();

    expect(first.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: false });
    expect(second.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: true });
    expect(secondBridge.setActiveSession).toHaveBeenLastCalledWith("second-session");

    first.posted.length = 0;
    second.posted.length = 0;
    first.activate();

    expect(second.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: false });
    expect(first.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: true });
    expect(firstBridge.setActiveSession).toHaveBeenLastCalledWith("session");

    vi.mocked(firstBridge.clearStepInspection!).mockClear();
    first.posted.length = 0;
    await first.send({ kind: "ready" });

    expect(firstBridge.clearStepInspection).toHaveBeenCalledWith("session");
    expect(first.posted[0]).toEqual({ kind: "stepInspectionCleared", resumeProfiling: false });
    expect(first.posted).toContainEqual(openedResponse);
  });

  it("rejects malformed or host-owned runtime messages before forwarding", async () => {
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse)
    };
    const harness = createPanelHarness(bridge);
    await harness.open();
    harness.posted.length = 0;

    await harness.send({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step: { id: "bad", kind: "renameColumn", params: { columns: ["city"] } },
        offset: 0,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      }
    });
    await harness.send({
      kind: "runtimeRequest",
      request: { kind: "exportData", path: "", format: "csv" }
    });
    await harness.send({
      kind: "runtimeRequest",
      request: { kind: "closeSession", force: true }
    });
    await harness.send({ kind: "ready", unexpected: true });

    expect(bridge.request).not.toHaveBeenCalled();
    expect(harness.posted).toEqual([]);
  });

  it("clears the active UI selection synchronously while runtime cleanup remains asynchronous", async () => {
    let resolveClose: ((response: OpenWranglerResponse) => void) | undefined;
    const bridge: OpenWranglerBridge = {
      request: vi.fn((request: OpenWranglerRequest) => {
        if (request.kind === "openSession") return Promise.resolve(openedResponse);
        if (request.kind === "closeSession") {
          return new Promise<OpenWranglerResponse>((resolve) => {
            resolveClose = resolve;
          });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }),
      setActiveSession: vi.fn()
    };
    const harness = createPanelHarness(bridge, { delegateOpen: true });
    await harness.open();

    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      {
        kind: "openSession",
        source: metadata.source,
        backend: "polars",
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16,
        mode: "editing"
      },
      undefined
    );

    harness.dispose();

    expect(bridge.setActiveSession).toHaveBeenCalledWith(undefined);
    expect(bridge.request).toHaveBeenCalledWith({
      kind: "closeSession",
      sessionId: "session",
      revision: 0
    });
    harness.dispose();
    expect(vi.mocked(bridge.request).mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
    resolveClose?.({ kind: "sessionClosed", sessionId: "session" });
  });

  it("disposes the active panel through the same lifecycle used by editor acceptance", async () => {
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return openedResponse;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { delegateOpen: true });
    await harness.open();

    await expect(OpenWranglerPanel.disposePanelForSession("other-session")).resolves.toBeUndefined();
    await expect(OpenWranglerPanel.disposePanelForSession("session")).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "session"
    });
    await expect(OpenWranglerPanel.disposePanelForSession("session")).resolves.toBeUndefined();
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(1);
  });

  it("closes exactly once when disposal wins the open-session race", async () => {
    let resolveOpen: ((response: OpenWranglerResponse) => void) | undefined;
    const request = vi.fn((request: OpenWranglerRequest) => {
      if (request.kind === "openSession") {
        return new Promise<OpenWranglerResponse>((resolve) => {
          resolveOpen = resolve;
        });
      }
      if (request.kind === "closeSession") {
        return Promise.resolve<OpenWranglerResponse>({ kind: "sessionClosed", sessionId: request.sessionId });
      }
      throw new Error(`Unexpected request ${request.kind}`);
    });
    const harness = createPanelHarness({ request }, { delegateOpen: true });

    const opening = harness.open();
    harness.dispose();
    resolveOpen?.(openedResponse);
    await opening;
    await harness.open();

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toEqual([
      [
        {
          kind: "closeSession",
          sessionId: "session",
          revision: 0
        }
      ]
    ]);
    expect(harness.posted).not.toContainEqual(openedResponse);
  });
});

function pageMessage(viewRequestId: string, viewContextId: string) {
  return {
    kind: "runtimeRequest",
    viewContextId,
    request: {
      kind: "getPage",
      viewRequestId,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: metadata.filterModel
    }
  };
}

function createPanelHarness(
  bridge: OpenWranglerBridge,
  options?: { delegateOpen?: boolean; openResponse?: SessionOpenedResponse }
): {
  posted: unknown[];
  readonly html: string;
  open(): Promise<void>;
  send(message: unknown): Promise<void>;
  activate(): void;
  dispose(): void;
} {
  let listener: ((message: unknown) => Promise<void>) | undefined;
  let disposeListener: (() => void) | undefined;
  let viewStateListener: ((event: { webviewPanel: { active: boolean } }) => void) | undefined;
  const posted: unknown[] = [];
  const webview = {
    options: {},
    html: "",
    cspSource: "mock-webview",
    asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: (next: (message: unknown) => Promise<void>) => {
      listener = next;
      return { dispose: () => undefined };
    },
    postMessage: async (message: unknown) => {
      posted.push(message);
      return true;
    }
  };
  const panel = {
    webview,
    viewColumn: 1,
    reveal: () => undefined,
    dispose: () => disposeListener?.(),
    onDidDispose: (listener: () => void) => {
      disposeListener = listener;
      return { dispose: () => undefined };
    },
    onDidChangeViewState: (next: (event: { webviewPanel: { active: boolean } }) => void) => {
      viewStateListener = next;
      return { dispose: () => undefined };
    }
  };
  const context = { extensionPath: "/extension" };
  const panelBridge: OpenWranglerBridge = options?.delegateOpen
    ? bridge
    : {
        ...bridge,
        request: (request, requestOptions) => {
          if (request.kind === "openSession") return Promise.resolve(options?.openResponse ?? openedResponse);
          if (request.kind === "closeSession") {
            return Promise.resolve({ kind: "sessionClosed", sessionId: request.sessionId });
          }
          return bridge.request(request, requestOptions);
        }
      };
  const instance = new OpenWranglerPanel(
    panel as unknown as vscode.WebviewPanel,
    context as unknown as vscode.ExtensionContext,
    panelBridge,
    metadata.source,
    metadata.backend,
    false
  );
  const harness = {
    posted,
    get html() {
      return webview.html;
    },
    open: () => instance.open(),
    async send(message: unknown) {
      await instance.open();
      if (!listener) throw new Error("Panel message listener was not registered.");
      await listener(message);
    },
    activate() {
      viewStateListener?.({ webviewPanel: { active: true } });
    },
    dispose() {
      disposeListener?.();
    }
  };
  liveHarnesses.push(harness);
  return harness;
}
