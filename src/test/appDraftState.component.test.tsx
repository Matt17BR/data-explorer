import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSchema, GridPage, SessionMetadata, TransformStep } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
const dataGridProps = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));
vi.mock("../webviews/grid/DataGrid", () => ({
  DataGrid: (props: unknown) => {
    dataGridProps(props);
    return null;
  }
}));

import { App } from "../webviews/App";

const originalSchema: ColumnSchema[] = [
  { id: "c:a", name: "a", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:b", name: "b", position: 1, rawType: "Int64", type: "integer", nullable: false },
  { id: "c:c", name: "c", position: 2, rawType: "String", type: "string", nullable: false }
];
const committedSchema: ColumnSchema[] = [
  { ...originalSchema[2], position: 0 },
  { ...originalSchema[0], position: 1 }
];
const selectStep: TransformStep = {
  id: "select-reordered",
  kind: "selectColumns",
  params: {
    columns: [
      { id: "c:c", name: "c" },
      { id: "c:a", name: "a" }
    ]
  }
};
const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 2,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: false,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 2 },
  filteredShape: { rows: 1, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [selectStep],
  latestStepInputSchema: originalSchema,
  schema: committedSchema
};
const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 1,
  columnIds: committedSchema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "C", display: "C", isNull: false, isNaN: false },
        { kind: "string", raw: "A", display: "A", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("App draft state boundaries", () => {
  beforeEach(() => {
    postMessage.mockClear();
    dataGridProps.mockClear();
  });

  it("uses the immediately previous committed schema for a newly appended draft", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "castColumn" });
    await screen.findByRole("dialog", { name: "Add cleaning step" });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const previewRequest = onlyPreviewRequest();
    expect(previewRequest.replaceStepId).toBeUndefined();

    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, revision: 3, draftStep: previewRequest.step },
      page,
      diff: emptyDiff(),
      code: "def clean_data(df):\n    return df"
    });

    await waitFor(() => {
      const props = latestGridProps();
      expect(props.beforeSchema).toEqual(committedSchema);
      expect(props.beforePage).toEqual(page);
    });
  });

  it("uses the latest applied-step input schema for a replacement draft", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Edit latest" }));
    await screen.findByRole("dialog", { name: "Edit cleaning step" });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const previewRequest = onlyPreviewRequest();
    expect(previewRequest.replaceStepId).toBe(selectStep.id);

    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: {
        ...metadata,
        revision: 3,
        draftStep: previewRequest.step,
        draftReplacesStepId: selectStep.id
      },
      page,
      diff: emptyDiff(),
      code: "def clean_data(df):\n    return df"
    });

    await waitFor(() => {
      const props = latestGridProps();
      expect(props.beforeSchema).toEqual(originalSchema);
      expect(props.beforePage).toBeUndefined();
    });
  });

  it("opens the generic operation picker for a host action without an operation kind", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    dispatch({ kind: "editorAction", action: "openOperation" });

    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose an operation" })).toBeInTheDocument();
  });

  it("blocks toolbar and host add-operation entry points while preserving draft actions", async () => {
    const draftStep: TransformStep = {
      id: "cast-c",
      kind: "castColumn",
      params: { column: { id: "c:c", name: "c" }, dtype: "string" }
    };
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, revision: 3, draftStep },
      page,
      summaries: []
    });

    expect(await screen.findByRole("button", { name: "Add step" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply step" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();

    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "formula" });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();

    dispatch({ kind: "editorAction", action: "editLatest" });
    expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull();
  });
});

function dispatch(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function onlyPreviewRequest(): { step: TransformStep; replaceStepId?: string } {
  const requests = postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.kind === "runtimeRequest" && message.request.kind === "previewStep")
    .map((message) => message.request);
  expect(requests).toHaveLength(1);
  return requests[0] as { step: TransformStep; replaceStepId?: string };
}

function latestGridProps(): { beforeSchema?: ColumnSchema[]; beforePage?: GridPage } {
  const call = dataGridProps.mock.calls.at(-1);
  if (!call) throw new Error("Expected DataGrid to render.");
  return call[0] as { beforeSchema?: ColumnSchema[]; beforePage?: GridPage };
}

function emptyDiff() {
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  };
}
