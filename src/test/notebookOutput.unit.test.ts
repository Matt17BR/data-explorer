import { describe, expect, it } from "vitest";
import {
  DATA_EXPLORER_MIME,
  DATA_EXPLORER_MIME_V1,
  DATA_EXPLORER_MIME_V2,
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

describe("notebook output compatibility", () => {
  it("uses MIME v2 for new outputs", () => {
    expect(DATA_EXPLORER_MIME).toBe(DATA_EXPLORER_MIME_V2);
    expect(DATA_EXPLORER_MIME_V1).not.toBe(DATA_EXPLORER_MIME_V2);
    const normalized = normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page, summaries: [] });
    expect(normalized?.mimeVersion).toBe(2);
    expect(notebookPayloadAsOpened(normalized!).kind).toBe("sessionOpened");
  });

  it("upgrades saved MIME v1 metadata without mutating its snapshot", () => {
    const legacy = normalizeNotebookOutputPayload({
      metadata: {
        sessionId: "legacy",
        backend: "pandas",
        source: { kind: "notebookOutput", label: "old frame" },
        shape: { rows: 1, columns: 1 },
        filteredShape: { rows: 1, columns: 1 },
        schema: metadata.schema,
        filterModel: { filters: [], sort: [] }
      },
      page,
      summaries: []
    });
    expect(legacy?.mimeVersion).toBe(1);
    expect(legacy?.metadata).toMatchObject({ protocolVersion: 2, revision: 0, mode: "viewing", steps: [] });
    expect(legacy?.metadata.capabilities.editable).toBe(false);
  });

  it("rejects malformed and unknown-version outputs", () => {
    expect(normalizeNotebookOutputPayload({ mimeVersion: 3, metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page: {}, summaries: [] })).toBeUndefined();
  });
});
