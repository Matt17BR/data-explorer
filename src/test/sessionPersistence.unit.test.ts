import { describe, expect, it } from "vitest";
import type { SessionMetadata } from "../shared/protocol";
import {
  decodePersistedSession,
  persistedSessionState,
  persistenceKey,
  SESSION_STORAGE_KEY
} from "../extension/sessionPersistence";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 4,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 1, columns: 2 },
  schema: [],
  filterModel: {
    filters: [],
    sort: [{ column: "value", direction: "desc", nulls: "last" }]
  },
  steps: [
    {
      id: "sort",
      kind: "sortRows",
      params: {
        rules: [
          {
            column: { id: "c:source:1", name: "value" },
            direction: "desc",
            nulls: "last"
          }
        ]
      }
    },
    {
      id: "rename",
      kind: "renameColumn",
      params: { column: { id: "c:source:0", name: "old" }, newName: "new" }
    },
    {
      id: "round",
      kind: "roundNumber",
      params: { column: { id: "c:source:1", name: "value" }, decimals: 2 }
    }
  ],
  draftStep: {
    id: "drop",
    kind: "dropColumns",
    params: { columns: [{ id: "c:source:1", name: "unused" }] }
  }
};

describe("session persistence", () => {
  it("uses the canonical Open Wrangler storage key", () => {
    expect(SESSION_STORAGE_KEY).toBe("openWrangler.persistedSessions.v4");
  });

  it("uses source, backend, and import options as a stable storage key", () => {
    const source = {
      kind: "file" as const,
      label: "sample.csv",
      path: "/workspace/sample.csv",
      importOptions: { delimiter: ";", hasHeader: true }
    };
    expect(persistenceKey(source, "polars")).toBe(persistenceKey({ ...source }, "polars"));
    expect(persistenceKey(source, "polars")).not.toBe(persistenceKey(source, "duckdb"));
    expect(persistenceKey(source, "polars")).not.toBe(
      persistenceKey({ ...source, importOptions: { delimiter: ",", hasHeader: true } }, "polars")
    );
  });

  it("round-trips only replayable plan and viewing state", () => {
    const persisted = persistedSessionState(metadata, {
      columnWidths: { "c:value": 240 },
      selectedColumnId: "c:value",
      viewport: { firstVisibleRow: 41, scrollLeft: 320.5 }
    });
    expect(decodePersistedSession(persisted)).toEqual(persisted);
    expect(persisted).not.toHaveProperty("sessionId");
    expect(persisted).not.toHaveProperty("stats");
    expect(Object.keys(persisted).sort()).toEqual(["backend", "cleaning", "view"]);
    expect(persisted.backend).toBe("polars");
    expect(persisted.cleaning.steps).toEqual(metadata.steps);
    expect(persisted.view).toMatchObject({
      filterModel: metadata.filterModel,
      columnWidths: { "c:value": 240 },
      selectedColumnId: "c:value",
      viewport: { firstVisibleRow: 41, scrollLeft: 320.5 }
    });
  });

  it("decodes valid cleaning independently when the saved view is missing or malformed", () => {
    const cleaning = {
      steps: metadata.steps,
      draftStep: metadata.draftStep
    };
    const expected = { backend: "polars", cleaning };

    expect(decodePersistedSession({ backend: "polars", cleaning })).toEqual(expected);
    expect(decodePersistedSession({ backend: "polars", cleaning, view: {} })).toEqual(expected);
    expect(
      decodePersistedSession({
        backend: "polars",
        cleaning,
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: { "c:value": 79 },
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toEqual(expected);
  });

  it("rejects malformed and unknown saved operations", () => {
    expect(
      decodePersistedSession({
        backend: "pandas",
        cleaning: {
          steps: [
            {
              id: "legacy-sort",
              kind: "sortRows",
              params: { rules: [{ column: "value", direction: "desc", nulls: "last" }] }
            }
          ]
        },
        view: {
          filterModel: {
            filters: [],
            sort: [{ column: "value", direction: "desc", nulls: "last" }]
          },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toBeUndefined();
    expect(
      decodePersistedSession({
        backend: "polars",
        cleaning: { steps: [{ id: "bad", kind: "notAnOperation", params: {} }] },
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toBeUndefined();
    expect(
      decodePersistedSession({
        backend: "polars",
        cleaning: { steps: [{ id: "bad", kind: "renameColumn", params: { columns: ["old"] } }] },
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toBeUndefined();
    expect(
      decodePersistedSession({
        backend: "polars",
        cleaning: { steps: [{ id: "legacy-value", kind: "oneHotEncode", params: { columns: ["value"] } }] },
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toBeUndefined();
    expect(
      decodePersistedSession({
        backend: "polars",
        cleaning: {
          steps: [],
          draftStep: { id: "legacy-draft", kind: "upperText", params: { column: "value" } }
        },
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toBeUndefined();
    expect(
      decodePersistedSession({
        backend: "polars",
        cleaning: { steps: [] },
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        },
        unexpected: true
      })
    ).toBeUndefined();
    expect(
      decodePersistedSession({
        backend: "spark",
        cleaning: { steps: [] },
        view: {
          filterModel: { filters: [], sort: [] },
          columnWidths: {},
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      })
    ).toBeUndefined();
  });
});
