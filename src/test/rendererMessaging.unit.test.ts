import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookDocument, NotebookEditor, Uri } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

interface RendererEvent {
  editor: NotebookEditor;
  message: unknown;
}

const rendererMocks = vi.hoisted(() => ({
  listener: undefined as ((event: RendererEvent) => void) | undefined,
  notebookDocuments: [] as NotebookDocument[],
  visibleNotebookEditors: [] as NotebookEditor[],
  activeNotebookEditor: undefined as NotebookEditor | undefined,
  activeEditorReads: 0,
  showErrorMessage: vi.fn(async () => undefined),
  createPanel: vi.fn(),
  createPanelFromPayload: vi.fn(),
  kernelNotebookUris: [] as string[],
  kernelNotebookDocuments: [] as NotebookDocument[]
}));

vi.mock("vscode", () => ({
  notebooks: {
    createRendererMessaging: () => ({
      onDidReceiveMessage: (listener: (event: RendererEvent) => void) => {
        rendererMocks.listener = listener;
        return { dispose: () => undefined };
      }
    })
  },
  window: {
    get visibleNotebookEditors() {
      return rendererMocks.visibleNotebookEditors;
    },
    get activeNotebookEditor() {
      rendererMocks.activeEditorReads += 1;
      return rendererMocks.activeNotebookEditor;
    },
    showErrorMessage: rendererMocks.showErrorMessage
  },
  workspace: {
    get notebookDocuments() {
      return rendererMocks.notebookDocuments;
    }
  }
}));

vi.mock("../extension/configuration", () => ({
  getSetting: <T>(_key: string, fallback: T): T => fallback
}));

vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: {
    create: rendererMocks.createPanel,
    createFromPayload: rendererMocks.createPanelFromPayload
  }
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  KernelBridge: class {
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      rendererMocks.kernelNotebookUris.push((document.uri as Uri).toString());
      rendererMocks.kernelNotebookDocuments.push(document);
    }
  }
}));

import { registerNotebookRendererMessaging } from "../extension/notebooks/rendererMessaging";

describe("notebook renderer messaging", () => {
  beforeEach(() => {
    rendererMocks.listener = undefined;
    rendererMocks.notebookDocuments.length = 0;
    rendererMocks.visibleNotebookEditors.length = 0;
    rendererMocks.activeNotebookEditor = undefined;
    rendererMocks.activeEditorReads = 0;
    rendererMocks.showErrorMessage.mockClear();
    rendererMocks.createPanel.mockReset();
    rendererMocks.createPanelFromPayload.mockReset();
    rendererMocks.kernelNotebookUris.length = 0;
    rendererMocks.kernelNotebookDocuments.length = 0;
  });

  it("opens a live variable from notebook A when notebook B is active", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    rendererMocks.notebookDocuments.push(notebookA, notebookB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    rendererMocks.activeNotebookEditor = editorB;
    const { context, coordinator, coordinatedBridge } = register();

    dispatch(editorA, validPayload());

    expect(rendererMocks.kernelNotebookUris).toEqual(["file:///workspace/a.ipynb"]);
    expect(rendererMocks.kernelNotebookDocuments).toEqual([notebookA]);
    expect(coordinator.createBridge).toHaveBeenCalledOnce();
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      context,
      coordinatedBridge,
      {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: "file:///workspace/a.ipynb"
      },
      "polars"
    );
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("opens a saved snapshot from its exact valid sender when no live variable is available", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    rendererMocks.notebookDocuments.push(notebookA, notebookB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    rendererMocks.activeNotebookEditor = editorB;
    const { context } = register();

    dispatch(editorA, validPayload(null));

    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.createPanelFromPayload).toHaveBeenCalledWith(
      context,
      expect.anything(),
      expect.objectContaining({
        kind: "sessionOpened",
        metadata: expect.objectContaining({
          source: { kind: "notebookOutput", label: "frame" }
        })
      })
    );
    expect(rendererMocks.kernelNotebookUris).toEqual([]);
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("keeps the originating notebook when focus changes during dispatch", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const notebookC = notebook("file:///workspace/c.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    const editorC = editor(notebookC);
    rendererMocks.notebookDocuments.push(notebookA, notebookB, notebookC);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB, editorC);
    rendererMocks.activeNotebookEditor = editorB;
    const { coordinator } = register();
    coordinator.createBridge.mockImplementation((bridge: OpenWranglerBridge) => {
      rendererMocks.activeNotebookEditor = editorC;
      return bridge;
    });

    dispatch(editorA, validPayload());

    expect(rendererMocks.kernelNotebookUris).toEqual(["file:///workspace/a.ipynb"]);
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ uri: "file:///workspace/a.ipynb" }),
      "polars"
    );
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it.each([
    ["closed", true, true],
    ["unknown", false, false]
  ])("rejects a %s originating notebook without opening a fallback", (_case, isClosed, includeAsOpen) => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb", isClosed);
    const otherNotebook = notebook("file:///workspace/other.ipynb");
    const originatingEditor = editor(originatingNotebook);
    const otherEditor = editor(otherNotebook);
    rendererMocks.notebookDocuments.push(otherNotebook);
    if (includeAsOpen) rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(originatingEditor, otherEditor);
    rendererMocks.activeNotebookEditor = otherEditor;
    const { coordinator } = register();

    dispatch(originatingEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.kernelNotebookUris).toEqual([]);
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "The notebook that sent this Open Wrangler action is no longer open. Reopen it and try again."
    );
    expect(rendererMocks.activeEditorReads).toBe(0);
  });

  it("rejects a stale originating editor even when another split still shows the same document", () => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb");
    const staleEditor = editor(originatingNotebook);
    const visibleSplit = editor(originatingNotebook);
    rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(visibleSplit);
    rendererMocks.activeNotebookEditor = visibleSplit;
    const { coordinator } = register();

    dispatch(staleEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
  });

  it("rejects a reopened editor and document that merely reuse the originating URI", () => {
    const staleDocument = notebook("file:///workspace/origin.ipynb", true);
    const reopenedDocument = notebook("file:///workspace/origin.ipynb");
    const staleEditor = editor(staleDocument);
    const reopenedEditor = editor(reopenedDocument);
    rendererMocks.notebookDocuments.push(reopenedDocument);
    rendererMocks.visibleNotebookEditors.push(reopenedEditor);
    rendererMocks.activeNotebookEditor = reopenedEditor;
    const { coordinator } = register();

    dispatch(staleEditor, validPayload());

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload without retaining or dispatching an action", () => {
    const originatingNotebook = notebook("file:///workspace/origin.ipynb");
    const originatingEditor = editor(originatingNotebook);
    rendererMocks.notebookDocuments.push(originatingNotebook);
    rendererMocks.visibleNotebookEditors.push(originatingEditor);
    const { coordinator } = register();

    dispatch(originatingEditor, { mimeVersion: 2, metadata: {}, page: {}, summaries: [] });

    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "This Open Wrangler notebook output is malformed or unsupported."
    );
  });

  it("does not fall back after a live-open setup failure or retain its origin for the next action", () => {
    const notebookA = notebook("file:///workspace/a.ipynb");
    const notebookB = notebook("file:///workspace/b.ipynb");
    const editorA = editor(notebookA);
    const editorB = editor(notebookB);
    rendererMocks.notebookDocuments.push(notebookA, notebookB);
    rendererMocks.visibleNotebookEditors.push(editorA, editorB);
    const { coordinator } = register();
    coordinator.createBridge.mockImplementationOnce(() => {
      throw new Error("Kernel access denied.");
    });

    dispatch(editorA, validPayload());

    expect(rendererMocks.createPanel).not.toHaveBeenCalled();
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
    expect(rendererMocks.showErrorMessage).toHaveBeenCalledWith(
      "Open Wrangler could not open the originating notebook. Kernel access denied."
    );

    dispatch(editorB, validPayload());

    expect(rendererMocks.kernelNotebookUris).toEqual(["file:///workspace/a.ipynb", "file:///workspace/b.ipynb"]);
    expect(rendererMocks.createPanel).toHaveBeenCalledOnce();
    expect(rendererMocks.createPanel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ uri: "file:///workspace/b.ipynb" }),
      "polars"
    );
    expect(rendererMocks.createPanelFromPayload).not.toHaveBeenCalled();
    expect(rendererMocks.activeEditorReads).toBe(0);
  });
});

function register(): {
  context: ExtensionContext;
  coordinator: { createBridge: ReturnType<typeof vi.fn> };
  coordinatedBridge: OpenWranglerBridge;
} {
  const context = { subscriptions: [] } as unknown as ExtensionContext;
  const coordinatedBridge = {} as OpenWranglerBridge;
  const coordinator = {
    createBridge: vi.fn(() => coordinatedBridge)
  };
  registerNotebookRendererMessaging(context, {} as OpenWranglerBridge, coordinator as unknown as SessionCoordinator);
  expect(rendererMocks.listener).toBeTypeOf("function");
  return { context, coordinator, coordinatedBridge };
}

function dispatch(origin: NotebookEditor, payload: unknown): void {
  rendererMocks.listener?.({
    editor: origin,
    message: { kind: "openInOpenWrangler", payload }
  });
}

function notebook(uri: string, isClosed = false): NotebookDocument {
  return {
    uri: { toString: () => uri },
    isClosed
  } as unknown as NotebookDocument;
}

function editor(document: NotebookDocument): NotebookEditor {
  return { notebook: document } as NotebookEditor;
}

function validPayload(variableName: string | null = "frame"): unknown {
  return {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "snapshot",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: {
        kind: "notebookOutput",
        label: "frame",
        ...(variableName ? { variableName } : {})
      },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema: [{ id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
      filterModel: { filters: [], sort: [] },
      steps: []
    },
    page: {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:0"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
        }
      ]
    },
    summaries: []
  };
}
