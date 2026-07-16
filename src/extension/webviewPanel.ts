import * as path from "path";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  OperationKind,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource
} from "../shared/protocol";
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import { decodeGridViewState, type GridViewState } from "../shared/viewState";
import type { OpenWranglerBridge } from "./dataBridge";
import { getSetting } from "./configuration";

export class OpenWranglerPanel {
  private static activePanel: OpenWranglerPanel | undefined;
  private sessionId: string | undefined;
  private sessionRevision = 0;
  private snapshot: SessionOpenedResponse | undefined;
  private snapshotViewContextId: string | undefined;
  private latestPageViewRequestId: string | undefined;
  private opening: Promise<void> | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: OpenWranglerBridge,
    private readonly source: SessionSource,
    private readonly backend?: DataBackend,
    private readonly initialResponse?: SessionOpenedResponse
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      undefined,
      this.disposables
    );
    if (this.initialResponse) {
      this.snapshot = this.initialResponse;
      this.sessionId = this.initialResponse.metadata.sessionId;
      this.sessionRevision = this.initialResponse.metadata.revision;
    } else {
      void this.open();
    }
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.activate();
    this.panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) this.activate();
      },
      undefined,
      this.disposables
    );
  }

  static sendEditorAction(message: EditorActionMessage): boolean {
    const active = OpenWranglerPanel.activePanel;
    if (!active) return false;
    if (message.action === "openOperation" || message.action === "editLatest" || message.action === "selectStep") {
      active.panel.reveal(active.panel.viewColumn, false);
    }
    void active.panel.webview.postMessage({ kind: "editorAction", ...message });
    return true;
  }

  static create(
    context: vscode.ExtensionContext,
    bridge: OpenWranglerBridge,
    source: SessionSource,
    backend?: DataBackend
  ): OpenWranglerPanel {
    const panel = vscode.window.createWebviewPanel(
      "openWrangler.viewer",
      `Open Wrangler: ${source.label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))]
      }
    );

    return new OpenWranglerPanel(panel, context, bridge, source, backend);
  }

  static createFromPayload(
    context: vscode.ExtensionContext,
    bridge: OpenWranglerBridge,
    response: SessionOpenedResponse
  ): OpenWranglerPanel {
    const panel = vscode.window.createWebviewPanel(
      "openWrangler.viewer",
      `Open Wrangler: ${response.metadata.source.label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))]
      }
    );

    return new OpenWranglerPanel(panel, context, bridge, response.metadata.source, response.metadata.backend, response);
  }

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    const pageSize = getSetting<number>("fetchBlockSize", 200);
    const columnLimit = fetchColumnBlockSize();
    const isFile = this.source.kind === "file";
    const mode = getSetting<"editing" | "viewing">(
      isFile ? "fileStartMode" : "notebookStartMode",
      isFile ? "editing" : "viewing"
    );
    this.opening = this.forward({
      kind: "openSession",
      source: this.source,
      backend: this.backend,
      pageSize,
      columnOffset: 0,
      columnLimit,
      mode
    });
    await this.opening;
    if (!this.sessionId) this.opening = undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (OpenWranglerPanel.activePanel === this) {
      OpenWranglerPanel.activePanel = undefined;
      this.bridge.setActiveSession?.(undefined);
    }
    if (this.sessionId && !this.initialResponse) {
      void this.bridge
        .request({
          kind: "closeSession",
          sessionId: this.sessionId,
          revision: this.sessionRevision
        })
        .catch(() => undefined);
      this.sessionId = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const decoded = this.decodeWebviewMessage(message);
    if (!decoded) {
      return;
    }

    if (decoded.kind === "ready") {
      if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      await this.postStepInspectionCleared(false);
      if (this.snapshot) {
        await this.post(this.snapshot);
        await this.postViewState();
        return;
      }
      await this.open();
      return;
    }

    if (decoded.kind === "setViewContext") {
      this.snapshotViewContextId = decoded.viewContextId;
      if (this.sessionId) this.bridge.setViewContext?.(this.sessionId, decoded.viewContextId);
      return;
    }

    if (decoded.kind === "cancelViewRequests") {
      if (this.sessionId && decoded.viewRequestIds.length) {
        this.bridge.cancelViewRequests?.(this.sessionId, decoded.viewRequestIds);
      }
      return;
    }

    if (decoded.kind === "updateViewState") {
      if (this.sessionId) await this.bridge.updateViewState?.(this.sessionId, decoded.state);
      return;
    }

    if (decoded.kind === "clearStepInspection") {
      if (this.sessionId) this.bridge.clearStepInspection?.(this.sessionId);
      return;
    }

    if (!this.sessionId) {
      await this.post({
        kind: "error",
        code: "session_not_open",
        message: "Session has not been opened yet.",
        recoverable: true,
        ...viewRequestIdProperty(decoded.request)
      });
      return;
    }

    const request = decoded.request;
    if (request.kind === "previewStep" && request.step.kind === "customCode" && !vscode.workspace.isTrusted) {
      await this.post({
        kind: "error",
        code: "workspace_untrusted",
        message: "Trust this workspace before running custom Python code.",
        recoverable: true
      });
      return;
    }
    await this.forward(request, decoded.viewContextId);
  }

  private async forward(request: OpenWranglerRequest, viewContextId?: string): Promise<void> {
    if (request.kind === "getPage") this.latestPageViewRequestId = request.viewRequestId;
    try {
      const response = correlateViewError(
        request,
        await this.bridge.request(request, viewContextId ? { viewContextId } : undefined)
      );
      if (this.disposed) {
        if (response.kind === "sessionOpened" && !this.initialResponse) {
          await this.bridge.request({
            kind: "closeSession",
            sessionId: response.metadata.sessionId,
            revision: response.metadata.revision
          });
        }
        return;
      }
      if (response.kind === "sessionOpened") {
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
        this.snapshotViewContextId = undefined;
        if (OpenWranglerPanel.activePanel === this) this.bridge.setActiveSession?.(this.sessionId);
      }
      if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.revision;
        const acceptsPage =
          response.kind !== "page" ||
          (request.kind === "getPage" &&
            response.viewRequestId === request.viewRequestId &&
            this.latestPageViewRequestId === response.viewRequestId);
        if (this.snapshot && acceptsPage) {
          const sameView =
            response.kind === "page" && viewContextId !== undefined && viewContextId === this.snapshotViewContextId;
          const metadata =
            sameView && this.snapshot.metadata.stats
              ? { ...response.metadata, stats: this.snapshot.metadata.stats }
              : withoutDatasetStats(response.metadata);
          this.snapshot = {
            ...this.snapshot,
            metadata,
            page: response.page,
            summaries: sameView ? this.snapshot.summaries : []
          };
          this.snapshotViewContextId = response.kind === "page" ? viewContextId : undefined;
        }
      }
      if (
        response.kind === "summary" &&
        request.kind === "getSummary" &&
        response.viewRequestId === request.viewRequestId &&
        this.snapshot &&
        viewContextId !== undefined &&
        viewContextId === this.snapshotViewContextId
      ) {
        const summaries = new Map(this.snapshot.summaries.map((summary) => [summary.column, summary]));
        for (const summary of response.summaries) summaries.set(summary.column, summary);
        this.snapshot = { ...this.snapshot, summaries: [...summaries.values()] };
      }
      if (
        response.kind === "datasetStats" &&
        request.kind === "getDatasetStats" &&
        response.viewRequestId === request.viewRequestId &&
        this.snapshot &&
        viewContextId !== undefined &&
        viewContextId === this.snapshotViewContextId
      ) {
        this.snapshot = {
          ...this.snapshot,
          metadata: { ...this.snapshot.metadata, stats: response.stats }
        };
      }
      await this.postRuntimeResponse(request, response);
      if (response.kind === "sessionOpened" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        await this.postViewState();
      }
    } catch (error) {
      await this.postRuntimeResponse(request, {
        kind: "error",
        code: "bridge_error",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
        ...viewRequestIdProperty(request)
      });
    }
  }

  private async post(response: OpenWranglerResponse): Promise<void> {
    await this.panel.webview.postMessage(response);
  }

  private activate(): void {
    if (this.disposed) return;
    const previous = OpenWranglerPanel.activePanel;
    if (previous !== this) {
      OpenWranglerPanel.activePanel = this;
      if (previous) void previous.postStepInspectionCleared(false);
      void this.postStepInspectionCleared(true);
    }
    this.bridge.setActiveSession?.(this.sessionId);
  }

  private async postStepInspectionCleared(resumeProfiling: boolean): Promise<void> {
    if (this.disposed) return;
    await this.panel.webview.postMessage({ kind: "stepInspectionCleared", resumeProfiling });
  }

  private async postRuntimeResponse(request: OpenWranglerRequest, response: OpenWranglerResponse): Promise<void> {
    if (request.kind === "inspectStep") {
      await this.panel.webview.postMessage({
        kind: "stepInspectionResult",
        stepId: request.stepId,
        offset: request.offset,
        limit: request.limit,
        columnOffset: request.columnOffset,
        columnLimit: request.columnLimit,
        response
      });
      return;
    }
    await this.post(response);
  }

  private async postViewState(): Promise<void> {
    if (!this.sessionId) return;
    const state = this.bridge.getViewState?.(this.sessionId);
    if (state) await this.panel.webview.postMessage({ kind: "viewState", state });
  }

  private decodeWebviewMessage(message: unknown): WebviewRequest | undefined {
    if (!isRecord(message) || typeof message.kind !== "string") return undefined;
    if (message.kind === "ready") {
      return hasExactKeys(message, ["kind"]) ? { kind: "ready" } : undefined;
    }
    if (message.kind === "setViewContext") {
      return hasExactKeys(message, ["kind", "viewContextId"]) && isNonEmptyString(message.viewContextId)
        ? { kind: "setViewContext", viewContextId: message.viewContextId }
        : undefined;
    }
    if (message.kind === "cancelViewRequests") {
      return hasExactKeys(message, ["kind", "viewRequestIds"]) &&
        Array.isArray(message.viewRequestIds) &&
        message.viewRequestIds.every(isNonEmptyString)
        ? { kind: "cancelViewRequests", viewRequestIds: [...message.viewRequestIds] }
        : undefined;
    }
    if (message.kind === "updateViewState") {
      if (!hasExactKeys(message, ["kind", "state"])) return undefined;
      const state = decodeGridViewState(message.state);
      return state ? { kind: "updateViewState", state } : undefined;
    }
    if (message.kind === "clearStepInspection") {
      return hasExactKeys(message, ["kind"]) ? { kind: "clearStepInspection" } : undefined;
    }
    if (
      message.kind !== "runtimeRequest" ||
      !hasExactKeys(message, ["kind", "request"], ["viewContextId"]) ||
      !isRecord(message.request) ||
      Object.prototype.hasOwnProperty.call(message.request, "sessionId") ||
      Object.prototype.hasOwnProperty.call(message.request, "revision") ||
      (message.viewContextId !== undefined && !isNonEmptyString(message.viewContextId))
    ) {
      return undefined;
    }
    const request = {
      ...message.request,
      sessionId: this.sessionId ?? "pending-session",
      revision: this.sessionRevision
    };
    if (!isOpenWranglerRequest(request) || !WEBVIEW_RUNTIME_REQUEST_KINDS.has(request.kind)) return undefined;
    return {
      kind: "runtimeRequest",
      request,
      ...(message.viewContextId === undefined ? {} : { viewContextId: message.viewContextId })
    };
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.js"))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.css"))
    );
    const nonce = randomNonce();
    const fetchBlockSize = getSetting<number>("fetchBlockSize", 200);
    const columnBlockSize = fetchColumnBlockSize();
    const defaultColumnWidth = getSetting<number>("defaultColumnWidth", 190);
    const insightsOnOpen = getSetting<boolean>("insightsOnOpen", true);
    const filterMode = getSetting<"basic" | "advanced">("filterMode", "basic");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Open Wrangler</title>
</head>
<body data-fetch-block-size="${fetchBlockSize}" data-fetch-column-block-size="${columnBlockSize}" data-default-column-width="${defaultColumnWidth}" data-insights-on-open="${insightsOnOpen}" data-filter-mode="${filterMode}">
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fetchColumnBlockSize(): number {
  const configured = getSetting<number>("fetchColumnBlockSize", 16);
  return Number.isInteger(configured) ? Math.min(256, Math.max(1, configured)) : 16;
}

function correlateViewError(request: OpenWranglerRequest, response: OpenWranglerResponse): OpenWranglerResponse {
  if ((response.kind !== "error" && response.kind !== "cancelled") || response.viewRequestId) return response;
  return { ...response, ...viewRequestIdProperty(request) };
}

function viewRequestIdProperty(request: { kind: string; viewRequestId?: unknown }): { viewRequestId?: string } {
  return typeof request.viewRequestId === "string" && request.viewRequestId
    ? { viewRequestId: request.viewRequestId }
    : {};
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...rest } = metadata;
  return rest;
}

type WebviewRequest =
  | { kind: "ready" }
  | { kind: "setViewContext"; viewContextId: string }
  | { kind: "cancelViewRequests"; viewRequestIds: string[] }
  | { kind: "updateViewState"; state: GridViewState }
  | { kind: "clearStepInspection" }
  | {
      kind: "runtimeRequest";
      request: OpenWranglerRequest;
      viewContextId?: string;
    };

const WEBVIEW_RUNTIME_REQUEST_KINDS = new Set<OpenWranglerRequest["kind"]>([
  "getPage",
  "getSummary",
  "getDatasetStats",
  "getColumnValues",
  "inspectStep",
  "previewStep",
  "applyDraft",
  "discardDraft",
  "undoStep"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export interface EditorActionMessage {
  action: "openOperation" | "editLatest" | "selectStep" | "applyDraft" | "discardDraft" | "undoStep";
  operationKind?: OperationKind;
  stepId?: string;
}

const randomNonce = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
};
