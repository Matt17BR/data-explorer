import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, OpenWranglerResponse, SessionMetadata, TransformStep } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App, alignedColumnWindow } from "../webviews/App";

const step: TransformStep = {
  id: "round-column",
  kind: "roundNumber",
  params: { column: "column-20", decimals: 0 }
};

const schema = Array.from({ length: 40 }, (_, position) => ({
  id: `c:${position}`,
  name: `column-${position}`,
  position,
  rawType: "String",
  type: "string" as const,
  nullable: false
}));

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "wide-session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "wide.csv", path: "wide.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 400, columns: schema.length },
  filteredShape: { rows: 400, columns: schema.length },
  filterModel: { filters: [], sort: [] },
  steps: [step],
  schema
};

describe("App column projection", () => {
  beforeEach(() => postMessage.mockClear());

  it("shifts a maximum-size window so a visible range crossing an alignment boundary stays covered", () => {
    const window = alignedColumnWindow({ start: 250, end: 270 }, 1_000, 256);
    expect(window).toEqual({ offset: 250, limit: 256 });
    expect(window.offset).toBeLessThanOrEqual(250);
    expect(window.offset + window.limit).toBeGreaterThanOrEqual(270);

    expect(alignedColumnWindow({ start: 250, end: 270 }, 300, 256)).toEqual({ offset: 44, limit: 256 });
  });

  it("preserves one aligned column window across rows, filters, mutations, and inspection", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);

    const projectionRequest = await onlyRuntimeRequest("getPage");
    expect(projectionRequest).toMatchObject({ offset: 0, limit: 200, columnOffset: 16, columnLimit: 16 });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Next block" })).toBeEnabled();
    dispatch({
      kind: "error",
      code: "engine_error",
      message: "Projection failed once",
      recoverable: true,
      viewRequestId: String(projectionRequest.viewRequestId)
    });
    expect(await screen.findByRole("button", { name: "Retry page" })).toBeVisible();

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const projectionRetry = await onlyRuntimeRequest("getPage");
    expect(projectionRetry).toMatchObject({ offset: 0, limit: 200, columnOffset: 16, columnLimit: 16 });
    expect(projectionRetry.viewRequestId).not.toBe(projectionRequest.viewRequestId);
    dispatch(pageResponse(projectionRetry, metadata, projectedPage(0, 16)));

    const projectedCell = await screen.findByRole("cell", { name: "value-20-row-0" });
    expect(projectedCell).toHaveAttribute("aria-colindex", "22");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "41");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const rowRequest = await onlyRuntimeRequest("getPage");
    expect(rowRequest).toMatchObject({ offset: 200, columnOffset: 16, columnLimit: 16 });
    dispatch(pageResponse(rowRequest, metadata, projectedPage(200, 16)));
    await screen.findByRole("cell", { name: "value-20-row-200" });

    postMessage.mockClear();
    fireEvent.click(screen.getByLabelText("Column actions for column-20"));
    const menu = screen.getByLabelText("Column actions for column-20").closest("details");
    expect(menu).not.toBeNull();
    fireEvent.click(within(menu!).getByRole("button", { name: "Sort ascending" }));
    const filterRequest = await onlyRuntimeRequest("getPage");
    expect(filterRequest).toMatchObject({ offset: 0, columnOffset: 16, columnLimit: 16 });
    const sortedMetadata = {
      ...metadata,
      filterModel: { filters: [], sort: [{ column: "column-20", direction: "asc" as const, nulls: "last" as const }] }
    };
    dispatch(pageResponse(filterRequest, sortedMetadata, projectedPage(0, 16)));
    await screen.findByRole("cell", { name: "value-20-row-0" });

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "applyDraft" });
    const mutationRequest = await onlyRuntimeRequest("applyDraft");
    expect(mutationRequest).toMatchObject({ columnOffset: 16, columnLimit: 16 });
    dispatch({ kind: "error", code: "engine_error", message: "Expected test failure", recoverable: true });

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    const inspectionRequest = await onlyRuntimeRequest("inspectStep");
    expect(inspectionRequest).toMatchObject({ offset: 0, columnOffset: 16, columnLimit: 16 });
  });

  it("reconciles a horizontal scroll that arrives while the next row block is pending", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const rowRequest = await onlyRuntimeRequest("getPage");
    expect(rowRequest).toMatchObject({ offset: 200, columnOffset: 0, columnLimit: 16 });

    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    expect(runtimeRequests("getPage")).toHaveLength(1);

    dispatch(pageResponse(rowRequest, metadata, projectedPage(200, 0)));
    await waitFor(() => expect(runtimeRequests("getPage")).toHaveLength(2));
    const projectionRequest = runtimeRequests("getPage")[1];
    expect(projectionRequest).toMatchObject({ offset: 200, columnOffset: 16, columnLimit: 16 });

    dispatch(pageResponse(projectionRequest, metadata, projectedPage(200, 16)));
    expect(await screen.findByRole("cell", { name: "value-20-row-200" })).toBeVisible();
  });

  it("reconciles the current page after a pending mutation fails during horizontal scrolling", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "applyDraft" });
    await onlyRuntimeRequest("applyDraft");

    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    dispatch({
      kind: "error",
      code: "engine_error",
      message: "Mutation failed",
      recoverable: true
    });

    await waitFor(() => expect(runtimeRequests("getPage")).toHaveLength(1));
    const projectionRequest = runtimeRequests("getPage")[0];
    expect(projectionRequest).toMatchObject({ offset: 0, columnOffset: 16, columnLimit: 16 });
    dispatch(pageResponse(projectionRequest, metadata, projectedPage(0, 16)));

    expect(await screen.findByRole("cell", { name: "value-20-row-0" })).toBeVisible();
  });

  it("exposes projection loading and disables cleaning actions instead of silently dropping them", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    await onlyRuntimeRequest("getPage");

    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(
      "Loading visible columns… Cleaning actions are temporarily unavailable."
    );
    expect(screen.getByRole("button", { name: "Add step" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit latest" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    dispatch({ kind: "editorAction", action: "applyDraft" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wait for the visible columns to finish loading before changing the cleaning plan."
    );
    expect(runtimeRequests("applyDraft")).toHaveLength(0);

    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wait for the visible columns to finish loading before inspecting a cleaning step."
    );
    expect(runtimeRequests("inspectStep")).toHaveLength(0);

    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "castColumn" });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Wait for the visible columns to finish loading before adding a cleaning step."
    );
  });
});

function projectedPage(offset: number, columnOffset: number): GridPage {
  const columns = schema.slice(columnOffset, columnOffset + 16);
  return {
    offset,
    limit: 200,
    totalRows: 400,
    columnIds: columns.map((column) => column.id),
    rows: [
      {
        id: `r:${offset}`,
        rowNumber: offset,
        values: columns.map((column) => ({
          kind: "string" as const,
          raw: `value-${column.position}-row-${offset}`,
          display: `value-${column.position}-row-${offset}`,
          isNull: false,
          isNaN: false
        }))
      }
    ]
  };
}

function pageResponse(
  request: Record<string, unknown>,
  responseMetadata: SessionMetadata,
  page: GridPage
): OpenWranglerResponse {
  return {
    kind: "page",
    revision: responseMetadata.revision,
    viewRequestId: String(request.viewRequestId),
    metadata: responseMetadata,
    page
  };
}

type HostMessage =
  | OpenWranglerResponse
  | { kind: "editorAction"; action: "applyDraft" }
  | { kind: "editorAction"; action: "selectStep"; stepId: string }
  | { kind: "editorAction"; action: "openOperation"; operationKind?: "castColumn" };

function dispatch(data: HostMessage): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

async function onlyRuntimeRequest(kind: string): Promise<Record<string, unknown>> {
  await waitFor(() => expect(runtimeRequests(kind)).toHaveLength(1));
  return runtimeRequests(kind)[0];
}

function runtimeRequests(kind: string): Record<string, unknown>[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { kind?: unknown; request?: Record<string, unknown> };
    return candidate.kind === "runtimeRequest" && candidate.request?.kind === kind ? [candidate.request] : [];
  });
}
