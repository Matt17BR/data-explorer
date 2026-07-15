import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { insertGeneratedNotebookCell } from "../../extension/notebooks/notebookInsertion";
import type {
  DataExplorerRequest,
  DataExplorerResponse,
  FilterModel,
  SessionMetadata,
  SessionSource,
  TransformStep
} from "../../shared/protocol";

interface TestApi {
  request(request: DataExplorerRequest): Promise<DataExplorerResponse>;
  setActiveSession(sessionId: string | undefined): void;
  activeSession(): { sessionId: string; metadata: SessionMetadata } | undefined;
  diagnostics(): {
    activeSessionId?: string;
    sessionCount: number;
    sessions: Array<{ publicId: string; runtimeId: string; sourceLabel: string }>;
  };
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
}

interface ExtensionApi {
  testing?: TestApi;
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("matt17br.data-explorer");
  assert.ok(extension, "The Data Explorer extension must be discoverable.");
  const extensionApi = await extension.activate();
  const testing = extensionApi?.testing;
  assert.ok(testing, "The isolated acceptance harness must enable the test-only extension API.");
  assert.equal(extension.isActive, true, "The extension must activate successfully.");
  assert.equal(extension.packageJSON.publisher, "Matt17BR");
  assert.equal(extension.packageJSON.icon, "media/icon.png");
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "icon.png"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "activity-icon.svg"));
  const testPython = process.env.DATA_EXPLORER_TEST_PYTHON;
  if (testPython) {
    await vscode.workspace
      .getConfiguration("dataExplorer")
      .update("pythonPath", testPython, vscode.ConfigurationTarget.Global);
  }

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "dataExplorer.openPath",
    "dataExplorer.openFile",
    "dataExplorer.launchDataViewer",
    "dataExplorer.openNotebookVariable",
    "dataExplorer.checkJupyterIntegration",
    "dataExplorer.changeRuntime",
    "dataExplorer.clearRuntime",
    "dataExplorer.installRuntimeDependencies",
    "dataExplorer.startOperation",
    "dataExplorer.applyStep",
    "dataExplorer.discardStep",
    "dataExplorer.editLatestStep",
    "dataExplorer.undoStep",
    "dataExplorer.copyCode",
    "dataExplorer.exportCode",
    "dataExplorer.insertNotebookCode",
    "dataExplorer.exportData",
    "dataExplorer.openSourceFile",
    "dataExplorer.openWalkthrough",
    "dataExplorer.openSettings",
    "dataExplorer.reportIssue"
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
      (container) => container.id === "dataExplorer" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.deepEqual(
    contributions.views?.dataExplorer?.map((view) => view.id),
    ["dataExplorer.operations", "dataExplorer.summary", "dataExplorer.filters", "dataExplorer.cleaningSteps"]
  );
  assert.ok(contributions.configuration?.properties?.["dataExplorer.fetchBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["dataExplorer.filterMode"]);
  assert.deepEqual(
    contributions.keybindings?.map((binding) => ({
      command: binding.command,
      key: binding.key,
      mac: binding.mac,
      when: binding.when
    })),
    [
      {
        command: "dataExplorer.applyStep",
        key: "ctrl+enter",
        mac: "cmd+enter",
        when: "activeCustomEditor == dataExplorer.viewer && dataExplorer.hasDraft"
      },
      {
        command: "dataExplorer.discardStep",
        key: "escape",
        mac: undefined,
        when: "activeCustomEditor == dataExplorer.viewer && dataExplorer.hasDraft"
      },
      {
        command: "dataExplorer.editLatestStep",
        key: "ctrl+shift+e",
        mac: "cmd+shift+e",
        when: "activeCustomEditor == dataExplorer.viewer && dataExplorer.canChangePlan"
      },
      {
        command: "dataExplorer.undoStep",
        key: "ctrl+alt+z",
        mac: "cmd+alt+z",
        when: "activeCustomEditor == dataExplorer.viewer && dataExplorer.canChangePlan"
      }
    ]
  );
  assert.deepEqual(contributions.notebookRenderer?.[0]?.mimeTypes, [
    "application/vnd.data-explorer.viewer.v1+json",
    "application/vnd.data-explorer.viewer.v2+json"
  ]);
  assert.ok(
    extension.packageJSON.contributes.walkthroughs?.some(
      (walkthrough: { id?: string }) => walkthrough.id === "gettingStarted"
    )
  );

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The extension-host fixture workspace must be open.");
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.csv");
  const phase = process.env.DATA_EXPLORER_TEST_PHASE ?? "verify";
  if (phase === "seed") {
    await seedPersistedPlan(testing, fixture);
    console.log("Data Explorer extension-host persistence seed passed.");
    return;
  }

  if (phase === "single") await seedPersistedPlan(testing, fixture);
  await verifyPersistedReplayAndRecovery(testing, workspace, fixture);
  await vscode.commands.executeCommand("vscode.openWith", fixture, "dataExplorer.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.viewType === "dataExplorer.viewer";
    },
    15_000,
    "the Data Explorer custom editor"
  );

  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeInput instanceof vscode.TabInputCustom);
  assert.equal(activeInput.viewType, "dataExplorer.viewer");
  assert.equal(path.basename(activeInput.uri.fsPath), "sample.csv");
  await vscode.commands.executeCommand("dataExplorer.openSourceFile");
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

  if (testPython) await exercisePackagedFileInputs(testing, workspace, testPython);
  await exercisePackagedOperationGroups(testing, fixture);

  const notebookDirectory = mkdtempSync(path.join(tmpdir(), "data-explorer-notebook-"));
  try {
    const notebookPath = path.join(notebookDirectory, "insertion.ipynb");
    writeFileSync(
      notebookPath,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: ["value = 1"]
          }
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      })
    );
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
    const inserted = await insertGeneratedNotebookCell(notebook, 1, "def clean_data(df):\n    return df\n", {
      source: "df",
      backend: "polars"
    });
    assert.equal(inserted, true);
    assert.equal(notebook.cellCount, 2);
    assert.equal(notebook.cellAt(1).document.getText(), "def clean_data(df):\n    return df\n");
    assert.deepEqual(notebook.cellAt(1).metadata.dataExplorer, {
      source: "df",
      backend: "polars",
      generated: true
    });
    assert.equal(await notebook.save(), true);
  } finally {
    rmSync(notebookDirectory, { recursive: true, force: true });
  }

  console.log("Data Explorer extension-host acceptance passed.");
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

  const exportDirectory = mkdtempSync(path.join(tmpdir(), "data-explorer-export-"));
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
  const directory = mkdtempSync(path.join(tmpdir(), "data-explorer-file-inputs-"));
  const config = vscode.workspace.getConfiguration("dataExplorer");
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
        "dataExplorer.viewer",
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

async function exercisePackagedOperationGroups(testing: TestApi, sourceFixture: vscode.Uri): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "data-explorer-operation-groups-"));
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
