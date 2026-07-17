import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

type CommandHandler = (...args: unknown[]) => unknown;

const notebookMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  notebookDocuments: [] as NotebookDocument[],
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  activeEditorReads: 0,
  showWarningMessage: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showInputBox: vi.fn(async () => undefined as string | undefined),
  createPanel: vi.fn(),
  kernelOrigins: [] as Array<{ uri: string; document: NotebookDocument | undefined }>,
  getKernel: vi.fn(async () => ({})),
  activateJupyter: vi.fn(async () => ({ kernels: { getKernel: notebookMocks.getKernel } }))
}));

vi.mock("vscode", () => {
  class Uri {
    private constructor(readonly value: string) {}
    static parse(value: string): Uri {
      return new Uri(value);
    }
    static file(path: string): Uri {
      return new Uri(`file://${path}`);
    }
    toString(): string {
      return this.value;
    }
  }
  return {
    Uri,
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        notebookMocks.commands.set(id, handler);
        return { dispose: () => undefined };
      }
    },
    window: {
      get activeNotebookEditor() {
        notebookMocks.activeEditorReads += 1;
        return notebookMocks.activeNotebookEditor;
      },
      showWarningMessage: notebookMocks.showWarningMessage,
      showInformationMessage: notebookMocks.showInformationMessage,
      showInputBox: notebookMocks.showInputBox
    },
    workspace: {
      get notebookDocuments() {
        return notebookMocks.notebookDocuments;
      }
    },
    extensions: {
      getExtension: () => ({ activate: notebookMocks.activateJupyter })
    }
  };
});

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { create: notebookMocks.createPanel }
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  KernelBridge: class {
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      notebookMocks.kernelOrigins.push({ uri: document.uri.toString(), document });
    }
  }
}));

import * as vscode from "vscode";
import { registerNotebookCommands } from "../extension/notebooks/jupyterBridge";

describe("notebook command provenance", () => {
  beforeEach(() => {
    notebookMocks.commands.clear();
    notebookMocks.notebookDocuments.length = 0;
    notebookMocks.activeNotebookEditor = undefined;
    notebookMocks.activeEditorReads = 0;
    notebookMocks.showWarningMessage.mockClear();
    notebookMocks.showInformationMessage.mockClear();
    notebookMocks.showInputBox.mockReset();
    notebookMocks.showInputBox.mockResolvedValue(undefined);
    notebookMocks.createPanel.mockReset();
    notebookMocks.kernelOrigins.length = 0;
    notebookMocks.getKernel.mockClear();
    notebookMocks.activateJupyter.mockReset();
    notebookMocks.activateJupyter.mockResolvedValue({ kernels: { getKernel: notebookMocks.getKernel } });
  });

  it("binds a variable-viewer URI to its exact open document instead of the active notebook", async () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    notebookMocks.notebookDocuments.push(notebookA, notebookB);
    notebookMocks.activeNotebookEditor = editor(notebookB);
    const { context, coordinator, coordinatedBridge } = register();

    await command("openWrangler.launchDataViewer")({
      variableName: "frame_a",
      notebookUri: notebookA.uri
    });

    expect(notebookMocks.kernelOrigins).toEqual([{ uri: notebookA.uri.toString(), document: notebookA }]);
    expect(coordinator.createBridge).toHaveBeenCalledWith(expect.anything(), notebookA);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(context, coordinatedBridge, {
      kind: "notebookVariable",
      label: "frame_a",
      variableName: "frame_a",
      uri: notebookA.uri.toString()
    });
    expect(notebookMocks.activeEditorReads).toBe(0);
  });

  it("fails a URI argument when more than one open document has that URI", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const duplicate = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original, duplicate);
    const { coordinator } = register();

    await command("openWrangler.launchDataViewer")({ variableName: "frame", notebookUri: original.uri });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler could not identify one originating notebook. Close duplicate notebook views and try again."
    );
  });

  it("does not retarget the interactive command after its captured document closes and reopens", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.showInputBox.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
      return "frame";
    });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
    expect(notebookMocks.activeEditorReads).toBe(1);
  });

  it("does not check a replacement notebook after Jupyter activation closes the captured document", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.activateJupyter.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
      return { kernels: { getKernel: notebookMocks.getKernel } };
    });
    register();

    await command("openWrangler.checkJupyterIntegration")();

    expect(notebookMocks.getKernel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
    );
    expect(notebookMocks.activeEditorReads).toBe(1);
  });

  it("discards a kernel lookup when the captured notebook closes before it resolves", async () => {
    const original = notebook("file:///workspace/shared.ipynb");
    const replacement = notebook("file:///workspace/shared.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    let resolveKernel!: (kernel: object) => void;
    notebookMocks.getKernel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveKernel = resolve;
        })
    );
    register();

    const checking = command("openWrangler.checkJupyterIntegration")();
    await vi.waitFor(() => expect(notebookMocks.getKernel).toHaveBeenCalledWith(original.uri));
    closeNotebook(original);
    notebookMocks.notebookDocuments.splice(0, 1, replacement);
    notebookMocks.activeNotebookEditor = editor(replacement);
    resolveKernel({});
    await checking;

    expect(notebookMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
    );
    expect(notebookMocks.activeEditorReads).toBe(1);
  });
});

function register(): {
  context: ExtensionContext;
  coordinator: { createBridge: ReturnType<typeof vi.fn> };
  coordinatedBridge: OpenWranglerBridge;
} {
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  const coordinatedBridge = {} as OpenWranglerBridge;
  const coordinator = { createBridge: vi.fn(() => coordinatedBridge) };
  registerNotebookCommands(context, coordinator as unknown as SessionCoordinator);
  return { context, coordinator, coordinatedBridge };
}

function command(id: string): CommandHandler {
  const handler = notebookMocks.commands.get(id);
  if (!handler) throw new Error(`Expected ${id} to be registered.`);
  return handler;
}

function notebook(uri: string): NotebookDocument {
  return { uri: vscode.Uri.parse(uri), isClosed: false } as unknown as NotebookDocument;
}

function closeNotebook(document: NotebookDocument): void {
  Object.defineProperty(document, "isClosed", { configurable: true, value: true });
}

function editor(document: NotebookDocument): NotebookEditor {
  return { notebook: document } as NotebookEditor;
}
