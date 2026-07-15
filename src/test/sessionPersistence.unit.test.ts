import { describe, expect, it } from "vitest";
import type { SessionMetadata } from "../shared/protocol";
import { decodePersistedSession, persistedStateFromMetadata, persistenceKey } from "../extension/sessionPersistence";

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
  steps: [{ id: "rename", kind: "renameColumn", params: { column: "old", newName: "new" } }],
  draftStep: { id: "drop", kind: "dropColumns", params: { columns: ["unused"] } }
};

describe("session persistence", () => {
  it("uses source identity and import options as a stable storage key", () => {
    const source = {
      kind: "file" as const,
      label: "sample.csv",
      path: "/workspace/sample.csv",
      importOptions: { delimiter: ";", hasHeader: true }
    };
    expect(persistenceKey(source)).toBe(persistenceKey({ ...source }));
    expect(persistenceKey(source)).not.toBe(
      persistenceKey({ ...source, importOptions: { delimiter: ",", hasHeader: true } })
    );
  });

  it("round-trips only replayable plan and viewing state", () => {
    const persisted = persistedStateFromMetadata(metadata);
    expect(decodePersistedSession(persisted)).toEqual(persisted);
    expect(persisted).not.toHaveProperty("sessionId");
    expect(persisted).not.toHaveProperty("stats");
  });

  it("rejects malformed and unknown saved operations", () => {
    expect(decodePersistedSession({ steps: [], filterModel: { filters: [] } })).toBeUndefined();
    expect(
      decodePersistedSession({
        steps: [{ id: "bad", kind: "notAnOperation", params: {} }],
        filterModel: { filters: [], sort: [] }
      })
    ).toBeUndefined();
  });
});
