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

    expect(operationCatalog).toHaveLength(27);
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

    fireEvent.change(screen.getByLabelText("Column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "revenue" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "renameColumn",
        params: { column: { id: "c:1", name: "sales" }, newName: "revenue" }
      }),
      undefined
    );
  });

  it("exposes preview progress and disables every dialog control while busy", () => {
    const onClose = vi.fn();
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        busy={true}
        onClose={onClose}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Previewing changes…");
    expect(screen.getByRole("button", { name: "Close operation picker" })).toBeDisabled();
    expect(screen.getByPlaceholderText("Search operations")).toBeDisabled();
    expect(screen.getByText("Rename column", { selector: "strong" }).closest("button")).toBeDisabled();
    expect(screen.getByLabelText("New name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    fireEvent.submit(screen.getByRole("button", { name: "Preview changes" }).closest("form") as HTMLFormElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
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
      sort: [{ column: "sales", direction: "desc" as const, nulls: "first" as const }]
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
    expect(onPreview.mock.calls[0][0].params).toEqual({
      filterModel: {
        logic: "and",
        filters: [
          {
            column: { id: "c:0", name: "city" },
            type: "string",
            predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
          }
        ],
        sort: [{ column: { id: "c:1", name: "sales" }, direction: "desc", nulls: "first" }]
      }
    });
  });

  it("edits a saved stable filter step independently from an empty current view", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    const initialStep = {
      id: "filter-first-sort-second",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          logic: "and" as const,
          filters: [
            {
              column: { id: "c:0", name: "value" },
              type: "string" as const,
              predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
            }
          ],
          sort: [{ column: { id: "c:1", name: "value" }, direction: "desc" as const, nulls: "first" as const }]
        }
      }
    };
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [initialStep]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("group", { name: "Saved cleaning query" })).toBeInTheDocument();
    expect(screen.getByText("1 filters")).toBeInTheDocument();
    expect(screen.getByText("1 sorts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("replaces a saved filter step with the current viewing query only when explicitly selected", () => {
    const onPreview = vi.fn();
    const initialStep = {
      id: "saved-filter",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          filters: [
            {
              column: { id: "c:0", name: "city" },
              type: "string" as const,
              predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Milan" }]
            }
          ],
          sort: []
        }
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{
          filters: [],
          sort: [{ column: "sales", direction: "desc", nulls: "last" }]
        }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: /Replace it with the current viewing query/u }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview).toHaveBeenCalledWith(
      {
        id: "saved-filter",
        kind: "filterRows",
        params: {
          filterModel: {
            filters: [],
            sort: [{ column: { id: "c:1", name: "sales" }, direction: "desc", nulls: "last" }]
          }
        }
      },
      "saved-filter"
    );
  });

  it.each([
    [
      "ambiguous",
      [
        { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
        { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
      ],
      "Viewing query column “value” is ambiguous because 2 input columns share that name."
    ],
    ["missing", metadata.schema, "Viewing query column “value” is no longer available in the operation input."]
  ] as const)(
    "rejects a %s viewing-query column instead of guessing a transform reference",
    (_case, schema, message) => {
      const onPreview = vi.fn();
      render(
        <OperationBuilder
          metadata={{ ...metadata, schema: [...schema], shape: { rows: 2, columns: schema.length } }}
          filterModel={{
            filters: [{ column: "value", type: "string", predicates: [] }],
            sort: []
          }}
          initialKind="filterRows"
          onClose={() => undefined}
          onPreview={onPreview}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(onPreview).not.toHaveBeenCalled();
    }
  );

  it("uses stable duplicate-safe references when adding and editing row sorts", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [
            {
              id: "sort-second",
              kind: "sortRows",
              params: { rules: [{ column: { id: "c:1", name: "value" }, direction: "desc", nulls: "first" }] }
            }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "sort-second",
          kind: "sortRows",
          params: { rules: [{ column: { id: "c:1", name: "value" }, direction: "desc", nulls: "first" }] }
        }}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("option", { name: "value — column 1" })).toHaveValue("c:0");
    expect((screen.getByRole("option", { name: "value — column 2" }) as HTMLOptionElement).selected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      rules: [{ column: { id: "c:1", name: "value" }, direction: "desc", nulls: "first" }]
    });
  });

  it("emits an explicit empty reference list when drop-missing applies to all columns", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="dropMissingRows"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({ columns: [], how: "any" });
  });

  it("uses stable duplicate-safe references for drop-duplicates columns", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: duplicateColumns }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="dropDuplicates"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const select = screen.getByRole("listbox") as HTMLSelectElement;
    select.options[1].selected = true;
    fireEvent.change(select);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      columns: [{ id: "c:1", name: "value" }],
      keep: "first"
    });
  });

  it("edits structural steps against their original input schema", () => {
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: [metadata.schema[1]],
          latestStepInputSchema: metadata.schema,
          steps: [{ id: "drop-city", kind: "dropColumns", params: { columns: [{ id: "c:0", name: "city" }] } }]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "drop-city",
          kind: "dropColumns",
          params: { columns: [{ id: "c:0", name: "city" }] }
        }}
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    expect(screen.getByRole("option", { name: "city — column 1" })).toBeInTheDocument();
    expect((screen.getByRole("option", { name: "city — column 1" }) as HTMLOptionElement).selected).toBe(true);
  });

  it("distinguishes duplicate labels by position and edits a structural reference by ID", () => {
    const onPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "", position: 2 },
      { ...metadata.schema[0], id: "c:3", name: "(empty name)", position: 3 },
      { ...metadata.schema[0], id: "c:4", name: "value — column 1", position: 4 }
    ];
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          schema: duplicateColumns,
          latestStepInputSchema: duplicateColumns,
          steps: [
            {
              id: "rename-second",
              kind: "renameColumn",
              params: { column: { id: "c:1", name: "value" }, newName: "second_value" }
            }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "rename-second",
          kind: "renameColumn",
          params: { column: { id: "c:1", name: "value" }, newName: "second_value" }
        }}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const first = screen.getByRole("option", { name: "value — column 1" }) as HTMLOptionElement;
    const second = screen.getByRole("option", { name: "value — column 2" }) as HTMLOptionElement;
    expect(first).toHaveValue("c:0");
    expect(second).toHaveValue("c:1");
    expect(first.selected).toBe(false);
    expect(second.selected).toBe(true);
    expect(screen.getByRole("option", { name: "(empty name) — column 3" })).toHaveValue("c:2");
    expect(screen.getByRole("option", { name: "(empty name) — column 4" })).toHaveValue("c:3");
    expect(screen.getByRole("option", { name: "value — column 1 — column 5" })).toHaveValue("c:4");

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rename-second",
        kind: "renameColumn",
        params: { column: { id: "c:1", name: "value" }, newName: "second_value" }
      }),
      "rename-second"
    );
  });

  it.each([
    [
      "cloneColumn",
      "Column",
      "c:1",
      "New name",
      "sales_copy",
      { column: { id: "c:1", name: "sales" }, newName: "sales_copy" }
    ],
    [
      "castColumn",
      "Column",
      "c:1",
      "Target type",
      "integer",
      { column: { id: "c:1", name: "sales" }, dtype: "integer" }
    ],
    [
      "textLength",
      "Text column",
      "c:0",
      "New column",
      "city_length",
      { column: { id: "c:0", name: "city" }, newColumn: "city_length" }
    ]
  ] as const)("emits stable references for %s", (kind, columnLabel, columnId, parameterLabel, parameter, expected) => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind={kind}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText(columnLabel), { target: { value: columnId } });
    fireEvent.change(screen.getByLabelText(parameterLabel), { target: { value: parameter } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0]).toEqual(expect.objectContaining({ kind, params: expected }));
  });

  it("emits stable references for both formula operands", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="formula"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText("Left column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("Right operand"), { target: { value: "column" } });
    fireEvent.change(screen.getByLabelText("Right column"), { target: { value: "c:0" } });
    fireEvent.change(screen.getByLabelText("New column"), { target: { value: "ratio" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        kind: "formula",
        params: {
          leftColumn: { id: "c:1", name: "sales" },
          operator: "add",
          newColumn: "ratio",
          rightColumn: { id: "c:0", name: "city" }
        }
      })
    );
  });

  it.each([
    ["selectColumns", "Columns to keep"],
    ["dropColumns", "Columns to drop"]
  ] as const)("emits reference lists for %s", (kind, label) => {
    const structuralPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind={kind}
        onClose={() => undefined}
        onPreview={structuralPreview}
      />
    );

    const structuralSelect = screen.getByRole("listbox") as HTMLSelectElement;
    expect(structuralSelect).toHaveAccessibleName(label);
    structuralSelect.options[0].selected = true;
    structuralSelect.options[1].selected = true;
    fireEvent.change(structuralSelect);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(structuralPreview.mock.calls[0][0].params).toEqual({
      columns: [
        { id: "c:0", name: "city" },
        { id: "c:1", name: "sales" }
      ]
    });
  });

  it("preserves an existing select-columns order when previewed unchanged", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={{
          ...metadata,
          latestStepInputSchema: metadata.schema,
          steps: [
            {
              id: "reverse-columns",
              kind: "selectColumns",
              params: {
                columns: [
                  { id: "c:1", name: "sales" },
                  { id: "c:0", name: "city" }
                ]
              }
            }
          ]
        }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={{
          id: "reverse-columns",
          kind: "selectColumns",
          params: {
            columns: [
              { id: "c:1", name: "sales" },
              { id: "c:0", name: "city" }
            ]
          }
        }}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByText("Output order: sales — column 2 → city — column 1")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Columns to keep");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      columns: [
        { id: "c:1", name: "sales" },
        { id: "c:0", name: "city" }
      ]
    });
  });

  it("records select-columns choices in interaction order", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="selectColumns"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const columnSelect = screen.getByRole("listbox") as HTMLSelectElement;
    columnSelect.options[1].selected = true;
    fireEvent.change(columnSelect);
    columnSelect.options[0].selected = true;
    fireEvent.change(columnSelect);
    expect(screen.getByText("Output order: sales — column 2 → city — column 1")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Columns to keep");

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      columns: [
        { id: "c:1", name: "sales" },
        { id: "c:0", name: "city" }
      ]
    });
  });

  it("leaves categorical selection name-based", () => {
    const categoricalPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="oneHotEncode"
        onClose={() => undefined}
        onPreview={categoricalPreview}
      />
    );
    const categoricalSelect = screen.getByLabelText(/Categorical columns/) as HTMLSelectElement;
    categoricalSelect.options[1].selected = true;
    fireEvent.change(categoricalSelect);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(categoricalPreview.mock.calls[0][0].params).toEqual({
      columns: ["sales"],
      prefixSeparator: "_",
      dropOriginal: true
    });
  });

  it("builds by-example inputs and reports malformed JSON before preview", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="byExample"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: "not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Examples must be valid JSON");
    expect(onPreview).not.toHaveBeenCalled();

    const valid = [
      { inputs: { city: "Milan" }, output: "MILAN" },
      { inputs: { city: "Paris" }, output: "PARIS" }
    ];
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: JSON.stringify(valid) } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        kind: "byExample",
        params: { sourceColumns: ["city"], newColumn: "example_result", examples: valid }
      })
    );
  });
});
