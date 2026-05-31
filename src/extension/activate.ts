import * as vscode from "vscode";
import { registerFileCommands } from "./files/fileOpen";
import { registerNotebookCommands } from "./notebooks/jupyterBridge";
import { registerNotebookRendererMessaging } from "./notebooks/rendererMessaging";
import { PythonBridge } from "./pythonBridge";

export function activate(context: vscode.ExtensionContext): void {
  const bridge = new PythonBridge(context);
  context.subscriptions.push(bridge);

  registerFileCommands(context, bridge);
  registerNotebookCommands(context);
  registerNotebookRendererMessaging(context, bridge);
}

export function deactivate(): void {
  // Disposables registered on the extension context clean up the Python bridge.
}
