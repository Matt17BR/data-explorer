import * as path from "path";
import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";
import type { OpenWranglerBridge } from "../dataBridge";
import { OpenWranglerPanel } from "../webviewPanel";
import { getSetting } from "../configuration";
import { defaultImportOptions, ImportCancelledError, promptImportOptions } from "./importOptions";

const CUSTOM_EDITOR_ID = "openWrangler.viewer";

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
    if (!(await validateFileTarget(document.uri, false))) {
      webviewPanel.dispose();
      return;
    }
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
    vscode.commands.registerCommand("openWrangler.openFile", async (resource?: unknown) => {
      const target = resolveFileTarget(resource);
      if (!target) {
        await vscode.commands.executeCommand("openWrangler.openPath");
        return;
      }
      if (!(await validateFileTarget(target))) return;

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
      if (!(await validateFileTarget(selected))) return;

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

const allFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"] as const;
const supportedFileTypes = new Set<string>(allFileTypes);
const supportedSchemes = new Set(["file", "vscode-remote"]);

const getEnabledFileTypes = (): string[] => getSetting<string[]>("enabledFileTypes", [...allFileTypes]);

const fileType = (uri: vscode.Uri): string => path.extname(uri.fsPath).slice(1).toLowerCase();

const resolveFileTarget = (resource: unknown): vscode.Uri | undefined => {
  if (resource instanceof vscode.Uri) return resource;

  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputCustom && input.viewType !== CUSTOM_EDITOR_ID) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
};

const validateFileTarget = async (uri: vscode.Uri, requireEnabledType = true): Promise<boolean> => {
  if (uri.scheme === "untitled") {
    await vscode.window.showWarningMessage("Save this data file before opening it in Open Wrangler.");
    return false;
  }
  if (!supportedSchemes.has(uri.scheme)) {
    await vscode.window.showWarningMessage(
      "Open Wrangler can open local files and files in VS Code remote workspaces."
    );
    return false;
  }

  const extension = fileType(uri);
  if (!supportedFileTypes.has(extension)) {
    await vscode.window.showWarningMessage("Open Wrangler supports CSV, TSV, Parquet, JSONL, XLSX, and XLS files.");
    return false;
  }
  if (requireEnabledType && !getEnabledFileTypes().includes(extension)) {
    await vscode.window.showWarningMessage(`.${extension} is disabled in Open Wrangler settings.`);
    return false;
  }

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      await vscode.window.showWarningMessage("Choose a data file, not a folder.");
      return false;
    }
    if ((stat.type & vscode.FileType.File) === 0) {
      await vscode.window.showWarningMessage("Choose a regular data file, not a special filesystem resource.");
      return false;
    }
  } catch {
    await vscode.window.showErrorMessage(`Open Wrangler could not access ${uri.toString()}.`);
    return false;
  }
  return true;
};
