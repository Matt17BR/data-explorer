import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, GridPage, OpenWranglerResponse, SessionMetadata } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";

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
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 500, columns: 2 },
  filteredShape: { rows: 500, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false }
  ]
};

const page = pageWithCity("Berlin");

const citySummary: ColumnSummary = {
  column: "city",
  type: "string",
  rawType: "String",
  totalCount: 500,
  nullCount: 0,
  nanCount: 0,
  distinctCount: 500,
  topValues: [{ value: "Berlin", count: 1 }]
};

describe("App progressive profiling and view correlation", () => {
  beforeEach(() => postMessage.mockClear());

  it("ignores messages from another origin", () => {
    render(<App />);
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { kind: "sessionOpened", metadata, page, summaries: [] },
          origin: "https://untrusted.invalid"
        })
      )
    );

    expect(screen.getByText("Loading dataframe...")).toBeInTheDocument();
    expect(screen.queryByText("Berlin")).toBeNull();
  });

  it("opens without exact stats and profiles each visible column independently", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const summaries = requestsOfKind("getSummary");
    expect(summaries.map((request) => request.columns)).toEqual([["city"], ["sales"]]);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
    expect(viewSequence(summaries[1]) > viewSequence(summaries[0])).toBe(true);

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const nextPage = onlyRequest("getPage");
    expect(nextPage).toMatchObject({ offset: 200, limit: 200, filterModel: metadata.filterModel });
    expect(nextPage.viewRequestId).toMatch(/^view-.+-\d+$/);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
  });

  it("restores host-owned grid presentation and publishes bounded changes independently from runtime requests", async () => {
    render(<App />);
    const restoredPage = {
      ...page,
      offset: 200,
      rows: page.rows.map((row, index) => ({ ...row, id: `r:${index + 200}`, rowNumber: index + 200 }))
    };
    dispatch({ kind: "sessionOpened", metadata, page: restoredPage, summaries: [] });
    dispatch({
      kind: "viewState",
      state: {
        columnWidths: { "c:1": 275 },
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 200, scrollLeft: 90 }
      }
    });

    const scroller = screen.getByTestId("data-grid-scroller");
    expect(scroller.scrollTop).toBe(200 * 29);
    expect(scroller.scrollLeft).toBe(90);
    expect(document.querySelectorAll("col")[2]).toHaveStyle({ width: "275px" });
    expect(document.querySelector('th[data-column="sales"]')).toHaveAttribute("aria-selected", "true");

    postMessage.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize sales column" }), { key: "ArrowRight" });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        kind: "updateViewState",
        state: {
          columnWidths: { "c:1": 285 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 200, scrollLeft: 90 }
        }
      })
    );
    expect(requestsOfKind("getPage")).toHaveLength(0);
  });

  it.each(["pagehide", "beforeunload"])("flushes the final pending grid presentation on %s", (eventName) => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({
      kind: "viewState",
      state: {
        columnWidths: { "c:1": 275 },
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
    postMessage.mockClear();

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize sales column" }), { key: "ArrowRight" });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "updateViewState" }));

    act(() => window.dispatchEvent(new Event(eventName)));

    expect(postMessage).toHaveBeenCalledWith({
      kind: "updateViewState",
      state: {
        columnWidths: { "c:1": 285 },
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
  });

  it("clears host-invalidated applied-step inspection locally without echoing the clear", () => {
    const step = {
      id: "round-sales",
      kind: "roundNumber",
      params: { column: { id: "c:1", name: "sales" }, decimals: 0 }
    } as const;
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: { ...metadata, steps: [step] }, page, summaries: [] });
    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    expect(screen.getByLabelText("Selected applied-step inspection")).toBeInTheDocument();
    expect(requestsOfKind("inspectStep")).toHaveLength(1);

    postMessage.mockClear();
    dispatch({ kind: "stepInspectionCleared", resumeProfiling: true });

    expect(screen.queryByLabelText("Selected applied-step inspection")).not.toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalledWith({ kind: "clearStepInspection" });
  });

  it("accepts only the newest page across A to B to A and out-of-order completion", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    sortCityAscending();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    const pages = requestsOfKind("getPage");
    expect(pages).toHaveLength(2);
    const [requestB, requestA] = pages;
    expect(viewSequence(requestA) > viewSequence(requestB)).toBe(true);

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(requestA),
      metadata,
      page: pageWithCity("Latest A")
    });
    expect(await screen.findByText("Latest A")).toBeInTheDocument();

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(requestB),
      metadata: { ...metadata, filterModel: requestB.filterModel as FilterModel },
      page: pageWithCity("Stale B")
    });
    expect(screen.queryByText("Stale B")).not.toBeInTheDocument();
    expect(screen.getByText("Latest A")).toBeInTheDocument();
  });

  it("keeps foreground loading through stale background failures and retries an unchanged failed filter", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const oldSummary = requestsOfKind("getSummary")[0];
    postMessage.mockClear();

    sortCityAscending();
    const firstPage = onlyRequest("getPage");
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    dispatch({
      kind: "error",
      code: "profile_failed",
      message: "Old profile failed",
      recoverable: true,
      viewRequestId: viewId(oldSummary)
    });
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Page failed",
      recoverable: true,
      viewRequestId: viewId(firstPage)
    });
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByText("Page failed")).toBeInTheDocument();

    postMessage.mockClear();
    sortCityAscending();
    const retry = onlyRequest("getPage");
    expect(viewId(retry)).not.toBe(viewId(firstPage));
  });

  it("restores the confirmed view context and restarts profiling when a new view fails", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    openCityFilter();
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const values = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(values),
      column: "city",
      values: [{ value: "Restored value", count: 7 }],
      hasMore: false
    });
    expect(await screen.findByText("Restored value")).toBeInTheDocument();
    const confirmedContext = setViewContextMessages().at(-1)?.viewContextId;
    if (!confirmedContext) throw new Error("Expected the opened view context.");

    postMessage.mockClear();
    sortCityAscending();
    const failedPage = onlyRequest("getPage");
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "The sorted view failed",
      recoverable: true,
      viewRequestId: viewId(failedPage)
    });

    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    expect(setViewContextMessages().at(-1)?.viewContextId).toBe(confirmedContext);
    for (const envelope of [...runtimeEnvelopes("getSummary"), ...runtimeEnvelopes("getDatasetStats")]) {
      expect(envelope.viewContextId).toBe(confirmedContext);
    }
    expect(screen.getByText("Berlin")).toBeInTheDocument();
    expect(screen.getByText("Restored value")).toBeInTheDocument();
    expect(screen.getByText("The sorted view failed")).toBeInTheDocument();
  });

  it("releases failed summary work and retries the column with a fresh correlation ID", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const firstCity = requestsOfKind("getSummary").find((request) => request.columns?.[0] === "city");
    if (!firstCity) throw new Error("Expected the initial city summary request.");

    dispatch({
      kind: "error",
      code: "profile_failed",
      message: "Profile failed once",
      recoverable: true,
      viewRequestId: viewId(firstCity)
    });

    await waitFor(() => {
      const cityRequests = requestsOfKind("getSummary").filter((request) => request.columns?.[0] === "city");
      expect(cityRequests).toHaveLength(2);
    });
    const retry = requestsOfKind("getSummary").filter((request) => request.columns?.[0] === "city")[1];
    expect(viewSequence(retry) > viewSequence(firstCity)).toBe(true);

    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(retry),
      summaries: [citySummary]
    });
    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
  });

  it("restores confirmed profile and value state after mutation errors and cancellation", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const cityRequest = requestsOfKind("getSummary").find((request) => request.columns?.[0] === "city");
    if (!cityRequest) throw new Error("Expected the city summary request.");
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityRequest),
      summaries: [citySummary]
    });

    openCityFilter();
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const valuesRequest = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(valuesRequest),
      column: "city",
      values: [{ value: "Owned value", count: 4 }],
      hasMore: false
    });
    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
    expect(await screen.findByText("Owned value")).toBeInTheDocument();
    const confirmedContext = setViewContextMessages().at(-1)?.viewContextId;

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRequest("undoStep")).toBeDefined();
    dispatch({
      kind: "error",
      code: "mutation_failed",
      message: "The mutation failed",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(await screen.findByText("Owned value")).toBeInTheDocument();
    expect(screen.getByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("The mutation failed")).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    expect(onlyRequest("getSummary").columns).toEqual(["sales"]);
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    expect(setViewContextMessages().at(-1)?.viewContextId).toBe(confirmedContext);

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRequest("undoStep")).toBeDefined();
    dispatch({ kind: "cancelled", targetRequestId: "mutation" });

    expect(await screen.findByText("Owned value")).toBeInTheDocument();
    expect(screen.getByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("The cleaning operation was cancelled.")).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    expect(onlyRequest("getSummary").columns).toEqual(["sales"]);
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
  });

  it("requests exact stats only for an open drawer and never accepts stale stats", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    expect(screen.getByText("Profiling exact missing values…")).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const oldStats = requestsOfKind("getDatasetStats")[0];

    sortCityAscending();
    const sortedPage = requestsOfKind("getPage").at(-1);
    if (!sortedPage) throw new Error("Expected the sorted page request.");
    dispatch({
      kind: "datasetStats",
      revision: metadata.revision,
      viewRequestId: viewId(oldStats),
      stats: emptyStats()
    });
    expect(screen.getByText("Profiling exact missing values…")).toBeInTheDocument();

    const sortedFilter = sortedPage.filterModel as FilterModel;
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(sortedPage),
      metadata: { ...metadata, filterModel: sortedFilter },
      page
    });
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(2));
    const currentStats = requestsOfKind("getDatasetStats")[1];
    dispatch({
      kind: "datasetStats",
      revision: metadata.revision,
      viewRequestId: viewId(currentStats),
      stats: emptyStats()
    });
    expect(await screen.findByText("No missing values.")).toBeInTheDocument();
  });

  it("accepts only the latest values search for a column", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByLabelText("Column actions for city"));
    const cityHeader = document.querySelector<HTMLTableCellElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city column header.");
    fireEvent.click(within(cityHeader).getByRole("button", { name: "Filter…" }));
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const firstValues = requestsOfKind("getColumnValues").at(-1);
    if (!firstValues) throw new Error("Expected the initial values request.");

    const search = screen.getByPlaceholderText("Search values");
    fireEvent.change(search, { target: { value: "mil" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const latestValues = requestsOfKind("getColumnValues").at(-1);
    if (!latestValues) throw new Error("Expected the searched values request.");
    expect(viewId(latestValues)).not.toBe(viewId(firstValues));

    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(firstValues),
      column: "city",
      values: [{ value: "Berlin", count: 10 }],
      hasMore: false
    });
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(latestValues),
      column: "city",
      values: [{ value: "Milan", count: 3 }],
      hasMore: false
    });
    expect(await screen.findByText("Milan")).toBeInTheDocument();
    expect(screen.queryByText("Berlin", { selector: ".valueList span" })).not.toBeInTheDocument();
  });

  it("keeps foreground page failures separate from successful profiling work", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const cityProfile = requestsOfKind("getSummary").find((request) => request.columns?.[0] === "city");
    if (!cityProfile) throw new Error("Expected a city summary request.");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const failedPage = onlyRequest("getPage");
    dispatch({ kind: "cancelled", targetRequestId: "unrelated-request" });
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Page fetch failed",
      recoverable: true,
      viewRequestId: viewId(failedPage)
    });
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityProfile),
      summaries: [citySummary]
    });

    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("Page fetch failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry page" })).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("keeps profiling diagnostics until that profiling request succeeds", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const cityProfile = requestsOfKind("getSummary").find((request) => request.columns?.[0] === "city");
    if (!cityProfile) throw new Error("Expected a city summary request.");

    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    const stats = onlyRequest("getDatasetStats");
    dispatch({
      kind: "error",
      code: "stats_failed",
      message: "Exact stats failed",
      recoverable: true,
      viewRequestId: viewId(stats)
    });
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityProfile),
      summaries: [citySummary]
    });

    expect(await screen.findByText(/Insights warning: Exact stats failed/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByText(/Insights warning: Exact stats failed/)).not.toBeInTheDocument();
  });

  it("restores confirmed profiling diagnostics after a foreground mutation fails", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    const firstStats = onlyRequest("getDatasetStats");
    dispatch({
      kind: "error",
      code: "stats_failed",
      message: "Keep this exact-stats warning",
      recoverable: true,
      viewRequestId: viewId(firstStats)
    });
    expect(await screen.findByText(/Keep this exact-stats warning/)).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(2));

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRequest("undoStep")).toBeDefined();
    expect(screen.queryByText(/Keep this exact-stats warning/)).not.toBeInTheDocument();
    dispatch({
      kind: "error",
      code: "mutation_failed",
      message: "Undo failed",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(await screen.findByText(/Keep this exact-stats warning/)).toBeInTheDocument();
    expect(screen.getByText("Undo failed")).toBeInTheDocument();
  });

  it("profiles a wide drawer progressively and batches cancellation when it closes", async () => {
    const columns = Array.from({ length: 20 }, (_, position) => ({
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
      limit: 200,
      totalRows: 1,
      columnIds: columns.map((column) => column.id),
      rows: [
        {
          id: "r:wide",
          rowNumber: 0,
          values: columns.map(({ name }) => ({
            kind: "string" as const,
            raw: name,
            display: name,
            isNull: false,
            isNaN: false
          }))
        }
      ]
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: wideMetadata, page: widePage, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Hide insights" }));
    await waitFor(() => expect(cancellationMessages().length).toBeGreaterThan(0));

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(4));
    const firstBatch = requestsOfKind("getSummary");
    expect(firstBatch.map((request) => request.columns?.[0])).toEqual(["column-0", "column-1", "column-2", "column-3"]);

    const completed = firstBatch[0];
    const completedColumn = completed.columns?.[0];
    if (!completedColumn) throw new Error("Expected a queued summary column.");
    dispatch({
      kind: "summary",
      revision: wideMetadata.revision,
      viewRequestId: viewId(completed),
      summaries: [{ ...citySummary, column: completedColumn }]
    });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(5));
    const activeSummaryIds = requestsOfKind("getSummary").slice(1).map(viewId);
    const statsId = viewId(onlyRequest("getDatasetStats"));

    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    const cancellations = cancellationMessages();
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0].viewRequestIds).toEqual(expect.arrayContaining([...activeSummaryIds, statsId]));
  });

  it("cancels obsolete background work on view changes and drawer close", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const initialSummaryIds = requestsOfKind("getSummary").map(viewId);

    sortCityAscending();
    const viewCancellation = cancellationMessages().at(-1);
    expect(viewCancellation?.viewRequestIds).toEqual(expect.arrayContaining(initialSummaryIds));

    const sortedPage = requestsOfKind("getPage").at(-1);
    if (!sortedPage) throw new Error("Expected a sorted page request.");
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(sortedPage),
      metadata: { ...metadata, filterModel: sortedPage.filterModel as FilterModel },
      page
    });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const statsId = viewId(onlyRequest("getDatasetStats"));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));

    expect(cancellationMessages().at(-1)?.viewRequestIds).toContain(statsId);
  });

  it("keeps a drawer-started summary when the visible grid also claims it", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    for (const request of requestsOfKind("getSummary")) {
      dispatch({
        kind: "summary",
        revision: metadata.revision,
        viewRequestId: viewId(request),
        summaries:
          request.columns?.[0] === "city"
            ? [citySummary]
            : [{ ...citySummary, column: "sales", type: "float", rawType: "Float64" }]
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Hide insights" }));

    postMessage.mockClear();
    sortCityAscending();
    const sortedPage = onlyRequest("getPage");
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(sortedPage),
      metadata: { ...metadata, filterModel: sortedPage.filterModel as FilterModel },
      page
    });
    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const drawerSummaryIds = requestsOfKind("getSummary").map(viewId);

    fireEvent.click(screen.getByRole("button", { name: "Show insights" }));
    expect(requestsOfKind("getSummary")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide insights" }));
    await waitFor(() => {
      const cancelledIds = cancellationMessages().flatMap((message) => message.viewRequestIds);
      for (const requestId of drawerSummaryIds) expect(cancelledIds).not.toContain(requestId);
    });
    fireEvent.click(screen.getByRole("button", { name: "Show insights" }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await waitFor(() => {
      const cancelledIds = cancellationMessages().flatMap((message) => message.viewRequestIds);
      for (const requestId of drawerSummaryIds) expect(cancelledIds).not.toContain(requestId);
    });
    fireEvent.click(screen.getByRole("button", { name: "Hide insights" }));
    await waitFor(() => {
      const cancelledIds = cancellationMessages().flatMap((message) => message.viewRequestIds);
      expect(cancelledIds).toEqual(expect.arrayContaining(drawerSummaryIds));
    });
  });

  it("retries the same failed page block with a fresh request ID and the same logical view", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const first = onlyRuntimeEnvelope("getPage");
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Block failed",
      recoverable: true,
      viewRequestId: viewId(first.request)
    });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const retry = onlyRuntimeEnvelope("getPage");
    expect(retry.request.offset).toBe(200);
    expect(viewId(retry.request)).not.toBe(viewId(first.request));
    expect(retry.viewContextId).toBe(first.viewContextId);

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(retry.request),
      metadata,
      page: { ...page, offset: 200, rows: [{ ...page.rows[0], rowNumber: 200, id: "r:200" }] }
    });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-grid-row", "200"));
  });

  it("uses a new opaque view context for A to B to A even when filters and revisions match again", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    sortCityAscending();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const [viewB, viewAAgain] = runtimeEnvelopes("getPage");

    expect(viewB.viewContextId).toBe(viewId(viewB.request));
    expect(viewAAgain.viewContextId).toBe(viewId(viewAAgain.request));
    expect(viewAAgain.viewContextId).not.toBe(viewB.viewContextId);
  });

  it("keeps value candidates available for multi-select filters and facets values outside their own filter", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    openCityFilter();
    const valuesRequest = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(valuesRequest),
      column: "city",
      values: [
        { value: "Berlin", count: 7 },
        { value: "Milan", count: 5 }
      ],
      hasMore: false
    });

    fireEvent.click(await screen.findByRole("checkbox", { name: /Berlin/ }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Berlin/ })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: /Milan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Milan/ }));

    const pageRequests = requestsOfKind("getPage");
    expect(pageRequests).toHaveLength(2);
    const latestPage = pageRequests.at(-1);
    if (!latestPage) throw new Error("Expected the combined value-filter request.");
    const latestModel = latestPage.filterModel as FilterModel;
    expect(latestModel.filters[0]?.valueFilter?.selectedValues).toEqual(["Berlin", "Milan"]);

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(latestPage),
      metadata: { ...metadata, filterModel: latestModel },
      page
    });
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    expect((onlyRequest("getColumnValues").filterModel as FilterModel).filters).toEqual([]);
  });

  it("rolls overlapping view failures back to the original confirmed profiles and values", async () => {
    const profiledMetadata = { ...metadata, stats: emptyStats() };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: profiledMetadata, page, summaries: [citySummary] });
    await screen.findByText("Distinct 100%");
    openCityFilter();
    const valuesRequest = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(valuesRequest),
      column: "city",
      values: [{ value: "Confirmed candidate", count: 7 }],
      hasMore: false
    });
    expect(await screen.findByText("Confirmed candidate")).toBeInTheDocument();
    expect(screen.getByText("No missing values.")).toBeInTheDocument();
    const originalContext = setViewContextMessages().at(-1)?.viewContextId;

    postMessage.mockClear();
    sortCityAscending();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const pageRequests = requestsOfKind("getPage");
    expect(pageRequests).toHaveLength(2);
    const newest = pageRequests[1];
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Newest view failed",
      recoverable: true,
      viewRequestId: viewId(newest)
    });

    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("Confirmed candidate")).toBeInTheDocument();
    expect(screen.getByText("No missing values.")).toBeInTheDocument();
    expect(setViewContextMessages().at(-1)?.viewContextId).toBe(originalContext);
  });

  it("keeps authored operation input mounted when preview fails", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("button", { name: "Add step" });
    openCityFilter();
    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "customCode" });
    await screen.findByRole("dialog", { name: "Add cleaning step" });
    const code = await screen.findByLabelText(/Engine-native Python/);
    fireEvent.change(code, { target: { value: "result = df.filter(pl.col('sales') > 10)" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onlyRequest("previewStep")).toMatchObject({
      step: { kind: "customCode", params: { code: "result = df.filter(pl.col('sales') > 10)" } }
    });

    const dialog = screen.getByRole("dialog", { name: "Add cleaning step" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(code).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close operation picker" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    dispatch({
      kind: "error",
      code: "custom_code_failed",
      message: "Custom code failed",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Engine-native Python/)).toHaveValue("result = df.filter(pl.col('sales') > 10)");
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull());
  });
});

function sortCityAscending(): void {
  fireEvent.click(screen.getByLabelText("Column actions for city"));
  const cityHeader = document.querySelector<HTMLTableCellElement>('th[data-column="city"]');
  if (!cityHeader) throw new Error("Expected the city column header.");
  fireEvent.click(within(cityHeader).getByRole("button", { name: "Sort ascending" }));
}

function openCityFilter(): void {
  fireEvent.click(screen.getByLabelText("Column actions for city"));
  const cityHeader = document.querySelector<HTMLTableCellElement>('th[data-column="city"]');
  if (!cityHeader) throw new Error("Expected the city column header.");
  fireEvent.click(within(cityHeader).getByRole("button", { name: "Filter…" }));
}

function dispatch(
  data: OpenWranglerResponse | EditorActionMessage | ViewStateMessage | StepInspectionClearedMessage
): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

interface EditorActionMessage {
  kind: "editorAction";
  action: "undoStep" | "openOperation" | "selectStep";
  operationKind?: "customCode";
  stepId?: string;
}

interface ViewStateMessage {
  kind: "viewState";
  state: unknown;
}

interface StepInspectionClearedMessage {
  kind: "stepInspectionCleared";
  resumeProfiling: boolean;
}

interface RuntimeRequest {
  kind: string;
  viewRequestId?: string;
  columns?: string[];
  filterModel?: unknown;
  [key: string]: unknown;
}

interface RuntimeEnvelope {
  kind: "runtimeRequest";
  viewContextId?: string;
  request: RuntimeRequest;
}

interface CancellationMessage {
  kind: "cancelViewRequests";
  viewRequestIds: string[];
}

interface SetViewContextMessage {
  kind: "setViewContext";
  viewContextId: string;
}

function runtimeEnvelopes(kind?: string): RuntimeEnvelope[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<RuntimeEnvelope>;
    if (
      candidate.kind !== "runtimeRequest" ||
      !isRuntimeRequest(candidate.request) ||
      (kind !== undefined && candidate.request.kind !== kind)
    )
      return [];
    return [candidate as RuntimeEnvelope];
  });
}

function onlyRuntimeEnvelope(kind: string): RuntimeEnvelope {
  const matches = runtimeEnvelopes(kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function cancellationMessages(): CancellationMessage[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<CancellationMessage>;
    return candidate.kind === "cancelViewRequests" && Array.isArray(candidate.viewRequestIds)
      ? [candidate as CancellationMessage]
      : [];
  });
}

function setViewContextMessages(): SetViewContextMessage[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<SetViewContextMessage>;
    return candidate.kind === "setViewContext" && typeof candidate.viewContextId === "string"
      ? [candidate as SetViewContextMessage]
      : [];
  });
}

function runtimeRequests(): RuntimeRequest[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { kind?: unknown; request?: unknown };
    if (candidate.kind !== "runtimeRequest" || !isRuntimeRequest(candidate.request)) return [];
    return [candidate.request];
  });
}

function requestsOfKind(kind: string): RuntimeRequest[] {
  return runtimeRequests().filter((request) => request.kind === kind);
}

function onlyRequest(kind: string): RuntimeRequest {
  const matches = requestsOfKind(kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function viewId(request: RuntimeRequest): string {
  if (!request.viewRequestId) throw new Error(`Request ${request.kind} has no viewRequestId.`);
  return request.viewRequestId;
}

function viewSequence(request: RuntimeRequest): number {
  return Number(viewId(request).split("-").at(-1));
}

function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  return typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string";
}

function pageWithCity(city: string): GridPage {
  return {
    offset: 0,
    limit: 200,
    totalRows: 500,
    columnIds: metadata.schema.map((column) => column.id),
    rows: [
      {
        id: "r:0",
        rowNumber: 0,
        values: [
          { kind: "string", raw: city, display: city, isNull: false, isNaN: false },
          { kind: "number", raw: 12, display: "12", isNull: false, isNaN: false }
        ]
      }
    ]
  };
}

function emptyStats() {
  return { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] };
}
