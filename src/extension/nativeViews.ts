import * as path from "path";
import * as vscode from "vscode";
import { canEditLatestStep, canStartOperation, operationCatalog, operationByKind } from "../shared/operations";
import type { FilterModel, OperationKind, SessionMetadata } from "../shared/protocol";
import { SessionCoordinator, type ActiveSessionSnapshot } from "./sessionCoordinator";
import { OpenWranglerPanel } from "./webviewPanel";
import { insertGeneratedNotebookCell } from "./notebooks/notebookInsertion";
import { getSetting } from "./configuration";

type ViewKind = "operations" | "summary" | "filters" | "steps";

class OpenWranglerTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
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
    if (this.kind === "summary") return summaryNodes(this.snapshot);
    if (this.kind === "filters") return filterNodes(this.snapshot.viewState.filterModel);
    return cleaningStepNodes(this.snapshot);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

class ViewNode extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, command?: vscode.Command, contextValue?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.contextValue = contextValue;
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
  private inspectionStepId: string | undefined;
  private displayedCode = "# Open a dataframe to preview generated code.";

  constructor(
    private readonly context: vscode.ExtensionContext,
    coordinator: SessionCoordinator
  ) {
    this.snapshot = coordinator.activeSession();
    this.generatedCode = this.snapshot?.code ?? "";
    this.inspectionStepId = this.snapshot?.stepInspection?.stepId;
    this.displayedCode = this.generatedCode || placeholderCode(this.snapshot);
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      const nextGenerated = snapshot?.code ?? "";
      const nextInspectionStepId = snapshot?.stepInspection?.stepId;
      if (
        snapshot?.sessionId !== this.snapshot?.sessionId ||
        nextGenerated !== this.generatedCode ||
        nextInspectionStepId !== this.inspectionStepId
      ) {
        this.generatedCode = nextGenerated;
        this.displayedCode = nextGenerated || placeholderCode(snapshot);
      }
      this.inspectionStepId = nextInspectionStepId;
      this.snapshot = snapshot;
      this.render();
      const behavior = getSetting<"onDraft" | "always" | "never">("panelRevealBehavior", "onDraft");
      const hasDraft = Boolean(snapshot?.metadata.draftStep);
      const changedSession = snapshot?.sessionId !== this.sessionId;
      if (
        snapshot &&
        ((behavior === "always" && changedSession) || (behavior === "onDraft" && hasDraft && !this.hadDraft))
      ) {
        void vscode.commands.executeCommand("openWrangler.codePreview.focus");
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
    this.generatedCode = code;
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
    const hasDraft = Boolean(snapshot?.metadata.draftStep);
    const canChangePlan = canEditLatestStep(snapshot?.metadata);
    void vscode.commands.executeCommand("setContext", "openWrangler.hasDraft", hasDraft);
    void vscode.commands.executeCommand("setContext", "openWrangler.canChangePlan", canChangePlan);
  };
  updatePlanContexts(coordinator.activeSession());
  const contextSubscription = coordinator.onDidChangeActiveSession(updatePlanContexts);
  const providers = {
    "openWrangler.operations": new OpenWranglerTreeProvider("operations", coordinator),
    "openWrangler.summary": new OpenWranglerTreeProvider("summary", coordinator),
    "openWrangler.filters": new OpenWranglerTreeProvider("filters", coordinator),
    "openWrangler.cleaningSteps": new OpenWranglerTreeProvider("steps", coordinator)
  };
  for (const [id, provider] of Object.entries(providers)) {
    context.subscriptions.push(provider, vscode.window.registerTreeDataProvider(id, provider));
  }
  const codePreview = new CodePreviewViewProvider(context, coordinator);
  context.subscriptions.push(
    contextSubscription,
    vscode.commands.registerCommand("openWrangler.startOperation", async (kind?: OperationKind) => {
      if (kind !== undefined && !operationCatalog.some((operation) => operation.kind === kind)) return;
      const snapshot = coordinator.activeSession();
      if (snapshot && !canStartOperation(snapshot.metadata)) {
        await vscode.window.showInformationMessage(
          snapshot.metadata.draftStep
            ? "Apply or discard the current draft before adding another cleaning step."
            : "Open an editable dataframe before adding a cleaning step."
        );
        return;
      }
      if (
        !OpenWranglerPanel.sendEditorAction({
          action: "openOperation",
          ...(kind === undefined ? {} : { operationKind: kind })
        })
      ) {
        await vscode.window.showInformationMessage("Open a dataframe in Open Wrangler before adding a cleaning step.");
      }
    }),
    vscode.commands.registerCommand("openWrangler.applyStep", () =>
      OpenWranglerPanel.sendEditorAction({ action: "applyDraft" })
    ),
    vscode.commands.registerCommand("openWrangler.discardStep", () =>
      OpenWranglerPanel.sendEditorAction({ action: "discardDraft" })
    ),
    vscode.commands.registerCommand("openWrangler.editLatestStep", async () => {
      const snapshot = coordinator.activeSession();
      if (!canEditLatestStep(snapshot?.metadata)) {
        await vscode.window.showInformationMessage(
          snapshot?.metadata.draftStep
            ? "Apply or discard the current draft before editing the latest step."
            : "Apply a cleaning step before editing the latest step."
        );
        return;
      }
      if (!OpenWranglerPanel.sendEditorAction({ action: "editLatest" })) {
        await vscode.window.showInformationMessage(
          "Open the active dataframe editor before editing the latest cleaning step."
        );
      }
    }),
    vscode.commands.registerCommand("openWrangler.selectStep", async (stepId?: unknown) => {
      const snapshot = coordinator.activeSession();
      if (!snapshot) {
        await vscode.window.showInformationMessage(
          "Open a dataframe in Open Wrangler before selecting a cleaning step."
        );
        return;
      }
      if (
        stepId !== undefined &&
        (typeof stepId !== "string" || !snapshot.metadata.steps.some((step) => step.id === stepId))
      ) {
        await vscode.window.showWarningMessage("That cleaning step is no longer available in the active dataframe.");
        return;
      }
      if (stepId === undefined) coordinator.clearActiveStepInspection();
      if (!OpenWranglerPanel.sendEditorAction({ action: "selectStep", ...(stepId ? { stepId } : {}) })) {
        await vscode.window.showInformationMessage(
          "Open the active dataframe editor before selecting a cleaning step."
        );
      }
    }),
    vscode.commands.registerCommand("openWrangler.undoStep", () =>
      OpenWranglerPanel.sendEditorAction({ action: "undoStep" })
    ),
    vscode.commands.registerCommand("openWrangler.copyCode", async () => {
      const code = codePreview.codeForExport();
      if (!code) {
        await vscode.window.showInformationMessage("Add a cleaning step before copying generated code.");
        return;
      }
      await vscode.env.clipboard.writeText(code);
      void vscode.window.showInformationMessage("Open Wrangler code copied to the clipboard.");
      return code;
    }),
    vscode.commands.registerCommand("openWrangler.exportCode", async (providedDestination?: unknown) => {
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
              title: "Export Open Wrangler Python Code",
              defaultUri: defaultExportUri(snapshot, ".clean.py"),
              filters: { "Python script": ["py"] },
              saveLabel: "Export code"
            });
      if (!destination) return;
      await vscode.workspace.fs.writeFile(destination, Buffer.from(code, "utf8"));
      void vscode.window.showInformationMessage(`Exported Open Wrangler code to ${destination.fsPath}.`);
    }),
    vscode.commands.registerCommand("openWrangler.insertNotebookCode", async () => {
      if (!(await requireTrustedWorkspace("insert generated code into a notebook"))) return;
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) {
        await vscode.window.showInformationMessage("Add a cleaning step before inserting generated code.");
        return;
      }
      if (!snapshot.metadata.capabilities.notebookInsert || snapshot.metadata.source.kind !== "notebookVariable") {
        await vscode.window.showWarningMessage(
          "The active Open Wrangler session did not originate from a notebook variable."
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
        await vscode.window.showErrorMessage("VS Code could not insert the generated Open Wrangler function.");
        return;
      }
      void vscode.window.showInformationMessage("Inserted the generated cleaning function into its notebook.");
    }),
    vscode.commands.registerCommand("openWrangler.exportData", async () => {
      if (!(await requireTrustedWorkspace("export cleaned data"))) return;
      const snapshot = coordinator.activeSession();
      if (!snapshot) {
        await vscode.window.showInformationMessage("Open a dataframe in Open Wrangler before exporting cleaned data.");
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
    vscode.window.registerWebviewViewProvider("openWrangler.codePreview", codePreview, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openSourceFile", async () => {
      const snapshot = coordinator.activeSession() ?? (await waitForActiveSession(coordinator, 30_000));
      const source = snapshot ? sourceUri(snapshot) : undefined;
      if (!source) {
        void vscode.window.showInformationMessage("The active Open Wrangler session has no reopenable source.");
        return;
      }
      await vscode.commands.executeCommand("vscode.open", source);
    }),
    vscode.commands.registerCommand("openWrangler.openWalkthrough", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "Matt17BR.openwrangler#gettingStarted", false)
    ),
    vscode.commands.registerCommand("openWrangler.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Matt17BR.openwrangler")
    ),
    vscode.commands.registerCommand("openWrangler.reportIssue", () =>
      vscode.env.openExternal(
        vscode.Uri.parse(
          `https://github.com/Matt17BR/openwrangler/issues/new?title=${encodeURIComponent("Open Wrangler issue")}&body=${encodeURIComponent(`VS Code: ${vscode.version}\nOS: ${process.platform}\n\nSteps to reproduce:\n`)}`
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
  const canStart = canStartOperation(metadata);
  return operationCatalog.map(
    (operation) =>
      new ViewNode(
        operation.title,
        !editable ? "Viewing mode" : metadata.draftStep ? "Apply or discard the current draft" : operation.group,
        operation.icon,
        canStart
          ? {
              command: "openWrangler.startOperation",
              title: `Start ${operation.title}`,
              arguments: [operation.kind]
            }
          : undefined
      )
  );
}

function cleaningStepNodes(snapshot: ActiveSessionSnapshot): ViewNode[] {
  const { metadata, stepInspection } = snapshot;
  const nodes: ViewNode[] = [
    new ViewNode(
      "Original data",
      stepInspection ? "Show the confirmed dataframe view" : "Selected · confirmed dataframe view",
      "database",
      { command: "openWrangler.selectStep", title: "Show original data", arguments: [] }
    )
  ];
  nodes.push(
    ...metadata.steps.map((step, index) => {
      const operation = operationByKind(step.kind);
      const isLatest = index === metadata.steps.length - 1;
      const selected = stepInspection?.stepId === step.id;
      return new ViewNode(
        `${index + 1}. ${operation.title}`,
        selected
          ? `Selected · ${isLatest ? "latest applied step" : "applied"}`
          : isLatest
            ? "Latest applied step"
            : "Applied",
        operation.icon,
        {
          command: "openWrangler.selectStep",
          title: `Inspect ${operation.title}`,
          arguments: [step.id]
        },
        isLatest && !metadata.draftStep ? "openWrangler.latestCleaningStep" : "openWrangler.cleaningStep"
      );
    })
  );
  if (metadata.draftStep) {
    const draft = operationByKind(metadata.draftStep.kind);
    nodes.push(new ViewNode(`Draft · ${draft.title}`, "Previewing — apply or discard", draft.icon));
  }
  return nodes;
}

function summaryNodes(snapshot: ActiveSessionSnapshot): ViewNode[] {
  const { metadata, viewState } = snapshot;
  const stats = metadata.stats;
  const selectedColumn = metadata.schema.find((column) => column.id === viewState.selectedColumnId);
  return [
    new ViewNode(metadata.source.label, `${metadata.backend} · ${metadata.mode}`, "table"),
    new ViewNode(
      "Shape",
      `${metadata.filteredShape.rows.toLocaleString()} × ${metadata.filteredShape.columns.toLocaleString()}`,
      "symbol-array"
    ),
    new ViewNode("Columns", metadata.schema.length.toLocaleString(), "list-tree"),
    new ViewNode("Selected column", selectedColumn?.name ?? "None", "symbol-field"),
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
  await vscode.window.showWarningMessage(`Trust this workspace before Open Wrangler can ${action}.`);
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
