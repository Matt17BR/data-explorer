import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { DataExplorerPanel } from "../webviewPanel";
import { KernelBridge } from "./kernelBridge";

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
  getKernelService?: () => Promise<unknown>;
}

export const registerNotebookCommands = (context: vscode.ExtensionContext): void => {
  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.launchDataViewer", async (...args: unknown[]) => {
      const variableName = variableNameFromArgs(args);
      if (!variableName) {
        vscode.window.showWarningMessage("Data Explorer could not determine the notebook variable name to open.");
        return;
      }

      await openLiveNotebookVariable(context, variableName, notebookUriFromArgs(args));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openNotebookVariable", async () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (!notebook) {
        vscode.window.showWarningMessage("Open a Jupyter notebook before launching a notebook variable in Data Explorer.");
        return;
      }

      const variableName = await vscode.window.showInputBox({
        title: "Open Notebook Variable in Data Explorer",
        prompt: "Enter a Pandas or Polars dataframe variable name from the active notebook kernel.",
        validateInput: (value) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : "Enter a valid Python variable name.")
      });
      if (!variableName) {
        return;
      }

      await openLiveNotebookVariable(context, variableName, notebook.uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.checkJupyterIntegration", async () => {
      const jupyter = vscode.extensions.getExtension<JupyterLikeApi>("ms-toolsai.jupyter");
      if (!jupyter) {
        vscode.window.showInformationMessage("Install the VS Code Jupyter extension to launch live notebook variables.");
        return;
      }
      await jupyter.activate();
      vscode.window.showInformationMessage("Data Explorer found the Jupyter extension.");
    })
  );
};

async function openLiveNotebookVariable(
  context: vscode.ExtensionContext,
  variableName: string,
  notebookUri?: vscode.Uri
): Promise<void> {
  const notebook = notebookUri ?? vscode.window.activeNotebookEditor?.notebook.uri;
  if (!notebook) {
    vscode.window.showWarningMessage("Open a Jupyter notebook before launching a notebook variable in Data Explorer.");
    return;
  }

  const source: SessionSource = {
    kind: "notebookVariable",
    label: variableName,
    variableName
  };
  const panel = DataExplorerPanel.create(context, new KernelBridge(context, notebook), source);
  await panel.open();
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

function notebookUriFromArgs(args: unknown[]): vscode.Uri | undefined {
  for (const arg of args) {
    if (arg instanceof vscode.Uri) {
      return arg;
    }
    if (typeof arg !== "object" || arg === null) {
      continue;
    }
    const candidate = arg as NotebookVariableArgument;
    if (candidate.notebookUri instanceof vscode.Uri) {
      return candidate.notebookUri;
    }
    if (candidate.uri instanceof vscode.Uri) {
      return candidate.uri;
    }
  }
  return vscode.window.activeNotebookEditor?.notebook.uri;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
