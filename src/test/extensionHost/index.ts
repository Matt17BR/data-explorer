import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { chromium } from "playwright-core";
import { getSetting } from "../../extension/configuration";
import { insertGeneratedNotebookCell } from "../../extension/notebooks/notebookInsertion";
import { OPEN_WRANGLER_MIME_V2 } from "../../shared/notebookOutput";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  FilterModel,
  SessionMetadata,
  SessionSource,
  TransformStep
} from "../../shared/protocol";

interface TestApi {
  request(request: OpenWranglerRequest): Promise<OpenWranglerResponse>;
  setActiveSession(sessionId: string | undefined): void;
  activeSession(): { sessionId: string; metadata: SessionMetadata; code?: string } | undefined;
  diagnostics(): {
    activeSessionId?: string;
    sessionCount: number;
    sessions: Array<{ publicId: string; runtimeId: string; sourceLabel: string }>;
  };
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  setCodeForExport(code: string): void;
}

interface ExtensionApi {
  testing?: TestApi;
}

interface FakeJupyterApi {
  testing: {
    execute(uri: vscode.Uri, code: string): Promise<string>;
    restart(uri: vscode.Uri, setupCode?: string): Promise<number>;
    setDenied(value: boolean): void;
    denialCalls(): number;
    stats(uri: vscode.Uri): { generation: number; executions: number } | undefined;
  };
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("matt17br.openwrangler");
  assert.ok(extension, "The Open Wrangler extension must be discoverable.");
  const extensionApi = await extension.activate();
  const testing = extensionApi?.testing;
  assert.ok(testing, "The isolated acceptance harness must enable the test-only extension API.");
  assert.equal(extension.isActive, true, "The extension must activate successfully.");
  assert.equal(extension.packageJSON.name, "openwrangler");
  assert.equal(extension.packageJSON.displayName, "Open Wrangler");
  assert.match(extension.packageJSON.description, /open-source dataframe wrangler/i);
  assert.equal(extension.packageJSON.publisher, "Matt17BR");
  assert.equal(extension.packageJSON.icon, "media/icon.png");
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "icon.png"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "activity-icon.svg"));
  const testPython = process.env.OPEN_WRANGLER_TEST_PYTHON;
  if (testPython) {
    await vscode.workspace
      .getConfiguration("openWrangler")
      .update("pythonPath", testPython, vscode.ConfigurationTarget.Global);
  }

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "openWrangler.openPath",
    "openWrangler.openFile",
    "openWrangler.launchDataViewer",
    "openWrangler.openNotebookVariable",
    "openWrangler.checkJupyterIntegration",
    "openWrangler.changeRuntime",
    "openWrangler.clearRuntime",
    "openWrangler.installRuntimeDependencies",
    "openWrangler.startOperation",
    "openWrangler.applyStep",
    "openWrangler.discardStep",
    "openWrangler.editLatestStep",
    "openWrangler.undoStep",
    "openWrangler.copyCode",
    "openWrangler.exportCode",
    "openWrangler.insertNotebookCode",
    "openWrangler.exportData",
    "openWrangler.openSourceFile",
    "openWrangler.openWalkthrough",
    "openWrangler.openSettings",
    "openWrangler.reportIssue"
  ]) {
    assert.ok(commands.includes(command), `Expected registered command: ${command}`);
  }

  const contributions = extension.packageJSON.contributes as {
    viewsContainers?: { activitybar?: Array<{ id?: string; icon?: string }> };
    views?: Record<string, Array<{ id?: string }>>;
    configuration?: { properties?: Record<string, unknown> };
    notebookRenderer?: Array<{ mimeTypes?: string[] }>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
  };
  assert.ok(
    contributions.viewsContainers?.activitybar?.some(
      (container) => container.id === "openWrangler" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.deepEqual(
    contributions.views?.openWrangler?.map((view) => view.id),
    ["openWrangler.operations", "openWrangler.summary", "openWrangler.filters", "openWrangler.cleaningSteps"]
  );
  assert.ok(contributions.configuration?.properties?.["openWrangler.fetchBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.filterMode"]);
  assert.deepEqual(
    contributions.keybindings?.map((binding) => ({
      command: binding.command,
      key: binding.key,
      mac: binding.mac,
      when: binding.when
    })),
    [
      {
        command: "openWrangler.applyStep",
        key: "ctrl+enter",
        mac: "cmd+enter",
        when: "activeCustomEditor == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.discardStep",
        key: "escape",
        mac: undefined,
        when: "activeCustomEditor == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.editLatestStep",
        key: "ctrl+shift+e",
        mac: "cmd+shift+e",
        when: "activeCustomEditor == openWrangler.viewer && openWrangler.canChangePlan"
      },
      {
        command: "openWrangler.undoStep",
        key: "ctrl+alt+z",
        mac: "cmd+alt+z",
        when: "activeCustomEditor == openWrangler.viewer && openWrangler.canChangePlan"
      }
    ]
  );
  assert.deepEqual(contributions.notebookRenderer?.[0]?.mimeTypes, ["application/vnd.openwrangler.viewer.v2+json"]);
  assert.ok(
    extension.packageJSON.contributes.walkthroughs?.some(
      (walkthrough: { id?: string }) => walkthrough.id === "gettingStarted"
    )
  );

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The extension-host fixture workspace must be open.");
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.csv");
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE ?? "verify";
  if (phase === "seed") {
    await seedPersistedPlan(testing, fixture);
    console.log("Open Wrangler extension-host persistence seed passed.");
    return;
  }

  if (phase === "single") await seedPersistedPlan(testing, fixture);
  await verifyPersistedReplayAndRecovery(testing, workspace, fixture);
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.viewType === "openWrangler.viewer";
    },
    45_000,
    "the Open Wrangler custom editor"
  );

  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeInput instanceof vscode.TabInputCustom);
  assert.equal(activeInput.viewType, "openWrangler.viewer");
  assert.equal(path.basename(activeInput.uri.fsPath), "sample.csv");
  await vscode.commands.executeCommand("openWrangler.openSourceFile");
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    45_000,
    "Open Source File to reveal the active runtime session"
  );
  const sourceInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(sourceInput instanceof vscode.TabInputText, "Open Source File must resolve the active runtime session.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the custom-editor session to close"
  );

  if (testPython) {
    await exerciseRuntimeSelectionCommands(testing, fixture, testPython);
    await exercisePackagedFileInputs(testing, workspace, testPython);
  }
  await exercisePackagedViewingQueries(testing, fixture);
  await exercisePackagedOperationGroups(testing, fixture);
  await exercisePackagedNotebookFlows(testing);
  if (process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
    await capturePackagedEditorScreenshots(testing, fixture, process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS);
  }

  console.log("Open Wrangler extension-host acceptance passed.");
}

async function capturePackagedEditorScreenshots(
  testing: TestApi,
  fixture: vscode.Uri,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  mkdirSync(outputDirectory, { recursive: true });
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    30_000,
    "the custom editor before screenshot capture"
  );
  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");

  const workbench = vscode.workspace.getConfiguration("workbench");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const scm = vscode.workspace.getConfiguration("scm");
  const typescript = vscode.workspace.getConfiguration("typescript");
  const javascript = vscode.workspace.getConfiguration("javascript");
  const originalTheme = workbench.get<string>("colorTheme");
  const originalStatusBarVisible = workbench.get<boolean>("statusBar.visible");
  const originalZoom = windowConfiguration.get<number>("zoomLevel");
  const originalTitle = windowConfiguration.get<string>("title");
  const originalCommandCenter = windowConfiguration.get<boolean>("commandCenter");
  const originalAutoDetectColorScheme = windowConfiguration.get<boolean>("autoDetectColorScheme");
  const originalAutoDetectHighContrast = windowConfiguration.get<boolean>("autoDetectHighContrast");
  const originalScmCountBadge = scm.get<string>("countBadge");
  const originalTypescriptValidation = typescript.get<boolean>("validate.enable");
  const originalJavascriptValidation = javascript.get<boolean>("validate.enable");
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  const cdpPort = Number(process.env.OPEN_WRANGLER_EDITOR_CDP_PORT);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Editor screenshot capture requires a CDP port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  let workbenchPage = pages.find((page) => page.url().includes("workbench"));
  for (const page of pages) {
    if ((await page.locator(".monaco-workbench").count()) > 0) {
      workbenchPage = page;
      break;
    }
  }
  assert.ok(workbenchPage, "The editor CDP endpoint must expose its workbench page.");
  const capturePage = workbenchPage;
  const darkTheme = contributedTheme("vs-dark", "Default Dark Modern");
  const lightTheme = contributedTheme("vs", "Default Light Modern");
  const highContrastTheme = contributedTheme("hc-black", "Default High Contrast");
  try {
    await workbench.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "title",
      "${activeEditorShort}${separator}Open Wrangler",
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", "off", vscode.ConfigurationTarget.Global);
    await typescript.update("validate.enable", false, vscode.ConfigurationTarget.Global);
    await javascript.update("validate.enable", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await prepareWorkbenchForEvidence();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await captureTheme(darkTheme, vscode.ColorThemeKind.Dark, 0, `${editor}-dark.png`);
    await captureTheme(lightTheme, vscode.ColorThemeKind.Light, 0, `${editor}-light.png`);
    await captureTheme(
      highContrastTheme,
      vscode.ColorThemeKind.HighContrast,
      4,
      `${editor}-high-contrast-zoom-200.png`
    );
  } finally {
    await workbench.update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
    await workbench.update("statusBar.visible", originalStatusBarVisible, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", originalZoom, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("title", originalTitle, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", originalCommandCenter, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", originalScmCountBadge, vscode.ConfigurationTarget.Global);
    await typescript.update("validate.enable", originalTypescriptValidation, vscode.ConfigurationTarget.Global);
    await javascript.update("validate.enable", originalJavascriptValidation, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "autoDetectColorScheme",
      originalAutoDetectColorScheme,
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update(
      "autoDetectHighContrast",
      originalAutoDetectHighContrast,
      vscode.ConfigurationTarget.Global
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the screenshot session and runtime to close"
    );
  }

  async function captureTheme(
    theme: string,
    expectedKind: vscode.ColorThemeKind,
    zoomLevel: number,
    fileName: string
  ): Promise<void> {
    await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", zoomLevel, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === expectedKind,
      10_000,
      `${theme} to activate before screenshot capture`
    );
    await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
    await clearNotifications();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const destination = path.resolve(outputDirectory, fileName);
    await capturePage.bringToFront();
    const viewport = await capturePage.evaluate(() => {
      const pageWindow = globalThis as unknown as {
        innerWidth: number;
        innerHeight: number;
        devicePixelRatio: number;
      };
      return {
        width: pageWindow.innerWidth,
        height: pageWindow.innerHeight,
        scale: Math.max(1, pageWindow.devicePixelRatio)
      };
    });
    await capturePage.mouse.move(Math.max(1, viewport.width - 8), Math.max(1, viewport.height - 8));
    await capturePage
      .locator(".monaco-hover")
      .waitFor({ state: "hidden", timeout: 2_000 })
      .catch(() => {});
    const workbenchOffsets: number[] = [];
    for (const selector of [".monaco-workbench", ".part.sidebar", ".part.editor", ".part.activitybar"]) {
      const locator = capturePage.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      const bounds = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
      if (bounds && bounds.y > 0) workbenchOffsets.push(bounds.y);
    }
    const titleBarHeight = Math.ceil(Math.min(...workbenchOffsets, Number.POSITIVE_INFINITY) * viewport.scale);
    const screenshotOptions = {
      path: destination,
      animations: "disabled" as const,
      timeout: 60_000,
      ...(viewport && Number.isFinite(titleBarHeight) && titleBarHeight > 0 && titleBarHeight < viewport.height
        ? {
            clip: {
              x: 0,
              y: titleBarHeight,
              width: viewport.width,
              height: viewport.height - titleBarHeight
            }
          }
        : {})
    };
    try {
      await capturePage.screenshot(screenshotOptions);
    } catch (error) {
      await capturePage.bringToFront();
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await capturePage.screenshot(screenshotOptions);
      } catch {
        throw error;
      }
    }
    const image = readFileSync(destination);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }

  async function prepareWorkbenchForEvidence(): Promise<void> {
    const commands = new Set(await vscode.commands.getCommands(true));
    const auxiliaryBar = capturePage.locator(".part.auxiliarybar");
    if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
      const closeCommand = commands.has("workbench.action.closeAuxiliaryBar")
        ? "workbench.action.closeAuxiliaryBar"
        : commands.has("workbench.action.toggleAuxiliaryBar")
          ? "workbench.action.toggleAuxiliaryBar"
          : undefined;
      if (closeCommand) {
        await vscode.commands.executeCommand(closeCommand);
        await auxiliaryBar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    await clearNotifications(commands);
  }

  async function clearNotifications(commands?: Set<string>): Promise<void> {
    const availableCommands = commands ?? new Set(await vscode.commands.getCommands(true));
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    if (availableCommands.has("notifications.hideList")) {
      await vscode.commands.executeCommand("notifications.hideList");
    }
    await capturePage
      .locator(".notifications-toasts")
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => {});
  }

  function contributedTheme(uiTheme: string, fallback: string): string {
    const themes = vscode.extensions.all.flatMap(
      (extension) =>
        (extension.packageJSON.contributes?.themes ?? []) as Array<{
          id?: string;
          label?: string;
          uiTheme?: string;
        }>
    );
    const candidates = themes.filter((theme) => theme.uiTheme === uiTheme);
    if (editor === "cursor") {
      const cursorTheme = candidates.find((theme) =>
        uiTheme === "vs-dark"
          ? theme.label === "Cursor Dark"
          : uiTheme === "vs"
            ? theme.label === "Cursor Light"
            : theme.label === "Cursor Dark High Contrast"
      );
      if (cursorTheme) return cursorTheme.id ?? cursorTheme.label ?? fallback;
    }
    const preferred = candidates.find((theme) => /default|modern/i.test(theme.label ?? theme.id ?? ""));
    return preferred?.id ?? preferred?.label ?? candidates[0]?.id ?? candidates[0]?.label ?? fallback;
  }
}

async function exercisePackagedNotebookFlows(testing: TestApi): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-notebook-"));
  const notebookPath = path.join(directory, "notebook-acceptance.ipynb");
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalMode = configuration.get<"viewing" | "editing">("notebookStartMode", "viewing");
  const page = {
    offset: 0,
    limit: 1,
    totalRows: 1,
    rows: [
      {
        id: "r:0",
        rowNumber: 0,
        values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
      }
    ]
  };
  const schema = [{ id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }];
  const currentPayload = {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "snapshot",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: { kind: "notebookOutput", label: "current frame" },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema,
      filterModel: { filters: [], sort: [] },
      steps: []
    },
    page,
    summaries: []
  };
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: {
                "text/plain": ["Open Wrangler saved output"],
                [OPEN_WRANGLER_MIME_V2]: currentPayload
              }
            }
          ],
          source: ["value = 1"]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );

  try {
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
    await vscode.window.showNotebookDocument(notebook);
    const outputMimes = notebook.cellAt(0).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(outputMimes.includes(OPEN_WRANGLER_MIME_V2), "MIME v2 output must be registered in a real notebook.");

    const inserted = await insertGeneratedNotebookCell(notebook, 1, "def clean_data(df):\n    return df\n", {
      source: "df",
      backend: "polars"
    });
    assert.equal(inserted, true);
    assert.equal(notebook.cellCount, 2);
    assert.equal(notebook.cellAt(1).document.getText(), "def clean_data(df):\n    return df\n");
    assert.deepEqual(notebook.cellAt(1).metadata.openWrangler, {
      source: "df",
      backend: "polars",
      generated: true
    });

    const jupyterExtension = vscode.extensions.getExtension<FakeJupyterApi>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The stable Jupyter API acceptance extension must be available.");
    const jupyter = await jupyterExtension.activate();
    const setupCode = [
      "import pandas as pd",
      "import polars as pl",
      "pandas_frame = pd.DataFrame({'value': [1, 2], 'label': ['a', 'b']})",
      "polars_frame = pl.DataFrame({'value': [3, 4], 'label': ['c', 'd']})"
    ].join("\n");
    await jupyter.testing.execute(notebook.uri, setupCode);

    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "pandas_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "pandas_frame",
      30_000,
      "the packaged Pandas notebook variable session"
    );
    let active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    assert.equal(active?.metadata.capabilities.notebookInsert, true);
    if (!active) throw new Error("Pandas notebook session did not become active.");
    const pandasPage = await testing.request({
      kind: "getPage",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(pandasPage.kind, "page");
    if (pandasPage.kind !== "page") throw new Error("Pandas notebook page did not resolve.");
    assert.equal(pandasPage.page.rows[1]?.values[0]?.display, "2");
    const preview = await testing.request({
      kind: "previewStep",
      sessionId: active.sessionId,
      revision: pandasPage.revision,
      step: {
        id: "notebook-score",
        kind: "formula",
        params: { leftColumn: "value", operator: "multiply", value: 2, newColumn: "score" }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") throw new Error("Pandas notebook step did not preview.");
    const applied = await testing.request({
      kind: "applyDraft",
      sessionId: active.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") throw new Error("Pandas notebook step did not apply.");
    const editedNotebookCode = "# edited notebook export\ndef clean_data(df):\n    return df\n";
    testing.setCodeForExport(editedNotebookCode);
    const insertionIndex = notebook.cellCount;
    await vscode.commands.executeCommand("openWrangler.insertNotebookCode");
    await waitFor(
      () => notebook.cellCount === insertionIndex + 1,
      10_000,
      "the notebook export command to insert a cell"
    );
    assert.equal(notebook.cellAt(insertionIndex).document.getText(), editedNotebookCode);
    assert.deepEqual(notebook.cellAt(insertionIndex).metadata.openWrangler, {
      source: "pandas_frame",
      backend: "pandas",
      generated: true
    });
    const pandasClosed = await testing.request({
      kind: "closeSession",
      sessionId: active.sessionId,
      revision: applied.revision
    });
    assert.equal(pandasClosed.kind, "sessionClosed");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the Pandas notebook session to close");

    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "polars_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "polars_frame",
      30_000,
      "the packaged Polars notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "polars");
    if (!active) throw new Error("Polars notebook session did not become active.");
    const generation = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const replacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(replacementGeneration > generation);
    const recovered = await testing.request({
      kind: "getPage",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(recovered.kind, "page", "The Polars notebook session must replay after kernel replacement.");
    if (recovered.kind !== "page") throw new Error("Polars notebook recovery did not return a page.");
    assert.equal(recovered.page.rows[0]?.values[0]?.display, "3");
    const polarsClosed = await testing.request({
      kind: "closeSession",
      sessionId: active.sessionId,
      revision: recovered.revision
    });
    assert.equal(polarsClosed.kind, "sessionClosed");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the Polars notebook session to close");

    const denialCalls = jupyter.testing.denialCalls();
    jupyter.testing.setDenied(true);
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "pandas_frame",
      notebookUri: notebook.uri
    });
    await waitFor(() => jupyter.testing.denialCalls() > denialCalls, 10_000, "the packaged Jupyter permission denial");
    assert.equal(testing.diagnostics().sessionCount, 0);
    jupyter.testing.setDenied(false);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    assert.equal(await notebook.save(), true);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  } finally {
    await configuration.update("notebookStartMode", originalMode, vscode.ConfigurationTarget.Workspace);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function seedPersistedPlan(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const source = csvSource(fixture);
  const opened = await testing.request({
    kind: "openSession",
    source,
    backend: "polars",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(opened.kind, "sessionOpened");
  if (opened.kind !== "sessionOpened") return;

  const preview = await testing.request({
    kind: "previewStep",
    sessionId: opened.metadata.sessionId,
    revision: opened.metadata.revision,
    step: {
      id: "packaged-score",
      kind: "formula",
      params: { leftColumn: "sales", operator: "multiply", value: 2, newColumn: "score" }
    },
    offset: 0,
    limit: 20
  });
  assert.equal(preview.kind, "stepPreview");
  if (preview.kind !== "stepPreview") return;

  const applied = await testing.request({
    kind: "applyDraft",
    sessionId: opened.metadata.sessionId,
    revision: preview.revision,
    offset: 0,
    limit: 20
  });
  assert.equal(applied.kind, "planUpdated");
  if (applied.kind !== "planUpdated") return;

  const filterModel: FilterModel = {
    filters: [],
    sort: [{ column: "sales", direction: "desc", nulls: "last" }]
  };
  const page = await testing.request({
    kind: "getPage",
    sessionId: opened.metadata.sessionId,
    revision: applied.revision,
    offset: 0,
    limit: 20,
    filterModel
  });
  assert.equal(page.kind, "page");
  if (page.kind !== "page") return;
  assert.equal(page.page.rows[0]?.values[0]?.display, "Berlin");
  assert.deepEqual(
    page.metadata.steps.map((step) => step.id),
    ["packaged-score"]
  );

  const closed = await testing.request({
    kind: "closeSession",
    sessionId: opened.metadata.sessionId,
    revision: page.revision
  });
  assert.equal(closed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the seeded session and standalone runtime to close"
  );

  const readback = await testing.request({
    kind: "openSession",
    source,
    backend: "polars",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(readback.kind, "sessionOpened");
  if (readback.kind !== "sessionOpened") return;
  assert.deepEqual(
    readback.metadata.steps.map((step) => step.id),
    ["packaged-score"]
  );
  const readbackClosed = await testing.request({
    kind: "closeSession",
    sessionId: readback.metadata.sessionId,
    revision: readback.metadata.revision
  });
  assert.equal(readbackClosed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the persistence readback session to close"
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function verifyPersistedReplayAndRecovery(
  testing: TestApi,
  workspace: vscode.Uri,
  fixture: vscode.Uri
): Promise<void> {
  const sourceText = readFileSync(fixture.fsPath, "utf8");
  const restored = await testing.request({
    kind: "openSession",
    source: csvSource(fixture),
    backend: "polars",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(restored.kind, "sessionOpened");
  if (restored.kind !== "sessionOpened") return;
  assert.deepEqual(
    restored.metadata.steps.map((step) => step.id),
    ["packaged-score"]
  );
  assert.equal(restored.metadata.shape.columns, 5);
  assert.equal(restored.page.rows[0]?.values[0]?.display, "Berlin");
  assert.equal(restored.page.rows[0]?.values[4]?.display, "24.0");
  assert.deepEqual(restored.metadata.filterModel.sort, [{ column: "sales", direction: "desc", nulls: "last" }]);

  const secondFixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv");
  const secondSourceText = readFileSync(secondFixture.fsPath, "utf8");
  const second = await testing.request({
    kind: "openSession",
    source: tsvSource(secondFixture),
    backend: "pandas",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(second.kind, "sessionOpened");
  if (second.kind !== "sessionOpened") return;
  assert.notEqual(second.metadata.sessionId, restored.metadata.sessionId);
  assert.equal(testing.diagnostics().sessionCount, 2);
  testing.setActiveSession(second.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, second.metadata.sessionId);
  testing.setActiveSession(restored.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, restored.metadata.sessionId);

  const beforeRestart = testing.diagnostics();
  const generation = testing.runtimeGeneration();
  testing.restartRuntime("Injected packaged-editor recovery test.");
  const [restoredPage, secondPage] = await Promise.all([
    testing.request({
      kind: "getPage",
      sessionId: restored.metadata.sessionId,
      revision: restored.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: restored.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      sessionId: second.metadata.sessionId,
      revision: second.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: second.metadata.filterModel
    })
  ]);
  assert.equal(restoredPage.kind, "page");
  assert.equal(secondPage.kind, "page");
  if (restoredPage.kind !== "page" || secondPage.kind !== "page") return;
  assert.equal(testing.runtimeGeneration(), generation + 1, "Concurrent recovery must start exactly one runtime.");
  assert.equal(restoredPage.page.rows[0]?.values[4]?.display, "24.0");
  assert.equal(secondPage.metadata.shape.columns, 4);
  const afterRestart = testing.diagnostics();
  assert.equal(afterRestart.sessionCount, 2);
  for (const before of beforeRestart.sessions) {
    const after = afterRestart.sessions.find((session) => session.publicId === before.publicId);
    assert.ok(after);
    assert.notEqual(after.runtimeId, before.runtimeId, `Expected runtime replay for ${before.sourceLabel}.`);
  }

  const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-export-"));
  try {
    for (const target of [
      {
        name: "polars",
        sessionId: restored.metadata.sessionId,
        revision: restoredPage.revision,
        columns: 5
      },
      { name: "pandas", sessionId: second.metadata.sessionId, revision: secondPage.revision, columns: 4 }
    ]) {
      const csvDestination = path.join(exportDirectory, `${target.name}.csv`);
      const csvExported = await testing.request({
        kind: "exportData",
        sessionId: target.sessionId,
        revision: target.revision,
        path: csvDestination,
        format: "csv"
      });
      assert.equal(csvExported.kind, "dataExported");
      if (csvExported.kind === "dataExported") assert.equal(csvExported.shape.columns, target.columns);
      assert.match(readFileSync(csvDestination, "utf8"), /city,year,sales,active/);

      const parquetDestination = path.join(exportDirectory, `${target.name}.parquet`);
      const parquetExported = await testing.request({
        kind: "exportData",
        sessionId: target.sessionId,
        revision: target.revision,
        path: parquetDestination,
        format: "parquet"
      });
      assert.equal(parquetExported.kind, "dataExported");
      if (parquetExported.kind === "dataExported") assert.equal(parquetExported.shape.columns, target.columns);
      assert.equal(readFileSync(parquetDestination).subarray(0, 4).toString("ascii"), "PAR1");
    }
    assert.equal(readFileSync(fixture.fsPath, "utf8"), sourceText, "Export must not modify the source fixture.");
    assert.equal(
      readFileSync(secondFixture.fsPath, "utf8"),
      secondSourceText,
      "Pandas export must not modify the source fixture."
    );
  } finally {
    rmSync(exportDirectory, { recursive: true, force: true });
  }

  const firstClosed = await testing.request({
    kind: "closeSession",
    sessionId: restored.metadata.sessionId,
    revision: restoredPage.revision
  });
  const secondClosed = await testing.request({
    kind: "closeSession",
    sessionId: second.metadata.sessionId,
    revision: secondPage.revision
  });
  assert.equal(firstClosed.kind, "sessionClosed");
  assert.equal(secondClosed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "all recovered sessions and the standalone runtime to close"
  );
}

async function exercisePackagedFileInputs(testing: TestApi, workspace: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-file-inputs-"));
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalBackend = config.get<"auto" | "polars" | "pandas">("defaultBackend", "auto");
  try {
    execFileSync(
      python,
      [
        "-c",
        [
          "import sys",
          "from pathlib import Path",
          "import polars as pl",
          "from openpyxl import Workbook",
          "root = Path(sys.argv[1])",
          "pl.DataFrame({'name': ['alpha', 'beta'], 'value': [1, 2], 'active': [True, False]}).write_parquet(root / 'sample.parquet')",
          "workbook = Workbook()",
          "sheet = workbook.active",
          "sheet.title = 'Sales'",
          "sheet.append(['name', 'value', 'active'])",
          "sheet.append(['alpha', 1, True])",
          "sheet.append(['beta', 2, False])",
          "workbook.save(root / 'sample.xlsx')"
        ].join("\n"),
        directory
      ],
      { encoding: "utf8" }
    );

    const fixtures = [
      {
        uri: vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv"),
        backend: "pandas" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.joinPath(workspace, "fixtures", "sample.jsonl"),
        backend: "polars" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.parquet")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.xlsx")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      }
    ];

    for (const fixture of fixtures) {
      await config.update("defaultBackend", fixture.backend, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        fixture.uri,
        "openWrangler.viewer",
        vscode.ViewColumn.One
      );
      await waitFor(
        () => {
          const active = testing.activeSession();
          return (
            active?.metadata.source.path === fixture.uri.fsPath &&
            active.metadata.backend === fixture.backend &&
            active.metadata.shape.rows === fixture.shape.rows &&
            active.metadata.shape.columns === fixture.shape.columns
          );
        },
        30_000,
        `${path.basename(fixture.uri.fsPath)} to open through the packaged custom editor`
      );
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        `${path.basename(fixture.uri.fsPath)} to dispose its session and runtime`
      );
    }
  } finally {
    await config.update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Global);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function exerciseRuntimeSelectionCommands(testing: TestApi, fixture: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-runtime-selection-"));
  const isolatedPython = path.join(directory, "python-without-site-packages");
  const quotedPython = `'${python.replaceAll("'", `'\\''`)}'`;
  writeFileSync(isolatedPython, `#!/bin/sh\nexec ${quotedPython} -I -S "$@"\n`);
  chmodSync(isolatedPython, 0o755);

  try {
    assert.equal(await vscode.commands.executeCommand("openWrangler.changeRuntime", isolatedPython), isolatedPython);
    const config = vscode.workspace.getConfiguration("openWrangler");
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, isolatedPython);

    const rejected = await testing.request({
      kind: "openSession",
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejected.kind, "error");
    if (rejected.kind === "error") {
      assert.equal(rejected.code, "missing_dependencies");
      assert.match(rejected.message, /Missing: polars/);
      assert.match(rejected.detail ?? "", /Install Runtime Dependencies/);
    }
    assert.equal(testing.runtimeRunning(), false, "Missing dependencies must fail before runtime startup.");
    assert.equal(
      await vscode.commands.executeCommand("openWrangler.installRuntimeDependencies", false),
      false,
      "A declined dependency prompt must not install or restart anything."
    );
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, isolatedPython);

    assert.equal(await vscode.commands.executeCommand("openWrangler.clearRuntime"), true);
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, undefined);
    assert.equal(getSetting("pythonPath", ""), python, "Clearing the workspace override must reveal the fallback.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function exercisePackagedViewingQueries(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const original = readFileSync(fixture.fsPath, "utf8");
  const filterModel: FilterModel = {
    logic: "or",
    filters: [
      {
        column: "city",
        type: "string",
        predicates: [{ kind: "predicate", operator: "startsWith", value: "M" }]
      },
      {
        column: "sales",
        type: "float",
        predicates: [{ kind: "predicate", operator: "gt", value: 11 }]
      }
    ],
    sort: [
      { column: "active", direction: "asc", nulls: "last" },
      { column: "sales", direction: "desc", nulls: "last" }
    ]
  };

  for (const backend of ["pandas", "polars"] as const) {
    const opened = await testing.request({
      kind: "openSession",
      source: csvSource(fixture),
      backend,
      pageSize: 2,
      mode: "viewing"
    });
    assert.equal(opened.kind, "sessionOpened", `${backend} viewing session must open.`);
    if (opened.kind !== "sessionOpened") continue;

    const page = await testing.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 2,
      filterModel
    });
    assert.equal(page.kind, "page", `${backend} advanced filter and multi-sort must return a page.`);
    if (page.kind !== "page") continue;
    assert.equal(page.page.totalRows, 2);
    assert.deepEqual(
      page.page.rows.map((row) => row.values[0]?.display),
      ["Berlin", "Milan"]
    );
    assert.equal(page.metadata.steps.length, 0, "Viewing queries must not become cleaning steps.");
    assert.deepEqual(page.metadata.filterModel, filterModel);

    const summary = await testing.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      filterModel
    });
    assert.equal(summary.kind, "summary", `${backend} progressive summary must resolve.`);
    if (summary.kind === "summary") {
      assert.equal(summary.summaries.length, 4);
      assert.ok(summary.summaries.every((column) => column.totalCount === 2));
      assert.equal(summary.summaries.find((column) => column.column === "sales")?.numeric?.max, 12);
    }

    const stats = await testing.request({
      kind: "getDatasetStats",
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      filterModel
    });
    assert.equal(stats.kind, "datasetStats", `${backend} exact dataset stats must resolve.`);
    if (stats.kind === "datasetStats") {
      assert.equal(stats.stats.missingCells, 0);
      assert.equal(stats.stats.missingRows, 0);
      assert.equal(stats.stats.duplicateRows, 0);
    }

    const values = await testing.request({
      kind: "getColumnValues",
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      column: "city",
      filterModel,
      search: "il",
      limit: 10
    });
    assert.equal(values.kind, "columnValues", `${backend} searchable column values must resolve.`);
    if (values.kind === "columnValues") {
      assert.deepEqual(values.values, [{ value: "Milan", count: 1 }]);
      assert.equal(values.hasMore, false);
    }

    assert.equal(testing.activeSession()?.metadata.steps.length, 0);
    const closed = await testing.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: page.revision
    });
    assert.equal(closed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `${backend} viewing-query session to dispose`
    );
  }

  assert.equal(readFileSync(fixture.fsPath, "utf8"), original, "Viewing queries must not alter the source.");
}

async function exercisePackagedOperationGroups(testing: TestApi, sourceFixture: vscode.Uri): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-operation-groups-"));
  const sourcePath = path.join(directory, "operations.csv");
  const original = readFileSync(sourceFixture.fsPath, "utf8");
  writeFileSync(sourcePath, original);

  try {
    for (const backend of ["pandas", "polars"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        source: csvSource(vscode.Uri.file(sourcePath)),
        backend,
        pageSize: 20,
        mode: "editing"
      });
      assert.equal(opened.kind, "sessionOpened", `${backend} operation-group session must open.`);
      if (opened.kind !== "sessionOpened") continue;

      let revision = opened.metadata.revision;
      let stepCount = 0;
      const steps: TransformStep[] = [
        {
          id: `${backend}-sort`,
          kind: "sortRows",
          params: { rules: [{ column: "sales", direction: "desc", nulls: "last" }] }
        },
        {
          id: `${backend}-formula`,
          kind: "formula",
          params: { leftColumn: "sales", operator: "multiply", value: 2, newColumn: "score" }
        },
        {
          id: `${backend}-text`,
          kind: "upperText",
          params: { column: "city", newColumn: "city_upper" }
        },
        {
          id: `${backend}-numeric`,
          kind: "roundNumber",
          params: { column: "score", decimals: 0, newColumn: "rounded_score" }
        },
        {
          id: `${backend}-example`,
          kind: "byExample",
          params: {
            sourceColumns: ["city"],
            newColumn: "city_example",
            examples: [
              { inputs: { city: "Milan" }, output: "MILAN" },
              { inputs: { city: "Rome" }, output: "ROME" }
            ]
          }
        },
        {
          id: `${backend}-custom`,
          kind: "customCode",
          params: {
            code:
              backend === "pandas"
                ? 'result = df.assign(custom=df["sales"] + 1)'
                : 'result = df.with_columns((pl.col("sales") + 1).alias("custom"))'
          }
        },
        {
          id: `${backend}-group`,
          kind: "groupBy",
          params: {
            keys: ["active"],
            aggregations: [{ column: "sales", operation: "sum", alias: "total_sales" }]
          }
        }
      ];

      for (const step of steps) {
        const preview = await testing.request({
          kind: "previewStep",
          sessionId: opened.metadata.sessionId,
          revision,
          step,
          offset: 0,
          limit: 20
        });
        assert.equal(preview.kind, "stepPreview", `${backend} ${step.kind} must preview.`);
        if (preview.kind !== "stepPreview") break;
        assert.equal(preview.metadata.draftStep?.kind, step.kind);
        assert.match(preview.code, /def clean_data\(df\):/);
        assert.equal(preview.diff.truncated, false);
        if (backend === "polars") assert.doesNotMatch(preview.code, /to_pandas|import pandas/);
        if (step.kind === "byExample") {
          assert.ok(preview.metadata.draftStep?.params.program, "By-example preview must resolve a program.");
        }

        revision = preview.revision;
        const applied = await testing.request({
          kind: "applyDraft",
          sessionId: opened.metadata.sessionId,
          revision,
          offset: 0,
          limit: 20
        });
        assert.equal(applied.kind, "planUpdated", `${backend} ${step.kind} must apply.`);
        if (applied.kind !== "planUpdated") break;
        stepCount += 1;
        revision = applied.revision;
        assert.equal(applied.metadata.steps.length, stepCount);

        if (step.kind === "customCode") {
          const generation = testing.runtimeGeneration();
          testing.restartRuntime(`${backend} custom-code replay acceptance`);
          const replayed = await testing.request({
            kind: "getPage",
            sessionId: opened.metadata.sessionId,
            revision,
            offset: 0,
            limit: 20,
            filterModel: applied.metadata.filterModel
          });
          assert.equal(replayed.kind, "page", `${backend} custom-code plan must replay after restart.`);
          assert.equal(testing.runtimeGeneration(), generation + 1);
          if (replayed.kind === "page") revision = replayed.revision;
        }
      }

      assert.equal(stepCount, steps.length, `${backend} must apply every representative operation group.`);
      const active = testing.activeSession();
      assert.equal(active?.metadata.steps.length, steps.length);
      assert.deepEqual(
        active?.metadata.schema.map((column) => column.name),
        ["active", "total_sales"]
      );
      assert.match(active?.code ?? "", /def clean_data/u, `${backend} must retain executable generated code.`);

      const editedCode = `# edited ${backend} code preview\ndef clean_data(df):\n    return df\n`;
      const priorClipboard = await vscode.env.clipboard.readText();
      testing.setCodeForExport(editedCode);
      const copiedCode = await vscode.commands.executeCommand<string>("openWrangler.copyCode");
      assert.equal(copiedCode, editedCode, `${backend} must copy the edited code buffer.`);
      if ((await vscode.env.clipboard.readText()) === editedCode) {
        await vscode.env.clipboard.writeText(priorClipboard);
      }
      const scriptPath = path.join(directory, `${backend}.clean.py`);
      await vscode.commands.executeCommand("openWrangler.exportCode", vscode.Uri.file(scriptPath));
      assert.equal(readFileSync(scriptPath, "utf8"), editedCode, `${backend} must export the edited code buffer.`);

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision
      });
      assert.equal(closed.kind, "sessionClosed");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        `${backend} operation-group session to dispose`
      );
    }

    assert.equal(
      readFileSync(sourcePath, "utf8"),
      original,
      "Operation previews and applies must not alter the source."
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function csvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

function tsvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: "\t", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, expectation: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${expectation}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
