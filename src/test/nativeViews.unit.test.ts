import { beforeEach, describe, expect, it, vi } from "vitest";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import type { SessionCoordinator, ActiveSessionSnapshot } from "../extension/sessionCoordinator";
import type { SessionMetadata, TransformStep } from "../shared/protocol";

type CommandHandler = (...args: unknown[]) => unknown;
type NotebookInsertionStatus = "applied" | "stale" | "indeterminate" | "rejected";

const nativeMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  sendEditorAction: vi.fn(() => true),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showSaveDialog: vi.fn(async () => undefined as unknown),
  workspaceFolders: [] as Array<{ uri: unknown }>,
  workspaceTrusted: true,
  notebookDocuments: [] as Array<{ uri: unknown; isClosed: boolean; cellCount: number }>,
  activeNotebookEditor: undefined as
    | { notebook: { uri: unknown; isClosed: boolean; cellCount: number }; selections: Array<{ end: number }> }
    | undefined,
  insertGeneratedNotebookCell: vi.fn(async (): Promise<{ status: NotebookInsertionStatus }> => ({ status: "applied" }))
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => unknown>();
    readonly event = (listener: (event: T) => unknown) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
      for (const listener of this.listeners) listener(event);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class TreeItem {
    constructor(
      readonly label: string,
      readonly collapsibleState: number
    ) {}
  }

  class ThemeIcon {
    constructor(readonly id: string) {}
  }

  class Uri {
    private constructor(
      readonly fsPath: string,
      readonly scheme: string,
      readonly authority = ""
    ) {}
    static file(path: string): Uri {
      return new Uri(path, "file");
    }
    static parse(value: string): Uri {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/u.exec(value);
      return new Uri(match?.[3] ?? value, match?.[1] ?? "file", match?.[2] ?? "");
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments: string[] = [];
      for (const segment of [base.fsPath, ...parts].join("/").split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      return new Uri(`/${segments.join("/")}`, base.scheme, base.authority);
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }

  const disposable = () => ({ dispose: () => undefined });
  return {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0 },
    ThemeIcon,
    Uri,
    ViewColumn: { Active: 1 },
    ProgressLocation: { Notification: 15 },
    version: "test",
    commands: {
      executeCommand: nativeMocks.executeCommand,
      registerCommand: (id: string, handler: CommandHandler) => {
        nativeMocks.commands.set(id, handler);
        return disposable();
      }
    },
    window: {
      get activeNotebookEditor() {
        return nativeMocks.activeNotebookEditor;
      },
      registerTreeDataProvider: () => disposable(),
      registerWebviewViewProvider: () => disposable(),
      showInformationMessage: nativeMocks.showInformationMessage,
      showWarningMessage: nativeMocks.showWarningMessage,
      showErrorMessage: nativeMocks.showErrorMessage,
      showSaveDialog: nativeMocks.showSaveDialog,
      showQuickPick: vi.fn(async () => undefined)
    },
    workspace: {
      get isTrusted(): boolean {
        return nativeMocks.workspaceTrusted;
      },
      get workspaceFolders() {
        return nativeMocks.workspaceFolders;
      },
      get notebookDocuments() {
        return nativeMocks.notebookDocuments;
      },
      getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
      fs: {}
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
      openExternal: vi.fn(async () => true)
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { sendEditorAction: nativeMocks.sendEditorAction }
}));
vi.mock("../extension/notebooks/notebookInsertion", () => ({
  insertGeneratedNotebookCell: nativeMocks.insertGeneratedNotebookCell
}));
vi.mock("../extension/configuration", () => ({
  getSetting: <T>(_key: string, fallback: T): T => fallback
}));

import { registerNativeViews } from "../extension/nativeViews";

const appliedStep: TransformStep = {
  id: "applied",
  kind: "dropMissingRows",
  params: {}
};

describe("native operation commands", () => {
  beforeEach(() => {
    nativeMocks.commands.clear();
    nativeMocks.executeCommand.mockClear();
    nativeMocks.sendEditorAction.mockClear();
    nativeMocks.sendEditorAction.mockReturnValue(true);
    nativeMocks.showInformationMessage.mockClear();
    nativeMocks.showWarningMessage.mockClear();
    nativeMocks.showErrorMessage.mockClear();
    nativeMocks.showSaveDialog.mockReset();
    nativeMocks.showSaveDialog.mockResolvedValue(undefined);
    nativeMocks.workspaceFolders.length = 0;
    nativeMocks.workspaceTrusted = true;
    nativeMocks.notebookDocuments.length = 0;
    nativeMocks.activeNotebookEditor = undefined;
    nativeMocks.insertGeneratedNotebookCell.mockReset();
    nativeMocks.insertGeneratedNotebookCell.mockResolvedValue({ status: "applied" });
  });

  it("forwards startOperation without a kind to the generic webview operation picker", async () => {
    register(noDraftSnapshot());

    await command("openWrangler.startOperation")();

    expect(nativeMocks.sendEditorAction).toHaveBeenCalledOnce();
    expect(nativeMocks.sendEditorAction).toHaveBeenCalledWith({ action: "openOperation" });
  });

  it("does not forward editLatestStep while a draft is active", async () => {
    register(snapshotWithDraft());

    await command("openWrangler.editLatestStep")();

    expect(nativeMocks.sendEditorAction).not.toHaveBeenCalled();
    expect(nativeMocks.showInformationMessage).toHaveBeenCalledWith(
      "Apply or discard the current draft before editing the latest step."
    );
  });

  it("ignores caller-provided export destinations and still opens the Save dialog", async () => {
    register(noDraftSnapshot());

    const hostileDestination = vscodeUri("/workspace/source.csv");
    await expect(command("openWrangler.exportCode")(hostileDestination)).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Export Open Wrangler Python Code",
        filters: { "Python script": ["py"] },
        saveLabel: "Export code"
      })
    );
    expect(nativeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("rechecks Workspace Trust after the Save dialog before writing", async () => {
    register(noDraftSnapshot());
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      nativeMocks.workspaceTrusted = false;
      return vscodeUri("/workspace/clean.py");
    });

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Trust this workspace before Open Wrangler can export code."
    );
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Exported Open Wrangler code")
    );
  });

  it("routes a hard-link source alias returned by the public Save dialog through the source guard", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-native-export-"));
    const source = path.join(directory, "source.csv");
    const alias = path.join(directory, "source-alias.py");
    const contents = "value\n1\n";
    try {
      await writeFile(source, contents);
      await link(source, alias);
      register(
        snapshot({
          mode: "editing",
          steps: [appliedStep],
          source: {
            kind: "file",
            label: "source.csv",
            path: source,
            uri: "file://malformed-source-metadata"
          }
        })
      );
      nativeMocks.showSaveDialog.mockResolvedValueOnce(resourceUri("file", alias));

      await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

      expect(await readFile(source, "utf8")).toBe(contents);
      expect(await readFile(alias, "utf8")).toBe(contents);
      expect((await readdir(directory)).filter((name) => name.startsWith(".openwrangler-"))).toEqual([]);
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("never overwrites the active source")
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an exact remote source URI in the default script destination", async () => {
    register(
      snapshot({
        mode: "editing",
        steps: [appliedStep],
        source: {
          kind: "file",
          label: "sales.csv",
          path: "/workspace/data/sales.csv",
          uri: "vscode-remote://ssh-remote+example/workspace/data/sales.csv"
        }
      })
    );

    await command("openWrangler.exportCode")();

    const calls = nativeMocks.showSaveDialog.mock.calls as unknown[][];
    const options = calls[0]?.[0] as {
      defaultUri?: { scheme?: string; authority?: string; fsPath?: string };
    };
    expect(options.defaultUri).toMatchObject({
      scheme: "vscode-remote",
      authority: "ssh-remote+example",
      fsPath: "/workspace/data/sales.clean.py"
    });
  });

  it("rejects a remote source authority that differs from the active workspace host", async () => {
    register(
      snapshot({
        mode: "editing",
        steps: [appliedStep],
        source: {
          kind: "file",
          label: "sales.csv",
          path: "/workspace/data/sales.csv",
          uri: "vscode-remote://ssh-remote+stale/workspace/data/sales.csv"
        }
      })
    );
    nativeMocks.workspaceFolders.push({
      uri: resourceUri("vscode-remote", "/workspace", "ssh-remote+current")
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(
      resourceUri("vscode-remote", "/workspace/data/sales.clean.py", "ssh-remote+current")
    );

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("active source no longer belongs to the current VS Code remote workspace host")
    );
  });

  it("inserts notebook code into the exact originating document while another notebook is active", async () => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    const other = notebookDocument("file:///workspace/other.ipynb", 5);
    nativeMocks.notebookDocuments.push(origin, other);
    nativeMocks.activeNotebookEditor = { notebook: other, selections: [{ end: 1 }] };
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(true);

    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledWith(
      origin,
      3,
      "def clean_data(df):\n    return df\n",
      { source: "frame", backend: "pandas" }
    );
  });

  it("rejects a same-URI replacement instead of retargeting notebook insertion", async () => {
    const origin = notebookDocument("file:///workspace/shared.ipynb", 3, true);
    const replacement = notebookDocument("file:///workspace/shared.ipynb", 4);
    nativeMocks.notebookDocuments.push(replacement);
    nativeMocks.activeNotebookEditor = { notebook: replacement, selections: [{ end: 2 }] };
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    expect(nativeMocks.insertGeneratedNotebookCell).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Reopen the originating notebook before inserting generated code."
    );
  });

  it.each([
    {
      status: "stale" as const,
      channel: "warning" as const,
      message: "changed or was replaced"
    },
    {
      status: "indeterminate" as const,
      channel: "warning" as const,
      message: "Inspect the notebook before retrying"
    },
    {
      status: "rejected" as const,
      channel: "error" as const,
      message: "VS Code could not insert"
    }
  ])("does not report insertion success when the helper result is $status", async ({ status, channel, message }) => {
    const origin = notebookDocument("file:///workspace/origin.ipynb", 3);
    nativeMocks.notebookDocuments.push(origin);
    nativeMocks.insertGeneratedNotebookCell.mockResolvedValueOnce({ status });
    register(notebookVariableSnapshot(), origin);

    await expect(command("openWrangler.insertNotebookCode")()).resolves.toBe(false);

    const messageMock = channel === "warning" ? nativeMocks.showWarningMessage : nativeMocks.showErrorMessage;
    expect(messageMock).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      "Inserted the generated cleaning function into its notebook."
    );
    expect(nativeMocks.insertGeneratedNotebookCell).toHaveBeenCalledOnce();
  });
});

function register(
  snapshot: ActiveSessionSnapshot,
  notebookDocument?: { uri: unknown; isClosed: boolean; cellCount: number }
): void {
  const coordinator = {
    activeSession: () => snapshot,
    activeNotebookDocument: () => notebookDocument,
    onDidChangeActiveSession: () => ({ dispose: () => undefined })
  } as unknown as SessionCoordinator;
  const context = {
    extensionPath: "/tmp/openwrangler",
    subscriptions: []
  } as unknown as ExtensionContext;
  registerNativeViews(context, coordinator);
}

function command(id: string): CommandHandler {
  const handler = nativeMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}

function vscodeUri(path: string): unknown {
  return resourceUri("file", path);
}

function resourceUri(scheme: string, fsPath: string, authority = ""): unknown {
  return {
    scheme,
    authority,
    fsPath,
    toString: () => `${scheme}://${authority}${fsPath}`
  };
}

function noDraftSnapshot(): ActiveSessionSnapshot {
  return snapshot({
    mode: "editing",
    steps: [appliedStep]
  });
}

function snapshotWithDraft(): ActiveSessionSnapshot {
  return snapshot({
    mode: "editing",
    steps: [appliedStep],
    draftStep: {
      id: "draft",
      kind: "dropMissingRows",
      params: {}
    }
  });
}

function notebookVariableSnapshot(): ActiveSessionSnapshot {
  const result = noDraftSnapshot();
  result.metadata = {
    ...result.metadata,
    backend: "pandas",
    source: {
      kind: "notebookVariable",
      label: "frame",
      variableName: "frame",
      uri: "file:///workspace/shared.ipynb"
    },
    capabilities: {
      editable: true,
      lazy: false,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: true
    }
  };
  return result;
}

function notebookDocument(uri: string, cellCount: number, isClosed = false) {
  return {
    uri: { toString: () => uri },
    isClosed,
    cellCount
  };
}

function snapshot(
  plan: Pick<SessionMetadata, "mode" | "steps"> & { draftStep?: TransformStep; source?: SessionMetadata["source"] }
): ActiveSessionSnapshot {
  return {
    sessionId: "session",
    code: "def clean_data(df):\n    return df\n",
    metadata: {
      source: { kind: "file", label: "sample.csv", path: "/tmp/sample.csv" },
      ...plan
    } as SessionMetadata,
    viewState: {
      filterModel: { filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    }
  };
}
