import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { SessionCoordinator, ActiveSessionSnapshot } from "../extension/sessionCoordinator";
import type { SessionMetadata, TransformStep } from "../shared/protocol";

type CommandHandler = (...args: unknown[]) => unknown;

const nativeMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  sendEditorAction: vi.fn(() => true),
  showInformationMessage: vi.fn(async () => undefined)
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
      readonly scheme: string
    ) {}
    static file(path: string): Uri {
      return new Uri(path, "file");
    }
    static parse(value: string): Uri {
      return new Uri(value, value.split(":", 1)[0] ?? "file");
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      return Uri.file([base.fsPath, ...parts].join("/"));
    }
    toString(): string {
      return this.scheme === "file" ? `file://${this.fsPath}` : this.fsPath;
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
      registerTreeDataProvider: () => disposable(),
      registerWebviewViewProvider: () => disposable(),
      showInformationMessage: nativeMocks.showInformationMessage,
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      showSaveDialog: vi.fn(async () => undefined),
      showQuickPick: vi.fn(async () => undefined)
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      notebookDocuments: [],
      getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
      fs: { writeFile: vi.fn(async () => undefined) }
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
  insertGeneratedNotebookCell: vi.fn(async () => true)
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
});

function register(snapshot: ActiveSessionSnapshot): void {
  const coordinator = {
    activeSession: () => snapshot,
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

function snapshot(
  plan: Pick<SessionMetadata, "mode" | "steps"> & { draftStep?: TransformStep }
): ActiveSessionSnapshot {
  return {
    sessionId: "session",
    code: "",
    metadata: {
      ...plan,
      source: { kind: "file", label: "sample.csv", path: "/tmp/sample.csv" }
    } as SessionMetadata,
    viewState: {
      filterModel: { filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    }
  };
}
