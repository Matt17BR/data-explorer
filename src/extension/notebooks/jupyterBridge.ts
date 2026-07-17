import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge } from "./kernelBridge";
import { SessionCoordinator } from "../sessionCoordinator";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

interface NotebookVariableArgument {
  name?: unknown;
  variableName?: unknown;
  expression?: unknown;
  title?: unknown;
  notebookUri?: unknown;
  uri?: unknown;
  variable?: {
    name?: unknown;
    variableName?: unknown;
  };
}

interface JupyterLikeApi {
  kernels: { getKernel(uri: vscode.Uri): Promise<unknown> | unknown };
}

export const registerNotebookCommands = (context: vscode.ExtensionContext, coordinator: SessionCoordinator): void => {
  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.launchDataViewer", async (...args: unknown[]) => {
      const notebookResolution = resolveNotebookAtCommandReceipt(args);
      const variableName = variableNameFromArgs(args);
      if (!variableName) {
        vscode.window.showWarningMessage("Open Wrangler could not determine the notebook variable name to open.");
        return;
      }
      if (!notebookResolution.notebook) {
        vscode.window.showWarningMessage(notebookResolution.error);
        return;
      }

      await openLiveNotebookVariable(context, coordinator, variableName, notebookResolution.notebook);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openNotebookVariable", async () => {
      const notebookResolution = resolveNotebookAtCommandReceipt([]);
      const notebook = notebookResolution.notebook;
      if (!notebook) {
        vscode.window.showWarningMessage(
          "Open a Jupyter notebook before launching a notebook variable in Open Wrangler."
        );
        return;
      }

      const variableName = await vscode.window.showInputBox({
        title: "Open Notebook Variable in Open Wrangler",
        prompt: "Enter a Pandas or Polars dataframe variable name from the active notebook kernel.",
        validateInput: (value) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a valid Python variable name."
      });
      if (!variableName) {
        return;
      }

      await openLiveNotebookVariable(context, coordinator, variableName, notebook);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.checkJupyterIntegration", async () => {
      const notebookResolution = resolveNotebookAtCommandReceipt([]);
      const jupyter = vscode.extensions.getExtension<JupyterLikeApi>("ms-toolsai.jupyter");
      if (!jupyter) {
        vscode.window.showInformationMessage(
          "Install the VS Code Jupyter extension to launch live notebook variables."
        );
        return;
      }
      const api = await jupyter.activate();
      const notebook = notebookResolution.notebook;
      if (notebook && !isExactOpenNotebook(notebook)) {
        vscode.window.showWarningMessage(
          "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
        );
        return;
      }
      const kernel = notebook ? await api.kernels.getKernel(notebook.uri) : undefined;
      if (notebook && !isExactOpenNotebook(notebook)) {
        vscode.window.showWarningMessage(
          "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
        );
        return;
      }
      vscode.window.showInformationMessage(
        kernel
          ? "Open Wrangler can access the selected Jupyter kernel."
          : "Open Wrangler found Jupyter, but no active notebook kernel is selected."
      );
    })
  );
};

async function openLiveNotebookVariable(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  variableName: string,
  notebook: vscode.NotebookDocument
): Promise<void> {
  if (!isExactOpenNotebook(notebook)) {
    vscode.window.showWarningMessage("The originating notebook is no longer open. Reopen it and try again.");
    return;
  }

  const source: SessionSource = {
    kind: "notebookVariable",
    label: variableName,
    variableName,
    uri: notebook.uri.toString()
  };
  OpenWranglerPanel.create(context, coordinator.createBridge(new KernelBridge(context, notebook), notebook), source);
}

function variableNameFromArgs(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === "string" && isPythonIdentifier(arg)) {
      return arg;
    }
    if (typeof arg !== "object" || arg === null) {
      continue;
    }
    const candidate = arg as NotebookVariableArgument;
    const value =
      stringValue(candidate.variableName) ??
      stringValue(candidate.name) ??
      stringValue(candidate.expression) ??
      stringValue(candidate.title) ??
      stringValue(candidate.variable?.variableName) ??
      stringValue(candidate.variable?.name);
    if (value && isPythonIdentifier(value)) {
      return value;
    }
  }
  return undefined;
}

function explicitNotebookUrisFromArgs(args: unknown[]): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  for (const arg of args) {
    if (arg instanceof vscode.Uri) {
      uris.push(arg);
      continue;
    }
    if (typeof arg !== "object" || arg === null) {
      continue;
    }
    const candidate = arg as NotebookVariableArgument;
    if (candidate.notebookUri instanceof vscode.Uri) {
      uris.push(candidate.notebookUri);
    }
    if (candidate.uri instanceof vscode.Uri) {
      uris.push(candidate.uri);
    }
  }
  return uris;
}

type NotebookResolution = { notebook: vscode.NotebookDocument; error?: never } | { notebook?: never; error: string };

function resolveNotebookAtCommandReceipt(args: unknown[]): NotebookResolution {
  const explicitUris = explicitNotebookUrisFromArgs(args);
  if (explicitUris.length > 0) {
    const uriKeys = new Set(explicitUris.map((uri) => uri.toString()));
    if (uriKeys.size !== 1) {
      return {
        error: "Open Wrangler received more than one originating notebook. Launch the variable again from one notebook."
      };
    }
    const uriKey = explicitUris[0]?.toString();
    if (!uriKey) {
      return { error: "The originating notebook is no longer open. Reopen it and try again." };
    }
    const matches = vscode.workspace.notebookDocuments.filter(
      (document) => !document.isClosed && document.uri.toString() === uriKey
    );
    if (matches.length === 1 && matches[0]) return { notebook: matches[0] };
    if (matches.length > 1) {
      return {
        error:
          "Open Wrangler could not identify one originating notebook. Close duplicate notebook views and try again."
      };
    }
    return { error: "The originating notebook is no longer open. Reopen it and try again." };
  }

  const notebook = vscode.window.activeNotebookEditor?.notebook;
  return notebook && isExactOpenNotebook(notebook)
    ? { notebook }
    : { error: "Open a Jupyter notebook before launching a notebook variable in Open Wrangler." };
}

function isExactOpenNotebook(notebook: vscode.NotebookDocument): boolean {
  return isSoleOpenNotebookDocument(notebook);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
