import * as vscode from "vscode";
import { registerFileCommands } from "./files/fileOpen";
import { registerNotebookCommands } from "./notebooks/jupyterBridge";
import { registerNotebookRendererMessaging } from "./notebooks/rendererMessaging";
import { PythonBridge } from "./pythonBridge";
import { SessionCoordinator } from "./sessionCoordinator";
import { registerRuntimeCommands } from "./runtimeCommands";
import { registerNativeViews } from "./nativeViews";

export function activate(context: vscode.ExtensionContext): void {
  const bridge = new PythonBridge(context);
  const coordinator = new SessionCoordinator(context.workspaceState);
  const coordinatedBridge = coordinator.createBridge(bridge);
  context.subscriptions.push(coordinator, bridge);

  registerFileCommands(context, coordinatedBridge);
  registerNativeViews(context, coordinator);
  registerRuntimeCommands(context, bridge);
  registerNotebookCommands(context, coordinator);
  registerNotebookRendererMessaging(context, coordinatedBridge, coordinator);
}

export function deactivate(): void {
  // Disposables registered on the extension context clean up the Python bridge.
}
