import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { persistedSessionState, persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import type { FilterModel } from "../shared/filterModel";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse,
  TransformStep
} from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";

const openRequest = {
  kind: "openSession",
  source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
  backend: "polars",
  mode: "editing",
  pageSize: 100,
  columnOffset: 0,
  columnLimit: 16
} as const;

const columnWindow = { columnOffset: 0, columnLimit: 16 } as const;

const inspectionStep: TransformStep = {
  id: "round-sales",
  kind: "roundNumber",
  params: { column: { id: "c:sales", name: "sales" }, decimals: 0 }
};

describe("SessionCoordinator", () => {
  it("observes asynchronous shutdown rejection from its synchronous disposable fallback", () => {
    const coordinator = new SessionCoordinator();
    const observeRejection = vi.fn((_onRejected: (reason: unknown) => unknown) => Promise.resolve());
    const shutdown = vi
      .spyOn(coordinator, "shutdown")
      .mockReturnValue({ catch: observeRejection } as unknown as Promise<void>);

    coordinator.dispose();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(observeRejection).toHaveBeenCalledOnce();
    expect(observeRejection.mock.calls[0][0]).toBeTypeOf("function");
  });

  it("keeps bounded notebook-output snapshots ephemeral and ignores stale persisted state", async () => {
    const source = { kind: "notebookOutput" as const, label: "Saved sales preview" };
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      source,
      mode: "viewing",
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 0, columns: 1 },
      filteredShape: { rows: 0, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
      steps: []
    };
    runtimeOpened.page = { ...runtimeOpened.page, columnIds: ["c:value"] };
    const stored = {
      [persistenceKey(source, "polars")]: persistedSessionState(
        { ...runtimeOpened.metadata, steps: [inspectionStep] },
        { columnWidths: { "c:value": 999 }, viewport: { firstVisibleRow: 0, scrollLeft: 123 } }
      )
    };
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected snapshot delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const opened = await bridge.request({ ...openRequest, source, mode: "viewing" });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the notebook snapshot to open.");
    expect(opened.metadata.steps).toEqual([]);
    expect(workspaceState.get).not.toHaveBeenCalled();

    await bridge.updateViewState?.(opened.metadata.sessionId, {
      selectedColumnId: "c:value",
      columnWidths: { "c:value": 240 },
      viewport: { firstVisibleRow: 0, scrollLeft: 40 }
    });

    expect(coordinator.activeSession()?.viewState).toMatchObject({
      selectedColumnId: "c:value",
      columnWidths: { "c:value": 240 },
      viewport: { scrollLeft: 40 }
    });
    expect(workspaceState.get).not.toHaveBeenCalled();
    expect(workspaceState.update).not.toHaveBeenCalled();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);

    await bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("retains notebook provenance only in host session state", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/origin.ipynb"),
      isClosed: false
    } as NotebookDocument;
    setOpenNotebookDocuments(notebook);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(
      { request: vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse()) },
      notebook
    );

    const opened = await bridge.request({
      ...openRequest,
      source: {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: notebook.uri.toString()
      }
    });

    expect(opened.kind).toBe("sessionOpened");
    expect(coordinator.activeNotebookDocument()).toBe(notebook);
    expect(coordinator.activeSession()).not.toHaveProperty("notebookDocument");
    setOpenNotebookDocuments();
  });

  it("rejects mismatched notebook provenance before opening a runtime session", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/origin.ipynb"),
      isClosed: false
    } as NotebookDocument;
    setOpenNotebookDocuments(notebook);
    const delegateRequest = vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse());
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);

    const opened = await bridge.request({
      ...openRequest,
      source: {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: "file:///workspace/replacement.ipynb"
      }
    });

    expect(opened).toMatchObject({ kind: "error", code: "invalid_notebook_origin" });
    expect(delegateRequest).not.toHaveBeenCalled();
    expect(coordinator.activeNotebookDocument()).toBeUndefined();
    expect(coordinator.diagnostics().sessionCount).toBe(0);
    setOpenNotebookDocuments();
  });

  it("pins public source metadata to the immutable open request across runtime responses", async () => {
    const runtimeOpened = openedResponse();
    const substitutedSource = {
      kind: "file" as const,
      label: "different.csv",
      path: "/workspace/different.csv"
    };
    runtimeOpened.metadata = { ...runtimeOpened.metadata, source: substitutedSource };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getPage") {
        return {
          ...pageResponse(request),
          metadata: {
            ...pageResponse(request).metadata,
            source: substitutedSource,
            sessionId: runtimeOpened.metadata.sessionId
          }
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const opened = await bridge.request(openRequest);
    expect(opened).toMatchObject({ kind: "sessionOpened", metadata: { source: openRequest.source } });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    expect(coordinator.activeSession()?.metadata.source).toEqual(openRequest.source);

    const page = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "immutable-source-page",
      offset: 0,
      limit: 10,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    expect(page).toMatchObject({ kind: "page", metadata: { source: openRequest.source } });
    expect(coordinator.activeSession()?.metadata.source).toEqual(openRequest.source);
  });

  it("publishes one bounded applied-step inspection and restores full-plan code when cleared", async () => {
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = { ...runtimeOpened.metadata, steps: [inspectionStep] };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "inspectStep") return stepInspectionResponse(request, 0, "# selected prefix");
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const response = await bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      ...columnWindow
    });

    expect(response).toMatchObject({ kind: "stepInspection", stepId: inspectionStep.id, revision: 0 });
    expect(coordinator.activeSession()).toMatchObject({
      code: "# selected prefix",
      stepInspection: { stepId: inspectionStep.id, outputPage: { limit: 25 } }
    });
    expect(coordinator.activeSession()?.metadata).toEqual(opened.metadata);

    coordinator.clearActiveStepInspection();
    expect(coordinator.activeSession()?.stepInspection).toBeUndefined();
    expect(coordinator.activeSession()?.code).toBe("");
  });

  it("recovers and retries an applied-step inspection without changing the source or viewing state", async () => {
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    const schema: SessionMetadata["schema"] = [
      { id: "c:sales", name: "sales", position: 0, rawType: "Int64", type: "integer", nullable: false }
    ];
    const runtimeOpened = openedResponse("runtime-1");
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      revision: 2,
      shape: { rows: 500, columns: 1 },
      filteredShape: { rows: 500, columns: 1 },
      schema,
      filterModel,
      steps: [inspectionStep]
    };
    runtimeOpened.page = { ...runtimeOpened.page, totalRows: 500, columnIds: ["c:sales"] };
    const recoveryOpened = openedResponse("runtime-2");
    recoveryOpened.metadata = {
      ...recoveryOpened.metadata,
      shape: { rows: 500, columns: 1 },
      filteredShape: { rows: 500, columns: 1 },
      schema
    };
    recoveryOpened.page = { ...recoveryOpened.page, totalRows: 500, columnIds: ["c:sales"] };

    const executionOrder: string[] = [];
    let openCount = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openCount === 1 ? runtimeOpened : recoveryOpened;
      }
      if (request.kind === "inspectStep") {
        executionOrder.push(`inspect-${request.sessionId}-${request.revision}`);
        if (request.sessionId === "runtime-1") throw new Error("inspection transport failed");
        return stepInspectionResponse(request, 0, "# recovered prefix");
      }
      if (request.kind === "previewStep") {
        executionOrder.push(`preview-${request.sessionId}-${request.revision}`);
        return {
          ...stepPreviewResponse(1, inspectionStep, "runtime-2"),
          metadata: { ...recoveryOpened.metadata, revision: 1, draftStep: inspectionStep },
          page: projectedPage(request, recoveryOpened.metadata)
        };
      }
      if (request.kind === "applyDraft") {
        executionOrder.push(`apply-${request.sessionId}-${request.revision}`);
        return {
          ...planUpdatedResponse(2, [inspectionStep], "runtime-2"),
          metadata: { ...recoveryOpened.metadata, revision: 2, steps: [inspectionStep] },
          page: projectedPage(request, recoveryOpened.metadata)
        };
      }
      if (request.kind === "getPage") {
        executionOrder.push(`restore-${request.sessionId}-${request.revision}-${request.offset}-${request.limit}`);
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata: {
            ...recoveryOpened.metadata,
            revision: request.revision,
            steps: [inspectionStep],
            filterModel: request.filterModel
          },
          page: {
            offset: request.offset,
            limit: request.limit,
            totalRows: 500,
            columnIds: schema
              .slice(request.columnOffset, request.columnOffset + request.columnLimit)
              .map((column) => column.id),
            rows: []
          }
        };
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}-${request.revision}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    await bridge.updateViewState?.(opened.metadata.sessionId, {
      columnWidths: { "c:sales": 260 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });
    const sourceBefore = coordinator.activeSession()?.metadata.source;
    const viewBefore = coordinator.activeSession()?.viewState;

    const response = await bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 25,
      limit: 25,
      ...columnWindow
    });

    expect(response).toMatchObject({
      kind: "stepInspection",
      stepId: inspectionStep.id,
      revision: opened.metadata.revision,
      code: "# recovered prefix"
    });
    expect(coordinator.activeSession()?.metadata.source).toEqual(sourceBefore);
    expect(coordinator.activeSession()?.viewState).toEqual(viewBefore);
    expect(
      delegateRequest.mock.calls.map(([request]) => request).filter((request) => request.kind === "openSession")
    ).toEqual([openRequest, openRequest]);
    const pageProducingRequests = delegateRequest.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          request.kind === "getPage" ||
          request.kind === "previewStep" ||
          request.kind === "applyDraft" ||
          request.kind === "discardDraft" ||
          request.kind === "undoStep" ||
          request.kind === "inspectStep"
      );
    expect(pageProducingRequests.length).toBeGreaterThan(0);
    expect(
      pageProducingRequests.every(
        (request) =>
          request.columnOffset === openRequest.columnOffset && request.columnLimit === openRequest.columnLimit
      )
    ).toBe(true);
    expect(executionOrder).toEqual([
      "open-1",
      "inspect-runtime-1-2",
      "open-2",
      "preview-runtime-2-0",
      "apply-runtime-2-1",
      "restore-runtime-2-2-240-1",
      "close-runtime-1-2",
      "inspect-runtime-2-2"
    ]);
  });

  it("rejects mis-correlated inspection responses without publishing them", async () => {
    const invalidResponses = [
      (request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>) => ({
        ...stepInspectionResponse(request),
        stepId: "different-step"
      }),
      (request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>) => ({
        ...stepInspectionResponse(request),
        revision: request.revision + 1
      }),
      (request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>) => ({
        ...stepInspectionResponse(request),
        outputPage: { ...stepInspectionResponse(request).outputPage, offset: request.offset + 1 }
      }),
      (request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>) => ({
        ...stepInspectionResponse(request),
        stepIndex: 1
      }),
      (request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>) => ({
        ...stepInspectionResponse(request),
        diff: {
          ...stepInspectionResponse(request).diff,
          changedCells: 1,
          cells: [{ rowNumber: 0, columnId: "spoofed", column: "sales", before: null, after: null }]
        }
      })
    ];

    for (const invalid of invalidResponses) {
      const runtimeOpened = openedResponse();
      runtimeOpened.metadata = { ...runtimeOpened.metadata, steps: [inspectionStep] };
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge({
        request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
          if (request.kind === "openSession") return runtimeOpened;
          if (request.kind === "inspectStep") return invalid(request);
          throw new Error(`Unexpected delegate request: ${request.kind}`);
        })
      });
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
      const response = await bridge.request({
        kind: "inspectStep",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        stepId: inspectionStep.id,
        offset: 0,
        limit: 25,
        ...columnWindow
      });

      expect(response).toMatchObject({ kind: "error", code: "invalid_runtime_response" });
      expect(coordinator.activeSession()?.stepInspection).toBeUndefined();
    }
  });

  it("correlates applied-step inspections to the exact row and column window", async () => {
    const schema: SessionMetadata["schema"] = [
      { id: "c:first", name: "first", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:second", name: "second", position: 1, rawType: "String", type: "string", nullable: false }
    ];
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 0, columns: 2 },
      filteredShape: { rows: 0, columns: 2 },
      schema,
      steps: [inspectionStep]
    };
    runtimeOpened.page = { ...runtimeOpened.page, columnIds: schema.map((column) => column.id) };
    const firstInspection = deferred<OpenWranglerResponse>();
    let firstRuntimeRequest: Extract<OpenWranglerRequest, { kind: "inspectStep" }> | undefined;
    const inspectionFor = (
      request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>
    ): Extract<OpenWranglerResponse, { kind: "stepInspection" }> => {
      const columnIds = schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id);
      const projectedPage = {
        offset: request.offset,
        limit: request.limit,
        totalRows: 0,
        columnIds,
        rows: []
      };
      return {
        ...stepInspectionResponse(request),
        inputPage: projectedPage,
        outputPage: projectedPage,
        inputSchema: schema,
        outputSchema: schema
      };
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "inspectStep" && !firstRuntimeRequest) {
        firstRuntimeRequest = request;
        return firstInspection.promise;
      }
      if (request.kind === "inspectStep") return inspectionFor(request);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const first = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      columnOffset: 0,
      columnLimit: 1
    });
    await vi.waitFor(() => expect(firstRuntimeRequest).toBeDefined());
    const second = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      columnOffset: 1,
      columnLimit: 1
    });
    firstInspection.resolve(inspectionFor(firstRuntimeRequest!));

    await expect(first).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    await expect(second).resolves.toMatchObject({
      kind: "stepInspection",
      outputPage: { columnIds: ["c:second"] }
    });
    expect(coordinator.activeSession()?.stepInspection?.outputPage.columnIds).toEqual(["c:second"]);
  });

  it("rejects page projections whose identities or row widths do not match the request", async () => {
    const schema: SessionMetadata["schema"] = [
      { id: "c:first", name: "first", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:second", name: "second", position: 1, rawType: "String", type: "string", nullable: false }
    ];
    const invalidPages = [
      (request: Extract<OpenWranglerRequest, { kind: "getPage" }>) => ({
        ...projectedPage(request, { ...openedResponse().metadata, schema }),
        columnIds: ["c:first"]
      }),
      (request: Extract<OpenWranglerRequest, { kind: "getPage" }>) => ({
        ...projectedPage(request, { ...openedResponse().metadata, schema }),
        rows: [
          {
            id: "r:0",
            rowNumber: 0,
            values: [
              { kind: "string" as const, raw: "one", display: "one", isNull: false, isNaN: false },
              { kind: "string" as const, raw: "two", display: "two", isNull: false, isNaN: false }
            ]
          }
        ]
      })
    ];

    for (const invalidPage of invalidPages) {
      const runtimeOpened = openedResponse();
      runtimeOpened.metadata = {
        ...runtimeOpened.metadata,
        shape: { rows: 1, columns: 2 },
        filteredShape: { rows: 1, columns: 2 },
        schema
      };
      runtimeOpened.page = { ...runtimeOpened.page, totalRows: 1, columnIds: schema.map((column) => column.id) };
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge({
        request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
          if (request.kind === "openSession") return runtimeOpened;
          if (request.kind === "getPage") {
            return {
              kind: "page",
              revision: request.revision,
              viewRequestId: request.viewRequestId,
              metadata: runtimeOpened.metadata,
              page: invalidPage(request)
            };
          }
          throw new Error(`Unexpected delegate request: ${request.kind}`);
        })
      });
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

      const response = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "projected-page",
        offset: 0,
        limit: 25,
        columnOffset: 1,
        columnLimit: 1,
        filterModel: opened.metadata.filterModel
      });
      expect(response).toMatchObject({ kind: "error", code: "invalid_runtime_response" });
    }
  });

  it("rejects a same-revision page whose runtime schema differs from the confirmed schema", async () => {
    const confirmedSchema: SessionMetadata["schema"] = [
      { id: "c:confirmed", name: "value", position: 0, rawType: "String", type: "string", nullable: false }
    ];
    const changedSchema: SessionMetadata["schema"] = [
      { id: "c:changed", name: "value", position: 0, rawType: "String", type: "string", nullable: false }
    ];
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 0, columns: 1 },
      filteredShape: { rows: 0, columns: 1 },
      schema: confirmedSchema
    };
    runtimeOpened.page = { ...runtimeOpened.page, columnIds: ["c:confirmed"] };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getPage") {
        const changedMetadata = { ...runtimeOpened.metadata, schema: changedSchema };
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata: changedMetadata,
          page: projectedPage(request, changedMetadata)
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const baseline = coordinator.activeSession();
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const response = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "changed-schema-page",
      offset: 0,
      limit: 25,
      columnOffset: 0,
      columnLimit: 1,
      filterModel: opened.metadata.filterModel
    });

    expect(response).toMatchObject({
      kind: "error",
      code: "invalid_runtime_response",
      message: expect.stringContaining("schema changed without a revision")
    });
    expect(coordinator.activeSession()).toEqual(baseline);
    expect(activeChanges).not.toHaveBeenCalled();
  });

  it("closes a runtime whose initial page does not match the requested projection", async () => {
    const projectedOpenRequest = { ...openRequest, columnOffset: 1, columnLimit: 1 } as const;
    const runtimeOpened = openedResponse("misprojected-runtime");
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 0, columns: 2 },
      filteredShape: { rows: 0, columns: 2 },
      schema: [
        { id: "c:first", name: "first", position: 0, rawType: "String", type: "string", nullable: false },
        { id: "c:second", name: "second", position: 1, rawType: "String", type: "string", nullable: false }
      ]
    };
    runtimeOpened.page = { ...runtimeOpened.page, columnIds: ["c:first"] };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });

    await expect(bridge.request(projectedOpenRequest)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_runtime_response"
    });
    expect(delegateRequest).toHaveBeenNthCalledWith(
      2,
      { kind: "closeSession", sessionId: "misprojected-runtime", revision: 0 },
      expect.objectContaining({ timeoutMs: 2_000, restartRuntimeOnTimeout: false })
    );
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("rejects preview diff cells that do not bind to the output schema", async () => {
    const step: TransformStep = {
      id: "round",
      kind: "roundNumber",
      params: { column: { id: "c:sales", name: "sales" } }
    };
    const runtimeOpened = openedResponse();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({
      request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return runtimeOpened;
        if (request.kind === "previewStep") {
          return {
            ...stepPreviewResponse(request.revision + 1, step),
            page: projectedPage(request, runtimeOpened.metadata),
            diff: {
              addedRows: 0,
              removedRows: 0,
              addedColumns: [],
              removedColumns: [],
              changedCells: 1,
              cells: [{ rowNumber: 0, columnId: "spoofed", column: "sales", before: null, after: null }],
              truncated: false
            }
          };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      })
    });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const response = await bridge.request({
      kind: "previewStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step,
      offset: 0,
      limit: 100,
      ...columnWindow
    });
    expect(response).toMatchObject({ kind: "error", code: "invalid_runtime_response" });
  });

  it("ignores a superseded inspection and clears selection before a mutation is dispatched", async () => {
    const secondStep: TransformStep = {
      id: "drop-city",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "city" }] }
    };
    const previewStep: TransformStep = {
      id: "upper-city",
      kind: "upperText",
      params: { column: { id: "c:source:0", name: "city" } }
    };
    const firstInspection = deferred<OpenWranglerResponse>();
    const pendingPreview = deferred<OpenWranglerResponse>();
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = { ...runtimeOpened.metadata, steps: [inspectionStep, secondStep] };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "inspectStep" && request.stepId === inspectionStep.id) return firstInspection.promise;
      if (request.kind === "inspectStep") return stepInspectionResponse(request, 1, "# second prefix");
      if (request.kind === "previewStep") return pendingPreview.promise;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const first = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: 0,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      ...columnWindow
    });
    await vi.waitFor(() => expect(delegateRequest).toHaveBeenCalledTimes(2));
    const second = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: 0,
      stepId: secondStep.id,
      offset: 0,
      limit: 25,
      ...columnWindow
    });
    firstInspection.resolve(
      stepInspectionResponse({
        kind: "inspectStep",
        sessionId: "runtime-session",
        revision: 0,
        stepId: inspectionStep.id,
        offset: 0,
        limit: 25,
        ...columnWindow
      })
    );
    await expect(first).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    await expect(second).resolves.toMatchObject({ kind: "stepInspection", stepId: secondStep.id });
    expect(coordinator.activeSession()?.code).toBe("# second prefix");

    const preview = bridge.request({
      kind: "previewStep",
      sessionId: opened.metadata.sessionId,
      revision: 0,
      step: previewStep,
      offset: 0,
      limit: 25,
      ...columnWindow
    });
    expect(coordinator.activeSession()?.stepInspection).toBeUndefined();
    pendingPreview.resolve({
      ...stepPreviewResponse(1, previewStep),
      metadata: { ...runtimeOpened.metadata, revision: 1, draftStep: previewStep },
      page: { ...runtimeOpened.page, offset: 0, limit: 25 }
    });
    await expect(preview).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
  });
  it("restores persisted viewing state without synchronously profiling columns", async () => {
    const projectedOpenRequest = { ...openRequest, columnOffset: 1, columnLimit: 1 } as const;
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    const stored = {
      [persistenceKey(openRequest.source, "polars")]: savedSession(filterModel, {
        columnWidths: { "c:sales": 260 },
        selectedColumnId: "c:sales",
        viewport: { firstVisibleRow: 240, scrollLeft: 180 }
      })
    };
    const workspaceState = {
      get: vi.fn((key: string) => (key === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 500, columns: 2 },
      filteredShape: { rows: 500, columns: 2 },
      schema: [
        { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
        { id: "c:sales", name: "sales", position: 1, rawType: "Int64", type: "integer", nullable: false }
      ]
    };
    runtimeOpened.page = {
      ...runtimeOpened.page,
      totalRows: 500,
      columnIds: ["c:sales"]
    };
    runtimeOpened.summaries = [
      {
        column: "sales",
        type: "float",
        rawType: "Float64",
        totalCount: 1,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 1,
        topValues: [{ value: "10", count: 1 }]
      }
    ];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getPage") {
        return {
          kind: "page",
          revision: 0,
          viewRequestId: request.viewRequestId,
          metadata: { ...runtimeOpened.metadata, filterModel },
          page: { ...runtimeOpened.page, offset: request.offset }
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const restored = await bridge.request(projectedOpenRequest);

    expect(restored.kind).toBe("sessionOpened");
    if (restored.kind !== "sessionOpened") throw new Error("Expected the persisted session to open.");
    expect(restored.metadata.filterModel).toEqual(filterModel);
    expect(restored.summaries).toEqual([]);
    expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "getPage"]);
    expect(delegateRequest.mock.calls[1]?.[0]).toMatchObject({
      kind: "getPage",
      offset: 200,
      limit: 100,
      columnOffset: 1,
      columnLimit: 1
    });
    expect(coordinator.activeSession()?.viewState).toMatchObject({
      selectedColumnId: "c:sales",
      columnWidths: { "c:sales": 260 },
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });
  });

  it("persists group and by-example identities across a real coordinator close and reopen", async () => {
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const groupStep: TransformStep = {
      id: "persisted-group",
      kind: "groupBy",
      params: {
        keys: [{ id: "c:region", name: "region" }],
        aggregations: [
          {
            column: { id: "c:sales", name: "sales" },
            operation: "sum",
            alias: "total"
          }
        ]
      }
    };
    const exampleStep: TransformStep = {
      id: "persisted-example",
      kind: "byExample",
      params: {
        sourceColumns: [
          { id: "c:region", name: "region" },
          { id: "c:step:persisted-group:0", name: "total" }
        ],
        newColumn: "label",
        examples: [
          { inputs: ["a", 3], output: "a-3" },
          { inputs: ["b", 7], output: "b-7" }
        ],
        program: {
          kind: "concat",
          parts: [
            { kind: "column", column: { id: "c:region", name: "region" } },
            { kind: "literal", value: "-" },
            { kind: "column", column: { id: "c:step:persisted-group:0", name: "total" } }
          ]
        },
        warnings: [],
        candidateCount: 1
      }
    };
    const steps = [groupStep, exampleStep];
    const schemas: SessionMetadata["schema"][] = [
      [
        { id: "c:region", name: "region", position: 0, rawType: "String", type: "string", nullable: false },
        { id: "c:sales", name: "sales", position: 1, rawType: "Int64", type: "integer", nullable: false }
      ],
      [
        { id: "c:region", name: "region", position: 0, rawType: "String", type: "string", nullable: false },
        {
          id: "c:step:persisted-group:0",
          name: "total",
          position: 1,
          rawType: "Int128",
          type: "integer",
          nullable: false
        }
      ],
      [
        { id: "c:region", name: "region", position: 0, rawType: "String", type: "string", nullable: false },
        {
          id: "c:step:persisted-group:0",
          name: "total",
          position: 1,
          rawType: "Int128",
          type: "integer",
          nullable: false
        },
        {
          id: "c:step:persisted-example:0",
          name: "label",
          position: 2,
          rawType: "String",
          type: "string",
          nullable: false
        }
      ]
    ];
    const metadataFor = (sessionId: string, appliedCount: number, draftStep?: TransformStep): SessionMetadata => {
      const opened = openedResponse(sessionId);
      const outputIndex = draftStep === undefined ? appliedCount : appliedCount + 1;
      const rows = outputIndex === 0 ? 4 : 2;
      return {
        ...opened.metadata,
        revision: appliedCount * 2 + (draftStep === undefined ? 0 : 1),
        shape: { rows, columns: schemas[outputIndex].length },
        filteredShape: { rows, columns: schemas[outputIndex].length },
        schema: schemas[outputIndex],
        steps: steps.slice(0, appliedCount),
        ...(draftStep === undefined ? {} : { draftStep })
      };
    };
    const makeDelegate = (sessionId: string, order?: string[]) => {
      const applied: TransformStep[] = [];
      let draft: TransformStep | undefined;
      return vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          order?.push("open");
          const metadata = metadataFor(sessionId, 0);
          return {
            ...openedResponse(sessionId),
            metadata,
            page: {
              offset: 0,
              limit: openRequest.pageSize,
              totalRows: metadata.filteredShape.rows,
              columnIds: metadata.schema.map((column) => column.id),
              rows: []
            }
          };
        }
        if (request.kind === "previewStep") {
          const expected = steps[applied.length];
          expect(request.step).toEqual(expected);
          draft = request.step;
          order?.push(`preview:${draft.id}`);
          const metadata = metadataFor(sessionId, applied.length, draft);
          return {
            ...stepPreviewResponse(metadata.revision, draft, sessionId),
            metadata,
            page: projectedPage(request, metadata)
          };
        }
        if (request.kind === "applyDraft") {
          if (draft === undefined) throw new Error("Apply received without a draft.");
          applied.push(draft);
          order?.push(`apply:${draft.id}`);
          draft = undefined;
          const metadata = metadataFor(sessionId, applied.length);
          return {
            ...planUpdatedResponse(metadata.revision, [...applied], sessionId),
            metadata,
            page: projectedPage(request, metadata)
          };
        }
        if (request.kind === "getPage") {
          order?.push("page");
          return pageResponseForMetadata(request, metadataFor(sessionId, applied.length));
        }
        if (request.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        throw new Error(`Unexpected persistence delegate request: ${request.kind}`);
      });
    };
    const firstDelegate = makeDelegate("persistence-runtime-1");
    const firstCoordinator = new SessionCoordinator(workspaceState);
    const firstBridge = firstCoordinator.createBridge({ request: firstDelegate });
    const opened = await firstBridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the first fake session to open.");
    let revision = opened.metadata.revision;
    for (const step of steps) {
      const preview = await firstBridge.request({
        kind: "previewStep",
        sessionId: opened.metadata.sessionId,
        revision,
        step,
        offset: 0,
        limit: 2,
        ...columnWindow
      });
      if (preview.kind !== "stepPreview") throw new Error("Expected the identity-addressed step to preview.");
      const applied = await firstBridge.request({
        kind: "applyDraft",
        sessionId: opened.metadata.sessionId,
        revision: preview.revision,
        offset: 0,
        limit: 2,
        ...columnWindow
      });
      if (applied.kind !== "planUpdated") throw new Error("Expected the identity-addressed step to apply.");
      revision = applied.revision;
    }
    await firstBridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision
    });

    expect(firstCoordinator.diagnostics().sessionCount).toBe(0);
    expect(stored[persistenceKey(openRequest.source, "polars")]).toMatchObject({
      cleaning: { steps }
    });

    const replayOrder: string[] = [];
    const secondDelegate = makeDelegate("persistence-runtime-2", replayOrder);
    const secondCoordinator = new SessionCoordinator(workspaceState);
    const secondBridge = secondCoordinator.createBridge({ request: secondDelegate });

    const restored = await secondBridge.request(openRequest);

    expect(restored).toMatchObject({ kind: "sessionOpened", metadata: { revision: 4, steps } });
    expect(replayOrder).toEqual([
      "open",
      `preview:${groupStep.id}`,
      `apply:${groupStep.id}`,
      `preview:${exampleStep.id}`,
      `apply:${exampleStep.id}`,
      "page"
    ]);
    if (restored.kind === "sessionOpened") {
      await secondBridge.request({
        kind: "closeSession",
        sessionId: restored.metadata.sessionId,
        revision: restored.metadata.revision
      });
    }
    expect(secondCoordinator.diagnostics().sessionCount).toBe(0);
  });

  it("discards a stale saved view while preserving replayed cleaning steps and draft", async () => {
    const appliedStep: TransformStep = {
      id: "persisted-drop",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "unused" }] }
    };
    const draftStep: TransformStep = {
      id: "persisted-round",
      kind: "roundNumber",
      params: { column: { id: "c:sales", name: "sales" }, decimals: 1 }
    };
    const staleFilterModel: FilterModel = {
      filters: [],
      sort: [{ column: "removed", direction: "asc", nulls: "last" }]
    };
    const key = persistenceKey(openRequest.source, "polars");
    const stored = {
      [key]: persistedSessionState(
        {
          ...openedResponse().metadata,
          steps: [appliedStep],
          draftStep,
          filterModel: staleFilterModel
        },
        {
          columnWidths: { "c:removed": 260 },
          selectedColumnId: "c:removed",
          viewport: { firstVisibleRow: 40, scrollLeft: 120 }
        }
      )
    };
    const workspaceState = {
      get: vi.fn((storageKey: string) => (storageKey === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const runtimeOpened = openedResponse("stale-view-runtime");
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 5, columns: 1 },
      filteredShape: { rows: 5, columns: 1 },
      schema: [{ id: "c:sales", name: "sales", position: 0, rawType: "Int64", type: "integer", nullable: false }]
    };
    runtimeOpened.page = { ...runtimeOpened.page, totalRows: 5, columnIds: ["c:sales"] };
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        executionOrder.push("open");
        return runtimeOpened;
      }
      if (request.kind === "previewStep") {
        executionOrder.push(`preview-${request.step.id}`);
        if (request.step.id === appliedStep.id) {
          return {
            ...stepPreviewResponse(1, appliedStep, "stale-view-runtime"),
            metadata: { ...runtimeOpened.metadata, revision: 1, draftStep: appliedStep },
            page: projectedPage(request, runtimeOpened.metadata)
          };
        }
        return {
          ...stepPreviewResponse(3, draftStep, "stale-view-runtime", "# restored draft"),
          metadata: {
            ...runtimeOpened.metadata,
            revision: 3,
            steps: [appliedStep],
            draftStep
          },
          page: projectedPage(request, runtimeOpened.metadata)
        };
      }
      if (request.kind === "applyDraft") {
        executionOrder.push("apply");
        return {
          ...planUpdatedResponse(2, [appliedStep], "stale-view-runtime"),
          metadata: { ...runtimeOpened.metadata, revision: 2, steps: [appliedStep] },
          page: projectedPage(request, runtimeOpened.metadata)
        };
      }
      if (request.kind === "getPage") {
        const isSavedView = request.filterModel.sort.length > 0;
        executionOrder.push(isSavedView ? "page-saved" : "page-empty");
        if (isSavedView) {
          return {
            kind: "error",
            code: "engine_error",
            message: "The saved view references a removed column.",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata: {
            ...runtimeOpened.metadata,
            revision: request.revision,
            steps: [appliedStep],
            draftStep,
            filterModel: request.filterModel
          },
          page: projectedPage(request, runtimeOpened.metadata)
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const restored = await bridge.request(openRequest);

    expect(restored).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        revision: 3,
        steps: [appliedStep],
        draftStep,
        filterModel: { filters: [], sort: [] }
      },
      page: { offset: 0, totalRows: 5 }
    });
    expect(coordinator.activeSession()?.viewState).toEqual({
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 },
      filterModel: { filters: [], sort: [] }
    });
    expect(executionOrder).toEqual([
      "open",
      `preview-${appliedStep.id}`,
      "apply",
      `preview-${draftStep.id}`,
      "page-saved",
      "page-empty"
    ]);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
  });

  it("reopens original data with an empty plan only when saved cleaning replay fails", async () => {
    const savedStep: TransformStep = {
      id: "invalid-for-source",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "missing" }] }
    };
    const key = persistenceKey(openRequest.source, "polars");
    const stored = {
      [key]: persistedSessionState(
        { ...openedResponse().metadata, steps: [savedStep] },
        { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      )
    };
    const workspaceState = {
      get: vi.fn((storageKey: string) => (storageKey === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let openCount = 0;
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`cleaning-runtime-${openCount}`);
      }
      if (request.kind === "previewStep") {
        executionOrder.push("preview-failed");
        return {
          kind: "error",
          code: "engine_error",
          message: "The saved step no longer applies to this source.",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const restored = await bridge.request(openRequest);

    expect(restored).toMatchObject({
      kind: "sessionOpened",
      metadata: { revision: 0, steps: [], filterModel: { filters: [], sort: [] } }
    });
    expect(executionOrder).toEqual(["open-1", "preview-failed", "close-cleaning-runtime-1", "open-2"]);
    expect(
      delegateRequest.mock.calls.map(([request]) => request).filter((request) => request.kind === "openSession")
    ).toEqual([openRequest, openRequest]);
  });

  it("persists grid presentation separately and notifies native views only when column selection changes", async () => {
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const opened = openedResponse();
    opened.metadata = {
      ...opened.metadata,
      shape: { rows: 500, columns: 2 },
      filteredShape: { rows: 500, columns: 2 },
      schema: [
        { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
        { id: "c:sales", name: "sales", position: 1, rawType: "Int64", type: "integer", nullable: false }
      ]
    };
    opened.page = { ...opened.page, totalRows: 500, columnIds: opened.metadata.schema.map((column) => column.id) };
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: vi.fn(async () => opened) });
    const response = await bridge.request(openRequest);
    if (response.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    await bridge.updateViewState?.(response.metadata.sessionId, {
      columnWidths: { "c:sales": 260, removed: 300 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });

    expect(activeChanges).toHaveBeenCalledOnce();
    expect(coordinator.activeSession()?.viewState).toMatchObject({
      filterModel: response.metadata.filterModel,
      columnWidths: { "c:sales": 260 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });
    expect(stored[persistenceKey(openRequest.source, "polars")]).toMatchObject({
      cleaning: { steps: [] },
      view: {
        filterModel: response.metadata.filterModel,
        columnWidths: { "c:sales": 260 },
        selectedColumnId: "c:sales",
        viewport: { firstVisibleRow: 240, scrollLeft: 180 }
      }
    });

    await bridge.updateViewState?.(response.metadata.sessionId, {
      columnWidths: { "c:sales": 260 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 260, scrollLeft: 220 }
    });
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(workspaceState.update).toHaveBeenCalledTimes(2);
  });

  it("bounds a restored visible row to the final block when the saved result has shrunk", async () => {
    const filterModel: FilterModel = { filters: [], sort: [] };
    const stored = {
      [persistenceKey(openRequest.source, "polars")]: savedSession(filterModel, {
        columnWidths: {},
        viewport: { firstVisibleRow: 450, scrollLeft: 30 }
      })
    };
    const workspaceState = {
      get: vi.fn((key: string) => (key === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 120, columns: 0 },
      filteredShape: { rows: 120, columns: 0 }
    };
    runtimeOpened.page = { ...runtimeOpened.page, totalRows: 120 };
    const offsets: number[] = [];
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({
      request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return runtimeOpened;
        if (request.kind === "getPage") {
          offsets.push(request.offset);
          return {
            kind: "page",
            revision: request.revision,
            viewRequestId: request.viewRequestId,
            metadata: runtimeOpened.metadata,
            page: { ...runtimeOpened.page, offset: request.offset }
          };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      })
    });

    const restored = await bridge.request(openRequest);

    expect(restored).toMatchObject({ kind: "sessionOpened", page: { offset: 100, totalRows: 120 } });
    expect(offsets).toEqual([400, 100]);
    expect(coordinator.activeSession()?.viewState.viewport).toEqual({ firstVisibleRow: 119, scrollLeft: 30 });
  });

  it("lets an interactive page overtake active and queued background profiling", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    let profileNumber = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        profileNumber += 1;
        executionOrder.push(`profile-${profileNumber}`);
        return profileNumber === 1 ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const firstProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "priority-profile-active",
      filterModel: opened.metadata.filterModel,
      columns: ["first"]
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile-1"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "priority-profile-queued",
      filterModel: opened.metadata.filterModel,
      columns: ["second"]
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "priority-page",
      offset: 100,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    await page;
    expect(executionOrder).toEqual(["profile-1", "page"]);
    activeProfile.resolve(summaryResponse("priority-profile-active"));
    await Promise.all([firstProfile, queuedProfile]);

    expect(executionOrder).toEqual(["profile-1", "page", "profile-2"]);
  });

  it("honors an explicit priority override", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getDatasetStats") {
        executionOrder.push("stats");
        return activeProfile.promise;
      }
      if (request.kind === "getSummary") {
        executionOrder.push(request.columns?.[0] ?? "summary");
        return summaryResponse(request.viewRequestId);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const stats = bridge.request({
      kind: "getDatasetStats",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "override-stats-active",
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["stats"]));
    const background = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "override-summary-background",
      filterModel: opened.metadata.filterModel,
      columns: ["background"]
    });
    const promoted = bridge.request(
      {
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "override-summary-promoted",
        filterModel: opened.metadata.filterModel,
        columns: ["promoted"]
      },
      { priority: "interactive" }
    );

    activeProfile.resolve(datasetStatsResponse("override-stats-active"));
    await Promise.all([stats, background, promoted]);
    expect(executionOrder).toEqual(["stats", "promoted", "background"]);
  });

  it("drops only obsolete queued background view requests", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        const column = request.columns?.[0] ?? "unknown";
        executionOrder.push(column);
        return column === "active" ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const requestSummary = (viewRequestId: string, column: string) =>
      bridge.request({
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId,
        filterModel: opened.metadata.filterModel,
        columns: [column]
      });
    const active = requestSummary("cancel-active", "active");
    await vi.waitFor(() => expect(executionOrder).toEqual(["active"]));
    const obsolete = requestSummary("cancel-obsolete", "obsolete");
    const retained = requestSummary("cancel-retained", "retained");

    bridge.cancelViewRequests?.(opened.metadata.sessionId, ["cancel-obsolete", "unknown"]);
    await expect(obsolete).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "cancel-obsolete"
    });

    activeProfile.resolve(summaryResponse("cancel-active"));
    await Promise.all([active, retained]);
    expect(executionOrder).toEqual(["active", "retained"]);
  });

  it("cancels queued interactive column values without cancelling a queued page", async () => {
    const activeValues = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getColumnValues") {
        executionOrder.push(request.viewRequestId);
        if (request.viewRequestId === "values-active") return activeValues.promise;
        return columnValuesResponse(request.viewRequestId, request.column);
      }
      if (request.kind === "getPage") {
        executionOrder.push(request.viewRequestId);
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const valuesRequest = (viewRequestId: string) =>
      bridge.request({
        kind: "getColumnValues",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId,
        column: "sales",
        filterModel: opened.metadata.filterModel,
        limit: 20
      });

    const active = valuesRequest("values-active");
    await vi.waitFor(() => expect(executionOrder).toEqual(["values-active"]));
    const obsolete = valuesRequest("values-obsolete");
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "page-retained",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    bridge.cancelViewRequests?.(opened.metadata.sessionId, ["values-obsolete", "page-retained"]);
    await expect(obsolete).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getColumnValues",
      viewRequestId: "values-obsolete"
    });

    activeValues.resolve(columnValuesResponse("values-active", "sales"));
    await expect(active).resolves.toMatchObject({ kind: "columnValues", viewRequestId: "values-active" });
    await expect(page).resolves.toMatchObject({ kind: "page", viewRequestId: "page-retained" });
    expect(executionOrder).toEqual(["values-active", "page-retained"]);
  });

  it("rejects queued mutations and pages when an earlier mutation advances the public revision", async () => {
    const activeMutation = deferred<OpenWranglerResponse>();
    const dispatched: string[] = [];
    const step: TransformStep = {
      id: "queued-revision",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "sales" }] }
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "previewStep") {
        dispatched.push("preview");
        return activeMutation.promise;
      }
      if (request.kind === "applyDraft") {
        dispatched.push("apply");
        return planUpdatedResponse(2, [step]);
      }
      if (request.kind === "getPage") {
        dispatched.push("page");
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const preview = bridge.request({
      kind: "previewStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step,
      offset: 0,
      limit: 100,
      ...columnWindow
    });
    await vi.waitFor(() => expect(dispatched).toEqual(["preview"]));
    const staleApply = bridge.request({
      kind: "applyDraft",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 100,
      ...columnWindow
    });
    const stalePage = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "queued-stale-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    activeMutation.resolve(stepPreviewResponse(1, step));
    await expect(preview).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    await expect(staleApply).resolves.toMatchObject({
      kind: "error",
      code: "stale_request",
      sessionId: opened.metadata.sessionId
    });
    await expect(stalePage).resolves.toMatchObject({
      kind: "error",
      code: "stale_request",
      sessionId: opened.metadata.sessionId,
      viewRequestId: "queued-stale-page"
    });

    expect(dispatched).toEqual(["preview"]);
    expect(coordinator.activeSession()?.metadata.revision).toBe(1);
  });

  it("does not replay a failed background profile and lets the next interactive request recover", async () => {
    const executionOrder: string[] = [];
    let openCount = 0;
    let interactivePageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "getSummary") {
        executionOrder.push("profile");
        throw new Error("profile transport failed");
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) {
          executionOrder.push("restore-page");
        } else {
          interactivePageAttempts += 1;
          executionOrder.push(`interactive-page-${interactivePageAttempts}`);
          if (interactivePageAttempts === 1) throw new Error("interactive transport failed");
        }
        return pageResponse(request, `runtime-${openCount}`);
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request({
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "failure-profile",
        filterModel: opened.metadata.filterModel
      })
    ).rejects.toThrow("profile transport failed");
    expect(openCount).toBe(1);

    const page = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "failure-interactive-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    expect(page).toMatchObject({ kind: "page", viewRequestId: "failure-interactive-page" });
    expect(executionOrder).toEqual([
      "open-1",
      "profile",
      "interactive-page-1",
      "open-2",
      "restore-page",
      "close-runtime-1",
      "interactive-page-2"
    ]);
  });

  it("pins an automatically selected backend for crash replay", async () => {
    const autoRequest = { ...openRequest, backend: undefined };
    const openedBackends: Array<string | undefined> = [];
    let openCount = 0;
    let pageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        openedBackends.push(request.backend);
        return openedResponse(`duckdb-runtime-${openCount}`, "duckdb");
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) return pageResponse(request, `duckdb-runtime-${openCount}`, "duckdb");
        pageAttempts += 1;
        if (pageAttempts === 1) throw new Error("runtime crashed");
        return pageResponse(request, `duckdb-runtime-${openCount}`, "duckdb");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(autoRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the automatic session to open.");

    const recovered = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "duckdb-recovery-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    expect(recovered).toMatchObject({ kind: "page", metadata: { backend: "duckdb" } });
    expect(openedBackends).toEqual([undefined, "duckdb"]);
  });

  it("rejects and closes a recovery candidate when a same-URI notebook begins overlapping", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/recovery.ipynb"),
      isClosed: false
    } as NotebookDocument;
    const overlappingReplacement = {
      uri: vscode.Uri.parse("file:///workspace/recovery.ipynb"),
      isClosed: false
    } as NotebookDocument;
    setOpenNotebookDocuments(notebook);
    let openCount = 0;
    const closedRuntimeIds: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount === 2) setOpenNotebookDocuments(notebook, overlappingReplacement);
        return openedResponse(openCount === 1 ? "runtime-old" : "runtime-recovery-candidate");
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-old") {
        return {
          kind: "error",
          code: "engine_error",
          message: "Unknown session: runtime-old",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "closeSession") {
        closedRuntimeIds.push(request.sessionId);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected recovery provenance request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);

    try {
      const opened = await bridge.request({
        ...openRequest,
        source: {
          kind: "notebookVariable",
          label: "frame",
          variableName: "frame",
          uri: notebook.uri.toString()
        },
        mode: "viewing"
      });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the notebook session to open.");

      const response = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "same-uri-recovery",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      });

      expect(response).toMatchObject({
        kind: "error",
        code: "engine_error",
        sessionId: opened.metadata.sessionId,
        viewRequestId: "same-uri-recovery"
      });
      expect(openCount).toBe(2);
      expect(closedRuntimeIds).toEqual(["runtime-recovery-candidate"]);
      expect(coordinator.diagnostics().sessions).toEqual([
        expect.objectContaining({ publicId: opened.metadata.sessionId, runtimeId: "runtime-old" })
      ]);

      await bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      });
      expect(closedRuntimeIds).toEqual(["runtime-recovery-candidate", "runtime-old"]);
    } finally {
      setOpenNotebookDocuments();
      await coordinator.shutdown();
    }
  });

  it("serializes concurrent recovery for sessions sharing one runtime delegate", async () => {
    let openCount = 0;
    let firstRecoveryRestoreStarted = false;
    const firstRecoveryRestoreGate = deferred<void>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount <= 3) return openedResponse(`runtime-old-${openCount}`);
        return openedResponse(`runtime-new-${openCount - 3}`);
      }
      if (request.kind === "getPage" && request.sessionId.startsWith("runtime-old-")) {
        return {
          kind: "error",
          code: "engine_error",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-new-1" && request.limit === 1) {
        firstRecoveryRestoreStarted = true;
        await firstRecoveryRestoreGate.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened: SessionOpenedResponse[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await bridge.request(openRequest);
      if (response.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
      opened.push(response);
    }

    const recoveries = opened.map((session, index) =>
      bridge.request({
        kind: "getPage",
        sessionId: session.metadata.sessionId,
        revision: session.metadata.revision,
        viewRequestId: `shared-runtime-recovery-${index}`,
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: session.metadata.filterModel
      })
    );

    await vi.waitFor(() => expect(firstRecoveryRestoreStarted).toBe(true));
    await Promise.resolve();
    expect(openCount).toBe(4);
    firstRecoveryRestoreGate.resolve();

    await expect(Promise.all(recoveries)).resolves.toEqual(
      opened.map((session, index) =>
        expect.objectContaining({
          kind: "page",
          revision: session.metadata.revision,
          viewRequestId: `shared-runtime-recovery-${index}`
        })
      )
    );
    expect(openCount).toBe(6);
    expect(coordinator.diagnostics().sessions.map((session) => session.runtimeId)).toEqual([
      "runtime-new-1",
      "runtime-new-2",
      "runtime-new-3"
    ]);
    await coordinator.shutdown();
  });

  it("keeps recovery concurrent for sessions backed by independent runtime delegates", async () => {
    const recoveryRestoreGate = deferred<void>();
    let activeRecoveryRestores = 0;
    let enteredRecoveryRestores = 0;
    let maximumConcurrentRecoveryRestores = 0;
    const makeDelegate = (label: string): OpenWranglerBridge => {
      let openCount = 0;
      return {
        request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
          if (request.kind === "openSession") {
            openCount += 1;
            return openedResponse(`${label}-${openCount === 1 ? "old" : "new"}`);
          }
          if (request.kind === "getPage" && request.sessionId === `${label}-old`) {
            return {
              kind: "error",
              code: "engine_error",
              message: `Unknown session: ${request.sessionId}`,
              recoverable: true,
              sessionId: request.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
          if (request.kind === "getPage" && request.limit === 1) {
            enteredRecoveryRestores += 1;
            activeRecoveryRestores += 1;
            maximumConcurrentRecoveryRestores = Math.max(maximumConcurrentRecoveryRestores, activeRecoveryRestores);
            try {
              await recoveryRestoreGate.promise;
              return pageResponse(request, request.sessionId);
            } finally {
              activeRecoveryRestores -= 1;
            }
          }
          if (request.kind === "getPage") return pageResponse(request, request.sessionId);
          if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
          throw new Error(`Unexpected ${label} delegate request: ${request.kind}`);
        })
      };
    };
    const coordinator = new SessionCoordinator();
    const firstBridge = coordinator.createBridge(makeDelegate("first-runtime"));
    const secondBridge = coordinator.createBridge(makeDelegate("second-runtime"));
    const firstOpened = await firstBridge.request(openRequest);
    const secondOpened = await secondBridge.request(openRequest);
    if (firstOpened.kind !== "sessionOpened" || secondOpened.kind !== "sessionOpened") {
      throw new Error("Expected both independent sessions to open.");
    }

    const recoveries = Promise.all([
      firstBridge.request({
        kind: "getPage",
        sessionId: firstOpened.metadata.sessionId,
        revision: firstOpened.metadata.revision,
        viewRequestId: "independent-recovery-first",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: firstOpened.metadata.filterModel
      }),
      secondBridge.request({
        kind: "getPage",
        sessionId: secondOpened.metadata.sessionId,
        revision: secondOpened.metadata.revision,
        viewRequestId: "independent-recovery-second",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: secondOpened.metadata.filterModel
      })
    ]);

    try {
      await vi.waitFor(() => expect(enteredRecoveryRestores).toBe(2));
      expect(maximumConcurrentRecoveryRestores).toBe(2);
    } finally {
      recoveryRestoreGate.resolve();
    }

    await expect(recoveries).resolves.toEqual([
      expect.objectContaining({ kind: "page", viewRequestId: "independent-recovery-first" }),
      expect.objectContaining({ kind: "page", viewRequestId: "independent-recovery-second" })
    ]);
    expect(coordinator.diagnostics().sessions.map((session) => session.runtimeId)).toEqual([
      "first-runtime-new",
      "second-runtime-new"
    ]);
    await coordinator.shutdown();
  });

  it("does not establish a fresh session on a delegate while recovery is still restoring", async () => {
    let openCount = 0;
    let recoveryRestoreStarted = false;
    const recoveryRestoreGate = deferred<void>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount === 1) return openedResponse("runtime-old");
        if (openCount === 2) return openedResponse("runtime-recovery");
        return openedResponse("runtime-fresh");
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-old") {
        return {
          kind: "error",
          code: "engine_error",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-recovery" && request.limit === 1) {
        recoveryRestoreStarted = true;
        await recoveryRestoreGate.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const onIdle = vi.fn();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the original session to open.");
    const recovery = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "recovery-before-fresh-open",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });
    const recoverySettlement = recovery.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    await vi.waitFor(() => expect(recoveryRestoreStarted).toBe(true));
    const freshOpen = bridge.request({
      ...openRequest,
      source: { kind: "file", label: "fresh.csv", path: "/workspace/fresh.csv" }
    });
    const freshSettlement = freshOpen.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    try {
      await Promise.resolve();
      expect(openCount).toBe(2);
    } finally {
      recoveryRestoreGate.resolve();
    }

    const [recovered, fresh] = await Promise.all([recoverySettlement, freshSettlement]);
    expect(recovered).toMatchObject({ status: "fulfilled", value: { kind: "page" } });
    expect(fresh).toMatchObject({ status: "fulfilled", value: { kind: "sessionOpened" } });
    expect(openCount).toBe(3);
    expect(coordinator.diagnostics().sessions.map((session) => session.runtimeId)).toEqual([
      "runtime-recovery",
      "runtime-fresh"
    ]);
    await coordinator.shutdown();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("drains a serialized recovery chain before shutdown releases its runtime delegate", async () => {
    let openCount = 0;
    let recoveryRestoreStarted = false;
    const recoveryRestoreGate = deferred<void>();
    const events: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        return openedResponse(openCount <= 2 ? `runtime-old-${openCount}` : `runtime-candidate-${openCount - 2}`);
      }
      if (request.kind === "getPage" && request.sessionId.startsWith("runtime-old-")) {
        return {
          kind: "error",
          code: "engine_error",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-candidate-1" && request.limit === 1) {
        recoveryRestoreStarted = true;
        events.push("restore-candidate-1");
        await recoveryRestoreGate.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") {
        events.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const onIdle = vi.fn(() => events.push("idle"));
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened: SessionOpenedResponse[] = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await bridge.request(openRequest);
      if (response.kind !== "sessionOpened") throw new Error("Expected the original sessions to open.");
      opened.push(response);
    }

    const recoverySettlements = Promise.allSettled(
      opened.map((session, index) =>
        bridge.request({
          kind: "getPage",
          sessionId: session.metadata.sessionId,
          revision: session.metadata.revision,
          viewRequestId: `shutdown-recovery-${index}`,
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: session.metadata.filterModel
        })
      )
    );
    await vi.waitFor(() => expect(recoveryRestoreStarted).toBe(true));

    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();
    recoveryRestoreGate.resolve();

    const [results] = await Promise.all([recoverySettlements, shutdown]);
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ kind: "error" }) }),
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ kind: "error" }) })
    ]);
    expect(openCount).toBe(3);
    expect(events).toContain("close-runtime-candidate-1");
    expect(events).toContain("close-runtime-old-1");
    expect(events).toContain("close-runtime-old-2");
    expect(events.indexOf("close-runtime-candidate-1")).toBeLessThan(events.indexOf("close-runtime-old-1"));
    expect(events.indexOf("close-runtime-candidate-1")).toBeLessThan(events.indexOf("close-runtime-old-2"));
    expect(events.at(-1)).toBe("idle");
    expect(onIdle).toHaveBeenCalledOnce();
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("rejects a background response from the runtime replaced by concurrent recovery", async () => {
    const oldStats = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    let openCount = 0;
    let livePageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "getDatasetStats" && request.sessionId === "runtime-1") {
        executionOrder.push("old-stats");
        return oldStats.promise;
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) {
          executionOrder.push("restore-page");
          return pageResponse(request, "runtime-2");
        }
        livePageAttempts += 1;
        executionOrder.push(`page-${request.sessionId}-${livePageAttempts}`);
        if (request.sessionId === "runtime-1") throw new Error("old runtime failed");
        return pageResponse(request, "runtime-2");
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    bridge.setViewContext?.(opened.metadata.sessionId, "logical-view-a");

    const stats = bridge.request(
      {
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "old-runtime-stats",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-view-a" }
    );
    await vi.waitFor(() => expect(executionOrder).toEqual(["open-1", "old-stats"]));
    const page = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "recovering-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-view-b" }
    );
    await expect(page).resolves.toMatchObject({ kind: "page", viewRequestId: "recovering-page" });

    oldStats.resolve(datasetStatsResponse("old-runtime-stats"));
    await expect(stats).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "old-runtime-stats"
    });
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
    expect(executionOrder).toEqual([
      "open-1",
      "old-stats",
      "page-runtime-1-1",
      "open-2",
      "restore-page",
      "close-runtime-1",
      "page-runtime-2-2"
    ]);
  });

  it("closes a failed replay candidate without corrupting the live coordinated state", async () => {
    const firstStep: TransformStep = {
      id: "replay-first",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "first" }] }
    };
    const secondStep: TransformStep = {
      id: "replay-second",
      kind: "renameColumn",
      params: { column: { id: "c:source:1", name: "second" }, newName: "renamed" }
    };
    const liveOpened = openedResponse("runtime-live");
    liveOpened.metadata = {
      ...liveOpened.metadata,
      revision: 4,
      shape: { rows: 7, columns: 2 },
      filteredShape: { rows: 7, columns: 2 },
      steps: [firstStep, secondStep]
    };
    let openCount = 0;
    let failLivePage = true;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        return openCount === 1 ? liveOpened : openedResponse("runtime-candidate");
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-live") {
        if (failLivePage) {
          failLivePage = false;
          throw new Error("live transport failed");
        }
        return pageResponseForMetadata(request, liveOpened.metadata);
      }
      if (request.kind === "previewStep" && request.sessionId === "runtime-candidate") {
        if (request.step.id === firstStep.id) {
          const response = stepPreviewResponse(1, firstStep, "runtime-candidate", "candidate-preview-code");
          return { ...response, page: projectedPage(request, response.metadata) };
        }
        return {
          kind: "error",
          code: "engine_error",
          message: "second replay step failed",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      if (request.kind === "applyDraft" && request.sessionId === "runtime-candidate") {
        const response = planUpdatedResponse(2, [firstStep], "runtime-candidate", "candidate-applied-code");
        return { ...response, page: projectedPage(request, response.metadata) };
      }
      if (request.kind === "closeSession" && request.sessionId === "runtime-candidate") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    expect(opened.metadata.revision).toBe(4);
    expect(coordinator.activeSession()?.code).toBe("");

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "failed-replay-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).rejects.toThrow("live transport failed");

    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({
        runtimeId: "runtime-live",
        publicRevision: 4,
        runtimeRevision: 4
      })
    ]);
    expect(coordinator.activeSession()).toMatchObject({
      metadata: {
        revision: 4,
        shape: { rows: 7, columns: 2 },
        steps: [firstStep, secondStep]
      },
      code: ""
    });
    expect(
      delegateRequest.mock.calls.map(([request]) => request).filter((request) => request.kind === "closeSession")
    ).toEqual([{ kind: "closeSession", sessionId: "runtime-candidate", revision: 2 }]);

    const retried = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "live-state-retry",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });
    expect(retried).toMatchObject({ kind: "page", revision: 4, viewRequestId: "live-state-retry" });
    expect(delegateRequest.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "getPage",
      sessionId: "runtime-live",
      revision: 4
    });
  });

  it("uses fresh bounded options and diagnoses a cancelled recovery-candidate close", async () => {
    let openCount = 0;
    let failLivePage = true;
    let cleanupOptions: BridgeRequestOptions | undefined;
    const reportDiagnostic = vi.fn();
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openCount += 1;
          return openedResponse(openCount === 1 ? "runtime-live" : "runtime-candidate");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-live") {
          if (failLivePage) {
            failLivePage = false;
            throw new Error("live transport failed");
          }
          return pageResponse(request, "runtime-live");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-candidate") {
          return {
            kind: "error",
            code: "engine_error",
            message: "candidate restore failed",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        if (request.kind === "closeSession" && request.sessionId === "runtime-candidate") {
          cleanupOptions = options;
          return { kind: "cancelled", targetRequestId: "candidate-close" };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const cancelledRequestOptions: BridgeRequestOptions = {
      cancellation: {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => undefined })
      },
      timeoutMs: 7,
      viewContextId: "candidate-view"
    };

    await expect(
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId: "candidate-cleanup-page",
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: opened.metadata.filterModel
        },
        cancelledRequestOptions
      )
    ).rejects.toThrow("live transport failed");

    expect(cleanupOptions).toEqual({
      priority: "interactive",
      timeoutMs: 2_000,
      restartRuntimeOnTimeout: false
    });
    expect(cleanupOptions).not.toBe(cancelledRequestOptions);
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/recovery candidate session runtime-candidate.*close was cancelled \(candidate-close\)/)
    );
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({ runtimeId: "runtime-live", runtimeRevision: 0 })
    ]);

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "candidate-cleanup-retry",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "candidate-cleanup-retry" });
  });

  it("diagnoses a retired-runtime close error without destabilizing the replacement session", async () => {
    let openCount = 0;
    let failLivePage = true;
    let cleanupOptions: BridgeRequestOptions | undefined;
    const reportDiagnostic = vi.fn();
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openCount += 1;
          return openedResponse(openCount === 1 ? "runtime-live" : "runtime-replacement");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-live") {
          if (failLivePage) {
            failLivePage = false;
            throw new Error("live transport failed");
          }
          return pageResponse(request, "runtime-live");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-replacement") {
          return pageResponse(request, "runtime-replacement");
        }
        if (request.kind === "closeSession" && request.sessionId === "runtime-live") {
          cleanupOptions = options;
          return {
            kind: "error",
            code: "engine_error",
            message: "retired close failed",
            recoverable: true,
            sessionId: request.sessionId
          };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId: "retired-cleanup-page",
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: opened.metadata.filterModel
        },
        { timeoutMs: 11, viewContextId: "replacement-view" }
      )
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "retired-cleanup-page" });

    await vi.waitFor(() => expect(reportDiagnostic).toHaveBeenCalledOnce());
    expect(cleanupOptions).toEqual({
      priority: "interactive",
      timeoutMs: 2_000,
      restartRuntimeOnTimeout: false
    });
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/retired runtime session runtime-live.*engine_error: retired close failed/)
    );
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({ runtimeId: "runtime-replacement", runtimeRevision: 0 })
    ]);

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "replacement-still-live",
        offset: 100,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "replacement-still-live" });
  });

  it("runs different sessions concurrently and lets same-session pages bypass profiles", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const firstSessionOrder: string[] = [];
    const secondSessionOrder: string[] = [];
    const firstDelegate = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse("runtime-first");
      if (request.kind === "getSummary") {
        firstSessionOrder.push("profile");
        return activeProfile.promise;
      }
      if (request.kind === "getPage") {
        firstSessionOrder.push("page");
        return pageResponse(request, "runtime-first");
      }
      throw new Error(`Unexpected first delegate request: ${request.kind}`);
    });
    const secondDelegate = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse("runtime-second");
      if (request.kind === "getPage") {
        secondSessionOrder.push("page");
        return pageResponse(request, "runtime-second");
      }
      throw new Error(`Unexpected second delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const firstBridge = coordinator.createBridge({ request: firstDelegate });
    const secondBridge = coordinator.createBridge({ request: secondDelegate });
    const firstOpened = await firstBridge.request(openRequest);
    const secondOpened = await secondBridge.request(openRequest);
    if (firstOpened.kind !== "sessionOpened" || secondOpened.kind !== "sessionOpened") {
      throw new Error("Expected both fake sessions to open.");
    }

    const profile = firstBridge.request({
      kind: "getSummary",
      sessionId: firstOpened.metadata.sessionId,
      revision: firstOpened.metadata.revision,
      viewRequestId: "concurrency-first-profile",
      filterModel: firstOpened.metadata.filterModel
    });
    await vi.waitFor(() => expect(firstSessionOrder).toEqual(["profile"]));
    const firstPage = firstBridge.request({
      kind: "getPage",
      sessionId: firstOpened.metadata.sessionId,
      revision: firstOpened.metadata.revision,
      viewRequestId: "concurrency-first-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: firstOpened.metadata.filterModel
    });
    const secondPage = secondBridge.request({
      kind: "getPage",
      sessionId: secondOpened.metadata.sessionId,
      revision: secondOpened.metadata.revision,
      viewRequestId: "concurrency-second-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: secondOpened.metadata.filterModel
    });

    await Promise.all([firstPage, secondPage]);
    expect(secondSessionOrder).toEqual(["page"]);
    expect(firstSessionOrder).toEqual(["profile", "page"]);

    activeProfile.resolve(summaryResponse("concurrency-first-profile"));
    await profile;
    expect(firstSessionOrder).toEqual(["profile", "page"]);
  });

  it("cancels queued background work on close and does not replay a failing active profile", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    let profileNumber = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        profileNumber += 1;
        executionOrder.push(`profile-${profileNumber}`);
        return profileNumber === 1 ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "closeSession") {
        executionOrder.push("close");
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-profile-active",
      filterModel: opened.metadata.filterModel,
      columns: ["active"]
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile-1"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-profile-queued",
      filterModel: opened.metadata.filterModel,
      columns: ["queued"]
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });
    const close = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });

    await expect(queuedProfile).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "close-profile-queued"
    });
    await page;
    expect(executionOrder).toEqual(["profile-1", "page"]);
    const activeFailure = expect(profile).rejects.toThrow("profile transport failed");
    activeProfile.reject(new Error("profile transport failed"));
    await Promise.all([activeFailure, close]);

    expect(executionOrder).toEqual(["profile-1", "page", "close"]);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("cancels queued background work and drains active plus interactive work before shutdown closes", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        const label = request.columns?.[0] ?? "profile";
        executionOrder.push(label);
        return label === "active" ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "closeSession") {
        executionOrder.push("close");
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-profile-active",
      filterModel: opened.metadata.filterModel,
      columns: ["active"]
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["active"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-profile-queued",
      filterModel: opened.metadata.filterModel,
      columns: ["queued"]
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });

    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await expect(queuedProfile).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "shutdown-profile-queued"
    });
    await page;
    expect(executionOrder).toEqual(["active", "page"]);

    activeProfile.resolve(summaryResponse("shutdown-profile-active"));
    await Promise.all([profile, shutdown]);
    expect(executionOrder).toEqual(["active", "page", "close"]);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("cancels queued work at the shutdown bound but closes after active work settles", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        executionOrder.push("profile");
        return activeProfile.promise;
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "closeSession") {
        executionOrder.push("close");
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "timeout-profile-active",
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile"]));
    const queuedInteractive = bridge.request(
      {
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "timeout-promoted-profile",
        filterModel: opened.metadata.filterModel,
        columns: ["queued"]
      },
      { priority: "interactive" }
    );

    await coordinator.shutdown(0);
    await expect(queuedInteractive).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "timeout-promoted-profile"
    });
    expect(executionOrder).toEqual(["profile"]);
    expect(coordinator.diagnostics().sessionCount).toBe(0);

    activeProfile.resolve(summaryResponse("timeout-profile-active"));
    await profile;
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile", "close"]));
  });

  it("does not attach queued statistics calculated for an obsolete filter model", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        executionOrder.push("profile");
        return activeProfile.promise;
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "getDatasetStats") {
        executionOrder.push("stats");
        return {
          kind: "datasetStats",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          stats: { missingCells: 7, missingRows: 3, duplicateRows: 2, missingValuesByColumn: [] }
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const originalFilter = opened.metadata.filterModel;
    const changedFilter: FilterModel = {
      filters: [
        {
          column: "sales",
          type: "integer",
          predicates: [{ kind: "predicate", operator: "gt", value: 5 }]
        }
      ],
      sort: []
    };

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "stale-stats-profile",
      filterModel: originalFilter
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile"]));
    const stats = bridge.request({
      kind: "getDatasetStats",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "stale-stats-request",
      filterModel: originalFilter
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "stale-stats-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: changedFilter
    });

    activeProfile.resolve(summaryResponse("stale-stats-profile"));
    await Promise.all([profile, stats, page]);

    expect(executionOrder).toEqual(["profile", "page", "stats"]);
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(changedFilter);
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
  });

  it("clears retained statistics and publishes native state when a same-filter page changes view context", async () => {
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") return pageResponse(request);
      if (request.kind === "getDatasetStats") return datasetStatsResponse(request.viewRequestId);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const requestPage = (viewRequestId: string, viewContextId: string) =>
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: opened.metadata.filterModel
        },
        { viewContextId }
      );

    await requestPage("context-page-a", "logical-context-a");
    await bridge.request(
      {
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "context-stats-a",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-context-a" }
    );
    expect(coordinator.activeSession()?.metadata.stats).toEqual(datasetStatsResponse("ignored").stats);
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    await expect(requestPage("context-page-b", "logical-context-b")).resolves.toMatchObject({
      kind: "page",
      viewRequestId: "context-page-b"
    });

    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(activeChanges.mock.calls[0]?.[0]?.metadata.stats).toBeUndefined();
  });

  it("rejects A-to-B-to-A statistics by opaque view context even when filters match", async () => {
    const pendingStats = deferred<OpenWranglerResponse>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") return pageResponse(request);
      if (request.kind === "getDatasetStats") return pendingStats.promise;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const pageRequest = (viewRequestId: string, viewContextId: string) =>
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: opened.metadata.filterModel
        },
        { viewContextId }
      );

    await pageRequest("same-filter-page-a", "logical-view-a");
    const stats = bridge.request(
      {
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "same-filter-stats-a",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-view-a" }
    );
    await vi.waitFor(() =>
      expect(delegateRequest.mock.calls.some(([request]) => request.kind === "getDatasetStats")).toBe(true)
    );
    await pageRequest("same-filter-page-b", "logical-view-b");
    await pageRequest("same-filter-page-a-again", "logical-view-a-again");

    pendingStats.resolve(datasetStatsResponse("same-filter-stats-a"));
    await stats;
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
  });

  it("rejects a mismatched page response ID before changing retained or persisted state", async () => {
    const changedFilter: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 9 }] }],
      sort: []
    };
    const update = vi.fn(async () => undefined);
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const runtimePageRevisions: number[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") {
        runtimePageRevisions.push(request.revision);
        if (request.viewRequestId === "mismatched-page") {
          const page = pageResponse(request);
          return {
            ...page,
            revision: 1,
            viewRequestId: "different-runtime-request",
            metadata: { ...page.metadata, revision: 1, filterModel: changedFilter }
          };
        }
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const mismatched = await bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "mismatched-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: changedFilter
      },
      { viewContextId: "mismatched-view" }
    );

    expect(mismatched).toMatchObject({
      kind: "error",
      code: "invalid_runtime_response",
      sessionId: opened.metadata.sessionId,
      viewRequestId: "mismatched-page"
    });
    expect(update).not.toHaveBeenCalled();
    expect(activeChanges).not.toHaveBeenCalled();
    expect(coordinator.activeSession()?.metadata).toMatchObject({
      revision: opened.metadata.revision,
      filterModel: opened.metadata.filterModel
    });

    const retry = await bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "matching-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "matching-view" }
    );
    expect(retry).toMatchObject({ kind: "page", revision: opened.metadata.revision, viewRequestId: "matching-page" });
    expect(runtimePageRevisions).toEqual([0, 0]);
  });

  it("rejects a superseded page before it can persist or update native state", async () => {
    const delayedPage = deferred<OpenWranglerResponse>();
    const update = vi.fn(async () => undefined);
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage" && request.viewRequestId === "superseded-page-a") {
        return delayedPage.promise;
      }
      if (request.kind === "getPage") return pageResponse(request);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const filterA: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 1 }] }],
      sort: []
    };
    const filterB: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 2 }] }],
      sort: []
    };
    const requestPage = (viewRequestId: string, viewContextId: string, filterModel: FilterModel) =>
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel
        },
        { viewContextId }
      );

    const pageA = requestPage("superseded-page-a", "logical-view-a", filterA);
    await vi.waitFor(() => expect(delegateRequest).toHaveBeenCalledTimes(2));
    const pageB = requestPage("latest-page-b", "logical-view-b", filterB);
    delayedPage.resolve(
      pageResponse({
        kind: "getPage",
        sessionId: "runtime-session",
        revision: 0,
        viewRequestId: "superseded-page-a",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: filterA
      })
    );

    await expect(pageA).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "superseded-page-a"
    });
    await expect(pageB).resolves.toMatchObject({ kind: "page", viewRequestId: "latest-page-b" });
    expect(update).toHaveBeenCalledOnce();
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterB);
  });

  it("rolls back a page superseded while persistence is deferred without publishing it", async () => {
    const filterA: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 1 }] }],
      sort: []
    };
    const filterB: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 2 }] }],
      sort: []
    };
    const filterC: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 3 }] }],
      sort: []
    };
    const key = persistenceKey(openRequest.source, "polars");
    const savedA = savedSession(filterA);
    let stored: Record<string, unknown> = { [key]: savedA };
    const firstUpdate = deferred<void>();
    let updateCount = 0;
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      updateCount += 1;
      stored = value;
      if (updateCount === 1) await firstUpdate.promise;
    });
    const workspaceState = {
      get: vi.fn((storageKey: string, fallback?: unknown) => (storageKey === SESSION_STORAGE_KEY ? stored : fallback)),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage" && request.viewRequestId === "deferred-latest-page") {
        return {
          kind: "error",
          code: "engine_error",
          message: "The latest page failed.",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage") return pageResponse(request);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the persisted session to open.");
    expect(opened.metadata.filterModel).toEqual(filterA);
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const pageB = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "deferred-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: filterB
      },
      { viewContextId: "deferred-view" }
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterA);
    expect(activeChanges).not.toHaveBeenCalled();

    const pageC = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "deferred-latest-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: filterC
      },
      { viewContextId: "deferred-view" }
    );
    firstUpdate.resolve();

    await expect(pageB).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "deferred-page"
    });
    await expect(pageC).resolves.toMatchObject({
      kind: "error",
      code: "engine_error",
      viewRequestId: "deferred-latest-page"
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(stored).toEqual({ [key]: savedA });
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterA);
    expect(activeChanges).not.toHaveBeenCalled();
  });

  it("persists page viewing state only when the filter model changes", async () => {
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") {
        return pageResponse({
          ...request,
          filterModel: { ...request.filterModel, logic: request.filterModel.logic ?? "and" }
        });
      }
      if (request.kind === "getSummary") return summaryResponse(request.viewRequestId);
      if (request.kind === "getDatasetStats") return datasetStatsResponse(request.viewRequestId);
      if (request.kind === "getColumnValues") {
        return {
          kind: "columnValues",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          column: request.column,
          values: [],
          hasMore: false
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);
    const base = {
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    };

    await bridge.request(
      {
        kind: "getPage",
        ...base,
        viewRequestId: "persistence-page-initial",
        offset: 100,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "persistence-view" }
    );
    expect(activeChanges).not.toHaveBeenCalled();
    await bridge.request({
      kind: "getSummary",
      ...base,
      viewRequestId: "persistence-summary",
      filterModel: opened.metadata.filterModel
    });
    await bridge.request(
      {
        kind: "getDatasetStats",
        ...base,
        viewRequestId: "persistence-stats",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "persistence-view" }
    );
    await bridge.request({
      kind: "getColumnValues",
      ...base,
      viewRequestId: "persistence-values",
      column: "sales",
      filterModel: opened.metadata.filterModel,
      limit: 20
    });
    expect(update).not.toHaveBeenCalled();
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(coordinator.activeSession()?.metadata.stats).toEqual(datasetStatsResponse("ignored").stats);

    activeChanges.mockClear();
    await bridge.request(
      {
        kind: "getPage",
        ...base,
        viewRequestId: "persistence-page-after-stats",
        offset: 200,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "persistence-view" }
    );
    expect(activeChanges).not.toHaveBeenCalled();
    expect(coordinator.activeSession()?.metadata.stats).toEqual(datasetStatsResponse("ignored").stats);

    const changedFilter: FilterModel = {
      filters: [
        {
          column: "sales",
          type: "integer",
          predicates: [{ kind: "predicate", operator: "gt", value: 5 }]
        }
      ],
      sort: []
    };
    await bridge.request({
      kind: "getPage",
      ...base,
      viewRequestId: "persistence-page-filter-change",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: changedFilter
    });
    await bridge.request({
      kind: "getPage",
      ...base,
      viewRequestId: "persistence-page-filter-unchanged",
      offset: 100,
      limit: 100,
      ...columnWindow,
      filterModel: changedFilter
    });

    expect(update).toHaveBeenCalledOnce();
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(stored[persistenceKey(openRequest.source, "polars")]).toMatchObject({
      view: { filterModel: { ...changedFilter, logic: "and" } }
    });
  });

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
      viewRequestId: "terminal-close-during",
      offset: 0,
      limit: 1,
      ...columnWindow,
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
      viewRequestId: "terminal-close-after",
      offset: 0,
      limit: 1,
      ...columnWindow,
      filterModel: { filters: [], sort: [] }
    });
    expect(afterClose).toMatchObject({ kind: "error", code: "unknown_session" });
    expect(delegateRequest).toHaveBeenCalledTimes(3);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(2);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("treats the caller revision as advisory for terminal close", async () => {
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision + 99
      })
    ).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(delegateRequest).toHaveBeenLastCalledWith(
      { kind: "closeSession", sessionId: "runtime-session", revision: opened.metadata.revision },
      undefined
    );
    expect(coordinator.diagnostics().sessions).toEqual([]);
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
    expect(delegateRequest).toHaveBeenCalledTimes(3);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(2);
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

function openedResponse(
  sessionId = "runtime-session",
  backend: SessionMetadata["backend"] = "polars"
): SessionOpenedResponse {
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId,
    revision: 0,
    backend,
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
    page: { offset: 0, limit: openRequest.pageSize, totalRows: 0, columnIds: [], rows: [] },
    summaries: []
  };
}

function savedSession(
  filterModel: FilterModel,
  gridViewState: GridViewState = { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
) {
  return persistedSessionState({ ...openedResponse().metadata, filterModel }, gridViewState);
}

function pageResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  sessionId = "runtime-session",
  backend: SessionMetadata["backend"] = "polars"
): Extract<OpenWranglerResponse, { kind: "page" }> {
  const opened = openedResponse(sessionId, backend);
  return {
    kind: "page",
    revision: opened.metadata.revision,
    viewRequestId: request.viewRequestId,
    metadata: { ...opened.metadata, filterModel: request.filterModel },
    page: { ...opened.page, offset: request.offset, limit: request.limit }
  };
}

function projectedPage(
  request: Extract<
    OpenWranglerRequest,
    { kind: "getPage" | "previewStep" | "applyDraft" | "discardDraft" | "undoStep" }
  >,
  metadata: SessionMetadata
): SessionOpenedResponse["page"] {
  return {
    offset: request.offset,
    limit: request.limit,
    totalRows: metadata.filteredShape.rows,
    columnIds: metadata.schema
      .slice(request.columnOffset, request.columnOffset + request.columnLimit)
      .map((column) => column.id),
    rows: []
  };
}

function pageResponseForMetadata(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  metadata: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata: {
      ...metadata,
      sessionId: request.sessionId,
      revision: request.revision,
      filterModel: request.filterModel
    },
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: metadata.filteredShape.rows,
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    }
  };
}

function stepPreviewResponse(
  revision: number,
  step: TransformStep,
  sessionId = "runtime-session",
  code = "# preview"
): Extract<OpenWranglerResponse, { kind: "stepPreview" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "stepPreview",
    revision,
    metadata: { ...opened.metadata, revision, draftStep: step },
    page: opened.page,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code
  };
}

function stepInspectionResponse(
  request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>,
  stepIndex = 0,
  code = "# inspection"
): Extract<OpenWranglerResponse, { kind: "stepInspection" }> {
  const inspectionPage = {
    offset: request.offset,
    limit: request.limit,
    totalRows: 0,
    columnIds: [],
    rows: []
  };
  return {
    kind: "stepInspection",
    revision: request.revision,
    stepId: request.stepId,
    stepIndex,
    inputPage: inspectionPage,
    outputPage: inspectionPage,
    inputSchema: [],
    outputSchema: [],
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code
  };
}

function planUpdatedResponse(
  revision: number,
  steps: TransformStep[],
  sessionId = "runtime-session",
  code = "# applied"
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "planUpdated",
    action: "apply",
    revision,
    metadata: { ...opened.metadata, revision, steps },
    page: opened.page,
    code
  };
}

function summaryResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "summary" }> {
  return { kind: "summary", revision: 0, viewRequestId, summaries: [] };
}

function columnValuesResponse(
  viewRequestId: string,
  column: string
): Extract<OpenWranglerResponse, { kind: "columnValues" }> {
  return { kind: "columnValues", revision: 0, viewRequestId, column, values: [], hasMore: false };
}

function datasetStatsResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "datasetStats" }> {
  return {
    kind: "datasetStats",
    revision: 0,
    viewRequestId,
    stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
  };
}

function setOpenNotebookDocuments(...documents: NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "notebookDocuments", {
    configurable: true,
    value: documents
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
