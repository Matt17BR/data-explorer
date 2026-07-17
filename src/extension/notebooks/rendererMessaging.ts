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
    messaging.onDidReceiveMessage(({ editor, message }) => {
      if (!isOpenInOpenWranglerMessage(message)) {
        return;
      }
      const payload = normalizeNotebookOutputPayload(message.payload);
      if (!payload) {
        void vscode.window.showErrorMessage("This Open Wrangler notebook output is malformed or unsupported.");
        return;
      }

      const notebook = originatingNotebook(editor);
      if (!notebook) {
        void vscode.window.showErrorMessage(
          "The notebook that sent this Open Wrangler action is no longer open. Reopen it and try again."
        );
        return;
      }

      const variableName = payload.metadata.source.variableName;
      if (variableName && isPythonIdentifier(variableName)) {
        try {
          OpenWranglerPanel.create(
            context,
            coordinator.createBridge(new KernelBridge(context, notebook), notebook),
            {
              kind: "notebookVariable",
              label: variableName,
              variableName,
              uri: notebook.uri.toString()
            },
            payload.metadata.backend
          );
        } catch (error) {
          const detail = error instanceof Error ? ` ${error.message}` : "";
          void vscode.window.showErrorMessage(`Open Wrangler could not open the originating notebook.${detail}`);
        }
        return;
      }

      OpenWranglerPanel.createFromPayload(context, bridge, notebookPayloadAsOpened(payload));
    })
  );
}

function originatingNotebook(editor: vscode.NotebookEditor): vscode.NotebookDocument | undefined {
  const notebook = editor?.notebook;
  if (
    !notebook ||
    notebook.isClosed ||
    !vscode.window.visibleNotebookEditors.includes(editor) ||
    !vscode.workspace.notebookDocuments.includes(notebook)
  ) {
    return undefined;
  }
  return notebook;
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
