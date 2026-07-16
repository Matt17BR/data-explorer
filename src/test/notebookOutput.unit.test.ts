import { describe, expect, it } from "vitest";
import {
  OPEN_WRANGLER_MIME,
  OPEN_WRANGLER_MIME_V2,
  normalizeNotebookOutputPayload,
  notebookPayloadAsOpened
} from "../shared/notebookOutput";

const page = {
  offset: 0,
  limit: 1,
  totalRows: 1,
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
    expect(OPEN_WRANGLER_MIME).toBe(OPEN_WRANGLER_MIME_V2);
    const normalized = normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page, summaries: [] });
    expect(normalized?.mimeVersion).toBe(2);
    expect(notebookPayloadAsOpened(normalized!).kind).toBe("sessionOpened");
  });

  it("rejects malformed and unknown-version outputs", () => {
    expect(normalizeNotebookOutputPayload({ mimeVersion: 3, metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page: {}, summaries: [] })).toBeUndefined();
  });
});
