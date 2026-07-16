import * as vscode from "vscode";
import { normalizeNotebookOutputPayload, notebookPayloadAsOpened } from "../../shared/notebookOutput";
import type { OpenWranglerBridge } from "../dataBridge";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge } from "./kernelBridge";
import { getSetting } from "../configuration";

interface OpenInOpenWranglerMessage {
  kind: "openInOpenWrangler";
  payload: unknown;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  bridge: OpenWranglerBridge,
  coordinator: SessionCoordinator
): void {
  if (!getSetting<boolean>("renderer.enabled", true)) {
    return;
  }
  const messaging = vscode.notebooks.createRendererMessaging("openWrangler.renderer");
  context.subscriptions.push(
    messaging.onDidReceiveMessage(({ message }) => {
      if (!isOpenInOpenWranglerMessage(message)) {
        return;
      }
      const payload = normalizeNotebookOutputPayload(message.payload);
      if (!payload) {
        void vscode.window.showErrorMessage("This Open Wrangler notebook output is malformed or unsupported.");
        return;
      }

      const notebook = vscode.window.activeNotebookEditor?.notebook.uri;
      const variableName = payload.metadata.source.variableName;
      if (notebook && variableName && isPythonIdentifier(variableName)) {
        OpenWranglerPanel.create(
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

      OpenWranglerPanel.createFromPayload(context, bridge, notebookPayloadAsOpened(payload));
    })
  );
}

function isOpenInOpenWranglerMessage(message: unknown): message is OpenInOpenWranglerMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { kind?: unknown; payload?: unknown };
  return candidate.kind === "openInOpenWrangler" && typeof candidate.payload === "object" && candidate.payload !== null;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
