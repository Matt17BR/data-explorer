import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
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
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 2,
  totalRows: 2,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false },
        { kind: "number", raw: 10.5, display: "10.5", isNull: false, isNaN: false }
      ]
    },
    {
      id: "r:1",
      rowNumber: 1,
      values: [
        { kind: "string", raw: "Paris", display: "Paris", isNull: false, isNaN: false },
        { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
      ]
    }
  ]
};

describe("DataGrid", () => {
  it("renders schema headers and cell values", () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByText("city")).toBeTruthy();
    expect(screen.getByText("sales")).toBeTruthy();
    expect(screen.getByText("Milan")).toBeTruthy();
    expect(screen.getByText("Paris")).toBeTruthy();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "3");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "3");
  });

  it("bounds very long cell text before it reaches the DOM", () => {
    const longValue = "x".repeat(10_000);
    const longPage: GridPage = {
      ...page,
      rows: [
        {
          ...page.rows[0]!,
          values: [
            { kind: "string", raw: longValue, display: longValue, isNull: false, isNaN: false },
            page.rows[0]!.values[1]!
          ]
        }
      ],
      totalRows: 1,
      limit: 1
    };
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 1, columns: 2 }, filteredShape: { rows: 1, columns: 2 } }}
        page={longPage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const cell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]');
    expect(cell?.textContent).toHaveLength(4_097);
    expect(cell?.textContent).toMatch(/…$/u);
    expect(cell).toHaveAttribute("title", cell?.textContent);
    expect(cell?.textContent).not.toContain(longValue);
  });

  it("supports roving keyboard focus across typed cells", async () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const city = screen.getByRole("cell", { name: "Milan" });
    const sales = screen.getByRole("cell", { name: "10.5" });
    expect(city).toHaveAttribute("tabindex", "0");
    act(() => city.focus());
    expect(document.activeElement).toBe(city);
    fireEvent.keyDown(city, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(sales));
    expect(screen.queryByText("Profiling…")).toBeNull();
  });

  it("restores stable column widths, selection, and both viewport axes", async () => {
    const onViewStateChange = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={{
          columnWidths: { "c:1": 280 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 95 }
        }}
        viewStateRestoreVersion={1}
        onViewStateChange={onViewStateChange}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const scroller = screen.getByTestId("data-grid-scroller");
    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(95);
    expect(document.querySelectorAll("col")[2]).toHaveStyle({ width: "280px" });
    expect(screen.getByRole("columnheader", { name: /sales/u })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("cell", { name: "" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");
    expect(onViewStateChange).not.toHaveBeenCalled();
  });

  it("preserves a restored logical viewport across device-pixel scroll quantization", async () => {
    const onViewStateChange = vi.fn();
    const onPage = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onViewStateChange,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    let physicalScrollTop = scroller.scrollTop;
    let physicalScrollLeft = scroller.scrollLeft;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => physicalScrollTop,
      set: (value: number) => {
        physicalScrollTop = value === 29 ? 28.8 : value;
      }
    });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => physicalScrollLeft,
      set: (value: number) => {
        physicalScrollLeft = value === 35 ? 35.2000007629 : value;
      }
    });

    rerender(
      <DataGrid
        {...props}
        viewState={{
          columnWidths: {},
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 35 }
        }}
        viewStateRestoreVersion={1}
      />
    );
    fireEvent.scroll(scroller);

    expect(scroller.scrollTop).toBe(28.8);
    expect(scroller.scrollLeft).toBe(35.2000007629);
    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");

    fireEvent.wheel(scroller);
    scroller.scrollTop = 28.8;
    scroller.scrollLeft = 80;
    fireEvent.scroll(scroller);

    expect(onViewStateChange).toHaveBeenLastCalledWith({
      columnWidths: {},
      selectedColumnId: "c:1",
      viewport: { firstVisibleRow: 1, scrollLeft: 80 }
    });
    expect(onPage).not.toHaveBeenCalled();
  });

  it("carries the scroll-requested row into the next block's roving focus", async () => {
    const onPage = vi.fn();
    const scrollMetadata = {
      ...metadata,
      shape: { rows: 6, columns: 2 },
      filteredShape: { rows: 6, columns: 2 }
    };
    const scrollPage = { ...page, totalRows: 6 };
    const props = {
      metadata: scrollMetadata,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={scrollPage} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    scroller.scrollTop = 4 * 29;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(4));

    rerender(
      <DataGrid
        {...props}
        page={{
          ...scrollPage,
          offset: 4,
          rows: scrollPage.rows.map((row, index) => ({ ...row, id: `r:${index + 4}`, rowNumber: index + 4 }))
        }}
      />
    );
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-grid-row", "4"));
  });

  it("reports ownership changes when horizontal virtualization replaces visible columns", async () => {
    const columns = Array.from({ length: 8 }, (_, position) => ({
      id: `c:${position}`,
      name: `column-${position}`,
      position,
      rawType: "String",
      type: "string" as const,
      nullable: false
    }));
    const wideMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 1, columns: columns.length },
      filteredShape: { rows: 1, columns: columns.length },
      schema: columns
    };
    const widePage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: columns.map((column) => column.id),
      rows: [
        {
          id: "r:wide",
          rowNumber: 0,
          values: columns.map((column) => ({
            kind: "string" as const,
            raw: column.name,
            display: column.name,
            isNull: false,
            isNaN: false
          }))
        }
      ]
    };
    const onVisibleSummaryColumnsChange = vi.fn();
    const onVisibleColumnRangeChange = vi.fn();
    render(
      <DataGrid
        metadata={wideMetadata}
        page={widePage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={100}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleColumnRangeChange={onVisibleColumnRangeChange}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["column-0", "column-1", "column-2", "column-3"])
    );

    scroller.scrollLeft = 700;
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["column-4", "column-5", "column-6", "column-7"])
    );
    expect(onVisibleColumnRangeChange).toHaveBeenLastCalledWith({ start: 4, end: 8 });
    expect(document.querySelector('th[data-column="column-4"]')).toHaveAttribute("aria-colindex", "6");
    expect(document.querySelector('th[data-column="column-7"]')).toHaveAttribute("aria-colindex", "9");
    await waitFor(() => {
      const rovingCells = document.querySelectorAll<HTMLTableCellElement>('td[tabindex="0"]');
      expect(rovingCells).toHaveLength(1);
      expect(rovingCells[0]).toHaveAttribute("data-grid-column", "4");
    });
  });

  it("keeps one roving tab stop when mouse scrolling virtualizes the focused row", async () => {
    const rows = Array.from({ length: 40 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      values: page.rows[0].values
    }));
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 40, columns: 2 }, filteredShape: { rows: 40, columns: 2 } }}
        page={{ offset: 0, limit: 200, totalRows: 40, columnIds: page.columnIds, rows }}
        summaries={[]}
        pageSize={200}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    fireEvent(window, new Event("resize"));
    const initialRovingCell = document.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
    expect(initialRovingCell).not.toBeNull();
    act(() => initialRovingCell?.focus());
    expect(document.activeElement).toBe(initialRovingCell);
    scroller.scrollTop = 20 * 29;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const rovingCells = document.querySelectorAll<HTMLTableCellElement>('td[tabindex="0"]');
      expect(rovingCells).toHaveLength(1);
      expect(Number(rovingCells[0].dataset.gridRow)).toBeGreaterThan(0);
      expect(document.activeElement).toBe(rovingCells[0]);
    });
  });

  it("keeps explicit paging focus ahead of queued scroll-focus preservation", async () => {
    const rows = Array.from({ length: 80 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      values: page.rows[0].values
    }));
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 80, columns: 2 }, filteredShape: { rows: 80, columns: 2 } }}
        page={{ offset: 0, limit: 200, totalRows: 80, columnIds: page.columnIds, rows }}
        summaries={[]}
        pageSize={200}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 616 });
    fireEvent(window, new Event("resize"));
    const firstCell = document.querySelector<HTMLTableCellElement>('[data-grid-row="0"][data-grid-column="0"]');
    expect(firstCell).not.toBeNull();
    act(() => firstCell?.focus());
    fireEvent.keyDown(firstCell!, { key: "PageDown" });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-grid-row", "21"));

    const pageDownCell = document.activeElement as HTMLTableCellElement;
    act(() => {
      fireEvent.scroll(scroller);
      fireEvent.keyDown(pageDownCell, { key: "PageUp" });
    });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("data-grid-row", "0");
      expect(document.activeElement).toHaveAttribute("data-grid-column", "0");
    });
  });

  it("resets the row position while retaining the horizontal column context for a new logical view", async () => {
    const laterPage: GridPage = {
      ...page,
      offset: 4,
      totalRows: 6,
      rows: page.rows.map((row, index) => ({ ...row, id: `r:${index + 4}`, rowNumber: index + 4 }))
    };
    const props = {
      metadata: { ...metadata, shape: { rows: 6, columns: 2 }, filteredShape: { rows: 6, columns: 2 } },
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage: () => undefined,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={laterPage} viewContextId="view-a" />);
    const scroller = screen.getByTestId("data-grid-scroller");
    scroller.scrollTop = 4 * 29;
    scroller.scrollLeft = 200;
    fireEvent.scroll(scroller);

    rerender(<DataGrid {...props} page={page} viewContextId="view-b" />);

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(0);
      expect(scroller.scrollLeft).toBe(200);
      const rovingCells = document.querySelectorAll<HTMLTableCellElement>('td[tabindex="0"]');
      expect(rovingCells).toHaveLength(1);
      expect(rovingCells[0]).toHaveAttribute("data-grid-row", "0");
      expect(rovingCells[0]).toHaveAttribute("data-grid-column", "0");
    });
  });

  it("reports the complete visible summary ownership as insights and visibility change", async () => {
    const onVisibleSummaryColumnsChange = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );

    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));
    onVisibleSummaryColumnsChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Show insights" }));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["city", "sales"]));

    fireEvent.click(screen.getByRole("button", { name: "Hide insights" }));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));
    fireEvent.click(screen.getByRole("button", { name: "Show insights" }));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["city", "sales"]));
    expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(3);
  });

  it("maps a projected page by stable column ID while preserving full-schema grid coordinates", async () => {
    const projectedPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:1"],
      rows: [
        {
          id: "r:projected",
          rowNumber: 0,
          values: [{ kind: "number", raw: 42, display: "42", isNull: false, isNaN: false }]
        }
      ]
    };

    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 1, columns: 2 }, filteredShape: { rows: 1, columns: 2 } }}
        page={projectedPage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        projecting={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "3");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector('[data-grid-row="0"][data-grid-column="0"]')).toHaveAccessibleName(
      "Loading city, row 1"
    );
    const projectedCell = screen.getByRole("cell", { name: "42" });
    expect(projectedCell).toHaveAttribute("aria-colindex", "3");

    const loadingCell = screen.getByRole("cell", { name: "Loading city, row 1" });
    act(() => loadingCell.focus());
    fireEvent.keyDown(loadingCell, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(projectedCell));
  });

  it("reprofiles visible columns when the filter scope changes without a revision change", async () => {
    const onVisibleSummaryColumnsChange = vi.fn();
    const props = {
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: true,
      onPage: () => undefined,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange
    };
    const { rerender } = render(<DataGrid {...props} metadata={metadata} />);
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(1));

    rerender(
      <DataGrid
        {...props}
        metadata={{
          ...metadata,
          filterModel: { filters: [], sort: [{ column: "sales", direction: "asc", nulls: "last" }] }
        }}
      />
    );

    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(2));
    expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["city", "sales"]);
  });

  it("resizes columns from the keyboard and labels an empty grid", () => {
    let currentViewState = { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } };
    const onViewStateChange = vi.fn((next) => {
      currentViewState = next;
      rerender(
        <DataGrid
          metadata={metadata}
          page={page}
          summaries={[]}
          pageSize={2}
          defaultColumnWidth={190}
          insightsOnOpen={false}
          viewState={currentViewState}
          onViewStateChange={onViewStateChange}
          onPage={() => undefined}
          onSortColumn={() => undefined}
          onOpenFilter={() => undefined}
          onVisibleSummaryColumnsChange={() => undefined}
        />
      );
    });
    const { rerender } = render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={currentViewState}
        onViewStateChange={onViewStateChange}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const resize = screen.getByRole("button", { name: "Resize city column" });
    fireEvent.keyDown(resize, { key: "ArrowRight" });
    expect(document.querySelectorAll("col")[1]).toHaveStyle({ width: "200px" });

    rerender(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 0, columns: 2 }, filteredShape: { rows: 0, columns: 2 } }}
        page={{ offset: 0, limit: 2, totalRows: 0, columnIds: page.columnIds, rows: [] }}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={currentViewState}
        onViewStateChange={onViewStateChange}
        onPage={vi.fn()}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByText("No rows")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  });
});
