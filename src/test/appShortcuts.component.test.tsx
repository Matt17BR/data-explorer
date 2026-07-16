import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata, TransformStep } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";

const step: TransformStep = {
  id: "formula-step",
  kind: "formula",
  params: { leftColumn: { id: "c:1", name: "sales" }, operator: "multiply", value: 2, newColumn: "score" }
};

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 1,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 3 },
  filteredShape: { rows: 1, columns: 3 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  draftStep: step,
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false },
    { id: "c:step", name: "score", position: 2, rawType: "Float64", type: "float", nullable: false }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 1,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false },
        { kind: "number", raw: 12, display: "12", isNull: false, isNaN: false },
        { kind: "number", raw: 24, display: "24", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("App cleaning-plan keyboard shortcuts", () => {
  beforeEach(() => postMessage.mockClear());

  it("applies, discards, edits, and undoes without stealing editable-field undo", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    const apply = await screen.findByRole("button", { name: "Apply step" });
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(apply).toHaveAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    expect(discard).toHaveAttribute("aria-keyshortcuts", "Escape");

    postMessage.mockClear();
    fireEvent.keyDown(apply, { key: "Enter", ctrlKey: true });
    expect(runtimeRequestKinds()).toContain("applyDraft");
    fireEvent.keyDown(discard, { key: "Escape" });
    expect(runtimeRequestKinds()).not.toContain("discardDraft");
    expect(apply).toBeDisabled();
    expect(discard).toBeDisabled();

    const appliedMetadata: SessionMetadata = { ...metadata, draftStep: undefined, steps: [step] };
    dispatch({ kind: "planUpdated", revision: 2, metadata: appliedMetadata, page, code: "def clean_data(df):\n" });
    const undo = await screen.findByRole("button", { name: "Undo" });
    const edit = screen.getByRole("button", { name: "Edit latest" });
    expect(undo).toHaveAttribute("aria-keyshortcuts", "Control+Alt+Z Meta+Alt+Z");
    expect(edit).toHaveAttribute("aria-keyshortcuts", "Control+Shift+E Meta+Shift+E");
    edit.focus();

    postMessage.mockClear();
    const columnSearch = screen.getByPlaceholderText("Search columns");
    fireEvent.keyDown(columnSearch, { key: "z", ctrlKey: true, altKey: true });
    expect(runtimeRequestKinds()).not.toContain("undoStep");

    fireEvent.keyDown(edit, { key: "e", ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Edit cleaning step" })).toBeInTheDocument();
    expect(screen.getByTestId("app-workspace")).toHaveAttribute("inert");
    expect(screen.getByTestId("app-workspace")).toHaveAttribute("aria-hidden", "true");
    fireEvent.keyDown(screen.getByPlaceholderText("Search operations"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull());
    await waitFor(() => expect(edit).toHaveFocus());
    expect(screen.getByTestId("app-workspace")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("app-workspace")).not.toHaveAttribute("aria-hidden");

    fireEvent.keyDown(undo, { key: "z", ctrlKey: true, altKey: true });
    fireEvent.keyDown(undo, { key: "z", ctrlKey: true, altKey: true });
    expect(runtimeRequestKinds().filter((kind) => kind === "undoStep")).toHaveLength(1);
    expect(undo).toBeDisabled();
  });
});

function dispatch(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function runtimeRequestKinds(): string[] {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.kind === "runtimeRequest")
    .map((message) => message.request.kind);
}
