import * as vscode from "vscode";
import { registerFileCommands } from "./files/fileOpen";
import { registerNotebookCommands } from "./notebooks/jupyterBridge";
import { registerNotebookRendererMessaging } from "./notebooks/rendererMessaging";
import { PythonBridge } from "./pythonBridge";
import { SessionCoordinator } from "./sessionCoordinator";
import { registerRuntimeCommands } from "./runtimeCommands";
import { registerNativeViews } from "./nativeViews";

export interface OpenWranglerTestApi {
  request: ReturnType<SessionCoordinator["createBridge"]>["request"];
  setActiveSession(sessionId: string | undefined): void;
  activeSession: SessionCoordinator["activeSession"];
  diagnostics: SessionCoordinator["diagnostics"];
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  setCodeForExport(code: string): void;
}

export interface OpenWranglerExtensionApi {
  testing?: OpenWranglerTestApi;
}

export function activate(context: vscode.ExtensionContext): OpenWranglerExtensionApi | undefined {
  const bridge = new PythonBridge(context);
  const coordinator = new SessionCoordinator(context.workspaceState);
  const coordinatedBridge = coordinator.createBridge(bridge);
  context.subscriptions.push(coordinator, bridge);

  registerFileCommands(context, coordinatedBridge);
  const nativeViews = registerNativeViews(context, coordinator);
  registerRuntimeCommands(context, bridge);
  registerNotebookCommands(context, coordinator);
  registerNotebookRendererMessaging(context, coordinatedBridge, coordinator);

  if (process.env.OPEN_WRANGLER_EXTENSION_TESTS === "1") {
    return {
      testing: {
        request: (request, options) => coordinatedBridge.request(request, options),
        setActiveSession: (sessionId) => coordinator.setActive(sessionId),
        activeSession: () => coordinator.activeSession(),
        diagnostics: () => coordinator.diagnostics(),
        restartRuntime: (reason) => bridge.restart(reason),
        runtimeGeneration: () => bridge.runtimeGeneration,
        runtimeRunning: () => bridge.runtimeRunning,
        setCodeForExport: (code) => nativeViews.setCodeForExport(code)
      }
    };
  }
  return undefined;
}

export function deactivate(): void {
  // Disposables registered on the extension context clean up the Python bridge.
}
