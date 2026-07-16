import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";

type CommandHandler = (...args: unknown[]) => unknown;

const fileMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  createPanel: vi.fn(),
  panelConstructor: vi.fn(),
  promptImportOptions: vi.fn<(uri: unknown) => Promise<unknown>>(async () => undefined),
  defaultImportOptions: vi.fn(() => undefined),
  stat: vi.fn(async () => ({ type: 1 })),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showOpenDialog: vi.fn<() => Promise<unknown>>(async () => undefined),
  customEditorProvider: undefined as
    | {
        resolveCustomEditor(document: { uri: unknown }, panel: { dispose(): void }): Promise<void>;
      }
    | undefined,
  activeTabInput: undefined as unknown,
  activeTextUri: undefined as unknown,
  enabledFileTypes: ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"],
  ImportCancelledError: class ImportCancelledError extends Error {}
}));

vi.mock("vscode", () => {
  class Uri {
    readonly authority: string;
    readonly path: string;
    readonly query = "";
    readonly fragment = "";

    private constructor(
      readonly scheme: string,
      readonly fsPath: string,
      authority = ""
    ) {
      this.authority = authority;
      this.path = fsPath;
    }

    static file(path: string): Uri {
      return new Uri("file", path);
    }

    static from(components: { scheme: string; path?: string; authority?: string }): Uri {
      return new Uri(components.scheme, components.path ?? "", components.authority);
    }

    toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }

  class TabInputText {
    constructor(readonly uri: Uri) {}
  }

  class TabInputTextDiff {
    constructor(
      readonly original: Uri,
      readonly modified: Uri
    ) {}
  }

  class TabInputCustom {
    constructor(
      readonly uri: Uri,
      readonly viewType: string
    ) {}
  }

  const disposable = () => ({ dispose: () => undefined });
  return {
    Uri,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    FileType: { File: 1, Directory: 2 },
    ViewColumn: { Active: 1 },
    commands: {
      executeCommand: fileMocks.executeCommand,
      registerCommand: (id: string, handler: CommandHandler) => {
        fileMocks.commands.set(id, handler);
        return disposable();
      }
    },
    window: {
      get activeTextEditor() {
        return fileMocks.activeTextUri ? { document: { uri: fileMocks.activeTextUri } } : undefined;
      },
      tabGroups: {
        activeTabGroup: {
          get activeTab() {
            return fileMocks.activeTabInput ? { input: fileMocks.activeTabInput } : undefined;
          }
        }
      },
      registerCustomEditorProvider: (_id: string, provider: typeof fileMocks.customEditorProvider) => {
        fileMocks.customEditorProvider = provider;
        return disposable();
      },
      showWarningMessage: fileMocks.showWarningMessage,
      showErrorMessage: fileMocks.showErrorMessage,
      showOpenDialog: fileMocks.showOpenDialog
    },
    workspace: {
      fs: { stat: fileMocks.stat }
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: class OpenWranglerPanel {
    static create(...args: unknown[]): unknown {
      return fileMocks.createPanel(...args);
    }

    constructor(...args: unknown[]) {
      fileMocks.panelConstructor(...args);
    }
  }
}));

vi.mock("../extension/files/importOptions", () => ({
  defaultImportOptions: fileMocks.defaultImportOptions,
  promptImportOptions: fileMocks.promptImportOptions,
  ImportCancelledError: fileMocks.ImportCancelledError
}));

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(key: string, fallback: T): T =>
    (key === "enabledFileTypes" ? fileMocks.enabledFileTypes : fallback) as T
}));

import { registerFileCommands } from "../extension/files/fileOpen";

describe("file launch command", () => {
  beforeEach(() => {
    fileMocks.commands.clear();
    fileMocks.executeCommand.mockClear();
    fileMocks.createPanel.mockClear();
    fileMocks.panelConstructor.mockClear();
    fileMocks.promptImportOptions.mockReset();
    fileMocks.promptImportOptions.mockResolvedValue(undefined);
    fileMocks.defaultImportOptions.mockClear();
    fileMocks.stat.mockReset();
    fileMocks.stat.mockResolvedValue({ type: vscode.FileType.File });
    fileMocks.showWarningMessage.mockClear();
    fileMocks.showErrorMessage.mockClear();
    fileMocks.showOpenDialog.mockReset();
    fileMocks.showOpenDialog.mockResolvedValue(undefined);
    fileMocks.customEditorProvider = undefined;
    fileMocks.activeTabInput = undefined;
    fileMocks.activeTextUri = undefined;
    fileMocks.enabledFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"];
  });

  it("prefers the URI supplied by an editor or Explorer menu", async () => {
    const { context, bridge } = register();
    const menuUri = vscode.Uri.file("/workspace/menu.PARQUET");
    fileMocks.activeTextUri = vscode.Uri.file("/workspace/other.jsonl");

    await command("openWrangler.openFile")(menuUri);

    expect(fileMocks.stat).toHaveBeenCalledWith(menuUri);
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      bridge,
      {
        kind: "file",
        label: "menu.PARQUET",
        path: "/workspace/menu.PARQUET",
        uri: menuUri.toString(),
        importOptions: undefined
      },
      undefined
    );
  });

  it("falls back to text, custom, and modified diff tab resources", async () => {
    const candidates = [
      new vscode.TabInputText(vscode.Uri.file("/workspace/text.jsonl")),
      new vscode.TabInputCustom(vscode.Uri.file("/workspace/custom.parquet"), "thirdParty.csvEditor"),
      new vscode.TabInputTextDiff(
        vscode.Uri.file("/workspace/original.csv"),
        vscode.Uri.file("/workspace/modified.jsonl")
      )
    ];

    for (const input of candidates) {
      fileMocks.activeTabInput = input;
      fileMocks.createPanel.mockClear();
      register();
      await command("openWrangler.openFile")();
      expect(fileMocks.createPanel).toHaveBeenCalledOnce();
    }
  });

  it("falls back to the active text editor when the active tab has no resource", async () => {
    const uri = vscode.Uri.file("/workspace/active.jsonl");
    fileMocks.activeTextUri = uri;
    register();

    await command("openWrangler.openFile")();

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(fileMocks.createPanel).toHaveBeenCalledOnce();
  });

  it("accepts uppercase files in a VS Code remote workspace", async () => {
    const uri = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
      path: "/workspace/FRAME.CSV"
    });
    fileMocks.promptImportOptions.mockResolvedValue({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    register();

    await command("openWrangler.openFile")(uri);

    expect(fileMocks.createPanel).toHaveBeenCalledOnce();
    expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["untitled", vscode.Uri.from({ scheme: "untitled", path: "Untitled-1.csv" }), /save this data file/i],
    ["virtual", vscode.Uri.from({ scheme: "git", path: "/workspace/data.csv" }), /local files/i],
    ["unsupported", vscode.Uri.file("/workspace/notes.txt"), /supports CSV/i]
  ])("rejects %s resources before filesystem access", async (_case, uri, warning) => {
    register();

    await command("openWrangler.openFile")(uri);

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(warning));
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("distinguishes a supported but disabled file type", async () => {
    fileMocks.enabledFileTypes = ["csv"];
    register();

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.parquet"));

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(".parquet is disabled in Open Wrangler settings.");
    expect(fileMocks.stat).not.toHaveBeenCalled();
  });

  it("rejects directories and inaccessible resources without starting a runtime", async () => {
    register();
    const directory = vscode.Uri.file("/workspace/data.csv");
    fileMocks.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory });

    await command("openWrangler.openFile")(directory);

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith("Choose a data file, not a folder.");
    expect(fileMocks.createPanel).not.toHaveBeenCalled();

    fileMocks.stat.mockRejectedValueOnce(new Error("missing"));
    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/missing.csv"));
    expect(fileMocks.showErrorMessage).toHaveBeenCalledWith(
      "Open Wrangler could not access file:///workspace/missing.csv."
    );
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("rejects unknown and special filesystem nodes before starting a runtime", async () => {
    register();
    fileMocks.stat.mockResolvedValueOnce({ type: vscode.FileType.Unknown });

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/pipe.csv"));

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(
      "Choose a regular data file, not a special filesystem resource."
    );
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("does not open a panel after import configuration is cancelled", async () => {
    fileMocks.promptImportOptions.mockRejectedValueOnce(new fileMocks.ImportCancelledError());
    register();

    await command("openWrangler.openFile")(vscode.Uri.file("/workspace/data.csv"));

    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("opens the file picker when no usable editor resource exists", async () => {
    fileMocks.activeTabInput = new vscode.TabInputCustom(
      vscode.Uri.file("/workspace/already.csv"),
      "openWrangler.viewer"
    );
    register();

    await command("openWrangler.openFile")();

    expect(fileMocks.executeCommand).toHaveBeenCalledWith("openWrangler.openPath");
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("validates a picker result even when the native dialog returns a disallowed file", async () => {
    const selected = vscode.Uri.file("/workspace/notes.txt");
    fileMocks.showOpenDialog.mockResolvedValueOnce([selected]);
    register();

    await command("openWrangler.openPath")();

    expect(fileMocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/supports CSV/i));
    expect(fileMocks.stat).not.toHaveBeenCalled();
    expect(fileMocks.createPanel).not.toHaveBeenCalled();
  });

  it("opens a validated picker result", async () => {
    const selected = vscode.Uri.file("/workspace/data.csv");
    fileMocks.showOpenDialog.mockResolvedValueOnce([selected]);
    const { context, bridge } = register();

    await command("openWrangler.openPath")();

    expect(fileMocks.stat).toHaveBeenCalledWith(selected);
    expect(fileMocks.createPanel).toHaveBeenCalledWith(
      context,
      bridge,
      expect.objectContaining({ path: "/workspace/data.csv" }),
      undefined
    );
  });

  it("rejects a virtual custom-editor resource before constructing its panel", async () => {
    const panel = { dispose: vi.fn() };
    register();

    await fileMocks.customEditorProvider?.resolveCustomEditor(
      { uri: vscode.Uri.from({ scheme: "git", path: "/workspace/data.csv" }) },
      panel
    );

    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(fileMocks.panelConstructor).not.toHaveBeenCalled();
    expect(fileMocks.stat).not.toHaveBeenCalled();
  });

  it("validates a supported custom-editor resource before constructing its panel", async () => {
    const uri = vscode.Uri.file("/workspace/data.csv");
    const panel = { dispose: vi.fn() };
    const { context, bridge } = register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel);

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(fileMocks.panelConstructor).toHaveBeenCalledWith(
      panel,
      context,
      bridge,
      expect.objectContaining({ path: "/workspace/data.csv" }),
      undefined
    );
  });

  it("keeps explicit custom-editor selection available for a picker-disabled format", async () => {
    const uri = vscode.Uri.file("/workspace/data.parquet");
    const panel = { dispose: vi.fn() };
    fileMocks.enabledFileTypes = ["csv"];
    register();

    await fileMocks.customEditorProvider?.resolveCustomEditor({ uri }, panel);

    expect(fileMocks.stat).toHaveBeenCalledWith(uri);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(fileMocks.panelConstructor).toHaveBeenCalledOnce();
    expect(fileMocks.showWarningMessage).not.toHaveBeenCalled();
  });
});

function register(): { context: ExtensionContext; bridge: OpenWranglerBridge } {
  const context = {
    extensionPath: "/tmp/openwrangler",
    subscriptions: []
  } as unknown as ExtensionContext;
  const bridge = {} as OpenWranglerBridge;
  registerFileCommands(context, bridge);
  return { context, bridge };
}

function command(id: string): CommandHandler {
  const handler = fileMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}
