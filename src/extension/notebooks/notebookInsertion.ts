import * as vscode from "vscode";
import type { DataBackend } from "../../shared/protocol";

export interface NotebookInsertionMetadata {
  source: string;
  backend: DataBackend;
}

export async function insertGeneratedNotebookCell(
  notebook: vscode.NotebookDocument,
  index: number,
  code: string,
  metadata: NotebookInsertionMetadata
): Promise<boolean> {
  if (!code.trim()) throw new Error("Generated notebook code must not be empty.");
  if (!Number.isInteger(index) || index < 0 || index > notebook.cellCount) {
    throw new Error(`Notebook insertion index ${index} is outside the document.`);
  }
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, "python");
  cell.metadata = {
    openWrangler: {
      source: metadata.source,
      backend: metadata.backend,
      generated: true
    }
  };
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [cell])]);
  return vscode.workspace.applyEdit(edit);
}
