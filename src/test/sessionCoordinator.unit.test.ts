import { describe, expect, it, vi } from "vitest";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse
} from "../shared/protocol";

const openRequest = {
  kind: "openSession",
  source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
  backend: "polars",
  mode: "editing",
  pageSize: 100
} as const;

describe("SessionCoordinator", () => {
  it("retires a session after terminal close failure without replaying or reviving it", async () => {
    const onIdle = vi.fn();
    let finishClose!: (response: OpenWranglerResponse) => void;
    const closeResponse = new Promise<OpenWranglerResponse>((resolve) => {
      finishClose = resolve;
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return closeResponse;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const delegate: OpenWranglerBridge = { request: delegateRequest, onIdle };
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(delegate);

    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const publicSessionId = opened.metadata.sessionId;

    const closePromise = bridge.request({
      kind: "closeSession",
      sessionId: publicSessionId,
      revision: opened.metadata.revision
    });
    const duringClose = await bridge.request({
      kind: "getPage",
      sessionId: publicSessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 1,
      filterModel: { filters: [], sort: [] }
    });
    expect(duringClose).toMatchObject({ kind: "error", code: "session_closing" });
    finishClose({
      kind: "error",
      code: "engine_error",
      message: "Engine close failed: close exploded",
      recoverable: false,
      sessionId: "runtime-session"
    });
    const close = await closePromise;

    expect(close).toMatchObject({ kind: "error", code: "engine_error", message: expect.stringContaining("close") });
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);

    const afterClose = await bridge.request({
      kind: "getPage",
      sessionId: publicSessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 1,
      filterModel: { filters: [], sort: [] }
    });
    expect(afterClose).toMatchObject({ kind: "error", code: "unknown_session" });
    expect(delegateRequest).toHaveBeenCalledTimes(2);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("awaits runtime close before shutdown resolves", async () => {
    const onIdle = vi.fn();
    let finishClose!: (response: OpenWranglerResponse) => void;
    const closeResponse = new Promise<OpenWranglerResponse>((resolve) => {
      finishClose = resolve;
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return closeResponse;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });

    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });

    await vi.waitFor(() => {
      expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
    });
    expect(shutdownSettled).toBe(false);
    expect(coordinator.diagnostics().sessionCount).toBe(1);

    finishClose({ kind: "sessionClosed", sessionId: "runtime-session" });
    await shutdown;

    expect(shutdownSettled).toBe(true);
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown close transport failure as terminal without replay", async () => {
    const onIdle = vi.fn();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") throw new Error("close transport exploded");
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      })
    ).rejects.toThrow("close transport exploded");

    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest).toHaveBeenCalledTimes(2);
  });

  it("waits for a delayed open during shutdown and closes its late runtime session", async () => {
    const onIdle = vi.fn();
    let finishOpen!: (response: OpenWranglerResponse) => void;
    const openResponse = new Promise<OpenWranglerResponse>((resolve) => {
      finishOpen = resolve;
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openResponse;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const pendingOpen = bridge.request(openRequest);
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shutdownSettled).toBe(false);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(0);

    finishOpen(openedResponse());
    const openResult = await pendingOpen;
    await shutdown;

    expect(openResult).toMatchObject({ kind: "error", code: "coordinator_disposed" });
    const closeRequests = delegateRequest.mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === "closeSession");
    expect(closeRequests).toEqual([{ kind: "closeSession", sessionId: "runtime-session", revision: 0 }]);
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(activeChanges).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest).toHaveBeenCalledTimes(2);
  });
});

function openedResponse(): SessionOpenedResponse {
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId: "runtime-session",
    revision: 0,
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
    shape: { rows: 0, columns: 0 },
    filteredShape: { rows: 0, columns: 0 },
    schema: [],
    filterModel: { filters: [], sort: [] },
    steps: []
  };
  return {
    kind: "sessionOpened",
    metadata,
    page: { offset: 0, limit: openRequest.pageSize, totalRows: 0, rows: [] },
    summaries: []
  };
}
