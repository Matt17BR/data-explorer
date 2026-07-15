import * as path from "path";
import * as vscode from "vscode";
import { operationCatalog, operationByKind } from "../shared/operations";
import type { FilterModel, OperationKind, SessionMetadata } from "../shared/protocol";
import { SessionCoordinator, type ActiveSessionSnapshot } from "./sessionCoordinator";
import { DataExplorerPanel } from "./webviewPanel";
import { insertGeneratedNotebookCell } from "./notebooks/notebookInsertion";

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

  codeForExport(): string | undefined {
    return this.snapshot && this.generatedCode ? this.displayedCode : undefined;
  }

  setCodeForExportForTests(code: string): void {
    this.displayedCode = code;
    this.render();
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

export interface NativeViewsTestController {
  setCodeForExport(code: string): void;
}

export function registerNativeViews(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): NativeViewsTestController {
  const updatePlanContexts = (snapshot: ActiveSessionSnapshot | undefined) => {
    void vscode.commands.executeCommand("setContext", "dataExplorer.hasDraft", Boolean(snapshot?.metadata.draftStep));
    void vscode.commands.executeCommand(
      "setContext",
      "dataExplorer.canChangePlan",
      Boolean(snapshot && !snapshot.metadata.draftStep && snapshot.metadata.steps.length > 0)
    );
  };
  updatePlanContexts(coordinator.activeSession());
  const contextSubscription = coordinator.onDidChangeActiveSession(updatePlanContexts);
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
    contextSubscription,
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
    vscode.commands.registerCommand("dataExplorer.copyCode", async () => {
      const code = codePreview.codeForExport();
      if (!code) {
        await vscode.window.showInformationMessage("Add a cleaning step before copying generated code.");
        return;
      }
      await vscode.env.clipboard.writeText(code);
      void vscode.window.showInformationMessage("Data Explorer code copied to the clipboard.");
    }),
    vscode.commands.registerCommand("dataExplorer.exportCode", async (providedDestination?: unknown) => {
      if (!(await requireTrustedWorkspace("export code"))) return;
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) {
        await vscode.window.showInformationMessage("Add a cleaning step before exporting generated code.");
        return;
      }
      const destination =
        providedDestination instanceof vscode.Uri
          ? providedDestination
          : await vscode.window.showSaveDialog({
              title: "Export Data Explorer Python Code",
              defaultUri: defaultExportUri(snapshot, ".clean.py"),
              filters: { "Python script": ["py"] },
              saveLabel: "Export code"
            });
      if (!destination) return;
      await vscode.workspace.fs.writeFile(destination, Buffer.from(code, "utf8"));
      void vscode.window.showInformationMessage(`Exported Data Explorer code to ${destination.fsPath}.`);
    }),
    vscode.commands.registerCommand("dataExplorer.insertNotebookCode", async () => {
      if (!(await requireTrustedWorkspace("insert generated code into a notebook"))) return;
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) {
        await vscode.window.showInformationMessage("Add a cleaning step before inserting generated code.");
        return;
      }
      if (!snapshot.metadata.capabilities.notebookInsert || snapshot.metadata.source.kind !== "notebookVariable") {
        await vscode.window.showWarningMessage(
          "The active Data Explorer session did not originate from a notebook variable."
        );
        return;
      }
      const sourceUri = snapshot.metadata.source.uri;
      const notebookUri = sourceUri ? vscode.Uri.parse(sourceUri) : vscode.window.activeNotebookEditor?.notebook.uri;
      const notebook = notebookUri
        ? vscode.workspace.notebookDocuments.find((document) => document.uri.toString() === notebookUri.toString())
        : undefined;
      if (!notebook || !notebookUri) {
        await vscode.window.showWarningMessage("Reopen the originating notebook before inserting generated code.");
        return;
      }
      const activeEditor = vscode.window.activeNotebookEditor;
      const insertionIndex =
        activeEditor?.notebook.uri.toString() === notebookUri.toString()
          ? (activeEditor.selections[0]?.end ?? notebook.cellCount)
          : notebook.cellCount;
      if (
        !(await insertGeneratedNotebookCell(notebook, insertionIndex, code, {
          source: snapshot.metadata.source.label,
          backend: snapshot.metadata.backend
        }))
      ) {
        await vscode.window.showErrorMessage("VS Code could not insert the generated Data Explorer function.");
        return;
      }
      void vscode.window.showInformationMessage("Inserted the generated cleaning function into its notebook.");
    }),
    vscode.commands.registerCommand("dataExplorer.exportData", async () => {
      if (!(await requireTrustedWorkspace("export cleaned data"))) return;
      const snapshot = coordinator.activeSession();
      if (!snapshot) {
        await vscode.window.showInformationMessage("Open a dataframe in Data Explorer before exporting cleaned data.");
        return;
      }
      if (snapshot.metadata.draftStep) {
        await vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
        return;
      }
      const choices = [
        snapshot.metadata.capabilities.exportCsv
          ? { label: "CSV", description: "Comma-separated values", format: "csv" as const }
          : undefined,
        snapshot.metadata.capabilities.exportParquet
          ? { label: "Parquet", description: "Typed columnar data", format: "parquet" as const }
          : undefined
      ].filter((choice): choice is NonNullable<typeof choice> => Boolean(choice));
      if (!choices.length) {
        await vscode.window.showWarningMessage("The active dataframe does not support cleaned-data export.");
        return;
      }
      const selected = await vscode.window.showQuickPick(choices, {
        title: "Export Cleaned Data",
        placeHolder: "Choose a file format"
      });
      if (!selected) return;
      const extension = selected.format === "csv" ? ".cleaned.csv" : ".cleaned.parquet";
      const destination = await vscode.window.showSaveDialog({
        title: "Export Cleaned Data",
        defaultUri: defaultExportUri(snapshot, extension),
        filters: selected.format === "csv" ? { CSV: ["csv"] } : { Parquet: ["parquet"] },
        saveLabel: "Export data"
      });
      if (!destination) return;
      if (destination.scheme !== "file") {
        await vscode.window.showErrorMessage("Cleaned-data export currently requires a file-system destination.");
        return;
      }
      try {
        const exported = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Exporting cleaned data…", cancellable: false },
          () => coordinator.exportActiveData(destination.fsPath, selected.format)
        );
        await vscode.window.showInformationMessage(
          `Exported ${exported.shape.rows.toLocaleString()} rows × ${exported.shape.columns.toLocaleString()} columns to ${exported.path}.`
        );
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    codePreview,
    vscode.window.registerWebviewViewProvider("dataExplorer.codePreview", codePreview, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openSourceFile", async () => {
      const snapshot = coordinator.activeSession() ?? (await waitForActiveSession(coordinator, 30_000));
      const source = snapshot ? sourceUri(snapshot) : undefined;
      if (!source) {
        void vscode.window.showInformationMessage("The active Data Explorer session has no reopenable source.");
        return;
      }
      await vscode.commands.executeCommand("vscode.open", source);
    }),
    vscode.commands.registerCommand("dataExplorer.openWalkthrough", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "Matt17BR.data-explorer#gettingStarted", false)
    ),
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

  return {
    setCodeForExport: (code) => codePreview.setCodeForExportForTests(code)
  };
}

async function waitForActiveSession(
  coordinator: SessionCoordinator,
  timeoutMs: number
): Promise<ActiveSessionSnapshot | undefined> {
  const current = coordinator.activeSession();
  if (current) return current;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (snapshot: ActiveSessionSnapshot | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription.dispose();
      resolve(snapshot);
    };
    const subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      if (snapshot) finish(snapshot);
    });
    const timeout = setTimeout(() => finish(undefined), timeoutMs);
  });
}

export function sourceUri(snapshot: ActiveSessionSnapshot): vscode.Uri | undefined {
  const source = snapshot.metadata.source;
  if (source.path) return vscode.Uri.file(source.path);
  if (!source.uri) return undefined;
  try {
    return vscode.Uri.parse(source.uri, true);
  } catch {
    return undefined;
  }
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

function defaultExportUri(snapshot: ActiveSessionSnapshot, suffix: string): vscode.Uri {
  const sourcePath = snapshot.metadata.source.path;
  const baseName = path.basename(snapshot.metadata.source.label, path.extname(snapshot.metadata.source.label));
  const fileName = `${baseName || "cleaned-data"}${suffix}`;
  if (sourcePath) return vscode.Uri.file(path.join(path.dirname(sourcePath), fileName));
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  return workspace ? vscode.Uri.joinPath(workspace, fileName) : vscode.Uri.file(path.join(process.cwd(), fileName));
}

async function requireTrustedWorkspace(action: string): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  await vscode.window.showWarningMessage(`Trust this workspace before Data Explorer can ${action}.`);
  return false;
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
