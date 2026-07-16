import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  ColumnSchema,
  DataDiff,
  OpenWranglerRequest,
  OpenWranglerResponse,
  DataExportedResponse,
  ErrorResponse,
  FilterModel,
  GridPage,
  OpenSessionRequest,
  PageResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionBoundRequest,
  StepInspectionResponse
} from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";
import { emptyGridViewState, type GridViewState, type PersistedViewingState } from "../shared/viewState";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import {
  decodePersistedSession,
  persistedSessionState,
  persistenceKey,
  SESSION_STORAGE_KEY,
  type DecodedPersistedSessionState,
  type PersistedCleaningState
} from "./sessionPersistence";

interface RuntimeSessionState {
  publicId: string;
  runtimeId: string;
  runtimeRevision: number;
  delegate: OpenWranglerBridge;
  metadata: SessionMetadata;
  code: string;
  viewState: PersistedViewingState;
}

interface CoordinatedSession extends RuntimeSessionState {
  publicRevision: number;
  openRequest: OpenSessionRequest;
  activeViewContextId?: string;
  latestRequestedViewContextId?: string;
  latestRequestedPageRequestId?: string;
  activeForegroundOperation?: Promise<void>;
  activeBackgroundOperation?: Promise<void>;
  interactiveQueue: QueuedSessionOperation[];
  backgroundQueue: QueuedSessionOperation[];
  terminalOperation?: QueuedSessionOperation;
  idleWaiters: Set<() => void>;
  closing: boolean;
  recoveryRequired: boolean;
  stepInspection?: StepInspectionResponse;
  latestStepInspectionKey?: string;
}

interface QueuedSessionOperation {
  request: SessionBoundRequest;
  options?: BridgeRequestOptions;
  resolve(response: OpenWranglerResponse): void;
  reject(error: unknown): void;
}

const SHUTDOWN_TIMEOUT_MS = 2_000;
const RUNTIME_CLEANUP_TIMEOUT_MS = 2_000;
type DetachedRuntimeRole =
  | "recovery candidate"
  | "retired runtime"
  | "saved-plan fallback runtime"
  | "failed saved-state runtime"
  | "invalid open runtime"
  | "late-open runtime"
  | "terminal runtime";

export interface ActiveSessionSnapshot {
  sessionId: string;
  metadata: SessionMetadata;
  code: string;
  viewState: PersistedViewingState;
  stepInspection?: StepInspectionResponse;
}

export interface SessionCoordinatorDiagnostics {
  activeSessionId?: string;
  sessionCount: number;
  sessions: Array<{
    publicId: string;
    runtimeId: string;
    publicRevision: number;
    runtimeRevision: number;
    sourceLabel: string;
  }>;
}

export class SessionCoordinator implements vscode.Disposable {
  private readonly sessions = new Map<string, CoordinatedSession>();
  private readonly pendingOpens = new Map<OpenWranglerBridge, number>();
  private readonly pendingOpenWaiters = new Set<() => void>();
  private readonly activeSessionEmitter = new vscode.EventEmitter<ActiveSessionSnapshot | undefined>();
  private activeSessionId: string | undefined;
  private disposed = false;
  private persistenceTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;
  private readonly detachedCleanups = new Set<Promise<void>>();

  constructor(
    private readonly workspaceState?: vscode.Memento,
    private readonly diagnosticSink?: (message: string) => void
  ) {}

  readonly onDidChangeActiveSession = this.activeSessionEmitter.event;

  createBridge(delegate: OpenWranglerBridge): OpenWranglerBridge {
    return {
      request: (request, options) => this.request(delegate, request, options),
      cancelViewRequests: (sessionId, viewRequestIds) => this.cancelViewRequests(sessionId, viewRequestIds),
      setViewContext: (sessionId, viewContextId) => this.setViewContext(sessionId, viewContextId),
      getViewState: (sessionId) => this.gridViewState(sessionId),
      updateViewState: (sessionId, state) => this.updateGridViewState(sessionId, state),
      clearStepInspection: (sessionId) => this.clearStepInspection(sessionId),
      setActiveSession: (sessionId) => this.setActive(sessionId)
    };
  }

  setActive(sessionId: string | undefined): void {
    if (sessionId !== this.activeSessionId) {
      const previous = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
      if (previous) this.invalidateStepInspection(previous);
      const next = sessionId ? this.sessions.get(sessionId) : undefined;
      if (next) this.invalidateStepInspection(next);
    }
    this.activeSessionId = sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    this.activeSessionEmitter.fire(session ? activeSnapshot(session) : undefined);
  }

  activeSession(): ActiveSessionSnapshot | undefined {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    return session ? activeSnapshot(session) : undefined;
  }

  clearActiveStepInspection(): void {
    if (this.activeSessionId) this.clearStepInspection(this.activeSessionId);
  }

  private gridViewState(sessionId: string): GridViewState | undefined {
    const session = this.sessions.get(sessionId);
    return session ? gridState(session.viewState) : undefined;
  }

  private async updateGridViewState(sessionId: string, state: GridViewState): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return;
    const next = reconcileViewingState({ ...state, filterModel: session.metadata.filterModel }, session.metadata);
    if (isDeepStrictEqual(next, session.viewState)) return;
    const selectedColumnChanged = next.selectedColumnId !== session.viewState.selectedColumnId;
    session.viewState = next;
    await this.persistSession(session);
    if (selectedColumnChanged && this.isLiveSession(session) && this.activeSessionId === session.publicId) {
      this.setActive(session.publicId);
    }
  }

  private clearStepInspection(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const changed = Boolean(session.stepInspection || session.latestStepInspectionKey);
    this.invalidateStepInspection(session);
    if (changed && this.isLiveSession(session) && this.activeSessionId === session.publicId) {
      this.activeSessionEmitter.fire(activeSnapshot(session));
    }
  }

  private invalidateStepInspection(session: CoordinatedSession): void {
    session.stepInspection = undefined;
    session.latestStepInspectionKey = undefined;
  }

  private clearPublishedStepInspection(session: CoordinatedSession): void {
    session.stepInspection = undefined;
  }

  diagnostics(): SessionCoordinatorDiagnostics {
    return {
      activeSessionId: this.activeSessionId,
      sessionCount: this.sessions.size,
      sessions: [...this.sessions.values()].map((session) => ({
        publicId: session.publicId,
        runtimeId: session.runtimeId,
        publicRevision: session.publicRevision,
        runtimeRevision: session.runtimeRevision,
        sourceLabel: session.openRequest.source.label
      }))
    };
  }

  async exportActiveData(path: string, format: "csv" | "parquet"): Promise<DataExportedResponse> {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!session) throw new Error("Open a dataframe in Open Wrangler before exporting cleaned data.");
    const response = await this.request(session.delegate, {
      kind: "exportData",
      sessionId: session.publicId,
      revision: session.publicRevision,
      path,
      format
    });
    if (response.kind === "error") throw new Error(response.message);
    if (response.kind !== "dataExported") throw new Error("The runtime returned an unexpected export response.");
    return response;
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.shutdownPromise ??= this.shutdownSessions(timeoutMs);
    return this.shutdownPromise;
  }

  private async request(
    delegate: OpenWranglerBridge,
    request: OpenWranglerRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      return protocolError(
        "coordinator_disposed",
        "The Open Wrangler session coordinator has been disposed.",
        false,
        undefined,
        requestViewId(request)
      );
    }
    if (request.kind === "openSession") {
      return this.open(delegate, request, options);
    }
    if (!isSessionBoundRequest(request)) {
      return delegate.request(request, options);
    }

    const session = this.sessions.get(request.sessionId);
    if (!session) {
      return protocolError(
        "unknown_session",
        `Unknown Open Wrangler session: ${request.sessionId}`,
        true,
        undefined,
        requestViewId(request)
      );
    }
    if (request.revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Ignored stale request revision ${request.revision}; current revision is ${session.publicRevision}.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (session.closing) {
      return protocolError(
        "session_closing",
        `Open Wrangler session ${session.publicId} is already closing.`,
        true,
        session.publicId,
        requestViewId(request)
      );
    }
    if (request.kind === "closeSession") {
      session.closing = true;
      this.cancelQueuedBackgroundOperations(session);
    }
    if (request.kind === "inspectStep") {
      const inspectionChanged = Boolean(session.stepInspection && session.stepInspection.stepId !== request.stepId);
      if (inspectionChanged) session.stepInspection = undefined;
      session.latestStepInspectionKey = stepInspectionKey(request);
      if (inspectionChanged && this.activeSessionId === session.publicId) {
        this.activeSessionEmitter.fire(activeSnapshot(session));
      }
    } else if (isRuntimeStateMutation(request)) {
      this.clearStepInspection(session.publicId);
    }
    if (request.kind === "getPage") {
      session.latestRequestedPageRequestId = request.viewRequestId;
      session.latestRequestedViewContextId = options?.viewContextId;
    }
    return this.enqueueSessionRequest(session, request, options);
  }

  private async open(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    this.pendingOpens.set(delegate, (this.pendingOpens.get(delegate) ?? 0) + 1);
    try {
      return await this.openTracked(delegate, request, options);
    } finally {
      const remaining = (this.pendingOpens.get(delegate) ?? 1) - 1;
      if (remaining > 0) this.pendingOpens.set(delegate, remaining);
      else this.pendingOpens.delete(delegate);
      this.resolvePendingOpenWaitersIfIdle();
      this.releaseDelegateIfIdle(delegate);
    }
  }

  private async openTracked(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const response = await delegate.request(request, options);
    if (response.kind === "error" || response.kind === "cancelled") return response;
    if (response.kind !== "sessionOpened") {
      return protocolError(
        "invalid_runtime_response",
        `The runtime returned ${response.kind} while opening an Open Wrangler session.`,
        true
      );
    }

    const publicId = randomUUID();
    const session: CoordinatedSession = {
      publicId,
      runtimeId: response.metadata.sessionId,
      publicRevision: response.metadata.revision,
      runtimeRevision: response.metadata.revision,
      openRequest: { ...request, backend: response.metadata.backend },
      delegate,
      interactiveQueue: [],
      backgroundQueue: [],
      idleWaiters: new Set(),
      metadata: response.metadata,
      code: "",
      viewState: initialViewingState(response.metadata),
      closing: false,
      recoveryRequired: false
    };
    const openedMismatch = sessionOpenedResponseMismatch(request, response);
    if (openedMismatch) {
      await this.closeRuntimeState(session, "invalid open runtime");
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid openSession response: ${openedMismatch}`,
        true
      );
    }
    let opened: SessionOpenedResponse = { ...response, summaries: [] };
    const persisted = this.loadPersistedSession(request, response.metadata.backend);
    if (persisted) {
      let cleaningRestored = false;
      try {
        await this.restoreCleaningState(
          session,
          persisted.cleaning,
          request.columnOffset,
          request.columnLimit,
          options
        );
        cleaningRestored = true;
      } catch {
        await this.closeRuntimeState(session, "saved-plan fallback runtime");
        const clean = await delegate.request(session.openRequest, options);
        if (clean.kind === "error" || clean.kind === "cancelled") return clean;
        if (clean.kind !== "sessionOpened") {
          return protocolError(
            "invalid_runtime_response",
            `The runtime returned ${clean.kind} while reopening the immutable source.`,
            true
          );
        }
        session.runtimeId = clean.metadata.sessionId;
        session.runtimeRevision = clean.metadata.revision;
        session.publicRevision = clean.metadata.revision;
        session.metadata = clean.metadata;
        session.code = "";
        session.viewState = initialViewingState(clean.metadata);
        const cleanMismatch = sessionOpenedResponseMismatch(session.openRequest, clean);
        if (cleanMismatch) {
          await this.closeRuntimeState(session, "invalid open runtime");
          return protocolError(
            "invalid_runtime_response",
            `Ignored an invalid openSession response while reopening the immutable source: ${cleanMismatch}`,
            true
          );
        }
        opened = { ...clean, summaries: [] };
        void vscode.window.showWarningMessage(
          `Open Wrangler could not replay the saved cleaning plan for ${request.source.label}. Original data was opened instead.`
        );
      }
      if (cleaningRestored) {
        let page: PageResponse;
        try {
          page = await this.restoreViewingState(
            session,
            persisted.view,
            request.pageSize,
            request.columnOffset,
            request.columnLimit,
            options
          );
        } catch {
          await this.closeRuntimeState(session, "failed saved-state runtime");
          return protocolError(
            "saved_view_restore_failed",
            `Open Wrangler could not restore a confirmed view for ${request.source.label}.`,
            true
          );
        }
        session.publicRevision = session.runtimeRevision;
        opened = {
          kind: "sessionOpened",
          metadata: session.metadata,
          page: page.page,
          summaries: []
        };
      }
    }
    if (this.disposed) {
      await this.closeRuntimeState(session, "late-open runtime");
      return protocolError(
        "coordinator_disposed",
        "The Open Wrangler session coordinator was disposed before the dataframe finished opening.",
        false
      );
    }
    this.sessions.set(publicId, session);
    this.setActive(publicId);
    return publicOpenedResponse(opened, publicId, session.publicRevision);
  }

  private enqueueSessionRequest(
    session: CoordinatedSession,
    request: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    return new Promise((resolve, reject) => {
      const operation: QueuedSessionOperation = { request, options, resolve, reject };
      if (request.kind === "closeSession") {
        // Closing is a terminal barrier: queued background work is discarded before
        // enqueueing it, while active and already-accepted interactive work finish first.
        session.terminalOperation = operation;
      } else if (sessionRequestPriority(request, options) === "background") {
        session.backgroundQueue.push(operation);
      } else {
        session.interactiveQueue.push(operation);
      }
      this.startNextSessionOperation(session);
    });
  }

  private startNextSessionOperation(session: CoordinatedSession): void {
    if (!session.activeForegroundOperation && session.interactiveQueue.length > 0) {
      const next = session.interactiveQueue[0];
      if (!session.activeBackgroundOperation || canRunAlongsideBackground(next.request)) {
        session.interactiveQueue.shift();
        this.startSessionOperation(session, next, "foreground");
      }
    }

    if (
      !session.activeForegroundOperation &&
      !session.activeBackgroundOperation &&
      session.interactiveQueue.length === 0 &&
      session.backgroundQueue.length === 0
    ) {
      const terminal = takeTerminalOperation(session);
      if (terminal) this.startSessionOperation(session, terminal, "foreground");
    }

    if (
      !session.activeForegroundOperation &&
      !session.activeBackgroundOperation &&
      session.interactiveQueue.length === 0 &&
      session.backgroundQueue.length > 0
    ) {
      const background = session.backgroundQueue.shift();
      if (background) this.startSessionOperation(session, background, "background");
    }

    this.resolveSessionIdleWaiters(session);
  }

  private startSessionOperation(
    session: CoordinatedSession,
    operation: QueuedSessionOperation,
    lane: "foreground" | "background"
  ): void {
    const activeOperation = this.executeSessionRequest(session, operation.request, operation.options)
      .then(operation.resolve, operation.reject)
      .finally(() => {
        if (lane === "foreground" && session.activeForegroundOperation === activeOperation) {
          session.activeForegroundOperation = undefined;
        }
        if (lane === "background" && session.activeBackgroundOperation === activeOperation) {
          session.activeBackgroundOperation = undefined;
        }
        this.startNextSessionOperation(session);
      });
    if (lane === "foreground") session.activeForegroundOperation = activeOperation;
    else session.activeBackgroundOperation = activeOperation;
  }

  private waitForSessionIdle(session: CoordinatedSession): Promise<void> {
    if (isSessionIdle(session)) return Promise.resolve();
    return new Promise((resolve) => session.idleWaiters.add(resolve));
  }

  private resolveSessionIdleWaiters(session: CoordinatedSession): void {
    if (!isSessionIdle(session)) return;
    for (const resolve of session.idleWaiters) resolve();
    session.idleWaiters.clear();
  }

  private cancelQueuedBackgroundOperations(session: CoordinatedSession): void {
    this.cancelOperations(session.backgroundQueue.splice(0));
  }

  private cancelViewRequests(sessionId: string, viewRequestIds: readonly string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session || viewRequestIds.length === 0) return;
    const cancelled = new Set(viewRequestIds);
    const discarded: QueuedSessionOperation[] = [];
    const retainUncancelled = (queue: QueuedSessionOperation[]): QueuedSessionOperation[] =>
      queue.filter((operation) => {
        const viewRequestId = requestViewId(operation.request);
        if (viewRequestId && cancelled.has(viewRequestId) && isCancellableQueuedViewRequest(operation.request)) {
          discarded.push(operation);
          return false;
        }
        return true;
      });
    session.interactiveQueue = retainUncancelled(session.interactiveQueue);
    session.backgroundQueue = retainUncancelled(session.backgroundQueue);
    this.cancelOperations(discarded);
    this.startNextSessionOperation(session);
  }

  private setViewContext(sessionId: string, viewContextId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return;
    session.activeViewContextId = viewContextId;
    session.latestRequestedViewContextId = viewContextId;
  }

  private isCurrentPageRequest(
    session: CoordinatedSession,
    request: Extract<SessionBoundRequest, { kind: "getPage" }>,
    options?: BridgeRequestOptions
  ): boolean {
    return (
      request.viewRequestId === session.latestRequestedPageRequestId &&
      (options?.viewContextId === undefined || options.viewContextId === session.latestRequestedViewContextId)
    );
  }

  private cancelAllQueuedOperations(session: CoordinatedSession): void {
    this.cancelOperations(session.interactiveQueue.splice(0));
    this.cancelOperations(session.backgroundQueue.splice(0));
    this.startNextSessionOperation(session);
  }

  private cancelOperations(operations: QueuedSessionOperation[]): void {
    for (const operation of operations) {
      const viewRequestId = requestViewId(operation.request);
      operation.resolve({
        kind: "cancelled",
        targetRequestId: `session-queue:${operation.request.kind}`,
        ...(viewRequestId ? { viewRequestId } : {})
      });
    }
  }

  private async executeSessionRequest(
    session: CoordinatedSession,
    publicRequest: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    // Closing is a terminal barrier and intentionally rebases to the latest
    // runtime revision. Every other queued request must still target the public
    // revision that was current when it entered the queue.
    if (publicRequest.kind !== "closeSession" && publicRequest.revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Ignored stale queued request revision ${publicRequest.revision}; current revision is ${session.publicRevision}.`,
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }
    if (publicRequest.kind !== "closeSession" && session.recoveryRequired) {
      const recovered = !this.disposed && !session.closing && (await this.replay(session, runtimeRecoveryOptions()));
      if (!recovered) {
        return protocolError(
          "runtime_recovery_failed",
          "The prior runtime mutation had an ambiguous transport result and the confirmed session could not be restored.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      session.recoveryRequired = false;
    }
    let requestRuntimeId = session.runtimeId;
    let requestRuntimeRevision = session.runtimeRevision;
    const previousFilterModel = session.metadata.filterModel;
    const isBackground = sessionRequestPriority(publicRequest, options) === "background";
    const canRecoverUnknownSession = (): boolean => !this.disposed && !session.closing && !isBackground;
    const canRecoverTransport = (): boolean => canRecoverUnknownSession() && isIdempotentReadRequest(publicRequest);
    const runtimeRequest = (): SessionBoundRequest =>
      ({
        ...publicRequest,
        sessionId: session.runtimeId,
        revision: session.runtimeRevision
      }) as SessionBoundRequest;

    if (publicRequest.kind === "closeSession") {
      return this.closeSession(session, runtimeRequest(), options);
    }

    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(runtimeRequest(), options);
    } catch (error) {
      if (isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
      // A transport failure is ambiguous for mutations and exports: the remote
      // runtime may have committed before delivery failed. Only pure reads may
      // be replayed and reissued automatically.
      const recovered = canRecoverTransport() && (await this.replay(session, options));
      if (!recovered) throw error;
      requestRuntimeId = session.runtimeId;
      requestRuntimeRevision = session.runtimeRevision;
      response = await session.delegate.request(runtimeRequest(), options);
    }

    if (isUnknownRuntimeSession(response)) {
      // An explicit unknown-session response proves the request did not run, so
      // replay and reissue are safe for all interactive operations.
      const recovered = canRecoverUnknownSession() && (await this.replay(session, options));
      if (recovered) {
        session.recoveryRequired = false;
        requestRuntimeId = session.runtimeId;
        requestRuntimeRevision = session.runtimeRevision;
        response = await session.delegate.request(runtimeRequest(), options);
      }
    }

    if (requestRuntimeId !== session.runtimeId) {
      return protocolError(
        "stale_response",
        "Ignored a response from a replaced runtime session.",
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }

    const mismatch = responseMismatch(publicRequest, response, requestRuntimeId, session.metadata.schema);
    if (mismatch) {
      if (isRuntimeStateMutation(publicRequest)) session.recoveryRequired = true;
      return protocolError(
        "invalid_runtime_response",
        `Ignored an invalid ${publicRequest.kind} response: ${mismatch}`,
        true,
        session.publicId,
        requestViewId(publicRequest)
      );
    }

    if (publicRequest.kind === "inspectStep" && response.kind === "stepInspection") {
      const expectedIndex = session.metadata.steps.findIndex((step) => step.id === publicRequest.stepId);
      if (expectedIndex < 0 || response.stepIndex !== expectedIndex) {
        return protocolError(
          "invalid_runtime_response",
          `Ignored an invalid inspectStep response: runtime reported step index ${response.stepIndex} instead of ${expectedIndex}.`,
          true,
          session.publicId
        );
      }
      if (session.latestStepInspectionKey !== stepInspectionKey(publicRequest)) {
        return protocolError(
          "stale_response",
          "Ignored an applied-step inspection superseded by a newer selection.",
          true,
          session.publicId
        );
      }
      const inspection = { ...response, revision: session.publicRevision };
      session.stepInspection = inspection;
      if (this.isLiveSession(session) && this.activeSessionId === session.publicId) {
        this.activeSessionEmitter.fire(activeSnapshot(session));
      }
      return inspection;
    }

    if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
      const pageRequest = response.kind === "page" && publicRequest.kind === "getPage" ? publicRequest : undefined;
      if (response.kind === "page" && (!pageRequest || response.viewRequestId !== pageRequest.viewRequestId)) {
        return protocolError(
          "stale_response",
          "Ignored a page response correlated to a different request.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      if (pageRequest && !this.isCurrentPageRequest(session, pageRequest, options)) {
        return protocolError(
          "stale_response",
          "Ignored a page from a superseded logical view.",
          true,
          session.publicId,
          pageRequest.viewRequestId
        );
      }
      if (response.revision < requestRuntimeRevision) {
        return protocolError(
          "stale_response",
          "Ignored a stale grid response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      const filterChanged = !sameFilterModel(previousFilterModel, response.metadata.filterModel);
      const revisionChanged = response.revision !== requestRuntimeRevision;
      const planChanged = response.kind === "stepPreview" || response.kind === "planUpdated";
      const stateChanged = filterChanged || revisionChanged || planChanged;
      const nextViewState = reconcileViewingState(
        {
          ...gridState(session.viewState),
          filterModel: response.metadata.filterModel,
          ...(filterChanged && response.kind === "page"
            ? {
                viewport: {
                  firstVisibleRow: response.page.offset,
                  scrollLeft: session.viewState.viewport.scrollLeft
                }
              }
            : {})
        },
        response.metadata
      );
      const viewContextChanged = Boolean(
        pageRequest &&
        session.activeViewContextId !== undefined &&
        options?.viewContextId !== session.activeViewContextId
      );
      const commitState = (): void => {
        if (pageRequest) {
          session.activeViewContextId = options?.viewContextId;
        } else if (planChanged) {
          session.activeViewContextId = undefined;
          session.latestRequestedViewContextId = undefined;
          session.latestRequestedPageRequestId = undefined;
        }
        session.publicRevision += response.revision - requestRuntimeRevision;
        session.runtimeRevision = response.revision;
        if (stateChanged) {
          session.metadata = response.metadata;
          session.viewState = nextViewState;
        }
        if (viewContextChanged) session.metadata = withoutDatasetStats(session.metadata);
        if (response.kind === "stepPreview" || response.kind === "planUpdated") session.code = response.code;
      };
      if (pageRequest && stateChanged) {
        const committed = await this.persistCurrentPage(
          session,
          response.metadata,
          nextViewState,
          () => this.isCurrentPageRequest(session, pageRequest, options),
          () => {
            commitState();
            if (this.isLiveSession(session)) this.setActive(session.publicId);
          }
        );
        if (!committed) {
          return protocolError(
            "stale_response",
            "Ignored a page superseded while its viewing state was being saved.",
            true,
            session.publicId,
            pageRequest.viewRequestId
          );
        }
      } else {
        commitState();
        if (stateChanged) await this.persistSession(session);
        if ((stateChanged || viewContextChanged) && this.isLiveSession(session)) this.setActive(session.publicId);
      }
      return {
        ...response,
        revision: session.publicRevision,
        metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision)
      };
    }
    if (response.kind === "summary" || response.kind === "columnValues") {
      if (response.revision < requestRuntimeRevision || !isCurrentLogicalView(session, options)) {
        return protocolError(
          "stale_response",
          "Ignored a stale or superseded profiling response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "dataExported") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError(
          "stale_response",
          "Ignored a stale export response.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "datasetStats") {
      if (response.revision < requestRuntimeRevision || !isCurrentLogicalView(session, options)) {
        return protocolError(
          "stale_response",
          "Ignored stale or superseded dataset statistics.",
          true,
          session.publicId,
          requestViewId(publicRequest)
        );
      }
      if (
        publicRequest.kind === "getDatasetStats" &&
        options?.viewContextId !== undefined &&
        options.viewContextId === session.activeViewContextId
      ) {
        session.metadata = { ...session.metadata, stats: response.stats };
        if (this.isLiveSession(session)) this.setActive(session.publicId);
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "error" && response.sessionId) {
      return { ...response, sessionId: session.publicId };
    }
    return response;
  }

  private async closeSession(
    session: CoordinatedSession,
    request: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    try {
      const response = await session.delegate.request(request, options);
      if (response.kind === "sessionClosed" && response.sessionId === session.runtimeId) {
        return { ...response, sessionId: session.publicId };
      }

      this.reportRuntimeCleanupDiagnostic(
        session,
        "terminal runtime",
        `initial close was not authoritative: ${cleanupResponseDescription(response, session.runtimeId)}`
      );
      await this.closeRuntimeState(session, "terminal runtime");
      if (response.kind === "error") {
        return { ...response, sessionId: session.publicId };
      }
      return protocolError(
        "invalid_close_response",
        `The runtime returned ${response.kind} while closing the Open Wrangler session.`,
        false,
        session.publicId
      );
    } catch (error) {
      this.reportRuntimeCleanupDiagnostic(
        session,
        "terminal runtime",
        `initial close transport failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.closeRuntimeState(session, "terminal runtime");
      throw error;
    } finally {
      this.releaseSession(session);
    }
  }

  private releaseSession(session: CoordinatedSession): void {
    if (this.sessions.get(session.publicId) !== session) return;
    this.sessions.delete(session.publicId);
    if (this.activeSessionId === session.publicId) this.setActive(undefined);
    this.releaseDelegateIfIdle(session.delegate);
  }

  private async shutdownSessions(timeoutMs: number): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions.values()].map((session) => {
      const alreadyClosing = session.closing;
      session.closing = true;
      this.cancelQueuedBackgroundOperations(session);
      return { session, alreadyClosing };
    });
    const closes = sessions.map(async ({ session, alreadyClosing }) => {
      await this.waitForSessionIdle(session);
      if (alreadyClosing) return;
      try {
        await this.closeSession(session, {
          kind: "closeSession",
          sessionId: session.runtimeId,
          revision: session.runtimeRevision
        });
      } catch {
        // Deactivation still releases local state; a standalone runtime also receives EOF below.
      }
    });

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled([...closes, this.waitForPendingOpens(), this.waitForDetachedCleanups()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            resolve();
          },
          Math.max(0, timeoutMs)
        );
      })
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      for (const { session } of sessions) this.cancelAllQueuedOperations(session);
    }
    for (const { session } of sessions) this.releaseSession(session);
    if (this.activeSessionId) this.setActive(undefined);
    this.activeSessionEmitter.dispose();
  }

  private waitForPendingOpens(): Promise<void> {
    if (this.pendingOpens.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.pendingOpenWaiters.add(resolve));
  }

  private resolvePendingOpenWaitersIfIdle(): void {
    if (this.pendingOpens.size > 0) return;
    for (const resolve of this.pendingOpenWaiters) resolve();
    this.pendingOpenWaiters.clear();
  }

  private loadPersistedSession(
    request: OpenSessionRequest,
    backend: SessionMetadata["backend"]
  ): DecodedPersistedSessionState | undefined {
    const key = persistenceKey(request.source, backend);
    const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {});
    const state = decodePersistedSession(stored?.[key]);
    return state?.backend === backend ? state : undefined;
  }

  private async persistSession(session: CoordinatedSession): Promise<void> {
    if (!this.workspaceState) return;
    const key = persistenceKey(session.openRequest.source, session.metadata.backend);
    const state = persistedSessionState(session.metadata, gridState(session.viewState));
    const task = this.persistenceTail
      .catch(() => undefined)
      .then(async () => {
        const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
        await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...stored, [key]: state });
      });
    this.persistenceTail = task.catch(() => undefined);
    await this.persistenceTail;
  }

  private async persistCurrentPage(
    session: CoordinatedSession,
    metadata: SessionMetadata,
    viewState: PersistedViewingState,
    isCurrent: () => boolean,
    commit: () => void
  ): Promise<boolean> {
    if (!this.workspaceState) {
      if (!isCurrent()) return false;
      commit();
      return true;
    }

    const key = persistenceKey(session.openRequest.source, metadata.backend);
    const state = persistedSessionState(metadata, gridState(viewState));
    let committed = false;
    const task = this.persistenceTail
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return;
        const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
        const hadPreviousState = Object.prototype.hasOwnProperty.call(stored, key);
        const previousState = stored[key];
        try {
          await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...stored, [key]: state });
        } catch {
          // Persistence is best-effort. A current page may still become the live
          // session state, matching the existing coordinator behavior.
          if (isCurrent()) {
            commit();
            committed = true;
          }
          return;
        }
        if (!isCurrent()) {
          const latest = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
          const restored = { ...latest };
          if (hadPreviousState) restored[key] = previousState;
          else delete restored[key];
          try {
            await this.workspaceState?.update(SESSION_STORAGE_KEY, restored);
          } catch {
            // The stale page remains rejected even if best-effort persistence rollback fails.
          }
          return;
        }
        commit();
        committed = true;
      });
    const settled = task.catch(() => undefined);
    this.persistenceTail = settled;
    await settled;
    return committed;
  }

  private async restoreRuntimeState(
    session: RuntimeSessionState,
    state: DecodedPersistedSessionState,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions
  ): Promise<PageResponse> {
    await this.restoreCleaningState(session, state.cleaning, columnOffset, columnLimit, options);
    return this.restoreViewingState(session, state.view, pageSize, columnOffset, columnLimit, options);
  }

  private async restoreCleaningState(
    session: RuntimeSessionState,
    cleaning: PersistedCleaningState,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions
  ): Promise<void> {
    for (const step of cleaning.steps) {
      const previewRequest: SessionBoundRequest = {
        kind: "previewStep",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        step,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit
      };
      const preview = await session.delegate.request(previewRequest, options);
      if (
        preview.kind !== "stepPreview" ||
        responseMismatch(previewRequest, preview, session.runtimeId) !== undefined
      ) {
        throw new Error("Could not replay a cleaning step.");
      }
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
      const applyRequest: SessionBoundRequest = {
        kind: "applyDraft",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit
      };
      const applied = await session.delegate.request(applyRequest, options);
      if (applied.kind !== "planUpdated" || responseMismatch(applyRequest, applied, session.runtimeId) !== undefined) {
        throw new Error("Could not apply a replayed cleaning step.");
      }
      session.runtimeRevision = applied.revision;
      session.metadata = applied.metadata;
      session.code = applied.code;
    }

    if (cleaning.draftStep) {
      const previewRequest: SessionBoundRequest = {
        kind: "previewStep",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        step: cleaning.draftStep,
        replaceStepId: cleaning.draftReplacesStepId,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit
      };
      const preview = await session.delegate.request(previewRequest, options);
      if (
        preview.kind !== "stepPreview" ||
        responseMismatch(previewRequest, preview, session.runtimeId) !== undefined
      ) {
        throw new Error("Could not restore the draft cleaning step.");
      }
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
    }
  }

  private async restoreViewingState(
    session: RuntimeSessionState,
    savedView: PersistedViewingState | undefined,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    options?: BridgeRequestOptions
  ): Promise<PageResponse> {
    if (!savedView)
      return this.restoreOneViewingState(
        session,
        emptyConfirmedViewingState(),
        pageSize,
        columnOffset,
        columnLimit,
        "empty",
        options
      );
    try {
      return await this.restoreOneViewingState(
        session,
        savedView,
        pageSize,
        columnOffset,
        columnLimit,
        "saved",
        options
      );
    } catch {
      return this.restoreOneViewingState(
        session,
        emptyConfirmedViewingState(),
        pageSize,
        columnOffset,
        columnLimit,
        "empty",
        options
      );
    }
  }

  private async restoreOneViewingState(
    session: RuntimeSessionState,
    view: PersistedViewingState,
    pageSize: number,
    columnOffset: number,
    columnLimit: number,
    label: "saved" | "empty",
    options?: BridgeRequestOptions
  ): Promise<PageResponse> {
    const restoredPageSize = Math.max(1, pageSize);
    const desiredOffset = Math.floor(view.viewport.firstVisibleRow / restoredPageSize) * restoredPageSize;
    const requestPage = async (offset: number, suffix: string = label): Promise<PageResponse> => {
      const pageRequest: SessionBoundRequest = {
        kind: "getPage",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        viewRequestId: `restore:${session.publicId}:${session.runtimeRevision}:${suffix}`,
        offset,
        limit: restoredPageSize,
        columnOffset,
        columnLimit,
        filterModel: view.filterModel
      };
      const response = await session.delegate.request(pageRequest, options);
      if (
        response.kind !== "page" ||
        responseMismatch(pageRequest, response, session.runtimeId, session.metadata.schema) !== undefined
      ) {
        throw new Error("Could not restore the saved viewing query.");
      }
      return response;
    };
    let page = await requestPage(desiredOffset);
    if (page.page.totalRows > 0 && desiredOffset >= page.page.totalRows) {
      const finalOffset = Math.floor((page.page.totalRows - 1) / restoredPageSize) * restoredPageSize;
      page = await requestPage(finalOffset, `${label}-bounded`);
    }
    session.runtimeRevision = page.revision;
    session.metadata = page.metadata;
    session.viewState = reconcileViewingState({ ...view, filterModel: page.metadata.filterModel }, page.metadata);
    return page;
  }

  private async replay(session: CoordinatedSession, options?: BridgeRequestOptions): Promise<boolean> {
    const persisted = persistedSessionState(session.metadata, gridState(session.viewState));
    const previous: RuntimeSessionState = {
      publicId: session.publicId,
      runtimeId: session.runtimeId,
      runtimeRevision: session.runtimeRevision,
      delegate: session.delegate,
      metadata: session.metadata,
      code: session.code,
      viewState: session.viewState
    };
    let candidate: RuntimeSessionState | undefined;
    try {
      const response = await session.delegate.request(session.openRequest, options);
      if (response.kind !== "sessionOpened") return false;
      candidate = {
        publicId: session.publicId,
        runtimeId: response.metadata.sessionId,
        runtimeRevision: response.metadata.revision,
        delegate: session.delegate,
        metadata: response.metadata,
        code: "",
        viewState: initialViewingState(response.metadata)
      };
      const openedMismatch = sessionOpenedResponseMismatch(session.openRequest, response);
      if (openedMismatch) throw new Error(openedMismatch);
      await this.restoreRuntimeState(
        candidate,
        persisted,
        1,
        session.openRequest.columnOffset,
        session.openRequest.columnLimit,
        options
      );
    } catch {
      if (candidate) await this.closeRuntimeState(candidate, "recovery candidate");
      return false;
    }

    if (!this.isLiveSession(session) || session.closing) {
      await this.closeRuntimeState(candidate, "recovery candidate");
      return false;
    }

    session.runtimeId = candidate.runtimeId;
    session.runtimeRevision = candidate.runtimeRevision;
    session.metadata = candidate.metadata;
    session.code = candidate.code;
    session.viewState = candidate.viewState;
    this.clearPublishedStepInspection(session);
    this.setActive(session.publicId);
    this.trackDetachedCleanup(previous, "retired runtime");
    return true;
  }

  private trackDetachedCleanup(state: RuntimeSessionState, role: DetachedRuntimeRole): void {
    const cleanup = this.closeRuntimeState(state, role);
    this.detachedCleanups.add(cleanup);
    void cleanup.finally(() => this.detachedCleanups.delete(cleanup));
  }

  private async waitForDetachedCleanups(): Promise<void> {
    while (this.detachedCleanups.size > 0) {
      await Promise.allSettled([...this.detachedCleanups]);
    }
  }

  private async closeRuntimeState(state: RuntimeSessionState, role: DetachedRuntimeRole): Promise<void> {
    try {
      const response = await state.delegate.request(
        {
          kind: "closeSession",
          sessionId: state.runtimeId,
          revision: state.runtimeRevision
        },
        runtimeCleanupOptions()
      );
      if (response.kind === "sessionClosed" && response.sessionId === state.runtimeId) return;
      this.reportRuntimeCleanupDiagnostic(state, role, cleanupResponseDescription(response, state.runtimeId));
    } catch (error) {
      this.reportRuntimeCleanupDiagnostic(state, role, error instanceof Error ? error.message : String(error));
    }
  }

  private reportRuntimeCleanupDiagnostic(state: RuntimeSessionState, role: DetachedRuntimeRole, detail: string): void {
    const message = `Open Wrangler could not confirm cleanup of ${role} session ${state.runtimeId}: ${detail}`;
    try {
      if (state.delegate.reportDiagnostic) state.delegate.reportDiagnostic(message);
      else this.diagnosticSink?.(message);
    } catch {
      try {
        this.diagnosticSink?.(message);
      } catch {
        // Diagnostics must never destabilize the live replacement session.
      }
    }
  }

  private releaseDelegateIfIdle(delegate: OpenWranglerBridge): void {
    if (
      !this.pendingOpens.has(delegate) &&
      ![...this.sessions.values()].some((session) => session.delegate === delegate)
    ) {
      delegate.onIdle?.();
    }
  }

  private isLiveSession(session: CoordinatedSession): boolean {
    return !this.disposed && this.sessions.get(session.publicId) === session;
  }
}

function sessionRequestPriority(
  request: SessionBoundRequest,
  options?: BridgeRequestOptions
): NonNullable<BridgeRequestOptions["priority"]> {
  if (options?.priority) return options.priority;
  return request.kind === "getSummary" || request.kind === "getDatasetStats" ? "background" : "interactive";
}

function takeTerminalOperation(session: CoordinatedSession): QueuedSessionOperation | undefined {
  const operation = session.terminalOperation;
  session.terminalOperation = undefined;
  return operation;
}

function isSessionIdle(session: CoordinatedSession): boolean {
  return (
    !session.activeForegroundOperation &&
    !session.activeBackgroundOperation &&
    session.interactiveQueue.length === 0 &&
    session.backgroundQueue.length === 0 &&
    !session.terminalOperation
  );
}

function canRunAlongsideBackground(request: SessionBoundRequest): boolean {
  return request.kind === "getPage" || request.kind === "getColumnValues";
}

function isIdempotentReadRequest(request: SessionBoundRequest): boolean {
  return (
    request.kind === "getPage" ||
    request.kind === "getSummary" ||
    request.kind === "getDatasetStats" ||
    request.kind === "getColumnValues" ||
    request.kind === "inspectStep"
  );
}

function isRuntimeStateMutation(request: SessionBoundRequest): boolean {
  return (
    request.kind === "previewStep" ||
    request.kind === "applyDraft" ||
    request.kind === "discardDraft" ||
    request.kind === "undoStep"
  );
}

function isCancellableQueuedViewRequest(request: SessionBoundRequest): boolean {
  return request.kind === "getSummary" || request.kind === "getDatasetStats" || request.kind === "getColumnValues";
}

function sameFilterModel(left: FilterModel, right: FilterModel): boolean {
  return isDeepStrictEqual(normalizeFilterModel(left), normalizeFilterModel(right));
}

function isCurrentLogicalView(session: CoordinatedSession, options?: BridgeRequestOptions): boolean {
  return (
    options?.viewContextId === undefined ||
    (options.viewContextId === session.activeViewContextId &&
      options.viewContextId === session.latestRequestedViewContextId)
  );
}

function responseMismatch(
  request: SessionBoundRequest,
  response: OpenWranglerResponse,
  runtimeSessionId: string,
  confirmedPageSchema?: readonly ColumnSchema[]
): string | undefined {
  const expectedViewRequestId = requestViewId(request);
  if (response.kind === "error") {
    if (response.sessionId !== undefined && response.sessionId !== runtimeSessionId) {
      return `error named runtime session ${response.sessionId} instead of ${runtimeSessionId}`;
    }
    if (expectedViewRequestId !== undefined && response.viewRequestId !== expectedViewRequestId) {
      return `error did not retain view request ${expectedViewRequestId}`;
    }
    return undefined;
  }
  if (response.kind === "cancelled") {
    if (expectedViewRequestId !== undefined && response.viewRequestId !== expectedViewRequestId) {
      return `cancellation did not retain view request ${expectedViewRequestId}`;
    }
    return undefined;
  }

  switch (request.kind) {
    case "getPage": {
      if (response.kind !== "page") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "page correlation did not match";
      if (response.revision !== request.revision) {
        return `page revision ${response.revision} did not match ${request.revision}`;
      }
      const pageMetadataMismatch = metadataResponseMismatch(response.metadata, response.revision, runtimeSessionId);
      if (pageMetadataMismatch) return pageMetadataMismatch;
      if (confirmedPageSchema && !isDeepStrictEqual(response.metadata.schema, confirmedPageSchema)) {
        return "page metadata schema changed without a revision";
      }
      return projectedPageMismatch(response.page, confirmedPageSchema ?? response.metadata.schema, request);
    }
    case "getSummary":
      if (response.kind !== "summary") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "summary correlation did not match";
      return response.revision === request.revision
        ? undefined
        : `summary revision ${response.revision} did not match ${request.revision}`;
    case "getDatasetStats":
      if (response.kind !== "datasetStats") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "dataset-statistics correlation did not match";
      return response.revision === request.revision
        ? undefined
        : `dataset-statistics revision ${response.revision} did not match ${request.revision}`;
    case "getColumnValues":
      if (response.kind !== "columnValues") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "column-values correlation did not match";
      if (response.column !== request.column) return `runtime returned values for ${response.column}`;
      return response.revision === request.revision
        ? undefined
        : `column-values revision ${response.revision} did not match ${request.revision}`;
    case "previewStep":
      if (response.kind !== "stepPreview") return `runtime returned ${response.kind}`;
      if (response.revision !== request.revision + 1) {
        return `preview revision ${response.revision} did not follow ${request.revision}`;
      }
      return (
        metadataResponseMismatch(response.metadata, response.revision, runtimeSessionId) ??
        projectedPageMismatch(response.page, response.metadata.schema, request) ??
        dataDiffSchemaMismatch(response.diff, response.metadata.schema)
      );
    case "inspectStep":
      if (response.kind !== "stepInspection") return `runtime returned ${response.kind}`;
      if (response.stepId !== request.stepId) {
        return `runtime inspected step ${response.stepId} instead of ${request.stepId}`;
      }
      if (response.revision !== request.revision) {
        return `inspection revision ${response.revision} did not match ${request.revision}`;
      }
      return (
        projectedPageMismatch(response.inputPage, response.inputSchema, request, "inspection input page") ??
        projectedPageMismatch(response.outputPage, response.outputSchema, request, "inspection output page") ??
        dataDiffSchemaMismatch(response.diff, response.outputSchema)
      );
    case "applyDraft":
    case "discardDraft":
    case "undoStep": {
      if (response.kind !== "planUpdated") return `runtime returned ${response.kind}`;
      const expectedAction =
        request.kind === "applyDraft" ? "apply" : request.kind === "discardDraft" ? "discard" : "undo";
      if (response.action !== expectedAction) {
        return `runtime reported ${response.action} instead of ${expectedAction}`;
      }
      if (response.revision !== request.revision + 1) {
        return `plan revision ${response.revision} did not follow ${request.revision}`;
      }
      return (
        metadataResponseMismatch(response.metadata, response.revision, runtimeSessionId) ??
        projectedPageMismatch(response.page, response.metadata.schema, request)
      );
    }
    case "exportData":
      if (response.kind !== "dataExported") return `runtime returned ${response.kind}`;
      if (response.format !== request.format) return `runtime reported ${response.format} export`;
      if (response.path !== request.path) return "runtime reported a different export path";
      return response.revision === request.revision
        ? undefined
        : `export revision ${response.revision} did not match ${request.revision}`;
    case "closeSession":
      if (response.kind !== "sessionClosed") return `runtime returned ${response.kind}`;
      return response.sessionId === runtimeSessionId
        ? undefined
        : `runtime acknowledged session ${response.sessionId} instead of ${runtimeSessionId}`;
  }
}

function sessionOpenedResponseMismatch(
  request: OpenSessionRequest,
  response: SessionOpenedResponse
): string | undefined {
  if (response.page.offset !== 0) return `page offset ${response.page.offset} did not match 0`;
  if (response.page.limit !== request.pageSize) {
    return `page limit ${response.page.limit} did not match ${request.pageSize}`;
  }
  return projectedPageMismatch(response.page, response.metadata.schema, {
    offset: 0,
    limit: request.pageSize,
    columnOffset: request.columnOffset,
    columnLimit: request.columnLimit
  });
}

function projectedPageMismatch(
  page: GridPage,
  schema: readonly ColumnSchema[],
  request: { offset: number; limit: number; columnOffset: number; columnLimit: number },
  label = "page"
): string | undefined {
  if (page.offset !== request.offset) return `${label} offset ${page.offset} did not match ${request.offset}`;
  if (page.limit !== request.limit) return `${label} limit ${page.limit} did not match ${request.limit}`;
  const expectedColumnIds = schema
    .slice(request.columnOffset, request.columnOffset + request.columnLimit)
    .map((column) => column.id);
  if (!isDeepStrictEqual(page.columnIds, expectedColumnIds)) {
    return `${label} column identities did not match the requested projection`;
  }
  if (page.rows.length > request.limit) return `${label} returned more than ${request.limit} rows`;
  if (page.rows.some((row) => row.values.length !== expectedColumnIds.length)) {
    return `${label} row width did not match its projected column identities`;
  }
  return undefined;
}

function dataDiffSchemaMismatch(diff: DataDiff, outputSchema: readonly ColumnSchema[]): string | undefined {
  for (const cell of diff.cells) {
    const column = outputSchema.find((candidate) => candidate.id === cell.columnId);
    if (!column) return `diff cell named unknown output column identity ${cell.columnId}`;
    if (column.name !== cell.column) {
      return `diff cell label ${cell.column} did not match output column ${column.name}`;
    }
  }
  return undefined;
}

function metadataResponseMismatch(
  metadata: SessionMetadata,
  responseRevision: number,
  runtimeSessionId: string
): string | undefined {
  if (metadata.sessionId !== runtimeSessionId) {
    return `metadata named runtime session ${metadata.sessionId} instead of ${runtimeSessionId}`;
  }
  if (metadata.revision !== responseRevision) {
    return `metadata revision ${metadata.revision} did not match response revision ${responseRevision}`;
  }
  return undefined;
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...withoutStats } = metadata;
  return withoutStats;
}

function runtimeCleanupOptions(): BridgeRequestOptions {
  return {
    priority: "interactive",
    timeoutMs: RUNTIME_CLEANUP_TIMEOUT_MS,
    restartRuntimeOnTimeout: false
  };
}

function runtimeRecoveryOptions(): BridgeRequestOptions {
  return { priority: "interactive" };
}

function cleanupResponseDescription(response: OpenWranglerResponse, expectedSessionId: string): string {
  if (response.kind === "sessionClosed") {
    return `runtime acknowledged session ${response.sessionId} instead of ${expectedSessionId}`;
  }
  if (response.kind === "error") return `${response.code}: ${response.message}`;
  if (response.kind === "cancelled") return `close was cancelled (${response.targetRequestId})`;
  return `runtime returned ${response.kind}`;
}

function requestViewId(request: OpenWranglerRequest): string | undefined {
  return "viewRequestId" in request && typeof request.viewRequestId === "string" ? request.viewRequestId : undefined;
}

function initialViewingState(metadata: SessionMetadata): PersistedViewingState {
  return { ...emptyGridViewState(), filterModel: metadata.filterModel };
}

function emptyConfirmedViewingState(): PersistedViewingState {
  return { ...emptyGridViewState(), filterModel: { filters: [], sort: [] } };
}

function gridState(state: PersistedViewingState): GridViewState {
  return {
    columnWidths: { ...state.columnWidths },
    ...(state.selectedColumnId === undefined ? {} : { selectedColumnId: state.selectedColumnId }),
    viewport: { ...state.viewport }
  };
}

function reconcileViewingState(state: PersistedViewingState, metadata: SessionMetadata): PersistedViewingState {
  const columnIds = new Set(metadata.schema.map((column) => column.id));
  const columnWidths = Object.fromEntries(
    Object.entries(state.columnWidths).filter(([columnId]) => columnIds.has(columnId))
  );
  const finalRow = Math.max(0, metadata.filteredShape.rows - 1);
  const selectedColumnId = state.selectedColumnId;
  return {
    columnWidths,
    ...(selectedColumnId !== undefined && columnIds.has(selectedColumnId) ? { selectedColumnId } : {}),
    viewport: {
      firstVisibleRow: Math.min(state.viewport.firstVisibleRow, finalRow),
      scrollLeft: state.viewport.scrollLeft
    },
    filterModel: metadata.filterModel
  };
}

function normalizeFilterModel(model: FilterModel): unknown {
  return {
    logic: model.logic ?? "and",
    filters: model.filters.map((filter) => ({ ...filter, logic: filter.logic ?? "and" })),
    sort: model.sort
  };
}

function publicMetadata(metadata: SessionMetadata, publicId: string, publicRevision: number): SessionMetadata {
  return { ...metadata, sessionId: publicId, revision: publicRevision };
}

function activeSnapshot(session: CoordinatedSession): ActiveSessionSnapshot {
  const stepInspection = session.stepInspection;
  return {
    sessionId: session.publicId,
    metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision),
    code: stepInspection?.code ?? session.code,
    viewState: session.viewState,
    ...(stepInspection ? { stepInspection } : {})
  };
}

function stepInspectionKey(request: Extract<SessionBoundRequest, { kind: "inspectStep" }>): string {
  return `${request.revision}:${request.stepId}:${request.offset}:${request.limit}:${request.columnOffset}:${request.columnLimit}`;
}

function publicOpenedResponse(
  response: SessionOpenedResponse,
  publicId: string,
  publicRevision: number
): SessionOpenedResponse {
  return { ...response, metadata: publicMetadata(response.metadata, publicId, publicRevision) };
}

function isUnknownRuntimeSession(response: OpenWranglerResponse): response is ErrorResponse {
  return (
    response.kind === "error" && response.code === "engine_error" && response.message.startsWith("Unknown session:")
  );
}

function protocolError(
  code: string,
  message: string,
  recoverable: boolean,
  sessionId?: string,
  viewRequestId?: string
): ErrorResponse {
  return {
    kind: "error",
    code,
    message,
    recoverable,
    ...(sessionId ? { sessionId } : {}),
    ...(viewRequestId ? { viewRequestId } : {})
  };
}
