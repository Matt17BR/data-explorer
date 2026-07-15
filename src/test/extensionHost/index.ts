import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("matt17br.data-explorer");
  assert.ok(extension, "The Data Explorer extension must be discoverable.");
  await extension.activate();
  assert.equal(extension.isActive, true, "The extension must activate successfully.");

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "dataExplorer.openPath",
    "dataExplorer.openFile",
    "dataExplorer.changeRuntime",
    "dataExplorer.startOperation",
    "dataExplorer.applyStep",
    "dataExplorer.discardStep",
    "dataExplorer.editLatestStep",
    "dataExplorer.undoStep",
    "dataExplorer.openSettings",
    "dataExplorer.reportIssue"
  ]) {
    assert.ok(commands.includes(command), `Expected registered command: ${command}`);
  }

  const contributions = extension.packageJSON.contributes as {
    viewsContainers?: { activitybar?: Array<{ id?: string }> };
    views?: Record<string, Array<{ id?: string }>>;
    configuration?: { properties?: Record<string, unknown> };
  };
  assert.ok(contributions.viewsContainers?.activitybar?.some((container) => container.id === "dataExplorer"));
  assert.deepEqual(
    contributions.views?.dataExplorer?.map((view) => view.id),
    ["dataExplorer.operations", "dataExplorer.summary", "dataExplorer.filters", "dataExplorer.cleaningSteps"]
  );
  assert.ok(contributions.configuration?.properties?.["dataExplorer.fetchBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["dataExplorer.filterMode"]);

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The extension-host fixture workspace must be open.");
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.csv");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "dataExplorer.viewer", vscode.ViewColumn.One);
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === "dataExplorer.viewer";
  }, 10_000);

  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeInput instanceof vscode.TabInputCustom);
  assert.equal(activeInput.viewType, "dataExplorer.viewer");
  assert.equal(path.basename(activeInput.uri.fsPath), "sample.csv");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  console.log("Data Explorer extension-host acceptance passed.");
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the Data Explorer custom editor.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
