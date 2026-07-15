import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadata } from "../shared/protocol";
import { operationCatalog } from "../shared/operations";
import { OperationBuilder } from "../webviews/operations/OperationBuilder";

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

describe("OperationBuilder", () => {
  it("exposes the complete deterministic operation catalog", () => {
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    expect(operationCatalog).toHaveLength(26);
    for (const operation of operationCatalog) {
      expect(screen.getByText(operation.title, { selector: "strong" })).toBeInTheDocument();
    }
  });

  it("builds a validated rename step for preview", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Column"), { target: { value: "sales" } });
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "revenue" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "renameColumn",
        params: { column: "sales", newName: "revenue" }
      }),
      undefined
    );
  });

  it("copies viewing filters only through an explicit filter step", () => {
    const onPreview = vi.fn();
    const filterModel = {
      logic: "and" as const,
      filters: [
        {
          column: "city",
          type: "string" as const,
          predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
        }
      ],
      sort: []
    };
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={filterModel}
        initialKind="filterRows"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({ filterModel });
  });

  it("edits structural steps against their original input schema", () => {
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: [metadata.schema[1]],
          latestStepInputSchema: metadata.schema,
          steps: [{ id: "drop-city", kind: "dropColumns", params: { columns: ["city"] } }]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{ id: "drop-city", kind: "dropColumns", params: { columns: ["city"] } }}
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    expect(screen.getByRole("option", { name: "city" })).toBeInTheDocument();
    expect((screen.getByRole("option", { name: "city" }) as HTMLOptionElement).selected).toBe(true);
  });
});
