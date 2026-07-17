import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "vscode";

interface CapturedCellData {
  readonly kind: number;
  readonly value: string;
  readonly languageId: string;
  metadata: Record<string, unknown>;
}

interface CapturedCellEdit {
  readonly index: number;
  readonly newCells: CapturedCellData[];
}

interface FakeCell {
  readonly kind: number;
  readonly document: { readonly languageId: string; getText(): string };
  readonly metadata: Record<string, unknown>;
}

interface FakeNotebook {
  readonly uri: { toString(): string };
  version: number;
  isClosed: boolean;
  readonly cellCount: number;
  readonly cells: FakeCell[];
  cellAt(index: number): FakeCell;
}

const insertionMocks = vi.hoisted(() => ({
  notebookDocuments: [] as unknown[],
  applyEdit: vi.fn<() => Promise<boolean>>(),
  onSet: undefined as (() => void) | undefined,
  capturedEdit: undefined as CapturedCellEdit | undefined
}));

vi.mock("vscode", () => {
  class NotebookCellData {
    metadata: Record<string, unknown> = {};
    constructor(
      readonly kind: number,
      readonly value: string,
      readonly languageId: string
    ) {}
  }

  class WorkspaceEdit {
    set(_uri: unknown, edits: CapturedCellEdit[]): void {
      insertionMocks.capturedEdit = edits[0];
      insertionMocks.onSet?.();
    }
  }

  return {
    NotebookCellKind: { Code: 2 },
    NotebookCellData,
    NotebookEdit: {
      insertCells: (index: number, newCells: CapturedCellData[]): CapturedCellEdit => ({ index, newCells })
    },
    WorkspaceEdit,
    workspace: {
      get notebookDocuments() {
        return insertionMocks.notebookDocuments;
      },
      applyEdit: insertionMocks.applyEdit
    }
  };
});

import { insertGeneratedNotebookCell } from "../extension/notebooks/notebookInsertion";

describe("generated notebook insertion", () => {
  beforeEach(() => {
    insertionMocks.notebookDocuments.length = 0;
    insertionMocks.applyEdit.mockReset();
    insertionMocks.onSet = undefined;
    insertionMocks.capturedEdit = undefined;
  });

  it("reports applied only after the exact document contains the marked generated cell", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      return true;
    });

    await expect(insert(notebook)).resolves.toEqual({ status: "applied" });

    expect(notebook.version).toBe(2);
    expect(notebook.cellCount).toBe(1);
    expect(notebook.cellAt(0).metadata.openWrangler).toEqual({
      source: "frame",
      backend: "polars",
      generated: true,
      insertionId: expect.any(String)
    });
  });

  it("fails stale when the exact document is replaced while the edit is being built", async () => {
    const origin = fakeNotebook("file:///workspace/shared.ipynb");
    const replacement = fakeNotebook("file:///workspace/shared.ipynb");
    insertionMocks.notebookDocuments.push(origin);
    insertionMocks.onSet = () => {
      origin.isClosed = true;
      insertionMocks.notebookDocuments.splice(0, 1, replacement);
    };

    await expect(insert(origin)).resolves.toEqual({ status: "stale" });

    expect(insertionMocks.applyEdit).not.toHaveBeenCalled();
    expect(replacement.cellCount).toBe(0);
  });

  it("fails stale when a different open document has the same URI", async () => {
    const origin = fakeNotebook("file:///workspace/shared.ipynb");
    const duplicate = fakeNotebook("file:///workspace/shared.ipynb");
    insertionMocks.notebookDocuments.push(origin, duplicate);

    await expect(insert(origin)).resolves.toEqual({ status: "stale" });

    expect(insertionMocks.applyEdit).not.toHaveBeenCalled();
    expect(origin.cellCount).toBe(0);
    expect(duplicate.cellCount).toBe(0);
  });

  it("reports a false or failed VS Code edit as rejected", async () => {
    const rejected = fakeNotebook("file:///workspace/rejected.ipynb");
    insertionMocks.notebookDocuments.push(rejected);
    insertionMocks.applyEdit.mockResolvedValueOnce(false);
    await expect(insert(rejected)).resolves.toEqual({ status: "rejected" });

    const failed = fakeNotebook("file:///workspace/failed.ipynb");
    insertionMocks.notebookDocuments.splice(0, 1, failed);
    insertionMocks.applyEdit.mockRejectedValueOnce(new Error("transport failed"));
    await expect(insert(failed)).resolves.toEqual({ status: "rejected" });
  });

  it("reports indeterminate without retry or rollback when URI resolution reaches a replacement", async () => {
    const origin = fakeNotebook("file:///workspace/shared.ipynb");
    const replacement = fakeNotebook("file:///workspace/shared.ipynb");
    insertionMocks.notebookDocuments.push(origin);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      origin.isClosed = true;
      insertionMocks.notebookDocuments.splice(0, 1, replacement);
      applyCapturedEdit(replacement);
      return true;
    });

    await expect(insert(origin)).resolves.toEqual({ status: "indeterminate" });

    // Stable VS Code notebook edits are URI-addressed, so the helper can detect but cannot
    // safely compensate for this post-dispatch race. It must never issue a second edit.
    expect(replacement.cellCount).toBe(1);
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });

  it("reports indeterminate when the original version changes beyond the accepted insertion", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      notebook.version += 1;
      return true;
    });

    await expect(insert(notebook)).resolves.toEqual({ status: "indeterminate" });

    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });

  it("serializes its own edits and fails a queued stale snapshot without dispatching it", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      return true;
    });

    const first = insert(notebook);
    const queued = insert(notebook);

    await expect(first).resolves.toEqual({ status: "applied" });
    await expect(queued).resolves.toEqual({ status: "stale" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });
});

function insert(notebook: FakeNotebook) {
  return insertGeneratedNotebookCell(
    notebook as unknown as NotebookDocument,
    0,
    "def clean_data(df):\n    return df\n",
    { source: "frame", backend: "polars" }
  );
}

function fakeNotebook(uri: string): FakeNotebook {
  const cells: FakeCell[] = [];
  return {
    uri: { toString: () => uri },
    version: 1,
    isClosed: false,
    get cellCount() {
      return cells.length;
    },
    cells,
    cellAt(index: number): FakeCell {
      const cell = cells[index];
      if (!cell) throw new Error(`Missing fake cell ${index}.`);
      return cell;
    }
  };
}

function applyCapturedEdit(notebook: FakeNotebook): void {
  const edit = insertionMocks.capturedEdit;
  if (!edit) throw new Error("No notebook edit was captured.");
  const cells = edit.newCells.map<FakeCell>((cell) => ({
    kind: cell.kind,
    document: {
      languageId: cell.languageId,
      getText: () => cell.value
    },
    metadata: cell.metadata
  }));
  notebook.cells.splice(edit.index, 0, ...cells);
  notebook.version += 1;
}
