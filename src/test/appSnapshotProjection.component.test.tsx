import "@testing-library/jest-dom/vitest";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import type { SortDirection } from "../shared/filterModel";

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

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "snapshot",
  revision: 0,
  backend: "polars",
  mode: "viewing",
  source: { kind: "notebookOutput", label: "saved frame" },
  capabilities: {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:sales", name: "sales", position: 1, rawType: "Int64", type: "integer", nullable: false }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 2,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "Zurich", display: "Zurich", isNull: false, isNaN: false },
        { kind: "integer", raw: 2, display: "2", isNull: false, isNaN: false }
      ]
    },
    {
      id: "r:1",
      rowNumber: 1,
      values: [
        { kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false },
        { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("App saved notebook snapshots", () => {
  beforeEach(() => {
    postMessage.mockClear();
    dataGridProps.mockClear();
  });

  it("keeps local snapshot pages full-width and canonical after a view query", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(dataGridProps).toHaveBeenCalled());

    postMessage.mockClear();
    act(() => latestGridProps().onSortColumn("city", "asc"));

    await waitFor(() => {
      const nextPage = latestGridProps().page;
      expect(nextPage.columnIds).toEqual(["c:city", "c:sales"]);
      expect(nextPage.rows[0].values).toHaveLength(2);
      expect(nextPage.rows[0].values[0]?.display).toBe("Berlin");
    });
    expect(runtimeRequests("getPage")).toHaveLength(0);
  });
});

function dispatch(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function latestGridProps(): { page: GridPage; onSortColumn(column: string, direction: SortDirection): void } {
  const call = dataGridProps.mock.calls.at(-1);
  if (!call) throw new Error("Expected DataGrid to render.");
  return call[0] as { page: GridPage; onSortColumn(column: string, direction: SortDirection): void };
}

function runtimeRequests(kind: string): Record<string, unknown>[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { kind?: unknown; request?: Record<string, unknown> };
    return candidate.kind === "runtimeRequest" && candidate.request?.kind === kind ? [candidate.request] : [];
  });
}
