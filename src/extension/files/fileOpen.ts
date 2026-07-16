import * as path from "path";
import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";
import type { OpenWranglerBridge } from "../dataBridge";
import { OpenWranglerPanel } from "../webviewPanel";
import { getSetting } from "../configuration";

const CUSTOM_EDITOR_ID = "openWrangler.viewer";
import { defaultImportOptions, ImportCancelledError, promptImportOptions } from "./importOptions";

export class OpenWranglerCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: OpenWranglerBridge
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return {
      uri,
      dispose: () => undefined
    };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const source = fileSource(document.uri, defaultImportOptions(document.uri));
    const defaultBackend = getDefaultBackend();
    new OpenWranglerPanel(webviewPanel, this.context, this.bridge, source, defaultBackend);
  }
}

export const registerFileCommands = (context: vscode.ExtensionContext, bridge: OpenWranglerBridge): void => {
  const provider = new OpenWranglerCustomEditorProvider(context, bridge);
  const providerOptions = {
    supportsMultipleEditorsPerDocument: true,
    webviewOptions: {
      retainContextWhenHidden: true
    }
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(CUSTOM_EDITOR_ID, provider, providerOptions));

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openFile", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        await vscode.commands.executeCommand("openWrangler.openPath");
        return;
      }
      if (!isEnabledFileType(target)) {
        await vscode.window.showWarningMessage(
          `${path.extname(target.fsPath) || "This file type"} is disabled in Open Wrangler settings.`
        );
        return;
      }

      try {
        OpenWranglerPanel.create(
          context,
          bridge,
          fileSource(target, await promptImportOptions(target)),
          getDefaultBackend()
        );
      } catch (error) {
        if (!(error instanceof ImportCancelledError)) throw error;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openPath", async () => {
      const enabledFileTypes = getEnabledFileTypes();
      if (enabledFileTypes.length === 0) {
        await vscode.window.showWarningMessage("Enable at least one Open Wrangler file type in Settings.");
        return;
      }
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          "Data files": enabledFileTypes
        }
      });
      const selected = files?.[0];
      if (!selected) {
        return;
      }

      try {
        OpenWranglerPanel.create(
          context,
          bridge,
          fileSource(selected, await promptImportOptions(selected)),
          getDefaultBackend()
        );
      } catch (error) {
        if (!(error instanceof ImportCancelledError)) throw error;
      }
    })
  );
};

const fileSource = (uri: vscode.Uri, importOptions?: SessionSource["importOptions"]): SessionSource => ({
  kind: "file",
  label: path.basename(uri.fsPath),
  path: uri.fsPath,
  uri: uri.toString(),
  importOptions
});

const getDefaultBackend = (): DataBackend | undefined => {
  const configured = getSetting<DataBackend | "auto">("defaultBackend", "auto");
  return configured === "auto" ? undefined : configured;
};

const allFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"];

const getEnabledFileTypes = (): string[] => getSetting<string[]>("enabledFileTypes", allFileTypes);

const isEnabledFileType = (uri: vscode.Uri): boolean =>
  getEnabledFileTypes().includes(path.extname(uri.fsPath).slice(1).toLowerCase());
