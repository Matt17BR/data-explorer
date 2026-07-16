import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, SessionMetadata, ValuesResponse } from "../shared/protocol";
import { FilterPanel } from "../webviews/filters/FilterPanel";
import { SummaryPanel } from "../webviews/summary/SummaryPanel";

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
  shape: { rows: 4, columns: 2 },
  filteredShape: { rows: 4, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  stats: {
    missingCells: 1,
    missingRows: 1,
    duplicateRows: 1,
    missingValuesByColumn: [
      { column: "city", count: 0 },
      { column: "sales", count: 1 }
    ]
  },
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

const values = new Map<string, ValuesResponse>([
  [
    "city",
    {
      kind: "columnValues",
      revision: 0,
      viewRequestId: "values-city",
      column: "city",
      values: [
        { value: "Berlin", count: 2 },
        { value: "Milan", count: 1 }
      ],
      hasMore: true
    }
  ]
]);

describe("FilterPanel", () => {
  it("renders its loading state without metadata", () => {
    render(
      <FilterPanel
        metadata={undefined}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        onApply={() => undefined}
        onRequestValues={() => undefined}
      />
    );
    expect(screen.getByText("Preparing filters...")).toBeInTheDocument();
  });

  it("builds advanced values, predicates, sorts, and clear actions", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    const model: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "city",
          type: "string",
          logic: "and",
          valueFilter: {
            kind: "values",
            selectedValues: ["Berlin"],
            includeNulls: false,
            includeNaN: false,
            search: ""
          },
          predicates: [{ kind: "predicate", operator: "contains", value: "er" }]
        }
      ],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    render(
      <FilterPanel
        metadata={metadata}
        model={model}
        values={values}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    fireEvent.change(screen.getByLabelText("Across columns"), { target: { value: "or" } });
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ logic: "or" }));
    fireEvent.change(screen.getByPlaceholderText("Search values"), { target: { value: "mil" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    expect(onRequestValues).toHaveBeenCalledWith("city", "mil");
    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    expect(screen.getByText(/More values available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Berlin/ }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ valueFilter: expect.objectContaining({ selectedValues: [] }) })]
      })
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Milan/ }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({ valueFilter: expect.objectContaining({ selectedValues: ["Berlin", "Milan"] }) })
        ]
      })
    );

    fireEvent.change(screen.getByLabelText("Condition combination"), { target: { value: "or" } });
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [expect.objectContaining({ logic: "or" })] })
    );

    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "between" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("And"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({
            predicates: expect.arrayContaining([
              expect.objectContaining({ operator: "between", value: 10, secondValue: 20 })
            ])
          })
        ]
      })
    );

    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "isNull" } });
    expect(screen.queryByPlaceholderText("Value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));

    fireEvent.change(screen.getByLabelText("Sort direction"), { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: expect.arrayContaining([expect.objectContaining({ direction: "desc" })]) })
    );
    expect(screen.getByText("sales desc")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear column" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onApply).toHaveBeenLastCalledWith({ filters: [], sort: [] });
    fireEvent.click(screen.getByRole("button", { name: "Use basic filters" }));
    expect(screen.getByRole("button", { name: "Use advanced filters" })).toBeInTheDocument();
  });

  it("handles an empty schema without dispatching invalid filters", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    render(
      <FilterPanel
        metadata={{ ...metadata, schema: [], shape: { rows: 0, columns: 0 }, filteredShape: { rows: 0, columns: 0 } }}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    expect(screen.getByPlaceholderText("Search values")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeDisabled();
    expect(screen.getByLabelText("Condition combination")).toBeDisabled();
    expect(screen.getByLabelText("Predicate operator")).toBeDisabled();
    expect(screen.getByPlaceholderText("Value")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear column" })).toBeDisabled();

    fireEvent.click(screen.getByText("SORTS"));
    for (const select of screen.getAllByLabelText("Column")) {
      expect(select).toBeDisabled();
      expect(select).toHaveValue("");
    }
    expect(screen.getByLabelText("Sort direction")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add sort" })).toBeDisabled();

    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    fireEvent.change(screen.getByLabelText("Condition combination"), { target: { value: "or" } });
    fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear column" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onRequestValues).not.toHaveBeenCalled();
  });

  it("disables every filter action while a foreground mutation is pending", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={values}
        defaultAdvanced={true}
        disabled={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use basic filters" })).toBeDisabled();
    expect(screen.getByLabelText("Across columns")).toBeDisabled();
    expect(screen.getByPlaceholderText("Search values")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Berlin/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear column" })).toBeDisabled();
    fireEvent.click(screen.getByText("SORTS"));
    expect(screen.getByLabelText("Sort direction")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add sort" })).toBeDisabled();

    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Berlin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onRequestValues).not.toHaveBeenCalled();
  });

  it("keeps a selected non-first column by schema ID through rename and emits its current name", async () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    const { rerender } = render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        activeColumn="city"
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );
    const sortDisclosure = screen.getByText("SORTS").closest("details");
    if (!sortDisclosure) throw new Error("Expected the sort disclosure.");
    fireEvent.click(screen.getByText("SORTS"));
    expect(sortDisclosure).toHaveAttribute("open");
    fireEvent.change(screen.getAllByLabelText("Column")[0], { target: { value: "c:1" } });
    for (const select of screen.getAllByLabelText("Column")) {
      expect(select).toHaveValue("c:1");
      expect(select).toHaveDisplayValue("sales");
    }
    fireEvent.change(screen.getByLabelText("Sort direction"), { target: { value: "desc" } });
    expect(sortDisclosure).toHaveAttribute("open");

    const renamedMetadata = {
      ...metadata,
      schema: metadata.schema.map((column) => (column.id === "c:1" ? { ...column, name: "revenue" } : column))
    };
    rerender(
      <FilterPanel
        metadata={renamedMetadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        activeColumn="city"
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );
    await waitFor(() => {
      for (const select of screen.getAllByLabelText("Column")) {
        expect(select).toHaveValue("c:1");
        expect(select).toHaveDisplayValue("revenue");
      }
    });
    expect(sortDisclosure).toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    expect(onRequestValues).toHaveBeenLastCalledWith("revenue", "");
    fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sort: [expect.objectContaining({ column: "revenue", direction: "desc" })]
      })
    );
  });
});

describe("SummaryPanel", () => {
  const summaries: ColumnSummary[] = [
    {
      column: "sales",
      type: "float",
      rawType: "float",
      totalCount: 4,
      nullCount: 1,
      nanCount: 2,
      distinctCount: 2,
      topValues: [
        { value: "12", count: 2 },
        { value: "10", count: 1 }
      ],
      numeric: { min: 10, max: 12, mean: Number.NaN, median: 12 }
    }
  ];

  it("renders loading, empty, missing, numeric, and top-value summaries", () => {
    const { rerender } = render(<SummaryPanel metadata={undefined} summaries={[]} schemaByName={new Map()} />);
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByText("Profiling exact missing values…")).toBeInTheDocument();
    expect(screen.getByText("No summary data yet.")).toBeInTheDocument();

    rerender(
      <SummaryPanel
        metadata={metadata}
        summaries={summaries}
        schemaByName={new Map(metadata.schema.map((column) => [column.name, column]))}
      />
    );
    expect(screen.getByText("4 rows x 2 columns")).toBeInTheDocument();
    expect(screen.getByText("Float64")).toBeInTheDocument();
    expect(screen.getByText("n/a")).toBeInTheDocument();
    expect(screen.getAllByText("sales")).toHaveLength(2);
    expect(screen.getByText("Missing", { selector: "dt" }).nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("12", { selector: ".topValues span" })).toBeInTheDocument();
  });
});
