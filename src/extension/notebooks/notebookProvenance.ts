import * as vscode from "vscode";

/**
 * Jupyter's stable kernel API is URI-addressed, so membership alone cannot
 * distinguish an overlapping replacement document from the captured object.
 */
export function isSoleOpenNotebookDocument(notebook: vscode.NotebookDocument): boolean {
  if (notebook.isClosed) return false;

  const uri = notebook.uri.toString();
  let foundCapturedDocument = false;
  for (const openNotebook of vscode.workspace.notebookDocuments) {
    if (openNotebook.isClosed || openNotebook.uri.toString() !== uri) continue;
    if (openNotebook !== notebook || foundCapturedDocument) return false;
    foundCapturedDocument = true;
  }
  return foundCapturedDocument;
}
