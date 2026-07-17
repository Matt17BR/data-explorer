import * as vscode from "vscode";
import { registerFileCommands } from "./files/fileOpen";
import { registerNotebookCommands } from "./notebooks/jupyterBridge";
import { registerNotebookRendererMessaging } from "./notebooks/rendererMessaging";
import { PythonBridge } from "./pythonBridge";
import { SessionCoordinator } from "./sessionCoordinator";
import { registerRuntimeCommands } from "./runtimeCommands";
import { registerNativeViews } from "./nativeViews";
import type { GridViewState } from "../shared/viewState";

export interface OpenWranglerTestApi {
  request: ReturnType<SessionCoordinator["createBridge"]>["request"];
  setActiveSession(sessionId: string | undefined): void;
  activeSession: SessionCoordinator["activeSession"];
  updateViewState(sessionId: string, state: GridViewState): Promise<void>;
  diagnostics: SessionCoordinator["diagnostics"];
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  declineRuntimeDependencyInstallation(): Promise<boolean>;
  setCodeForExport(code: string): void;
  exportCodeTo(destination: vscode.Uri): Promise<void>;
}

export interface OpenWranglerExtensionApi {
  testing?: OpenWranglerTestApi;
}

let activeCoordinator: SessionCoordinator | undefined;
let activeBridge: PythonBridge | undefined;

export function activate(context: vscode.ExtensionContext): OpenWranglerExtensionApi | undefined {
  const bridge = new PythonBridge(context);
  const coordinator = new SessionCoordinator(context.workspaceState, (message) => bridge.reportDiagnostic(message));
  activeCoordinator = coordinator;
  activeBridge = bridge;
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
        updateViewState: async (sessionId, state) => coordinatedBridge.updateViewState?.(sessionId, state),
        diagnostics: () => coordinator.diagnostics(),
        restartRuntime: (reason) => bridge.restart(reason),
        runtimeGeneration: () => bridge.runtimeGeneration,
        runtimeRunning: () => bridge.runtimeRunning,
        declineRuntimeDependencyInstallation: () => bridge.declineMissingDependencyInstallForTesting(),
        setCodeForExport: (code) => nativeViews.setCodeForExport(code),
        exportCodeTo: (destination) => nativeViews.exportCodeTo(destination)
      }
    };
  }
  return undefined;
}

export async function deactivate(): Promise<void> {
  const coordinator = activeCoordinator;
  const bridge = activeBridge;
  activeCoordinator = undefined;
  activeBridge = undefined;
  try {
    await coordinator?.shutdown();
  } finally {
    bridge?.dispose();
  }
}
