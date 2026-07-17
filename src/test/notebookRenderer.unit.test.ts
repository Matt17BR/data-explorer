import { describe, expect, it, vi } from "vitest";
import { activate } from "../webviews/notebookRenderer";

describe("notebook renderer", () => {
  it("labels truncated saved outputs and forwards only the validated canonical payload", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = canonicalPayload(10);

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    expect(element.querySelector('[role="status"]')?.textContent).toContain("first 1 of 10 rows");
    const button = element.querySelector("button");
    expect(button?.textContent).toBe("Open in Open Wrangler");
    button?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });

  it("keeps captured truth primary and makes a live-variable launch explicit", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = canonicalPayload(1, "frame");

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    const captured = Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent === "Open in Open Wrangler"
    );
    const live = Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent === "Open live variable"
    );
    expect(captured?.title).toContain("captured notebook output");
    expect(live?.title).toContain("current value of frame through Jupyter");

    captured?.click();
    live?.click();
    expect(postMessage).toHaveBeenNthCalledWith(1, { kind: "openInOpenWrangler", payload });
    expect(postMessage).toHaveBeenNthCalledWith(2, { kind: "openLiveInOpenWrangler", payload });
  });

  it("rejects capability-elevated notebook metadata before rendering an action", () => {
    const element = document.createElement("div");
    const payload = canonicalPayload(1);

    activate({ postMessage: vi.fn() }).renderOutputItem(
      {
        json: () => ({
          ...payload,
          metadata: {
            ...payload.metadata,
            capabilities: { ...payload.metadata.capabilities, editable: true }
          }
        })
      },
      element
    );

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "malformed or uses an unsupported MIME version"
    );
    expect(element.querySelector("button")).toBeNull();
  });

  it("keeps the saved preview readable when extension-host messaging is unavailable", () => {
    const element = document.createElement("div");

    activate({}).renderOutputItem({ json: () => canonicalPayload(1, "frame") }, element);

    expect(element.querySelector("section.openwrangler-notebook")?.textContent).toContain(
      "Open Wrangler preview: saved frame"
    );
    expect(element.querySelector("table")?.textContent).toContain("value");
    expect(element.querySelector("button")).toBeNull();
  });

  it("renders a bounded inline window while retaining the complete capture in its action", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = widePayload(25, 24);

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    expect(element.querySelectorAll("thead th")).toHaveLength(20);
    expect(element.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(element.querySelectorAll("tbody td")).toHaveLength(400);
    expect(element.querySelector('[data-testid="inline-preview-limit"]')?.textContent).toContain(
      "20 of 25 captured rows and 20 of 24 columns"
    );
    element.querySelector("button")?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });

  it("rejects an over-limit capture before creating notebook DOM or an action", () => {
    const element = document.createElement("div");
    const payload = canonicalPayload(1);

    activate({ postMessage: vi.fn() }).renderOutputItem(
      { json: () => ({ ...payload, page: { ...payload.page, limit: 10_001 } }) },
      element
    );

    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.querySelector("table")).toBeNull();
    expect(element.querySelector("button")).toBeNull();
  });

  it("bounds every user-derived inline string without changing the expanded payload", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const longColumn = "🧪".repeat(200);
    const longCell = "🧪".repeat(600);
    const base = canonicalPayload(1);
    const payload = {
      ...base,
      metadata: {
        ...base.metadata,
        schema: [{ ...base.metadata.schema[0]!, name: longColumn, rawType: longColumn }]
      },
      page: {
        ...base.page,
        rows: [
          {
            ...base.page.rows[0]!,
            values: [{ kind: "string", raw: longCell, display: longCell, isNull: false, isNaN: false }]
          }
        ]
      }
    };

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    const truncated = element.querySelectorAll('[data-truncated-value="true"]');
    expect(truncated).toHaveLength(2);
    const cell = element.querySelector("tbody td");
    expect(cell?.textContent?.endsWith("…")).toBe(true);
    expect(Array.from(cell?.textContent ?? "")).toHaveLength(513);
    expect(Array.from(cell?.getAttribute("title") ?? "").length).toBeLessThan(650);
    expect(Array.from(cell?.getAttribute("aria-label") ?? "").length).toBeLessThan(650);
    element.querySelector("button")?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });
});

function canonicalPayload(totalRows: number, variableName?: string) {
  return {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "untrusted-saved-session",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: { kind: "notebookOutput", label: "saved frame", ...(variableName ? { variableName } : {}) },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: totalRows, columns: 1 },
      filteredShape: { rows: totalRows, columns: 1 },
      filterModel: { filters: [], sort: [] },
      steps: [],
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }]
    },
    page: {
      offset: 0,
      limit: 1,
      totalRows,
      columnIds: ["c:value"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
        }
      ]
    },
    summaries: []
  };
}

function widePayload(rowCount: number, columnCount: number) {
  const schema = Array.from({ length: columnCount }, (_, position) => ({
    id: `c:${position}`,
    name: `column_${position}`,
    position,
    rawType: "Int64",
    type: "integer",
    nullable: false
  }));
  return {
    mimeVersion: 2,
    metadata: {
      ...canonicalPayload(1).metadata,
      shape: { rows: rowCount, columns: columnCount },
      filteredShape: { rows: rowCount, columns: columnCount },
      schema
    },
    page: {
      offset: 0,
      limit: rowCount,
      totalRows: rowCount,
      columnIds: schema.map((column) => column.id),
      rows: Array.from({ length: rowCount }, (_, rowNumber) => ({
        id: `r:${rowNumber}`,
        rowNumber,
        values: schema.map((_, position) => ({
          kind: "integer",
          raw: rowNumber * columnCount + position,
          display: String(rowNumber * columnCount + position),
          isNull: false,
          isNaN: false
        }))
      }))
    },
    summaries: []
  };
}
