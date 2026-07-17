import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DataBackend } from "../../shared/protocol";

export interface NotebookInsertionMetadata {
  source: string;
  backend: DataBackend;
}

export type NotebookInsertionResult =
  { status: "applied" } | { status: "stale" } | { status: "indeterminate" } | { status: "rejected" };

interface NotebookSnapshot {
  readonly version: number;
  readonly cellCount: number;
}

const insertionQueues = new WeakMap<vscode.NotebookDocument, Promise<void>>();

export async function insertGeneratedNotebookCell(
  notebook: vscode.NotebookDocument,
  index: number,
  code: string,
  metadata: NotebookInsertionMetadata
): Promise<NotebookInsertionResult> {
  if (!code.trim()) throw new Error("Generated notebook code must not be empty.");
  if (!Number.isInteger(index) || index < 0 || index > notebook.cellCount) {
    throw new Error(`Notebook insertion index ${index} is outside the document.`);
  }

  const snapshot: NotebookSnapshot = {
    version: notebook.version,
    cellCount: notebook.cellCount
  };
  const previous = insertionQueues.get(notebook) ?? Promise.resolve();
  const operation = previous.then(() => performInsertion(notebook, snapshot, index, code, metadata));
  const tail = operation.then(
    () => undefined,
    () => undefined
  );
  insertionQueues.set(notebook, tail);
  void tail.finally(() => {
    if (insertionQueues.get(notebook) === tail) insertionQueues.delete(notebook);
  });
  return operation;
}

async function performInsertion(
  notebook: vscode.NotebookDocument,
  snapshot: NotebookSnapshot,
  index: number,
  code: string,
  metadata: NotebookInsertionMetadata
): Promise<NotebookInsertionResult> {
  if (!isCurrentNotebook(notebook, snapshot, index)) return { status: "stale" };

  let insertionId: string;
  let edit: vscode.WorkspaceEdit;
  try {
    insertionId = randomUUID();
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, "python");
    cell.metadata = {
      openWrangler: {
        source: metadata.source,
        backend: metadata.backend,
        generated: true,
        insertionId
      }
    };
    edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [cell])]);
  } catch {
    return { status: "rejected" };
  }

  // Notebook workspace edits are URI-addressed. Recheck after building the edit so any
  // replacement observed before dispatch fails closed instead of being retargeted.
  if (!isCurrentNotebook(notebook, snapshot, index)) return { status: "stale" };

  let accepted: boolean;
  try {
    accepted = await vscode.workspace.applyEdit(edit);
  } catch {
    return { status: "rejected" };
  }
  if (!accepted) return { status: "rejected" };

  try {
    return isExpectedAppliedCell(notebook, snapshot, index, code, metadata, insertionId)
      ? { status: "applied" }
      : { status: "indeterminate" };
  } catch {
    return { status: "indeterminate" };
  }
}

function isCurrentNotebook(notebook: vscode.NotebookDocument, snapshot: NotebookSnapshot, index: number): boolean {
  if (
    notebook.isClosed ||
    notebook.version !== snapshot.version ||
    notebook.cellCount !== snapshot.cellCount ||
    index > snapshot.cellCount
  ) {
    return false;
  }

  const uri = notebook.uri.toString();
  let foundExactDocument = false;
  for (const openNotebook of vscode.workspace.notebookDocuments) {
    if (openNotebook === notebook) {
      foundExactDocument = true;
    } else if (openNotebook.uri.toString() === uri) {
      return false;
    }
  }
  return foundExactDocument;
}

function isExpectedAppliedCell(
  notebook: vscode.NotebookDocument,
  snapshot: NotebookSnapshot,
  index: number,
  code: string,
  metadata: NotebookInsertionMetadata,
  insertionId: string
): boolean {
  if (
    notebook.isClosed ||
    notebook.version !== snapshot.version + 1 ||
    notebook.cellCount !== snapshot.cellCount + 1 ||
    !isOnlyOpenDocumentForUri(notebook)
  ) {
    return false;
  }

  const cell = notebook.cellAt(index);
  const marker: unknown = cell.metadata.openWrangler;
  return (
    cell.kind === vscode.NotebookCellKind.Code &&
    cell.document.languageId === "python" &&
    cell.document.getText() === code &&
    isInsertionMarker(marker, metadata, insertionId)
  );
}

function isOnlyOpenDocumentForUri(notebook: vscode.NotebookDocument): boolean {
  const uri = notebook.uri.toString();
  let exactMatches = 0;
  for (const openNotebook of vscode.workspace.notebookDocuments) {
    if (openNotebook === notebook) exactMatches += 1;
    else if (openNotebook.uri.toString() === uri) return false;
  }
  return exactMatches === 1;
}

function isInsertionMarker(value: unknown, metadata: NotebookInsertionMetadata, insertionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.source === metadata.source &&
    marker.backend === metadata.backend &&
    marker.generated === true &&
    marker.insertionId === insertionId
  );
}
