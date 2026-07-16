import { describe, expect, it } from "vitest";
import {
  OPEN_WRANGLER_MIME_V2,
  normalizeNotebookOutputPayload,
  notebookPayloadAsOpened
} from "../shared/notebookOutput";

const page = {
  offset: 0,
  limit: 1,
  totalRows: 1,
  columnIds: ["c:0"],
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
    }
  ]
};

const metadata = {
  protocolVersion: 2,
  sessionId: "snapshot",
  revision: 0,
  backend: "polars",
  mode: "viewing",
  source: { kind: "notebookOutput", label: "frame" },
  capabilities: {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 1 },
  filteredShape: { rows: 1, columns: 1 },
  schema: [{ id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
  filterModel: { filters: [], sort: [] },
  steps: []
};

describe("notebook output", () => {
  it("uses the canonical MIME v2 payload", () => {
    expect(OPEN_WRANGLER_MIME_V2).toBe("application/vnd.openwrangler.viewer.v2+json");
    const normalized = normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page, summaries: [] });
    expect(normalized?.mimeVersion).toBe(2);
    expect(notebookPayloadAsOpened(normalized!).kind).toBe("sessionOpened");
  });

  it("migrates saved full-width MIME v2 pages created before column projections", () => {
    const { columnIds: _columnIds, ...legacyPage } = page;

    const normalized = normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page: legacyPage, summaries: [] });

    expect(normalized?.page.columnIds).toEqual(["c:0"]);
    expect(normalized?.page.rows[0]?.values).toHaveLength(1);
  });

  it("rejects projected notebook snapshots that cannot fetch their missing columns", () => {
    const secondColumn = {
      id: "c:1",
      name: "other",
      position: 1,
      rawType: "Int64",
      type: "integer",
      nullable: false
    };
    const wideMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 2 },
      filteredShape: { rows: 1, columns: 2 },
      schema: [...metadata.schema, secondColumn]
    };
    const { columnIds: _columnIds, ...legacyNarrowPage } = page;

    expect(
      normalizeNotebookOutputPayload({ mimeVersion: 2, metadata: wideMetadata, page, summaries: [] })
    ).toBeUndefined();
    expect(
      normalizeNotebookOutputPayload({ mimeVersion: 2, metadata: wideMetadata, page: legacyNarrowPage, summaries: [] })
    ).toBeUndefined();
  });

  it("rejects current and legacy snapshots that omit claimed rows", () => {
    const { columnIds: _columnIds, ...legacyPage } = page;

    for (const candidate of [page, legacyPage]) {
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata,
          page: { ...candidate, totalRows: 1, rows: [] },
          summaries: []
        })
      ).toBeUndefined();
    }
  });

  it("rejects current and legacy snapshots that do not start at the first row", () => {
    const { columnIds: _columnIds, ...legacyPage } = page;

    for (const candidate of [page, legacyPage]) {
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata,
          page: { ...candidate, offset: 1 },
          summaries: []
        })
      ).toBeUndefined();
    }
  });

  it("rejects malformed and unknown-version outputs", () => {
    expect(normalizeNotebookOutputPayload({ mimeVersion: 3, metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page: {}, summaries: [] })).toBeUndefined();
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          steps: [{ id: "bad", kind: "renameColumn", params: { columns: ["value"] } }]
        },
        page,
        summaries: []
      })
    ).toBeUndefined();
  });
});
