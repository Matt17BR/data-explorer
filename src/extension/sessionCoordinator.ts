import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  DataExportedResponse,
  ErrorResponse,
  OpenSessionRequest,
  PageResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionBoundRequest
} from "../shared/protocol";
import { isSessionBoundRequest } from "../shared/protocol";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import {
  decodePersistedSession,
  persistedStateFromMetadata,
  persistenceKey,
  SESSION_STORAGE_KEY,
  type PersistedSessionState
} from "./sessionPersistence";

interface CoordinatedSession {
  publicId: string;
  runtimeId: string;
  publicRevision: number;
  runtimeRevision: number;
  openRequest: OpenSessionRequest;
  delegate: OpenWranglerBridge;
  tail: Promise<void>;
  metadata: SessionMetadata;
  code: string;
  closing: boolean;
}

const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface ActiveSessionSnapshot {
  sessionId: string;
  metadata: SessionMetadata;
  code: string;
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

  constructor(private readonly workspaceState?: vscode.Memento) {}

  readonly onDidChangeActiveSession = this.activeSessionEmitter.event;

  createBridge(delegate: OpenWranglerBridge): OpenWranglerBridge {
    return {
      request: (request, options) => this.request(delegate, request, options),
      setActiveSession: (sessionId) => this.setActive(sessionId)
    };
  }

  setActive(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    this.activeSessionEmitter.fire(
      session
        ? {
            sessionId: session.publicId,
            metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision),
            code: session.code
          }
        : undefined
    );
  }

  activeSession(): ActiveSessionSnapshot | undefined {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    return session
      ? {
          sessionId: session.publicId,
          metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision),
          code: session.code
        }
      : undefined;
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
      return protocolError("coordinator_disposed", "The Open Wrangler session coordinator has been disposed.", false);
    }
    if (request.kind === "openSession") {
      return this.open(delegate, request, options);
    }
    if (!isSessionBoundRequest(request)) {
      return delegate.request(request, options);
    }

    const session = this.sessions.get(request.sessionId);
    if (!session) {
      return protocolError("unknown_session", `Unknown Open Wrangler session: ${request.sessionId}`, true);
    }
    if (request.revision !== session.publicRevision) {
      return protocolError(
        "stale_request",
        `Ignored stale request revision ${request.revision}; current revision is ${session.publicRevision}.`,
        true,
        session.publicId
      );
    }
    if (session.closing) {
      return protocolError(
        "session_closing",
        `Open Wrangler session ${session.publicId} is already closing.`,
        true,
        session.publicId
      );
    }
    if (request.kind === "closeSession") session.closing = true;

    const operation = session.tail.then(() => this.executeSessionRequest(session, request, options));
    session.tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
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
    if (response.kind !== "sessionOpened") return response;

    const publicId = randomUUID();
    const session: CoordinatedSession = {
      publicId,
      runtimeId: response.metadata.sessionId,
      publicRevision: response.metadata.revision,
      runtimeRevision: response.metadata.revision,
      openRequest: request,
      delegate,
      tail: Promise.resolve(),
      metadata: response.metadata,
      code: "",
      closing: false
    };
    let opened = response;
    const persisted = this.loadPersistedSession(request);
    if (persisted) {
      try {
        const page = await this.restoreRuntimeState(session, persisted, request.pageSize, options);
        const summary = await delegate.request(
          {
            kind: "getSummary",
            sessionId: session.runtimeId,
            revision: session.runtimeRevision,
            filterModel: persisted.filterModel
          },
          options
        );
        if (summary.kind !== "summary") throw new Error("Could not restore persisted summaries.");
        session.publicRevision = session.runtimeRevision;
        opened = {
          kind: "sessionOpened",
          metadata: session.metadata,
          page: page.page,
          summaries: summary.summaries
        };
      } catch {
        await delegate
          .request({
            kind: "closeSession",
            sessionId: session.runtimeId,
            revision: session.runtimeRevision
          })
          .catch(() => undefined);
        const clean = await delegate.request(request, options);
        if (clean.kind !== "sessionOpened") return clean;
        session.runtimeId = clean.metadata.sessionId;
        session.runtimeRevision = clean.metadata.revision;
        session.publicRevision = clean.metadata.revision;
        session.metadata = clean.metadata;
        session.code = "";
        opened = clean;
        void vscode.window.showWarningMessage(
          `Open Wrangler could not replay the saved cleaning plan for ${request.source.label}. Original data was opened instead.`
        );
      }
    }
    if (this.disposed) {
      try {
        await delegate.request(
          {
            kind: "closeSession",
            sessionId: session.runtimeId,
            revision: session.runtimeRevision
          },
          options
        );
      } catch {
        // Shutdown remains terminal even if the runtime disappears during the late-open cleanup.
      }
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

  private async executeSessionRequest(
    session: CoordinatedSession,
    publicRequest: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    let requestRuntimeRevision = session.runtimeRevision;
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
      const recovered = await this.replay(session, options);
      if (!recovered) throw error;
      requestRuntimeRevision = session.runtimeRevision;
      response = await session.delegate.request(runtimeRequest(), options);
    }

    if (isUnknownRuntimeSession(response)) {
      const recovered = await this.replay(session, options);
      if (recovered) {
        requestRuntimeRevision = session.runtimeRevision;
        response = await session.delegate.request(runtimeRequest(), options);
      }
    }

    if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError("stale_response", "Ignored a stale grid response.", true, session.publicId);
      }
      session.publicRevision += response.revision - requestRuntimeRevision;
      session.runtimeRevision = response.revision;
      session.metadata = response.metadata;
      if (response.kind === "stepPreview" || response.kind === "planUpdated") session.code = response.code;
      await this.persistSession(session);
      this.setActive(session.publicId);
      return {
        ...response,
        revision: session.publicRevision,
        metadata: publicMetadata(response.metadata, session.publicId, session.publicRevision)
      };
    }
    if (response.kind === "summary" || response.kind === "columnValues") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError("stale_response", "Ignored a stale profiling response.", true, session.publicId);
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "dataExported") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError("stale_response", "Ignored a stale export response.", true, session.publicId);
      }
      return { ...response, revision: session.publicRevision };
    }
    if (response.kind === "datasetStats") {
      if (response.revision < requestRuntimeRevision) {
        return protocolError("stale_response", "Ignored stale dataset statistics.", true, session.publicId);
      }
      session.metadata = { ...session.metadata, stats: response.stats };
      this.setActive(session.publicId);
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
    let response: OpenWranglerResponse;
    try {
      response = await session.delegate.request(request, options);
    } finally {
      this.releaseSession(session);
    }
    if (response.kind === "sessionClosed") {
      return { ...response, sessionId: session.publicId };
    }
    if (response.kind === "error") {
      return { ...response, sessionId: session.publicId };
    }
    return protocolError(
      "invalid_close_response",
      `The runtime returned ${response.kind} while closing the Open Wrangler session.`,
      false,
      session.publicId
    );
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
      return { session, alreadyClosing };
    });
    const closes = sessions.map(async ({ session, alreadyClosing }) => {
      await session.tail;
      if (alreadyClosing || this.sessions.get(session.publicId) !== session) return;
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
    await Promise.race([
      Promise.allSettled([...closes, this.waitForPendingOpens()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      })
    ]);
    if (timer) clearTimeout(timer);
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

  private loadPersistedSession(request: OpenSessionRequest): PersistedSessionState | undefined {
    const key = persistenceKey(request.source);
    const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {});
    return decodePersistedSession(stored?.[key]);
  }

  private async persistSession(session: CoordinatedSession): Promise<void> {
    if (!this.workspaceState) return;
    const key = persistenceKey(session.openRequest.source);
    const state = persistedStateFromMetadata(session.metadata);
    const task = this.persistenceTail
      .catch(() => undefined)
      .then(async () => {
        const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
        await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...stored, [key]: state });
      });
    this.persistenceTail = task.catch(() => undefined);
    await this.persistenceTail;
  }

  private async restoreRuntimeState(
    session: CoordinatedSession,
    state: PersistedSessionState,
    pageSize: number,
    options?: BridgeRequestOptions
  ): Promise<PageResponse> {
    for (const step of state.steps) {
      const preview = await session.delegate.request(
        {
          kind: "previewStep",
          sessionId: session.runtimeId,
          revision: session.runtimeRevision,
          step,
          offset: 0,
          limit: 1
        },
        options
      );
      if (preview.kind !== "stepPreview") throw new Error("Could not replay a cleaning step.");
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
      const applied = await session.delegate.request(
        {
          kind: "applyDraft",
          sessionId: session.runtimeId,
          revision: session.runtimeRevision,
          offset: 0,
          limit: 1
        },
        options
      );
      if (applied.kind !== "planUpdated") throw new Error("Could not apply a replayed cleaning step.");
      session.runtimeRevision = applied.revision;
      session.metadata = applied.metadata;
      session.code = applied.code;
    }

    if (state.draftStep) {
      const preview = await session.delegate.request(
        {
          kind: "previewStep",
          sessionId: session.runtimeId,
          revision: session.runtimeRevision,
          step: state.draftStep,
          replaceStepId: state.draftReplacesStepId,
          offset: 0,
          limit: 1
        },
        options
      );
      if (preview.kind !== "stepPreview") throw new Error("Could not restore the draft cleaning step.");
      session.runtimeRevision = preview.revision;
      session.metadata = preview.metadata;
      session.code = preview.code;
    }

    const page = await session.delegate.request(
      {
        kind: "getPage",
        sessionId: session.runtimeId,
        revision: session.runtimeRevision,
        offset: 0,
        limit: pageSize,
        filterModel: state.filterModel
      },
      options
    );
    if (page.kind !== "page") throw new Error("Could not restore the saved viewing query.");
    session.runtimeRevision = page.revision;
    session.metadata = page.metadata;
    return page;
  }

  private async replay(session: CoordinatedSession, options?: BridgeRequestOptions): Promise<boolean> {
    try {
      const previous = session.metadata;
      const response = await session.delegate.request(session.openRequest, options);
      if (response.kind !== "sessionOpened") return false;
      session.runtimeId = response.metadata.sessionId;
      session.runtimeRevision = response.metadata.revision;
      session.metadata = response.metadata;
      session.code = "";
      await this.restoreRuntimeState(session, persistedStateFromMetadata(previous), 1, options);
      this.setActive(session.publicId);
      return true;
    } catch {
      return false;
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
}

function publicMetadata(metadata: SessionMetadata, publicId: string, publicRevision: number): SessionMetadata {
  return { ...metadata, sessionId: publicId, revision: publicRevision };
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

function protocolError(code: string, message: string, recoverable: boolean, sessionId?: string): ErrorResponse {
  return { kind: "error", code, message, recoverable, sessionId };
}
