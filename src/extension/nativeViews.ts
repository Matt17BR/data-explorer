import * as path from "path";
import * as vscode from "vscode";
import { operationCatalog, operationByKind } from "../shared/operations";
import type { FilterModel, OperationKind, SessionMetadata } from "../shared/protocol";
import { SessionCoordinator, type ActiveSessionSnapshot } from "./sessionCoordinator";
import { DataExplorerPanel } from "./webviewPanel";

type ViewKind = "operations" | "summary" | "filters" | "steps";

class DataExplorerTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ViewNode | undefined>();
  private snapshot: ActiveSessionSnapshot | undefined;
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly kind: ViewKind,
    coordinator: SessionCoordinator
  ) {
    this.snapshot = coordinator.activeSession();
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      this.snapshot = snapshot;
      this.changeEmitter.fire(undefined);
    });
  }

  getTreeItem(element: ViewNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ViewNode[] {
    if (this.kind === "operations") return operationNodes(this.snapshot?.metadata);
    if (!this.snapshot) return [new ViewNode("No active dataframe", "Open a data file or notebook variable", "info")];
    if (this.kind === "summary") return summaryNodes(this.snapshot.metadata);
    if (this.kind === "filters") return filterNodes(this.snapshot.metadata.filterModel);
    return cleaningStepNodes(this.snapshot.metadata);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

class ViewNode extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.tooltip = `${label}: ${description}`;
    this.accessibilityInformation = { label: `${label}, ${description}` };
  }
}

class CodePreviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private snapshot: ActiveSessionSnapshot | undefined;
  private readonly subscription: vscode.Disposable;
  private hadDraft = false;
  private sessionId: string | undefined;
  private generatedCode = "";
  private displayedCode = "# Open a dataframe to preview generated code.";

  constructor(
    private readonly context: vscode.ExtensionContext,
    coordinator: SessionCoordinator
  ) {
    this.snapshot = coordinator.activeSession();
    this.generatedCode = this.snapshot?.code ?? "";
    this.displayedCode = this.generatedCode || placeholderCode(this.snapshot);
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      const nextGenerated = snapshot?.code ?? "";
      if (snapshot?.sessionId !== this.snapshot?.sessionId || nextGenerated !== this.generatedCode) {
        this.generatedCode = nextGenerated;
        this.displayedCode = nextGenerated || placeholderCode(snapshot);
      }
      this.snapshot = snapshot;
      this.render();
      const behavior = vscode.workspace
        .getConfiguration("dataExplorer")
        .get<"onDraft" | "always" | "never">("panelRevealBehavior", "onDraft");
      const hasDraft = Boolean(snapshot?.metadata.draftStep);
      const changedSession = snapshot?.sessionId !== this.sessionId;
      if (
        snapshot &&
        ((behavior === "always" && changedSession) || (behavior === "onDraft" && hasDraft && !this.hadDraft))
      ) {
        void vscode.commands.executeCommand("dataExplorer.codePreview.focus");
      }
      this.hadDraft = hasDraft;
      this.sessionId = snapshot?.sessionId;
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isCodePreviewMessage(message)) return;
      if (message.kind === "ready") this.render();
      if (message.kind === "codeChanged") this.displayedCode = message.code;
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private render(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ kind: "codePreview", code: this.displayedCode });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "codePreview.js"))
    );
    const nonce = randomNonce();
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;overflow:hidden;background:var(--vscode-editor-background)}</style></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

export function registerNativeViews(context: vscode.ExtensionContext, coordinator: SessionCoordinator): void {
  const providers = {
    "dataExplorer.operations": new DataExplorerTreeProvider("operations", coordinator),
    "dataExplorer.summary": new DataExplorerTreeProvider("summary", coordinator),
    "dataExplorer.filters": new DataExplorerTreeProvider("filters", coordinator),
    "dataExplorer.cleaningSteps": new DataExplorerTreeProvider("steps", coordinator)
  };
  for (const [id, provider] of Object.entries(providers)) {
    context.subscriptions.push(provider, vscode.window.registerTreeDataProvider(id, provider));
  }
  const codePreview = new CodePreviewViewProvider(context, coordinator);
  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.startOperation", async (kind?: OperationKind) => {
      if (!kind || !operationCatalog.some((operation) => operation.kind === kind)) return;
      if (!DataExplorerPanel.sendEditorAction({ action: "openOperation", operationKind: kind })) {
        await vscode.window.showInformationMessage("Open a dataframe in Data Explorer before adding a cleaning step.");
      }
    }),
    vscode.commands.registerCommand("dataExplorer.applyStep", () =>
      DataExplorerPanel.sendEditorAction({ action: "applyDraft" })
    ),
    vscode.commands.registerCommand("dataExplorer.discardStep", () =>
      DataExplorerPanel.sendEditorAction({ action: "discardDraft" })
    ),
    vscode.commands.registerCommand("dataExplorer.editLatestStep", () =>
      DataExplorerPanel.sendEditorAction({ action: "editLatest" })
    ),
    vscode.commands.registerCommand("dataExplorer.undoStep", () =>
      DataExplorerPanel.sendEditorAction({ action: "undoStep" })
    ),
    codePreview,
    vscode.window.registerWebviewViewProvider("dataExplorer.codePreview", codePreview, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Matt17BR.data-explorer")
    ),
    vscode.commands.registerCommand("dataExplorer.reportIssue", () =>
      vscode.env.openExternal(
        vscode.Uri.parse(
          `https://github.com/Matt17BR/data-explorer/issues/new?title=${encodeURIComponent("Data Explorer issue")}&body=${encodeURIComponent(`VS Code: ${vscode.version}\nOS: ${process.platform}\n\nSteps to reproduce:\n`)}`
        )
      )
    )
  );
}

function operationNodes(metadata: SessionMetadata | undefined): ViewNode[] {
  if (!metadata) return [new ViewNode("Open a dataframe", "Operations appear here", "wand")];
  const editable = metadata.mode === "editing";
  return operationCatalog.map(
    (operation) =>
      new ViewNode(
        operation.title,
        editable ? operation.group : "Viewing mode",
        operation.icon,
        editable
          ? {
              command: "dataExplorer.startOperation",
              title: `Start ${operation.title}`,
              arguments: [operation.kind]
            }
          : undefined
      )
  );
}

function cleaningStepNodes(metadata: SessionMetadata): ViewNode[] {
  const nodes = metadata.steps.map((step, index) => {
    const operation = operationByKind(step.kind);
    const isLatest = index === metadata.steps.length - 1;
    return new ViewNode(
      `${index + 1}. ${operation.title}`,
      isLatest ? "Latest applied step" : "Applied",
      operation.icon,
      isLatest
        ? {
            command: "dataExplorer.editLatestStep",
            title: "Edit latest step"
          }
        : undefined
    );
  });
  if (metadata.draftStep) {
    const draft = operationByKind(metadata.draftStep.kind);
    nodes.push(new ViewNode(`Draft · ${draft.title}`, "Previewing — apply or discard", draft.icon));
  }
  return nodes.length ? nodes : [new ViewNode("Original data", "No cleaning steps applied", "database")];
}

function summaryNodes(metadata: SessionMetadata): ViewNode[] {
  const stats = metadata.stats;
  return [
    new ViewNode(metadata.source.label, `${metadata.backend} · ${metadata.mode}`, "table"),
    new ViewNode(
      "Shape",
      `${metadata.filteredShape.rows.toLocaleString()} × ${metadata.filteredShape.columns.toLocaleString()}`,
      "symbol-array"
    ),
    new ViewNode("Columns", metadata.schema.length.toLocaleString(), "list-tree"),
    new ViewNode("Missing cells", stats ? stats.missingCells.toLocaleString() : "Profiling…", "question"),
    new ViewNode("Duplicate rows", stats ? stats.duplicateRows.toLocaleString() : "Profiling…", "copy")
  ];
}

function filterNodes(model: FilterModel): ViewNode[] {
  const filters = model.filters.map(
    (filter) =>
      new ViewNode(
        filter.column,
        `${filter.predicates.length} predicates${filter.valueFilter ? " · values" : ""}`,
        "filter"
      )
  );
  const sorts = model.sort.map(
    (sort) =>
      new ViewNode(
        sort.column,
        `${sort.direction === "asc" ? "Ascending" : "Descending"} · nulls ${sort.nulls}`,
        "sort-precedence"
      )
  );
  return filters.length || sorts.length
    ? [...filters, ...sorts]
    : [new ViewNode("No filters or sorts", "Viewing state is separate from cleaning steps", "filter")];
}

function placeholderCode(snapshot: ActiveSessionSnapshot | undefined): string {
  return snapshot
    ? `# ${snapshot.metadata.source.label}\n# Add or select a cleaning step to preview generated code.`
    : "# Open a dataframe to preview generated code.";
}

function isCodePreviewMessage(message: unknown): message is { kind: "ready" } | { kind: "codeChanged"; code: string } {
  if (typeof message !== "object" || message === null || !("kind" in message)) return false;
  if (message.kind === "ready") return true;
  return message.kind === "codeChanged" && "code" in message && typeof message.code === "string";
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
}
