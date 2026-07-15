import * as vscode from "vscode";
import { normalizeNotebookOutputPayload, notebookPayloadAsOpened } from "../../shared/notebookOutput";
import type { DataExplorerBridge } from "../dataBridge";
import { SessionCoordinator } from "../sessionCoordinator";
import { DataExplorerPanel } from "../webviewPanel";
import { KernelBridge } from "./kernelBridge";

interface OpenInDataExplorerMessage {
  kind: "openInDataExplorer";
  payload: unknown;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  bridge: DataExplorerBridge,
  coordinator: SessionCoordinator
): void {
  if (!vscode.workspace.getConfiguration("dataExplorer").get<boolean>("renderer.enabled", true)) {
    return;
  }
  const messaging = vscode.notebooks.createRendererMessaging("dataExplorer.renderer");
  context.subscriptions.push(
    messaging.onDidReceiveMessage(({ message }) => {
      if (!isOpenInDataExplorerMessage(message)) {
        return;
      }
      const payload = normalizeNotebookOutputPayload(message.payload);
      if (!payload) {
        void vscode.window.showErrorMessage("This Data Explorer notebook output is malformed or unsupported.");
        return;
      }

      const notebook = vscode.window.activeNotebookEditor?.notebook.uri;
      const variableName = payload.metadata.source.variableName;
      if (notebook && variableName && isPythonIdentifier(variableName)) {
        DataExplorerPanel.create(
          context,
          coordinator.createBridge(new KernelBridge(context, notebook)),
          {
            kind: "notebookVariable",
            label: variableName,
            variableName,
            uri: notebook.toString()
          },
          payload.metadata.backend
        );
        return;
      }

      DataExplorerPanel.createFromPayload(context, bridge, notebookPayloadAsOpened(payload));
    })
  );
}

function isOpenInDataExplorerMessage(message: unknown): message is OpenInDataExplorerMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { kind?: unknown; payload?: unknown };
  return candidate.kind === "openInDataExplorer" && typeof candidate.payload === "object" && candidate.payload !== null;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
