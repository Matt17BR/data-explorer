import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CellValue, ColumnSchema, DataDiff, GridPage, SessionMetadata } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

const stringCell = (display: string): CellValue => ({
  kind: "string",
  raw: display,
  display,
  isNull: false,
  isNaN: false
});

const numberCell = (value: number): CellValue => ({
  kind: "number",
  raw: value,
  display: String(value),
  isNull: false,
  isNaN: false
});

const booleanCell = (value: boolean): CellValue => ({
  kind: "boolean",
  raw: value,
  display: String(value),
  isNull: false,
  isNaN: false
});

const outputSchema: ColumnSchema[] = [
  { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:sales", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false },
  { id: "c:segment", name: "segment", position: 2, rawType: "String", type: "string", nullable: false }
];

const inputSchema: ColumnSchema[] = [
  outputSchema[0],
  outputSchema[1],
  { id: "c:legacy", name: "legacy", position: 2, rawType: "Boolean", type: "boolean", nullable: false }
];

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 2,
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
  schema: outputSchema
};

const outputPage: GridPage = {
  offset: 0,
  limit: 1,
  totalRows: 1,
  columnIds: outputSchema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [stringCell("Milan"), numberCell(11), stringCell("north")]
    }
  ]
};

const inputPage: GridPage = {
  offset: 0,
  limit: 1,
  totalRows: 1,
  columnIds: inputSchema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [stringCell("Milan"), numberCell(10.5), booleanCell(true)]
    }
  ]
};

const diff: DataDiff = {
  addedRows: 0,
  removedRows: 0,
  addedColumns: ["segment"],
  removedColumns: ["legacy"],
  changedCells: 1,
  cells: [{ rowNumber: 0, columnId: "c:sales", column: "sales", before: numberCell(10.5), after: numberCell(11) }],
  truncated: false
};

function renderGrid(
  options: {
    gridMetadata?: SessionMetadata;
    page?: GridPage;
    dataDiff?: DataDiff;
    beforePage?: GridPage;
    beforeSchema?: ColumnSchema[];
    viewControlsDisabled?: boolean;
    onPage?: (offset: number) => void;
  } = {}
) {
  return render(
    <DataGrid
      metadata={options.gridMetadata ?? metadata}
      page={options.page ?? outputPage}
      summaries={[]}
      pageSize={1}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      diff={options.dataDiff}
      beforePage={options.beforePage}
      beforeSchema={options.beforeSchema}
      viewControlsDisabled={options.viewControlsDisabled}
      onPage={options.onPage ?? (() => undefined)}
      onSortColumn={() => undefined}
      onOpenFilter={() => undefined}
      onVisibleSummaryColumnsChange={() => undefined}
    />
  );
}

describe("DataGrid diff presentation", () => {
  it("marks changed cells and added columns while retaining removed columns in an accessible strip", () => {
    renderGrid({ dataDiff: diff, beforePage: inputPage, beforeSchema: inputSchema });
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 900 });
    fireEvent(window, new Event("resize"));

    const changed = screen.getByRole("cell", { name: "sales, row 1: changed from 10.5 to 11" });
    expect(changed).toHaveAttribute("data-diff-state", "changed");
    expect(changed).toHaveClass("diffChangedCell");
    expect(changed).toHaveAttribute("title", "sales, row 1: changed from 10.5 to 11");

    const addedHeader = screen.getByRole("columnheader", { name: "segment, added column" });
    expect(addedHeader).toHaveAttribute("data-diff-state", "added");
    expect(addedHeader).toHaveClass("diffAddedColumn");
    expect(
      screen.getByRole("cell", {
        name: "segment, row 1: added column; before column absent; after north"
      })
    ).toHaveAttribute("data-diff-state", "added");

    const changes = screen.getByRole("region", { name: "Column changes" });
    expect(within(changes).getByRole("listitem", { name: "Added column segment, type String" })).toBeVisible();
    expect(
      within(changes).getByRole("listitem", { name: "Removed column legacy, previous type Boolean" })
    ).toBeVisible();
  });

  it("uses stable column IDs from the before context when names are duplicated", () => {
    const duplicateSchema: ColumnSchema[] = [
      { id: "c:second", name: "value", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:first", name: "value", position: 1, rawType: "String", type: "string", nullable: false }
    ];
    const duplicateBeforeSchema: ColumnSchema[] = [
      { id: "c:first", name: "value", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:second", name: "value", position: 1, rawType: "String", type: "string", nullable: false }
    ];
    const duplicateMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 2 },
      filteredShape: { rows: 1, columns: 2 },
      schema: duplicateSchema
    };
    const duplicateBefore: GridPage = {
      ...inputPage,
      columnIds: ["c:first"],
      rows: [{ id: "r:0", rowNumber: 0, values: [stringCell("old")] }]
    };
    const duplicateAfter: GridPage = {
      ...outputPage,
      columnIds: ["c:first"],
      rows: [{ id: "r:0", rowNumber: 0, values: [stringCell("new")] }]
    };
    const duplicateDiff: DataDiff = {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 1,
      cells: [
        { rowNumber: 0, columnId: "c:first", column: "value", before: stringCell("old"), after: stringCell("new") }
      ],
      truncated: false
    };

    renderGrid({
      gridMetadata: duplicateMetadata,
      page: duplicateAfter,
      dataDiff: duplicateDiff,
      beforePage: duplicateBefore,
      beforeSchema: duplicateBeforeSchema
    });

    expect(document.querySelector('td[data-grid-column="0"]')).not.toHaveAttribute("data-diff-state");
    expect(document.querySelector('td[data-grid-column="1"]')).toHaveAttribute("data-diff-state", "changed");
    expect(screen.getByRole("cell", { name: "value, row 1: changed from old to new" })).toBeVisible();
  });

  it("falls back to protocol cell diffs when no before block is available", () => {
    const fallbackDiff: DataDiff = { ...diff, addedColumns: [], removedColumns: [] };
    renderGrid({ dataDiff: fallbackDiff });

    expect(screen.getByRole("cell", { name: "sales, row 1: changed from 10.5 to 11" })).toHaveAttribute(
      "data-diff-state",
      "changed"
    );
  });

  it("disables view-only header actions during inspection without disabling page navigation", () => {
    const onPage = vi.fn();
    renderGrid({
      page: { ...outputPage, totalRows: 2 },
      viewControlsDisabled: true,
      onPage
    });

    const cityActions = screen.getByLabelText("Column actions for city");
    fireEvent.click(cityActions);
    const cityMenu = cityActions.closest("details");
    expect(cityMenu).not.toBeNull();
    const filter = within(cityMenu!).getByRole("button", { name: "Filter…" });
    expect(filter).toBeDisabled();
    expect(filter).toHaveAccessibleDescription("View controls are unavailable while inspecting an applied step.");
    expect(within(cityMenu!).getByRole("button", { name: "Sort ascending" })).toBeDisabled();
    expect(within(cityMenu!).getByRole("button", { name: "Sort descending" })).toBeDisabled();
    const next = screen.getByRole("button", { name: "Next block" });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(onPage).toHaveBeenCalledWith(1);
  });
});
