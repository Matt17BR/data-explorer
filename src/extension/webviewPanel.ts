import * as path from "path";
import * as vscode from "vscode";
import type {
  DataBackend,
  DataExplorerRequest,
  DataExplorerResponse,
  OperationKind,
  SessionOpenedResponse,
  SessionSource
} from "../shared/protocol";
import type { DataExplorerBridge } from "./dataBridge";

export class DataExplorerPanel {
  private static activePanel: DataExplorerPanel | undefined;
  private sessionId: string | undefined;
  private sessionRevision = 0;
  private snapshot: SessionOpenedResponse | undefined;
  private opening: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: DataExplorerBridge,
    private readonly source: SessionSource,
    private readonly backend?: DataBackend,
    private readonly initialResponse?: SessionOpenedResponse
  ) {
    DataExplorerPanel.activePanel = this;
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) {
          DataExplorerPanel.activePanel = this;
          if (this.sessionId) this.bridge.setActiveSession?.(this.sessionId);
        }
      },
      undefined,
      this.disposables
    );
  }

  static sendEditorAction(message: EditorActionMessage): boolean {
    const active = DataExplorerPanel.activePanel;
    if (!active) return false;
    if (message.action === "openOperation" || message.action === "editLatest") {
      active.panel.reveal(active.panel.viewColumn, false);
    }
    void active.panel.webview.postMessage({ kind: "editorAction", ...message });
    return true;
  }

  static create(
    context: vscode.ExtensionContext,
    bridge: DataExplorerBridge,
    source: SessionSource,
    backend?: DataBackend
  ): DataExplorerPanel {
    const panel = vscode.window.createWebviewPanel(
      "dataExplorer.viewer",
      `Data Explorer: ${source.label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))]
      }
    );

    return new DataExplorerPanel(panel, context, bridge, source, backend);
  }

  static createFromPayload(
    context: vscode.ExtensionContext,
    bridge: DataExplorerBridge,
    response: SessionOpenedResponse
  ): DataExplorerPanel {
    const panel = vscode.window.createWebviewPanel(
      "dataExplorer.viewer",
      `Data Explorer: ${response.metadata.source.label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))]
      }
    );

    return new DataExplorerPanel(panel, context, bridge, response.metadata.source, response.metadata.backend, response);
  }

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    const configuration = vscode.workspace.getConfiguration("dataExplorer");
    const pageSize = configuredBlockSize(configuration);
    const isFile = this.source.kind === "file";
    const mode = configuration.get<"editing" | "viewing">(
      isFile ? "fileStartMode" : "notebookStartMode",
      isFile ? "editing" : "viewing"
    );
    this.opening = this.forward({
      kind: "openSession",
      source: this.source,
      backend: this.backend,
      pageSize,
      mode
    });
    await this.opening;
    if (!this.sessionId) this.opening = undefined;
  }

  dispose(): void {
    if (DataExplorerPanel.activePanel === this) DataExplorerPanel.activePanel = undefined;
    if (this.sessionId && !this.initialResponse) {
      void this.bridge.request({
        kind: "closeSession",
        sessionId: this.sessionId,
        revision: this.sessionRevision
      });
      this.sessionId = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!this.isWebviewRequest(message)) {
      return;
    }

    if (message.kind === "ready") {
      if (!this.snapshot && this.initialResponse) {
        this.snapshot = this.initialResponse;
        this.sessionId = this.snapshot.metadata.sessionId;
        this.sessionRevision = this.snapshot.metadata.revision;
      }
      if (this.snapshot) {
        await this.post(this.snapshot);
        return;
      }
      await this.open();
      return;
    }

    if (!this.sessionId) {
      await this.post({
        kind: "error",
        code: "session_not_open",
        message: "Session has not been opened yet.",
        recoverable: true
      });
      return;
    }

    const request = {
      ...message.request,
      sessionId: this.sessionId,
      revision: this.sessionRevision
    } as DataExplorerRequest;
    if (request.kind === "previewStep" && request.step.kind === "customCode" && !vscode.workspace.isTrusted) {
      await this.post({
        kind: "error",
        code: "workspace_untrusted",
        message: "Trust this workspace before running custom Python code.",
        recoverable: true
      });
      return;
    }
    await this.forward(request);
  }

  private async forward(request: DataExplorerRequest): Promise<void> {
    try {
      const response = await this.bridge.request(request);
      if (response.kind === "sessionOpened") {
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.metadata.revision;
        this.snapshot = response;
      }
      if (response.kind === "page" || response.kind === "stepPreview" || response.kind === "planUpdated") {
        this.sessionId = response.metadata.sessionId;
        this.sessionRevision = response.revision;
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, metadata: response.metadata, page: response.page };
        }
      }
      if (response.kind === "summary" && this.snapshot) {
        this.snapshot = { ...this.snapshot, summaries: response.summaries };
      }
      if (response.kind === "datasetStats" && this.snapshot) {
        this.snapshot = {
          ...this.snapshot,
          metadata: { ...this.snapshot.metadata, stats: response.stats }
        };
      }
      await this.post(response);
    } catch (error) {
      await this.post({
        kind: "error",
        code: "bridge_error",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true
      });
    }
  }

  private async post(response: DataExplorerResponse): Promise<void> {
    await this.panel.webview.postMessage(response);
  }

  private isWebviewRequest(
    message: unknown
  ): message is { kind: "ready" } | { kind: "runtimeRequest"; request: Omit<DataExplorerRequest, "sessionId"> } {
    if (typeof message !== "object" || message === null || !("kind" in message)) {
      return false;
    }
    const kind = (message as { kind: unknown }).kind;
    return kind === "ready" || kind === "runtimeRequest";
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
    const configuration = vscode.workspace.getConfiguration("dataExplorer");
    const fetchBlockSize = configuredBlockSize(configuration);
    const defaultColumnWidth = configuration.get<number>("defaultColumnWidth", 190);
    const insightsOnOpen = configuration.get<boolean>("insightsOnOpen", true);
    const filterMode = configuration.get<"basic" | "advanced">("filterMode", "basic");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Data Explorer</title>
</head>
<body data-fetch-block-size="${fetchBlockSize}" data-default-column-width="${defaultColumnWidth}" data-insights-on-open="${insightsOnOpen}" data-filter-mode="${filterMode}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export interface EditorActionMessage {
  action: "openOperation" | "editLatest" | "applyDraft" | "discardDraft" | "undoStep";
  operationKind?: OperationKind;
}

const randomNonce = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
};

function configuredBlockSize(configuration: vscode.WorkspaceConfiguration): number {
  const inspected = configuration.inspect<number>("fetchBlockSize");
  const explicitlyConfigured =
    inspected?.globalValue ??
    inspected?.workspaceValue ??
    inspected?.workspaceFolderValue ??
    inspected?.globalLanguageValue ??
    inspected?.workspaceLanguageValue ??
    inspected?.workspaceFolderLanguageValue;
  return explicitlyConfigured ?? configuration.get<number>("pageSize", 200);
}
