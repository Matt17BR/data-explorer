import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadata, TransformStep } from "../shared/protocol";
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

  it("contains keyboard focus within the modal operation picker", () => {
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="renameColumn"
        onClose={() => undefined}
        onPreview={() => undefined}
      />
    );

    const close = screen.getByRole("button", { name: "Close operation picker" });
    const preview = screen.getByRole("button", { name: "Preview changes" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(preview).toHaveFocus();
    fireEvent.keyDown(preview, { key: "Tab" });
    expect(close).toHaveFocus();
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

  it("fails closed when a saved step has no recorded input schema while leaving cancel usable", () => {
    const onClose = vi.fn();
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "rename-city",
      kind: "renameColumn",
      params: { column: { id: "c:0", name: "city" }, newName: "location" }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={onClose}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("recorded input schema is unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Cancel editing, then reload the session");
    const preview = screen.getByRole("button", { name: "Preview changes" });
    expect(preview).toBeDisabled();
    fireEvent.submit(preview.closest("form") as HTMLFormElement);
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    {
      caseName: "stale single reference",
      step: {
        id: "rename-missing",
        kind: "renameColumn",
        params: { column: { id: "c:missing", name: "city" }, newName: "location" }
      },
      message: "column ID “c:missing”, which is absent"
    },
    {
      caseName: "list reference name mismatch",
      step: {
        id: "encode-mismatched",
        kind: "oneHotEncode",
        params: { columns: [{ id: "c:0", name: "not-city" }] }
      },
      message: "expects column name “not-city” for ID “c:0”"
    },
    {
      caseName: "nested sort reference mismatch",
      step: {
        id: "sort-mismatched",
        kind: "sortRows",
        params: {
          rules: [{ column: { id: "c:1", name: "not-sales" }, direction: "asc", nulls: "last" }]
        }
      },
      message: "saved sort rule 1 expects column name “not-sales”"
    },
    {
      caseName: "filter semantic type mismatch",
      step: {
        id: "filter-type-mismatched",
        kind: "filterRows",
        params: {
          filterModel: {
            filters: [{ column: { id: "c:1", name: "sales" }, type: "string", predicates: [] }],
            sort: []
          }
        }
      },
      message: "declares type “string”, but its recorded input column has type “float”"
    },
    {
      caseName: "nested filter-step sort mismatch",
      step: {
        id: "filter-sort-missing",
        kind: "filterRows",
        params: {
          filterModel: {
            filters: [],
            sort: [{ column: { id: "c:missing", name: "other" }, direction: "asc", nulls: "last" }]
          }
        }
      },
      message: "saved filter-step sort 1 refers to column ID “c:missing”"
    },
    {
      caseName: "nested formula reference mismatch",
      step: {
        id: "formula-missing-right",
        kind: "formula",
        params: {
          leftColumn: { id: "c:1", name: "sales" },
          rightColumn: { id: "c:missing", name: "other" },
          operator: "add",
          newColumn: "total"
        }
      },
      message: "saved right formula column refers to column ID “c:missing”"
    },
    {
      caseName: "repeated list identity",
      step: {
        id: "encode-repeated",
        kind: "oneHotEncode",
        params: {
          columns: [
            { id: "c:0", name: "city" },
            { id: "c:0", name: "city" }
          ]
        }
      },
      message: "saved column list repeats column ID “c:0”"
    },
    {
      caseName: "repeated nested sort identity",
      step: {
        id: "sort-repeated",
        kind: "sortRows",
        params: {
          rules: [
            { column: { id: "c:1", name: "sales" }, direction: "asc", nulls: "last" },
            { column: { id: "c:1", name: "sales" }, direction: "desc", nulls: "first" }
          ]
        }
      },
      message: "saved sort rules repeats column ID “c:1”"
    }
  ] satisfies { caseName: string; step: TransformStep; message: string }[])(
    "blocks editing for a $caseName",
    ({ step, message }) => {
      const onClose = vi.fn();
      const onPreview = vi.fn();
      render(
        <OperationBuilder
          metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [step] }}
          filterModel={{ filters: [], sort: [] }}
          initialStep={step}
          onClose={onClose}
          onPreview={onPreview}
        />
      );

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      const preview = screen.getByRole("button", { name: "Preview changes" });
      expect(preview).toBeDisabled();
      fireEvent.submit(preview.closest("form") as HTMLFormElement);
      expect(onPreview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledOnce();
    }
  );

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

    expect(screen.getByText("Selected order: sales — column 2 → city — column 1")).toBeInTheDocument();
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
    expect(screen.getByText("Selected order: sales — column 2 → city — column 1")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Columns to keep");

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0].params).toEqual({
      columns: [
        { id: "c:1", name: "sales" },
        { id: "c:0", name: "city" }
      ]
    });
  });

  it("edits a categorical reference list by stable ID when labels are duplicated", () => {
    const categoricalPreview = vi.fn();
    const duplicateColumns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 }
    ];
    const initialStep: TransformStep = {
      id: "encode-second-value",
      kind: "oneHotEncode",
      params: {
        columns: [{ id: "c:1", name: "value" }],
        prefixSeparator: "",
        dropOriginal: true
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
        onPreview={categoricalPreview}
      />
    );
    const categoricalSelect = screen.getByLabelText(/Categorical columns/) as HTMLSelectElement;
    expect(Array.from(categoricalSelect.selectedOptions, (option) => option.value)).toEqual(["c:1"]);
    expect(Array.from(categoricalSelect.options, (option) => option.text)).toEqual([
      "value — column 1",
      "value — column 2"
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(categoricalPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("authors one-hot encoding with an intentionally empty prefix separator", () => {
    const onPreview = vi.fn();
    render(
      <OperationBuilder
        metadata={metadata}
        filterModel={{ filters: [], sort: [] }}
        initialKind="oneHotEncode"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const columns = screen.getByLabelText("Categorical columns") as HTMLSelectElement;
    columns.options[0].selected = true;
    fireEvent.change(columns);
    fireEvent.change(screen.getByLabelText("Prefix separator"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview.mock.calls[0][0].params).toEqual({
      columns: [{ id: "c:0", name: "city" }],
      prefixSeparator: "",
      dropOriginal: true
    });
  });

  it("round-trips an intentionally empty multi-label output prefix", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "labels-without-prefix",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "c:0", name: "city" },
        delimiter: ",",
        prefix: "",
        dropOriginal: false
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Output prefix mode")).toHaveValue("custom");
    expect(screen.getByLabelText("Custom output prefix")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it("authors and edits a find/replace step with an empty find pattern", () => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: "replace-empty-boundaries",
      kind: "findReplace",
      params: {
        column: { id: "c:0", name: "city" },
        find: "",
        replacement: "-",
        regex: false
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Find (blank matches empty boundaries)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(initialStep, initialStep.id);
  });

  it.each([
    ["omitted", undefined],
    ["null", null]
  ] as const)("preserves default whitespace stripping when characters is %s", (_caseName, characters) => {
    const onPreview = vi.fn();
    const initialStep: TransformStep = {
      id: `strip-${_caseName}`,
      kind: "stripText",
      params: {
        column: { id: "c:0", name: "city" },
        ...(characters === null ? { characters } : {})
      }
    };
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [initialStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={initialStep}
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    expect(screen.getByLabelText("Characters (blank means whitespace)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview).toHaveBeenCalledWith(
      {
        id: initialStep.id,
        kind: "stripText",
        params: { column: { id: "c:0", name: "city" } }
      },
      initialStep.id
    );
  });

  it.each([
    {
      label: "Labels column",
      step: {
        id: "labels",
        kind: "multiLabelBinarize",
        params: { column: { id: "c:1", name: "value" }, delimiter: ",", dropOriginal: false }
      }
    },
    {
      label: "Text column",
      step: {
        id: "replace",
        kind: "findReplace",
        params: {
          column: { id: "c:1", name: "value" },
          find: "before",
          replacement: "after",
          regex: false
        }
      }
    },
    {
      label: "Text column",
      step: {
        id: "strip",
        kind: "stripText",
        params: { column: { id: "c:1", name: "value" } }
      }
    },
    {
      label: "Text column",
      step: {
        id: "split",
        kind: "splitText",
        params: { column: { id: "c:1", name: "value" }, delimiter: ",", index: 0, newColumn: "part" }
      }
    },
    ...(["capitalizeText", "lowerText", "upperText", "minMaxScale", "floorNumber", "ceilNumber"] as const).map(
      (kind) => ({
        label: "Column",
        step: {
          id: kind,
          kind,
          params: { column: { id: "c:1", name: "value" }, newColumn: `${kind}_result` }
        }
      })
    ),
    {
      label: "Numeric column",
      step: {
        id: "round",
        kind: "roundNumber",
        params: { column: { id: "c:1", name: "value" }, decimals: 2, newColumn: "rounded" }
      }
    },
    {
      label: "Date or datetime column",
      step: {
        id: "format",
        kind: "formatDatetime",
        params: { column: { id: "c:1", name: "value" }, format: "%Y-%m-%d", newColumn: "formatted" }
      }
    }
  ] satisfies { label: string; step: TransformStep }[])(
    "edits $step.kind by saved column ID instead of a duplicate label",
    ({ label, step }) => {
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
            steps: [step]
          }}
          filterModel={{ filters: [], sort: [] }}
          initialStep={step}
          onClose={() => undefined}
          onPreview={onPreview}
        />
      );

      const columnSelect = screen.getByLabelText(label) as HTMLSelectElement;
      expect(columnSelect.value).toBe("c:1");
      expect(Array.from(columnSelect.options, (option) => option.text)).toEqual([
        "value — column 1",
        "value — column 2"
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
      expect(onPreview).toHaveBeenCalledWith(step, step.id);
    }
  );

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

    const legacy = [
      { inputs: { city: "Milan" }, output: "MILAN" },
      { inputs: { city: "Paris" }, output: "PARIS" }
    ];
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: JSON.stringify(legacy) } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Example 1 inputs must be an array with 1 values in source-column order"
    );
    expect(onPreview).not.toHaveBeenCalled();

    for (const [unsafeIntegerJson, token] of [
      ['[{"inputs":[9007199254740993],"output":1},{"inputs":[2],"output":3}]', "9007199254740993"],
      ['[{"inputs":[-9007199254740992],"output":1},{"inputs":[2],"output":3}]', "-9007199254740992"],
      ['[{"inputs":[9.007199254740993e15],"output":1},{"inputs":[2],"output":3}]', "9.007199254740993e15"]
    ]) {
      fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: unsafeIntegerJson } });
      fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        `Integer token ${token} is outside JavaScript's exact safe range`
      );
      expect(onPreview).not.toHaveBeenCalled();
    }

    const valid = [
      { inputs: ["9007199254740993"], output: "9007199254740993" },
      { inputs: ["-9007199254740992"], output: "-9007199254740992" }
    ];
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: JSON.stringify(valid) } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onPreview.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        kind: "byExample",
        params: { sourceColumns: [{ id: "c:0", name: "city" }], newColumn: "example_result", examples: valid }
      })
    );
  });

  it("builds group keys and repeated aggregation values from stable duplicate-safe identities", () => {
    const onPreview = vi.fn();
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "", position: 2 },
      { ...metadata.schema[1], id: "c:3", name: "7", position: 3 }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="groupBy"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const keys = screen.getByRole("listbox", { name: "Group keys" }) as HTMLSelectElement;
    expect(Array.from(keys.options, (option) => option.text)).toEqual([
      "value — column 1",
      "value — column 2",
      "(empty name) — column 3",
      "7 — column 4"
    ]);
    keys.options[1].selected = true;
    fireEvent.change(keys);
    const value = screen.getByLabelText("Value 1") as HTMLSelectElement;
    fireEvent.change(value, { target: { value: "c:3" } });
    fireEvent.change(screen.getByLabelText("Output name"), { target: { value: "total" } });
    fireEvent.click(screen.getByRole("button", { name: "Add aggregation" }));
    fireEvent.change(screen.getByLabelText("Value 2"), { target: { value: "c:3" } });
    const aliases = screen.getAllByLabelText("Output name") as HTMLInputElement[];
    fireEvent.change(aliases[1], { target: { value: "average" } });
    const calculations = screen.getAllByLabelText("Calculation") as HTMLSelectElement[];
    fireEvent.change(calculations[1], { target: { value: "mean" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview.mock.calls[0][0].params).toEqual({
      keys: [{ id: "c:1", name: "value" }],
      aggregations: [
        { column: { id: "c:3", name: "7" }, operation: "sum", alias: "total" },
        { column: { id: "c:3", name: "7" }, operation: "mean", alias: "average" }
      ]
    });
  });

  it("preserves by-example source interaction order and aligned scalar arrays", () => {
    const onPreview = vi.fn();
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[0], id: "c:2", name: "", position: 2 },
      { ...metadata.schema[1], id: "c:3", name: "7", position: 3 }
    ];
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns }}
        filterModel={{ filters: [], sort: [] }}
        initialKind="byExample"
        onClose={() => undefined}
        onPreview={onPreview}
      />
    );

    const sources = screen.getByRole("listbox", { name: "Source columns" }) as HTMLSelectElement;
    sources.options[0].selected = false;
    sources.options[1].selected = true;
    fireEvent.change(sources);
    sources.options[3].selected = true;
    fireEvent.change(sources);
    expect(screen.getByText("Selected order: value — column 2 → 7 — column 4")).toBeInTheDocument();
    const examples = [
      { inputs: ["a", 1], output: "a1" },
      { inputs: ["b", 2], output: "b2" }
    ];
    fireEvent.change(screen.getByLabelText(/Examples \(JSON\)/), { target: { value: JSON.stringify(examples) } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onPreview.mock.calls[0][0].params).toEqual({
      sourceColumns: [
        { id: "c:1", name: "value" },
        { id: "c:3", name: "7" }
      ],
      newColumn: "example_result",
      examples
    });
  });

  it("restores saved group and by-example IDs from the recorded input schema", () => {
    const columns = [
      { ...metadata.schema[0], id: "c:0", name: "value", position: 0 },
      { ...metadata.schema[1], id: "c:1", name: "value", position: 1 },
      { ...metadata.schema[1], id: "c:2", name: "7", position: 2 }
    ];
    const groupPreview = vi.fn();
    const groupStep = {
      id: "saved-group",
      kind: "groupBy",
      params: {
        keys: [{ id: "c:1", name: "value" }],
        aggregations: [{ column: { id: "c:2", name: "7" }, operation: "sum", alias: "total" }]
      }
    } satisfies TransformStep;
    const { unmount } = render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns, latestStepInputSchema: columns, steps: [groupStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={groupStep}
        onClose={() => undefined}
        onPreview={groupPreview}
      />
    );
    expect(screen.getByText("Selected order: value — column 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Value 1")).toHaveValue("c:2");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(groupPreview.mock.calls[0][0]).toEqual(groupStep);
    unmount();

    const examplePreview = vi.fn();
    const exampleStep = {
      id: "saved-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c:1", name: "value" }],
        newColumn: "upper",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "case", style: "upper", input: { kind: "column", column: { id: "c:1", name: "value" } } },
        warnings: ["Ambiguous examples: preview carefully."],
        candidateCount: 2
      }
    } satisfies TransformStep;
    render(
      <OperationBuilder
        metadata={{ ...metadata, schema: columns, latestStepInputSchema: columns, steps: [exampleStep] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={exampleStep}
        onClose={() => undefined}
        onPreview={examplePreview}
      />
    );
    expect(screen.getByText("Selected order: value — column 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(examplePreview.mock.calls[0][0].params).toEqual({
      sourceColumns: [{ id: "c:1", name: "value" }],
      newColumn: "upper",
      examples: exampleStep.params.examples
    });
  });

  it("fails a saved by-example edit closed when its program uses an unselected source", () => {
    const onClose = vi.fn();
    const onPreview = vi.fn();
    const step = {
      id: "unsafe-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c:0", name: "city" }],
        newColumn: "unsafe",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "column", column: { id: "c:1", name: "sales" } }
      }
    } satisfies TransformStep;
    render(
      <OperationBuilder
        metadata={{ ...metadata, latestStepInputSchema: metadata.schema, steps: [step] }}
        filterModel={{ filters: [], sort: [] }}
        initialStep={step}
        onClose={onClose}
        onPreview={onPreview}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("outside its selected sources");
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
  });
});
