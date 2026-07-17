import * as vscode from "vscode";
import { isPythonIdentifier, normalizeNotebookOutputPayload } from "../../shared/notebookOutput";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge } from "./kernelBridge";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";
import { SnapshotBridge } from "./snapshotBridge";

interface OpenInOpenWranglerMessage {
  kind: "openInOpenWrangler" | "openLiveInOpenWrangler";
  payload: unknown;
}

export function registerNotebookRendererMessaging(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): void {
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

      if (message.kind === "openLiveInOpenWrangler") {
        if (!isSoleOpenNotebookDocument(notebook)) {
          void vscode.window.showErrorMessage(
            "The notebook that sent this Open Wrangler action is no longer uniquely open. Close duplicate or replacement views and try again."
          );
          return;
        }
        const variableName = payload.metadata.source.variableName;
        if (!variableName || !isPythonIdentifier(variableName)) {
          void vscode.window.showErrorMessage("This Open Wrangler output does not contain a valid live variable link.");
          return;
        }
        try {
          OpenWranglerPanel.create(context, coordinator.createBridge(new KernelBridge(context, notebook), notebook), {
            kind: "notebookVariable",
            label: variableName,
            variableName,
            uri: notebook.uri.toString()
          });
        } catch (error) {
          const detail = error instanceof Error ? ` ${error.message}` : "";
          void vscode.window.showErrorMessage(`Open Wrangler could not open the originating notebook.${detail}`);
        }
        return;
      }

      try {
        OpenWranglerPanel.create(
          context,
          coordinator.createBridge(SnapshotBridge.fromNormalized(payload)),
          { kind: "notebookOutput", label: payload.metadata.source.label },
          payload.metadata.backend
        );
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        void vscode.window.showErrorMessage(`Open Wrangler could not open this saved notebook output.${detail}`);
      }
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
  return (
    (candidate.kind === "openInOpenWrangler" || candidate.kind === "openLiveInOpenWrangler") &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}
