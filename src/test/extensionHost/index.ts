import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { chromium, type Page } from "playwright-core";
import { getSetting } from "../../extension/configuration";
import { insertGeneratedNotebookCell } from "../../extension/notebooks/notebookInsertion";
import { OPEN_WRANGLER_MIME_V2 } from "../../shared/notebookOutput";
import type {
  ColumnReference,
  GridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  FilterModel,
  SessionMetadata,
  SessionSource,
  StepInspectionResponse,
  TransformStep
} from "../../shared/protocol";
import type { GridViewState, PersistedViewingState } from "../../shared/viewState";

interface TestApi {
  request(request: OpenWranglerRequest): Promise<OpenWranglerResponse>;
  setActiveSession(sessionId: string | undefined): void;
  activeSession():
    | {
        sessionId: string;
        metadata: SessionMetadata;
        code?: string;
        viewState: PersistedViewingState;
        stepInspection?: StepInspectionResponse;
      }
    | undefined;
  updateViewState(sessionId: string, state: GridViewState): Promise<void>;
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

const DUCKDB_FOREIGN_ENGINE_CONVERSION =
  /\b(?:pandas|polars|pyarrow)\b|(?:to|from)_(?:pandas|polars|arrow)\b|fetch_(?:df|pandas|arrow)\b|\.(?:arrow|df|pl)\s*\(/iu;
const GRID_COLUMN_WINDOW = { columnOffset: 0, columnLimit: 16 } as const;

function columnReference(metadata: SessionMetadata, name: string): ColumnReference {
  const column = metadata.schema.find((candidate) => candidate.name === name);
  assert.ok(column, `Expected ${name} in the opened session schema.`);
  return { id: column.id, name: column.name };
}

function columnReferenceAt(metadata: SessionMetadata, position: number): ColumnReference {
  const column = metadata.schema[position];
  assert.ok(column, `Expected a column at position ${position} in the opened session schema.`);
  return { id: column.id, name: column.name };
}

function gridColumnCells(page: GridPage, columnId: string): GridPage["rows"][number]["values"] {
  const position = page.columnIds.indexOf(columnId);
  assert.notEqual(position, -1, `Expected projected page column ${columnId}.`);
  return page.rows.map((row) => {
    const value = row.values[position];
    assert.ok(value, `Expected a cell for projected page column ${columnId}.`);
    return value;
  });
}

function gridColumnDisplays(page: GridPage, columnId: string): string[] {
  return gridColumnCells(page, columnId).map((value) => value.display);
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
    "openWrangler.selectStep",
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
    configurationDefaults?: Record<string, unknown>;
    commands?: Array<{ command?: string; title?: string; shortTitle?: string; icon?: string }>;
    viewsContainers?: { activitybar?: Array<{ id?: string; icon?: string }> };
    views?: Record<string, Array<{ id?: string }>>;
    configuration?: { properties?: Record<string, unknown> };
    notebookRenderer?: Array<{ mimeTypes?: string[] }>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
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
  assert.ok(contributions.configuration?.properties?.["openWrangler.fetchColumnBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.filterMode"]);
  const enabledFileTypes = contributions.configuration?.properties?.["openWrangler.enabledFileTypes"] as
    { items?: { enum?: string[] }; default?: string[] } | undefined;
  assert.ok(enabledFileTypes?.items?.enum?.includes("xls"));
  assert.ok(enabledFileTypes?.default?.includes("xls"));
  assert.deepEqual(contributions.configurationDefaults?.["cursor.general.pinnedTitleActions"], [
    "openWrangler.openFile"
  ]);
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.openFile"),
    {
      command: "openWrangler.openFile",
      title: "Open in Open Wrangler",
      icon: "$(open-preview)"
    }
  );
  const fileResourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|xlsx|xls)$/i";
  assert.ok(
    contributions.menus?.["explorer/context"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when === `!explorerResourceIsFolder && ${fileResourcePredicate}` &&
        item.group === "navigation@50"
    ),
    "Explorer data files must expose the canonical Open in Open Wrangler action."
  );
  assert.ok(
    contributions.menus?.["editor/title"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when ===
          `${fileResourcePredicate} && ` + "(!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)" &&
        item.group === "navigation@1"
    ),
    "Supported source editors must expose the Open Wrangler title action."
  );
  assert.ok(
    contributions.menus?.["editor/title/context"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when ===
          `${fileResourcePredicate} && (!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)` &&
        item.group === "navigation@50"
    ),
    "Supported source tabs must expose Open in Open Wrangler in their context menu."
  );
  assert.ok(
    contributions.menus?.commandPalette?.some(
      (item) => item.command === "openWrangler.launchDataViewer" && item.when === "false"
    ),
    "The argument-only Jupyter viewer command must stay out of the Command Palette."
  );
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
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.discardStep",
        key: "escape",
        mac: undefined,
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.editLatestStep",
        key: "ctrl+shift+e",
        mac: "cmd+shift+e",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.canChangePlan"
      },
      {
        command: "openWrangler.undoStep",
        key: "ctrl+alt+z",
        mac: "cmd+alt+z",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.canChangePlan"
      }
    ]
  );
  assert.ok(
    contributions.menus?.["view/item/context"]?.some(
      (item) =>
        item.command === "openWrangler.editLatestStep" &&
        item.when ===
          "view == openWrangler.cleaningSteps && viewItem == openWrangler.latestCleaningStep && openWrangler.canChangePlan" &&
        item.group === "inline@10"
    ),
    "Edit Latest Step must be unavailable from the Cleaning Steps menu while a draft blocks plan changes."
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
  await exercisePackagedStepInspection(testing, fixture);
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
  await exerciseWideColumnProjection(testing);
  await exercisePackagedOperationGroups(testing, fixture);
  await exercisePackagedNotebookFlows(testing);
  if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    await exercisePackagedFileLaunchSurfaces(
      testing,
      vscode.Uri.file(path.join(path.dirname(fixture.fsPath), "sample.jsonl")),
      process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
    );
  }
  if (process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
    await capturePackagedEditorScreenshots(testing, fixture, process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS);
  }

  console.log("Open Wrangler extension-host acceptance passed.");
}

async function exercisePackagedStepInspection(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.source.path === fixture.fsPath &&
        active.metadata.steps.some((step) => step.id === "packaged-score")
      );
    },
    30_000,
    "the packaged custom editor to restore its applied cleaning step"
  );
  await waitForSettledViewState(testing, "the confirmed packaged-editor view before step selection");

  const beforeSelection = testing.activeSession();
  assert.ok(beforeSelection, "The packaged custom editor must publish its active session.");
  assert.equal(beforeSelection.stepInspection, undefined);
  const confirmedMetadata = structuredClone(beforeSelection.metadata);
  const confirmedView = structuredClone(beforeSelection.viewState);
  const confirmedCode = beforeSelection.code;

  await vscode.commands.executeCommand("openWrangler.selectStep", "packaged-score");
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === "packaged-score",
    30_000,
    "the packaged editor to inspect the selected applied step"
  );

  const selected = testing.activeSession();
  assert.ok(selected?.stepInspection, "Selecting an applied step must publish its inspection snapshot.");
  const inspection = selected.stepInspection;
  assert.equal(inspection.revision, confirmedMetadata.revision, "Inspection must not advance the session revision.");
  assert.equal(inspection.stepIndex, 0);
  assert.deepEqual(
    inspection.inputSchema.map((column) => column.name),
    ["city", "year", "sales", "active"]
  );
  assert.deepEqual(
    inspection.outputSchema.map((column) => column.name),
    ["city", "year", "sales", "active", "score"]
  );
  assert.deepEqual(inspection.diff.addedColumns, ["score"]);
  assert.deepEqual(inspection.diff.removedColumns, []);
  assert.equal(inspection.diff.truncated, false);
  assert.match(inspection.code, /def clean_data\(df\):/u);
  assert.match(inspection.code, /score/u);
  assert.deepEqual(selected.metadata, confirmedMetadata, "Inspection must leave the confirmed metadata unchanged.");
  assert.deepEqual(selected.viewState, confirmedView, "Inspection must leave the confirmed view unchanged.");

  await vscode.commands.executeCommand("openWrangler.selectStep");
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "Original Data to clear the selected applied-step inspection"
  );
  await waitForSettledViewState(testing, "the confirmed packaged-editor view after clearing step selection");

  const restored = testing.activeSession();
  assert.ok(restored, "Clearing an inspection must retain the active dataframe session.");
  assert.equal(restored.stepInspection, undefined);
  assert.deepEqual(restored.metadata, confirmedMetadata, "Clearing must restore the exact confirmed metadata.");
  assert.deepEqual(
    restored.viewState,
    confirmedView,
    "Clearing must restore filters, sorts, widths, selection, and viewport exactly."
  );
  assert.equal(restored.code, confirmedCode, "Clearing must restore the full-plan generated code.");
}

async function waitForSettledViewState(testing: TestApi, expectation: string): Promise<void> {
  const started = Date.now();
  // The coordinator snapshot can become active before the newly mounted Electron
  // webview reports its browser-quantized physical scroll position. Wait across
  // the webview debounce and a full render quiet period so inspection compares
  // two confirmed UI states rather than racing that initial report.
  const stableForMs = 1_200;
  let previous = "";
  let unchangedSince = started;
  while (Date.now() - started <= 10_000) {
    const active = testing.activeSession();
    const current = active ? JSON.stringify(active.viewState) : "";
    if (current !== previous) {
      previous = current;
      unchangedSince = Date.now();
    } else if (active && Date.now() - unchangedSince >= stableForMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expectation}.`);
}

async function exercisePackagedFileLaunchSurfaces(
  testing: TestApi,
  fixture: vscode.Uri,
  outputDirectory?: string
): Promise<void> {
  const sourceBytes = readFileSync(fixture.fsPath);
  const page = await connectToEditorWorkbench();
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  const activeEditorGroup = page.locator(".part.editor .editor-group-container.active");
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible');

  if (editor === "cursor") {
    const pinnedTitleActions = vscode.workspace
      .getConfiguration("cursor.general")
      .inspect<string[]>("pinnedTitleActions");
    assert.ok(pinnedTitleActions, "Cursor must register its pinned-title-action setting.");
    assert.ok(
      pinnedTitleActions.defaultValue?.includes("openWrangler.openFile"),
      "The packaged Cursor default must pin the canonical file action."
    );
    assert.equal(
      pinnedTitleActions.globalValue,
      undefined,
      "Cursor acceptance must not persist a user-level title-action setting."
    );
    assert.equal(
      pinnedTitleActions.workspaceValue,
      undefined,
      "Cursor acceptance must not persist a workspace title-action setting."
    );
  }

  const availableCommands = new Set(await vscode.commands.getCommands(true));
  const auxiliaryBar = page.locator(".part.auxiliarybar");
  if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
    const closeAuxiliaryBar = availableCommands.has("workbench.action.closeAuxiliaryBar")
      ? "workbench.action.closeAuxiliaryBar"
      : availableCommands.has("workbench.action.toggleAuxiliaryBar")
        ? "workbench.action.toggleAuxiliaryBar"
        : undefined;
    if (closeAuxiliaryBar) await vscode.commands.executeCommand(closeAuxiliaryBar);
  }
  if (availableCommands.has("notifications.clearAll")) {
    await vscode.commands.executeCommand("notifications.clearAll");
  }
  if (availableCommands.has("notifications.hideList")) {
    await vscode.commands.executeCommand("notifications.hideList");
  }

  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    "the source text editor before file-launch interaction"
  );
  await page.bringToFront();
  try {
    await titleAction.first().waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const visibleEditorLabels = await page
      .locator(".part.editor .editor-group-container.active [aria-label]:visible")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
    const moreActions = activeEditorGroup.locator('[aria-label="More Actions..."]:visible').first();
    let overflowItems: string[] = [];
    if ((await moreActions.count()) > 0) {
      await moreActions.click();
      overflowItems = await page
        .locator('.context-view.monaco-menu-container [role="menuitem"]:visible')
        .allInnerTexts();
      await page.keyboard.press("Escape");
    }
    throw new Error(
      `Open Wrangler editor-title action was not visible. Visible editor labels: ${JSON.stringify(visibleEditorLabels)}. Editor overflow items: ${JSON.stringify(overflowItems)}`,
      { cause: error }
    );
  }
  if (outputDirectory) {
    mkdirSync(outputDirectory, { recursive: true });
    await titleAction.first().hover();
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "Open in Open Wrangler" })
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => {});
    await captureWorkbenchScreenshot(page, path.resolve(outputDirectory, `${editor}-file-title-action.png`));
    await page.keyboard.press("Escape");
  }

  await titleAction.first().click();
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    30_000,
    "the editor-title action to open the selected source"
  );
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "The editor-title action must not modify its source.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the editor-title launch session to dispose"
  );

  const sourceTab = page
    .locator(".part.editor .tabs-container .tab")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  const activeSourceTab = page
    .locator(".part.editor .editor-group-container.active .tabs-container .tab.active")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  await sourceTab.waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.bringToFront();
  await sourceTab.click();
  await activeSourceTab.waitFor({ state: "visible", timeout: 10_000 });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    "the source tab to become active before opening its context menu"
  );
  const tabMenuAction = page
    .locator('.context-view.monaco-menu-container:visible [role="menuitem"]')
    .filter({
      has: page.locator('.action-label[aria-label="Open in Open Wrangler"]')
    })
    .last();
  await activeSourceTab.click({ button: "right" });
  try {
    await tabMenuAction.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    await page.keyboard.press("Escape");
    await activeSourceTab.click({ button: "right" });
    await tabMenuAction.waitFor({ state: "visible", timeout: 10_000 });
  }
  await page.waitForTimeout(350);
  assert.equal(
    (await tabMenuAction.innerText()).trim(),
    "Open in Open Wrangler",
    "The editor-tab context action must use the compact product label."
  );
  if (outputDirectory) {
    await captureWorkbenchScreenshot(page, path.resolve(outputDirectory, `${editor}-tab-context-menu.png`));
  }
  await tabMenuAction.click();
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    30_000,
    "the editor-tab context action to open the selected source"
  );
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "The editor-tab action must not modify its source.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the editor-tab launch session to dispose"
  );

  const customEditorFixture = vscode.Uri.file(path.join(path.dirname(fixture.fsPath), "sample.csv"));
  const customEditorSourceBytes = readFileSync(customEditorFixture.fsPath);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    customEditorFixture,
    "openwrangler-tests.csvEditor",
    vscode.ViewColumn.One
  );
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return (
        input instanceof vscode.TabInputCustom &&
        input.viewType === "openwrangler-tests.csvEditor" &&
        input.uri.toString() === customEditorFixture.toString()
      );
    },
    10_000,
    "the third-party CSV custom editor before file-launch interaction"
  );
  await page.bringToFront();
  await titleAction.first().waitFor({ state: "visible", timeout: 10_000 });
  await titleAction.first().click();
  await acceptDefaultDelimitedImport(page);
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === customEditorFixture.fsPath,
    30_000,
    "the third-party custom-editor title action to open the selected CSV source"
  );
  assert.deepEqual(testing.activeSession()?.metadata.source.importOptions, {
    delimiter: ",",
    encoding: "utf-8",
    quoteChar: '"',
    hasHeader: true
  });
  assert.deepEqual(
    readFileSync(customEditorFixture.fsPath),
    customEditorSourceBytes,
    "The third-party custom-editor title action must not modify its source."
  );
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the third-party custom-editor launch session to dispose"
  );

  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    30_000,
    "the custom editor before duplicate-action verification"
  );
  await page.bringToFront();
  await page.waitForTimeout(250);
  assert.equal(await titleAction.count(), 0, "The Open Wrangler custom editor must not offer a duplicate open action.");
  const openWranglerTab = activeEditorGroup
    .locator(".tabs-container .tab.active")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  await openWranglerTab.click({ button: "right" });
  await page.waitForTimeout(350);
  assert.equal(
    await tabMenuAction.count(),
    0,
    "The Open Wrangler custom-editor tab must not offer a duplicate open action."
  );
  await page.keyboard.press("Escape");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the launch-surface custom editor to dispose"
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

async function acceptDefaultDelimitedImport(page: Page): Promise<void> {
  for (const title of ["Delimiter", "Text encoding", "Header row", "Quote character"]) {
    const quickInput = page.locator(".quick-input-widget:visible").filter({ hasText: title }).last();
    await quickInput.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
  }
}

async function connectToEditorWorkbench(): Promise<Page> {
  const cdpPort = Number(process.env.OPEN_WRANGLER_EDITOR_CDP_PORT);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Editor workbench interaction requires a CDP port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    if ((await page.locator(".monaco-workbench").count()) > 0) return page;
  }
  const workbench = pages.find((page) => page.url().includes("workbench"));
  assert.ok(workbench, "The editor CDP endpoint must expose its workbench page.");
  return workbench;
}

async function captureWorkbenchScreenshot(page: Page, destination: string): Promise<void> {
  await page.bringToFront();
  const viewport = await page.evaluate(() => {
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
  const workbenchOffsets: number[] = [];
  for (const selector of [".monaco-workbench", ".part.sidebar", ".part.editor", ".part.activitybar"]) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    const bounds = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bounds && bounds.y > 0) workbenchOffsets.push(bounds.y);
  }
  const titleBarHeight = Math.ceil(Math.min(...workbenchOffsets, Number.POSITIVE_INFINITY) * viewport.scale);
  const screenshotOptions = {
    path: destination,
    animations: "disabled" as const,
    timeout: 60_000,
    ...(Number.isFinite(titleBarHeight) && titleBarHeight > 0 && titleBarHeight < viewport.height
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
    await page.screenshot(screenshotOptions);
  } catch (error) {
    await page.bringToFront();
    await page.waitForTimeout(500);
    try {
      await page.screenshot(screenshotOptions);
    } catch {
      throw error;
    }
  }
  const image = readFileSync(destination);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
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
  const capturePage = await connectToEditorWorkbench();
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
    await captureWorkbenchScreenshot(capturePage, destination);
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
    columnIds: ["c:0"],
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
      "duplicate_frame = pd.DataFrame([[2, 10.26, 'a', 'red', 'x', '2024-01-02', '2020-05-06'], [1, 20.74, 'b', 'blue', 'y', '2024-02-03', '2021-06-07'], [2, 10.26, 'c', 'red', 'z', '2024-03-04', '2022-07-08'], [2, None, 'd', 'green', 'x', '2024-04-05', '2023-08-09']], columns=['duplicate', 'duplicate', 7, 'category', 'category', 'when', 'when'])",
      "duplicate_frame_source = duplicate_frame.copy(deep=True)",
      "identity_frame = duplicate_frame.copy(deep=True)",
      "identity_frame.iloc[:, 2] = ['alpha', 'bravo', 'charlie', 'delta']",
      "identity_frame_source = identity_frame.copy(deep=True)",
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
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-page",
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
      ...GRID_COLUMN_WINDOW,
      sessionId: active.sessionId,
      revision: pandasPage.revision,
      step: {
        id: "notebook-score",
        kind: "formula",
        params: {
          leftColumn: columnReference(active.metadata, "value"),
          operator: "multiply",
          value: 2,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") throw new Error("Pandas notebook step did not preview.");
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
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
      variableName: "duplicate_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "duplicate_frame",
      30_000,
      "the packaged duplicate-column Pandas notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Duplicate-column Pandas notebook session did not become active.");
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["duplicate", "duplicate", "7", "category", "category", "when", "when"]
    );
    const firstDuplicate = columnReferenceAt(active.metadata, 0);
    const secondDuplicate = columnReferenceAt(active.metadata, 1);
    const integerLabel = columnReferenceAt(active.metadata, 2);
    const firstCategory = columnReferenceAt(active.metadata, 3);
    const secondCategory = columnReferenceAt(active.metadata, 4);
    const firstDatetime = columnReferenceAt(active.metadata, 5);
    const secondDatetime = columnReferenceAt(active.metadata, 6);
    assert.notEqual(firstDuplicate.id, secondDuplicate.id, "Duplicate labels must retain distinct stable identities.");
    assert.notEqual(firstCategory.id, secondCategory.id, "Duplicate category labels must retain distinct identities.");
    assert.notEqual(firstDatetime.id, secondDatetime.id, "Duplicate datetime labels must retain distinct identities.");
    assert.equal(integerLabel.name, "7");

    let duplicateRevision = active.metadata.revision;
    const valueSteps: TransformStep[] = [
      {
        id: "duplicate-one-hot-second-category",
        kind: "oneHotEncode",
        params: { columns: [secondCategory], prefixSeparator: "__", dropOriginal: false }
      },
      {
        id: "integer-label-uppercase",
        kind: "upperText",
        params: { column: integerLabel }
      },
      {
        id: "duplicate-round-second",
        kind: "roundNumber",
        params: { column: secondDuplicate, decimals: 1 }
      },
      {
        id: "duplicate-format-second-datetime",
        kind: "formatDatetime",
        params: { column: secondDatetime, format: "%Y" }
      }
    ];
    const valueCodeMarkers: readonly (readonly RegExp[])[] = [
      [
        /for _position_0, _column_0 in \[\(4, 'category'\)\]:\s+_encoded_series_0 = df\.iloc\[:, _position_0\]/u,
        /\.eq\(value\)\.fillna\(False\)\.astype\('int8'\)/u
      ],
      [/df\.isetitem\(2, df\.iloc\[:, 2\]\.astype\('string'\)\.map\(str\.upper, na_action='ignore'\)\)/u],
      [/df\.isetitem\(1, pd\.to_numeric\(df\.iloc\[:, 1\], errors='coerce'\)\.round\(1\)\)/u],
      [/df\.isetitem\(6, pd\.to_datetime\(df\.iloc\[:, 6\], errors='coerce'\)\.dt\.strftime\('%Y'\)\)/u]
    ];

    for (const [index, step] of valueSteps.entries()) {
      const valuePreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicateRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(valuePreview.kind, "stepPreview", `Packaged ${step.kind} must preview duplicate labels.`);
      if (valuePreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} duplicate-label preview did not resolve.`);
      }
      for (const marker of valueCodeMarkers[index]) {
        assert.match(
          valuePreview.code,
          marker,
          `${step.kind} generated code must bind its operation-specific implementation to the exact Pandas position.`
        );
      }
      assert.doesNotMatch(
        JSON.stringify(valuePreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private bound positions must not leak into public value-operation drafts."
      );

      if (step.kind === "oneHotEncode") {
        const encodedX = columnReference(valuePreview.metadata, "category__x");
        const encodedY = columnReference(valuePreview.metadata, "category__y");
        const encodedZ = columnReference(valuePreview.metadata, "category__z");
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedX.id), ["1", "0", "0", "1"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedY.id), ["0", "1", "0", "0"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedZ.id), ["0", "0", "1", "0"]);
        assert.equal(
          valuePreview.metadata.schema.some((column) => column.name === "category__red"),
          false,
          "One-hot encoding must use the selected second duplicate, not its same-named neighbor."
        );
      } else if (step.kind === "upperText") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, integerLabel.id), ["A", "B", "C", "D"]);
      } else if (step.kind === "roundNumber") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, secondDuplicate.id).slice(0, 3), [
          "10.3",
          "20.7",
          "10.3"
        ]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, firstDuplicate.id), ["2", "1", "2", "2"]);
      } else if (step.kind === "formatDatetime") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, secondDatetime.id), ["2020", "2021", "2022", "2023"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, firstDatetime.id), [
          "2024-01-02",
          "2024-02-03",
          "2024-03-04",
          "2024-04-05"
        ]);
      }

      const valueApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: valuePreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(valueApplied.kind, "planUpdated", `Packaged ${step.kind} must apply duplicate labels.`);
      if (valueApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} duplicate-label apply did not resolve.`);
      }
      assert.equal(valueApplied.metadata.steps.length, index + 1);
      assert.doesNotMatch(
        JSON.stringify(valueApplied.metadata.steps),
        /"position"\s*:/u,
        "Private bound positions must not leak into persisted value-operation steps."
      );
      duplicateRevision = valueApplied.revision;
    }

    const duplicateSteps: TransformStep[] = [
      {
        id: "duplicate-sort-second",
        kind: "sortRows",
        params: {
          rules: [
            { column: secondDuplicate, direction: "desc", nulls: "last" },
            { column: integerLabel, direction: "desc", nulls: "last" }
          ]
        }
      },
      {
        id: "duplicate-filter-first",
        kind: "filterRows",
        params: {
          filterModel: {
            logic: "and",
            filters: [
              {
                column: firstDuplicate,
                type: "integer",
                predicates: [{ kind: "predicate", operator: "equals", value: 2 }]
              }
            ],
            sort: []
          }
        }
      },
      {
        id: "duplicate-drop-missing-second",
        kind: "dropMissingRows",
        params: { columns: [secondDuplicate], how: "any" }
      },
      {
        id: "duplicate-drop-duplicates-pair",
        kind: "dropDuplicates",
        params: { columns: [firstDuplicate, secondDuplicate], keep: "first" }
      }
    ];
    const expectedThirdColumnAfterStep = [["B", "C", "A", "D"], ["C", "A", "D"], ["C", "A"], ["C"]];
    const expectedCodeMarkerAfterStep: readonly (readonly RegExp[])[] = [
      [/_sort_order_4_0 = df\.iloc\[:, 2\]/u, /_sort_order_4_1 = df\.iloc\[:, 1\]/u],
      [/_filter_mask_5 = \(\(df\.iloc\[:, 0\] == 2\)\)/u],
      [
        /_missing_positions_6 = \[1\] or list\(range\(df\.shape\[1\]\)\)/u,
        /\[df\.iloc\[:, position\]\.notna\(\) for position in _missing_positions_6\]/u
      ],
      [
        /_duplicate_positions_7 = \[0, 1\] or list\(range\(df\.shape\[1\]\)\)/u,
        /df\.iloc\[:, _duplicate_positions_7\]/u
      ]
    ];

    for (const [index, step] of duplicateSteps.entries()) {
      const duplicatePreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicateRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(duplicatePreview.kind, "stepPreview", `Packaged ${step.kind} must preview duplicate labels.`);
      if (duplicatePreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} duplicate-label preview did not resolve.`);
      }
      for (const marker of expectedCodeMarkerAfterStep[index]) {
        assert.match(
          duplicatePreview.code,
          marker,
          `${step.kind} generated code must bind its operation-specific implementation to the exact Pandas position.`
        );
      }
      assert.doesNotMatch(
        JSON.stringify(duplicatePreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private bound positions must not leak into the public draft step."
      );
      assert.deepEqual(
        duplicatePreview.page.rows.map((row) => row.values[2]?.display),
        expectedThirdColumnAfterStep[index],
        `${step.kind} must target the selected duplicate or integer-labelled column before apply.`
      );
      const duplicateApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicatePreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(duplicateApplied.kind, "planUpdated", `Packaged ${step.kind} must apply duplicate labels.`);
      if (duplicateApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} duplicate-label apply did not resolve.`);
      }
      assert.equal(duplicateApplied.metadata.steps.length, valueSteps.length + index + 1);
      assert.doesNotMatch(
        JSON.stringify(duplicateApplied.metadata.steps),
        /"position"\s*:/u,
        "Private bound positions must not leak into persisted cleaning steps."
      );
      duplicateRevision = duplicateApplied.revision;
    }

    const duplicateSourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(duplicate_frame.equals(duplicate_frame_source))"
    );
    assert.match(
      duplicateSourceBeforeRestart,
      /\bTrue\b/u,
      "Cleaning steps must not mutate the originating notebook dataframe before kernel recovery."
    );

    const duplicateGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const duplicateReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(duplicateReplacementGeneration > duplicateGeneration);
    const duplicateReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-duplicate-row-operations-replay",
      sessionId: active.sessionId,
      revision: duplicateRevision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(duplicateReplayed.kind, "page", "Duplicate/non-string row operations must replay after restart.");
    if (duplicateReplayed.kind !== "page") throw new Error("Duplicate/non-string row-operation replay failed.");
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, duplicateReplacementGeneration);
    assert.equal(duplicateReplayed.page.totalRows, 1);
    assert.equal(duplicateReplayed.metadata.steps.length, valueSteps.length + duplicateSteps.length);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstDuplicate.id), ["2"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondDuplicate.id), ["10.3"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, integerLabel.id), ["C"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstCategory.id), ["red"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondCategory.id), ["z"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstDatetime.id), ["2024-03-04"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondDatetime.id), ["2022"]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, secondDuplicate.id), [
      { kind: "number", raw: 10.3, display: "10.3", isNull: false, isNaN: false }
    ]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, integerLabel.id), [
      { kind: "string", raw: "C", display: "C", isNull: false, isNaN: false }
    ]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, secondDatetime.id), [
      { kind: "string", raw: "2022", display: "2022", isNull: false, isNaN: false }
    ]);
    for (const [name, expected] of [
      ["category__x", "0"],
      ["category__y", "0"],
      ["category__z", "1"]
    ] as const) {
      assert.deepEqual(
        gridColumnDisplays(duplicateReplayed.page, columnReference(duplicateReplayed.metadata, name).id),
        [expected]
      );
      assert.deepEqual(gridColumnCells(duplicateReplayed.page, columnReference(duplicateReplayed.metadata, name).id), [
        { kind: "integer", raw: Number(expected), display: expected, isNull: false, isNaN: false }
      ]);
    }
    assert.deepEqual(
      duplicateReplayed.metadata.schema.slice(0, 7).map((column) => column.name),
      ["duplicate", "duplicate", "7", "category", "category", "when", "when"]
    );
    assert.doesNotMatch(
      JSON.stringify(duplicateReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public references."
    );
    const duplicateClosed = await testing.request({
      kind: "closeSession",
      sessionId: active.sessionId,
      revision: duplicateReplayed.revision
    });
    assert.equal(duplicateClosed.kind, "sessionClosed");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the duplicate-column Pandas notebook session to close"
    );
    assert.deepEqual(testing.diagnostics().sessions, [], "Duplicate/non-string acceptance must retain no session.");
    const duplicateSourceState = await jupyter.testing.execute(
      notebook.uri,
      "print(duplicate_frame.equals(duplicate_frame_source))"
    );
    assert.match(
      duplicateSourceState,
      /\bTrue\b/u,
      "Cleaning steps must not mutate the originating notebook dataframe."
    );

    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "identity_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "identity_frame",
      30_000,
      "the packaged group-by/by-example duplicate-column Pandas notebook session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Group-by/by-example duplicate-column Pandas session did not become active.");
    const identitySessionId = active.sessionId;
    const identityFirstDuplicate = columnReferenceAt(active.metadata, 0);
    const identitySecondDuplicate = columnReferenceAt(active.metadata, 1);
    const identityIntegerLabel = columnReferenceAt(active.metadata, 2);
    assert.notEqual(
      identityFirstDuplicate.id,
      identitySecondDuplicate.id,
      "Group-by/by-example acceptance requires independently addressable duplicate labels."
    );
    assert.equal(identityIntegerLabel.name, "7");

    const identityExamplePreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: active.metadata.revision,
      step: {
        id: "duplicate-by-example-stable-references",
        kind: "byExample",
        params: {
          sourceColumns: [identityIntegerLabel],
          newColumn: "upper_integer_label",
          examples: [
            { inputs: ["alpha"], output: "ALPHA" },
            { inputs: ["bravo"], output: "BRAVO" }
          ]
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(
      identityExamplePreview.kind,
      "stepPreview",
      `Stable-reference by-example must preview: ${JSON.stringify(identityExamplePreview)}`
    );
    if (identityExamplePreview.kind !== "stepPreview") {
      throw new Error(`Stable-reference by-example preview did not resolve: ${JSON.stringify(identityExamplePreview)}`);
    }
    assert.match(
      identityExamplePreview.code,
      /_open_wrangler_nullable_string_copy\(df\.iloc\[:, 2\]\)\.astype\('string'\)/u,
      "By-example generated code must address the non-string-labelled source by position."
    );
    assert.deepEqual(
      gridColumnDisplays(
        identityExamplePreview.page,
        columnReference(identityExamplePreview.metadata, "upper_integer_label").id
      ),
      ["ALPHA", "BRAVO", "CHARLIE", "DELTA"]
    );
    assert.equal(identityExamplePreview.metadata.draftStep?.kind, "byExample");
    if (identityExamplePreview.metadata.draftStep?.kind === "byExample") {
      assert.deepEqual(identityExamplePreview.metadata.draftStep.params.sourceColumns, [identityIntegerLabel]);
      assert.equal(identityExamplePreview.metadata.draftStep.params.program?.kind, "case");
      assert.match(
        JSON.stringify(identityExamplePreview.metadata.draftStep.params.program),
        new RegExp(identityIntegerLabel.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
      );
    }
    assert.doesNotMatch(
      JSON.stringify(identityExamplePreview.metadata.draftStep),
      /"position"\s*:/u,
      "Private by-example positions must not leak into public draft metadata."
    );

    const identityExampleApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityExamplePreview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(identityExampleApplied.kind, "planUpdated", "Stable-reference by-example must apply.");
    if (identityExampleApplied.kind !== "planUpdated") {
      throw new Error("Stable-reference by-example apply did not resolve.");
    }

    const identityGroupPreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityExampleApplied.revision,
      step: {
        id: "duplicate-group-stable-references",
        kind: "groupBy",
        params: {
          keys: [identityIntegerLabel],
          aggregations: [{ column: identitySecondDuplicate, operation: "sum", alias: "second_duplicate_total" }]
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(
      identityGroupPreview.kind,
      "stepPreview",
      `Stable-reference group-by must preview: ${JSON.stringify(identityGroupPreview)}`
    );
    if (identityGroupPreview.kind !== "stepPreview") {
      throw new Error(`Stable-reference group-by preview did not resolve: ${JSON.stringify(identityGroupPreview)}`);
    }
    assert.match(
      identityGroupPreview.code,
      /_group_labels_1 = \[df\.columns\[position\] for position in \[2\]\]/u,
      "Group-by generated code must bind the non-string-labelled key by position."
    );
    assert.match(
      identityGroupPreview.code,
      /pd\.concat\(\[df\.iloc\[:, position\] for position in \[2, 1\]\], axis=1\)/u,
      "Group-by generated code must bind the exact second duplicate aggregation by position."
    );
    assert.doesNotMatch(
      identityGroupPreview.code,
      /df\[['"]duplicate['"]\]/u,
      "Group-by generated code must not fall back to an ambiguous duplicate label."
    );
    assert.equal(identityGroupPreview.metadata.draftStep?.kind, "groupBy");
    if (identityGroupPreview.metadata.draftStep?.kind === "groupBy") {
      assert.deepEqual(identityGroupPreview.metadata.draftStep.params.keys, [identityIntegerLabel]);
      assert.deepEqual(identityGroupPreview.metadata.draftStep.params.aggregations, [
        { column: identitySecondDuplicate, operation: "sum", alias: "second_duplicate_total" }
      ]);
    }
    assert.doesNotMatch(
      JSON.stringify(identityGroupPreview.metadata.draftStep),
      /"position"\s*:/u,
      "Private group-by positions must not leak into public draft metadata."
    );

    const identityGroupApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityGroupPreview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(identityGroupApplied.kind, "planUpdated", "Stable-reference group-by must apply.");
    if (identityGroupApplied.kind !== "planUpdated") {
      throw new Error("Stable-reference group-by apply did not resolve.");
    }
    assert.equal(identityGroupApplied.metadata.steps.length, 2);
    assert.doesNotMatch(
      JSON.stringify(identityGroupApplied.metadata.steps),
      /"position"\s*:/u,
      "Private group-by/by-example positions must not leak into persisted public steps."
    );
    const identitySourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(identity_frame.equals(identity_frame_source))"
    );
    assert.match(
      identitySourceBeforeRestart,
      /\bTrue\b/u,
      "Group-by/by-example steps must not mutate the notebook source before recovery."
    );

    const identityGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const identityReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(identityReplacementGeneration > identityGeneration);
    const identityReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-group-by-example-stable-reference-replay",
      sessionId: identitySessionId,
      revision: identityGroupApplied.revision,
      offset: 0,
      limit: 10,
      filterModel: identityGroupApplied.metadata.filterModel
    });
    assert.equal(identityReplayed.kind, "page", "Stable-reference group-by/by-example plan must replay.");
    if (identityReplayed.kind !== "page") {
      throw new Error("Stable-reference group-by/by-example replay failed.");
    }
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, identityReplacementGeneration);
    assert.equal(identityReplayed.page.totalRows, 4);
    assert.equal(identityReplayed.metadata.steps.length, 2);
    assert.deepEqual(gridColumnDisplays(identityReplayed.page, columnReference(identityReplayed.metadata, "7").id), [
      "alpha",
      "bravo",
      "charlie",
      "delta"
    ]);
    assert.deepEqual(
      gridColumnDisplays(
        identityReplayed.page,
        columnReference(identityReplayed.metadata, "second_duplicate_total").id
      ).slice(0, 3),
      ["10.26", "20.74", "10.26"]
    );
    assert.doesNotMatch(
      JSON.stringify(identityReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public group-by/by-example references."
    );
    const identityClosed = await testing.request({
      kind: "closeSession",
      sessionId: identitySessionId,
      revision: identityReplayed.revision
    });
    assert.equal(identityClosed.kind, "sessionClosed");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the stable-reference group-by/by-example notebook session to close"
    );
    assert.deepEqual(
      testing.diagnostics().sessions,
      [],
      "Stable-reference group-by/by-example acceptance must retain no session."
    );
    const identitySourceAfterReplay = await jupyter.testing.execute(
      notebook.uri,
      "print(identity_frame.equals(identity_frame_source))"
    );
    assert.match(
      identitySourceAfterReplay,
      /\bTrue\b/u,
      "Recovered group-by/by-example steps must leave the notebook source immutable."
    );

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
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-polars-recovery-page",
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
  const filterModel: FilterModel = {
    filters: [],
    sort: [{ column: "sales", direction: "desc", nulls: "last" }]
  };
  for (const target of [
    {
      backend: "polars" as const,
      stepId: "packaged-score",
      multiplier: 2,
      score: "24.0",
      width: 250,
      scrollLeft: 35
    },
    {
      backend: "duckdb" as const,
      stepId: "packaged-duckdb-score",
      multiplier: 3,
      score: "36.0",
      width: 310,
      scrollLeft: 75
    }
  ]) {
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source,
      backend: target.backend,
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(opened.kind, "sessionOpened");
    if (opened.kind !== "sessionOpened") continue;

    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step: {
        id: target.stepId,
        kind: "formula",
        params: {
          leftColumn: columnReference(opened.metadata, "sales"),
          operator: "multiply",
          value: target.multiplier,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 20
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") continue;

    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: opened.metadata.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 20
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") continue;

    const page = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `persisted-${target.backend}-plan-page`,
      sessionId: opened.metadata.sessionId,
      revision: applied.revision,
      offset: 0,
      limit: 20,
      filterModel
    });
    assert.equal(page.kind, "page");
    if (page.kind !== "page") continue;
    assert.equal(page.page.rows[0]?.values[0]?.display, "Berlin");
    assert.equal(page.page.rows[0]?.values[4]?.display, target.score);
    assert.deepEqual(
      page.metadata.steps.map((step) => step.id),
      [target.stepId]
    );
    const salesColumnId = page.metadata.schema.find((column) => column.name === "sales")?.id;
    assert.ok(salesColumnId);
    await testing.updateViewState(opened.metadata.sessionId, {
      columnWidths: { [salesColumnId]: target.width },
      selectedColumnId: salesColumnId,
      viewport: { firstVisibleRow: 1, scrollLeft: target.scrollLeft }
    });

    const closed = await testing.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: page.revision
    });
    assert.equal(closed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the seeded ${target.backend} session and standalone runtime to close`
    );

    const readback = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source,
      backend: target.backend,
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(readback.kind, "sessionOpened");
    if (readback.kind !== "sessionOpened") continue;
    assert.deepEqual(
      readback.metadata.steps.map((step) => step.id),
      [target.stepId]
    );
    assert.equal(readback.page.rows[0]?.values[4]?.display, target.score);
    assert.deepEqual(testing.activeSession()?.viewState, {
      filterModel: { ...filterModel, logic: "and" },
      columnWidths: { [salesColumnId]: target.width },
      selectedColumnId: salesColumnId,
      viewport: { firstVisibleRow: 1, scrollLeft: target.scrollLeft }
    });
    const readbackClosed = await testing.request({
      kind: "closeSession",
      sessionId: readback.metadata.sessionId,
      revision: readback.metadata.revision
    });
    assert.equal(readbackClosed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the ${target.backend} persistence readback session to close`
    );
  }
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
    ...GRID_COLUMN_WINDOW,
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
  const restoredSalesId = restored.metadata.schema.find((column) => column.name === "sales")?.id;
  assert.ok(restoredSalesId);
  assert.deepEqual(testing.activeSession()?.viewState, {
    filterModel: restored.metadata.filterModel,
    columnWidths: { [restoredSalesId]: 250 },
    selectedColumnId: restoredSalesId,
    viewport: { firstVisibleRow: 1, scrollLeft: 35 }
  });

  const secondFixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv");
  const secondSourceText = readFileSync(secondFixture.fsPath, "utf8");
  const second = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: tsvSource(secondFixture),
    backend: "pandas",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(second.kind, "sessionOpened");
  if (second.kind !== "sessionOpened") return;
  assert.notEqual(second.metadata.sessionId, restored.metadata.sessionId);
  const third = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: csvSource(fixture),
    backend: "duckdb",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(third.kind, "sessionOpened");
  if (third.kind !== "sessionOpened") return;
  assert.deepEqual(
    third.metadata.steps.map((step) => step.id),
    ["packaged-duckdb-score"]
  );
  assert.equal(third.metadata.shape.columns, 5);
  assert.equal(third.page.rows[0]?.values[0]?.display, "Berlin");
  assert.equal(third.page.rows[0]?.values[4]?.display, "36.0");
  assert.deepEqual(third.metadata.filterModel.sort, [{ column: "sales", direction: "desc", nulls: "last" }]);
  const duckdbSalesId = third.metadata.schema.find((column) => column.name === "sales")?.id;
  assert.ok(duckdbSalesId);
  assert.deepEqual(testing.activeSession()?.viewState, {
    filterModel: third.metadata.filterModel,
    columnWidths: { [duckdbSalesId]: 310 },
    selectedColumnId: duckdbSalesId,
    viewport: { firstVisibleRow: 1, scrollLeft: 75 }
  });
  assert.notEqual(third.metadata.sessionId, restored.metadata.sessionId);
  assert.notEqual(third.metadata.sessionId, second.metadata.sessionId);
  assert.equal(testing.diagnostics().sessionCount, 3);
  testing.setActiveSession(second.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, second.metadata.sessionId);
  testing.setActiveSession(third.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, third.metadata.sessionId);
  testing.setActiveSession(restored.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, restored.metadata.sessionId);

  const beforeRestart = testing.diagnostics();
  const generation = testing.runtimeGeneration();
  testing.restartRuntime("Injected packaged-editor recovery test.");
  const [restoredPage, secondPage, thirdPage] = await Promise.all([
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-restored-page",
      sessionId: restored.metadata.sessionId,
      revision: restored.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: restored.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-second-page",
      sessionId: second.metadata.sessionId,
      revision: second.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: second.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-duckdb-page",
      sessionId: third.metadata.sessionId,
      revision: third.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: third.metadata.filterModel
    })
  ]);
  assert.equal(restoredPage.kind, "page");
  assert.equal(secondPage.kind, "page");
  assert.equal(thirdPage.kind, "page");
  if (restoredPage.kind !== "page" || secondPage.kind !== "page" || thirdPage.kind !== "page") return;
  assert.equal(testing.runtimeGeneration(), generation + 1, "Concurrent recovery must start exactly one runtime.");
  assert.equal(restoredPage.page.rows[0]?.values[4]?.display, "24.0");
  assert.equal(secondPage.metadata.shape.columns, 4);
  assert.equal(thirdPage.metadata.backend, "duckdb");
  assert.equal(thirdPage.metadata.shape.columns, 5);
  assert.equal(thirdPage.page.rows[0]?.values[4]?.display, "36.0");
  const afterRestart = testing.diagnostics();
  assert.equal(afterRestart.sessionCount, 3);
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
      { name: "pandas", sessionId: second.metadata.sessionId, revision: secondPage.revision, columns: 4 },
      { name: "duckdb", sessionId: third.metadata.sessionId, revision: thirdPage.revision, columns: 5 }
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
  const thirdClosed = await testing.request({
    kind: "closeSession",
    sessionId: third.metadata.sessionId,
    revision: thirdPage.revision
  });
  assert.equal(firstClosed.kind, "sessionClosed");
  assert.equal(secondClosed.kind, "sessionClosed");
  assert.equal(thirdClosed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "all recovered sessions and the standalone runtime to close"
  );
}

async function exercisePackagedFileInputs(testing: TestApi, workspace: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-file-inputs-"));
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalBackend = config.get<"auto" | "polars" | "duckdb" | "pandas">("defaultBackend", "auto");
  try {
    writeFileSync(
      path.join(directory, "sample.csv"),
      readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.csv").fsPath)
    );
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
    const parquetLaunchUri = vscode.Uri.file(path.join(directory, "sample.parquet"));
    const parquetSource = readFileSync(parquetLaunchUri.fsPath);
    await config.update("defaultBackend", "polars", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("openWrangler.openFile", parquetLaunchUri);
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === parquetLaunchUri.fsPath &&
          active.metadata.backend === "polars" &&
          active.metadata.shape.rows === 2 &&
          active.metadata.shape.columns === 3
        );
      },
      30_000,
      "the editor-menu file URI to open through the canonical launch command"
    );
    assert.deepEqual(
      readFileSync(parquetLaunchUri.fsPath),
      parquetSource,
      "Opening a source from an editor menu must not modify it."
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the editor-menu file session to dispose"
    );

    const fixtures = [
      {
        uri: vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv"),
        backend: "pandas" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv"),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.joinPath(workspace, "fixtures", "sample.jsonl"),
        backend: "polars" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.joinPath(workspace, "fixtures", "sample.jsonl"),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.csv")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.parquet")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.parquet")),
        backend: "duckdb" as const,
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
      ...GRID_COLUMN_WINDOW,
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
    const rejectedDuckDB = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "duckdb",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedDuckDB.kind, "error");
    if (rejectedDuckDB.kind === "error") {
      assert.equal(rejectedDuckDB.code, "missing_dependencies");
      assert.match(rejectedDuckDB.message, /Missing: duckdb>=1\.4\.5,<1\.6/);
      assert.match(rejectedDuckDB.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedLossyUtf8 = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: {
        ...csvSource(fixture),
        importOptions: {
          delimiter: ",",
          encoding: "utf8-lossy",
          quoteChar: '"',
          hasHeader: true
        }
      },
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedLossyUtf8.kind, "error");
    if (rejectedLossyUtf8.kind === "error") {
      assert.equal(rejectedLossyUtf8.code, "missing_dependencies");
      assert.match(rejectedLossyUtf8.message, /Missing: pandas/);
      assert.doesNotMatch(rejectedLossyUtf8.message, /polars|duckdb/iu);
      assert.match(rejectedLossyUtf8.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedLegacyExcel = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: {
        kind: "file",
        label: "legacy.xls",
        path: path.join(directory, "legacy.xls"),
        importOptions: { sheet: 0 }
      },
      backend: "pandas",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedLegacyExcel.kind, "error");
    if (rejectedLegacyExcel.kind === "error") {
      assert.equal(rejectedLegacyExcel.code, "missing_dependencies");
      assert.match(rejectedLegacyExcel.message, /Missing: pandas, xlrd>=2\.0\.1/);
      assert.doesNotMatch(rejectedLegacyExcel.message, /openpyxl/);
      assert.match(rejectedLegacyExcel.detail ?? "", /Install Runtime Dependencies/);
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

  for (const backend of ["pandas", "polars", "duckdb"] as const) {
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend,
      pageSize: 2,
      mode: "viewing"
    });
    assert.equal(opened.kind, "sessionOpened", `${backend} viewing session must open.`);
    if (opened.kind !== "sessionOpened") continue;

    const page = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `${backend}-filter-page`,
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
      viewRequestId: `${backend}-filter-summary`,
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
      viewRequestId: `${backend}-filter-stats`,
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
      viewRequestId: `${backend}-filter-values`,
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

async function exerciseWideColumnProjection(testing: TestApi): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-wide-projection-"));
  const sourcePath = path.join(directory, "wide.csv");
  const columnCount = 300;
  const names = Array.from({ length: columnCount }, (_, column) => `column_${column.toString().padStart(3, "0")}`);
  const values = (row: number) => names.map((_name, column) => String(row * 1_000 + column));
  const source = [names, values(0), values(1)].map((row) => row.join(",")).join("\n") + "\n";
  writeFileSync(sourcePath, source);

  try {
    for (const backend of ["pandas", "polars", "duckdb"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        source: { kind: "file", label: "wide.csv", path: sourcePath },
        backend,
        pageSize: 2,
        columnOffset: 0,
        columnLimit: 16,
        mode: "viewing"
      });
      assert.equal(opened.kind, "sessionOpened", `${backend} wide projection must open.`);
      if (opened.kind !== "sessionOpened") continue;
      assert.equal(opened.metadata.shape.columns, columnCount);
      assert.deepEqual(
        opened.page.columnIds,
        opened.metadata.schema.slice(0, 16).map((column) => column.id),
        `${backend} initial transport must stay column bounded.`
      );
      assert.ok(opened.page.rows.every((row) => row.values.length === 16));

      const projected = await testing.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: `${backend}-wide-far-columns`,
        offset: 0,
        limit: 2,
        columnOffset: 288,
        columnLimit: 12,
        filterModel: {
          logic: "and",
          filters: [
            {
              column: "column_000",
              type: "integer",
              predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
            }
          ],
          sort: [{ column: "column_001", direction: "desc", nulls: "last" }]
        }
      });
      assert.equal(projected.kind, "page", `${backend} far-column block must resolve.`);
      if (projected.kind !== "page") continue;
      assert.equal(projected.page.totalRows, 1, `${backend} must filter on an untransported column.`);
      assert.deepEqual(
        projected.page.columnIds,
        projected.metadata.schema.slice(288, 300).map((column) => column.id)
      );
      assert.equal(projected.page.rows[0]?.values[0]?.display, "1288");
      assert.equal(projected.page.rows[0]?.values[11]?.display, "1299");
      assert.ok(projected.page.rows.every((row) => row.values.length === 12));

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: projected.revision
      });
      assert.equal(closed.kind, "sessionClosed");
    }
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "wide projected sessions to close"
    );
    assert.equal(readFileSync(sourcePath, "utf8"), source, "Wide projection must not mutate the source.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function exercisePackagedOperationGroups(testing: TestApi, sourceFixture: vscode.Uri): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-operation-groups-"));
  const sourcePath = path.join(directory, "operations.csv");
  const original = readFileSync(sourceFixture.fsPath, "utf8");
  writeFileSync(sourcePath, original);

  try {
    for (const backend of ["pandas", "polars", "duckdb"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
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
          params: { rules: [{ column: columnReference(opened.metadata, "sales"), direction: "desc", nulls: "last" }] }
        },
        {
          id: `${backend}-formula`,
          kind: "formula",
          params: {
            leftColumn: columnReference(opened.metadata, "sales"),
            operator: "multiply",
            value: 2,
            newColumn: "score"
          }
        },
        {
          id: `${backend}-text`,
          kind: "upperText",
          params: { column: columnReference(opened.metadata, "city"), newColumn: "city_upper" }
        },
        {
          id: `${backend}-numeric`,
          kind: "roundNumber",
          params: {
            column: { id: `c:step:${backend}-formula:0`, name: "score" },
            decimals: 0,
            newColumn: "rounded_score"
          }
        },
        {
          id: `${backend}-example`,
          kind: "byExample",
          params: {
            sourceColumns: [columnReference(opened.metadata, "city")],
            newColumn: "city_example",
            examples: [
              { inputs: ["Milan"], output: "MILAN" },
              { inputs: ["Rome"], output: "ROME" }
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
                : backend === "polars"
                  ? 'result = df.with_columns((pl.col("sales") + 1).alias("custom"))'
                  : 'result = df.filter("sales IS NOT NULL")'
          }
        },
        {
          id: `${backend}-group`,
          kind: "groupBy",
          params: {
            keys: [columnReference(opened.metadata, "active")],
            aggregations: [
              { column: columnReference(opened.metadata, "sales"), operation: "sum", alias: "total_sales" }
            ]
          }
        }
      ];

      for (const step of steps) {
        const preview = await testing.request({
          kind: "previewStep",
          ...GRID_COLUMN_WINDOW,
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
        if (backend === "duckdb") {
          assert.match(preview.code, /\bimport duckdb\b/u);
          assert.doesNotMatch(preview.code, DUCKDB_FOREIGN_ENGINE_CONVERSION);
        }
        if (step.kind === "byExample") {
          assert.ok(preview.metadata.draftStep?.params.program, "By-example preview must resolve a program.");
        }

        revision = preview.revision;
        const applied = await testing.request({
          kind: "applyDraft",
          ...GRID_COLUMN_WINDOW,
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
            ...GRID_COLUMN_WINDOW,
            viewRequestId: `${backend}-${step.kind}-replay-page`,
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
      if (backend === "duckdb") {
        assert.match(active?.code ?? "", /\bimport duckdb\b/u);
        assert.doesNotMatch(active?.code ?? "", DUCKDB_FOREIGN_ENGINE_CONVERSION);
      }

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
