import { describe, expect, it } from "vitest";
import type { FilterModel, PredicateOperator } from "../shared/filterModel";
import type { CellValue, DataRow, SessionMetadata } from "../shared/protocol";
import { applySnapshotFilters, snapshotColumnValues, snapshotSummaries } from "../webviews/snapshotModel";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "snapshot",
  revision: 4,
  backend: "polars",
  mode: "viewing",
  source: { kind: "notebookOutput", label: "saved output" },
  capabilities: {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  },
  shape: { rows: 5, columns: 3 },
  filteredShape: { rows: 5, columns: 3 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:sales", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true },
    { id: "c:tag", name: "tag", position: 2, rawType: "String", type: "string", nullable: true }
  ]
};

const rows: DataRow[] = [
  row(0, stringCell("Berlin"), numberCell(12), stringCell("b")),
  row(1, stringCell("Milan"), numberCell(10), stringCell("a")),
  row(2, stringCell("Paris"), nullCell(), stringCell("a")),
  row(3, stringCell("Berlin"), numberCell(12), nanCell()),
  row(4, stringCell("Tokyo"), numberCell(8), nullCell())
];

describe("saved notebook snapshot model", () => {
  it.each<[PredicateOperator, unknown, unknown, number]>([
    ["equals", "berlin", undefined, 2],
    ["notEquals", "Berlin", undefined, 3],
    ["contains", "li", undefined, 2],
    ["startsWith", "To", undefined, 1],
    ["endsWith", "is", undefined, 1],
    ["gt", 10, undefined, 2],
    ["gte", 12, undefined, 2],
    ["lt", 10, undefined, 1],
    ["lte", 10, undefined, 2],
    ["between", 9, 11, 1],
    ["isNull", undefined, undefined, 1],
    ["isNotNull", undefined, undefined, 4],
    ["isNaN", undefined, undefined, 1],
    ["isNotNaN", undefined, undefined, 4]
  ])("applies %s predicates", (operator, value, secondValue, expected) => {
    const column = ["gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"].includes(operator)
      ? "sales"
      : operator === "isNaN" || operator === "isNotNaN"
        ? "tag"
        : "city";
    const model: FilterModel = {
      filters: [
        {
          column,
          type: column === "city" ? "string" : "float",
          predicates: [{ kind: "predicate", operator, value, secondValue }]
        }
      ],
      sort: []
    };
    expect(applySnapshotFilters(metadata, rows, model)).toHaveLength(expected);
  });

  it("combines value, null, NaN, unknown-column, AND, and OR filters", () => {
    const valueFilter = {
      kind: "values" as const,
      selectedValues: ["Berlin"],
      includeNulls: true,
      includeNaN: true,
      search: ""
    };
    expect(
      applySnapshotFilters(metadata, rows, {
        logic: "or",
        filters: [
          { column: "city", type: "string", valueFilter, predicates: [] },
          { column: "missing", type: "string", predicates: [] }
        ],
        sort: []
      })
    ).toHaveLength(5);
    expect(
      applySnapshotFilters(metadata, rows, {
        logic: "and",
        filters: [
          { column: "city", type: "string", valueFilter, predicates: [] },
          {
            column: "sales",
            type: "float",
            logic: "or",
            predicates: [
              { kind: "predicate", operator: "lt", value: 9 },
              { kind: "predicate", operator: "gt", value: 11 }
            ]
          }
        ],
        sort: []
      })
    ).toHaveLength(2);
    expect(applySnapshotFilters(metadata, rows, { logic: "or", filters: [], sort: [] })).toEqual(rows);
  });

  it("sorts numeric, string, null, missing-cell, and stable ties", () => {
    const missingCell = row(5, stringCell("Zurich"), numberCell(12));
    const sorted = applySnapshotFilters(metadata, [...rows, missingCell], {
      filters: [],
      sort: [
        { column: "sales", direction: "desc", nulls: "last" },
        { column: "city", direction: "asc", nulls: "last" }
      ]
    });
    expect(sorted.map((item) => item.values[0]?.display)).toEqual([
      "Berlin",
      "Berlin",
      "Zurich",
      "Milan",
      "Tokyo",
      "Paris"
    ]);
    const textSorted = applySnapshotFilters(metadata, rows, {
      filters: [],
      sort: [{ column: "city", direction: "asc", nulls: "last" }]
    });
    expect(textSorted.map((item) => item.values[0]?.display)).toEqual(["Berlin", "Berlin", "Milan", "Paris", "Tokyo"]);
    expect(applySnapshotFilters(metadata, rows, { filters: [], sort: [] })).toEqual(rows);
  });

  it("counts searched values, excludes null/NaN/missing cells, and caps distinct results", () => {
    expect(snapshotColumnValues(metadata, rows, { filters: [], sort: [] }, "city", "ber")).toEqual({
      kind: "columnValues",
      revision: 4,
      column: "city",
      values: [{ value: "Berlin", count: 2 }],
      hasMore: false
    });
    expect(snapshotColumnValues(metadata, rows, { filters: [], sort: [] }, "tag").values).toEqual([
      { value: "a", count: 2 },
      { value: "b", count: 1 }
    ]);
    const manyRows = Array.from({ length: 101 }, (_, index) =>
      row(index, stringCell(`city-${String(index).padStart(3, "0")}`), numberCell(index), stringCell("x"))
    );
    const many = snapshotColumnValues(metadata, manyRows, { filters: [], sort: [] }, "city");
    expect(many.values).toHaveLength(100);
    expect(many.hasMore).toBe(true);
  });

  it("profiles text and numeric snapshot columns with odd/even medians", () => {
    const summaries = snapshotSummaries(metadata, rows);
    expect(summaries[0]).toMatchObject({ distinctCount: 4, nullCount: 0, nanCount: 0 });
    expect(summaries[0]?.topValues[0]).toEqual({ value: "Berlin", count: 2 });
    expect(summaries[0]?.numeric).toBeUndefined();
    expect(summaries[1]).toMatchObject({ nullCount: 1, distinctCount: 3 });
    expect(summaries[1]?.numeric).toEqual({ min: 8, max: 12, mean: 10.5, median: 11 });
    expect(summaries[2]).toMatchObject({ nullCount: 1, nanCount: 1, distinctCount: 2 });

    const odd = snapshotSummaries(metadata, rows.slice(0, 3));
    expect(odd[1]?.numeric?.median).toBe(11);
  });
});

function row(rowNumber: number, ...values: CellValue[]): DataRow {
  return { id: `r:${rowNumber}`, rowNumber, values };
}

function stringCell(value: string): CellValue {
  return { kind: "string", raw: value, display: value, isNull: false, isNaN: false };
}

function numberCell(value: number): CellValue {
  return { kind: "number", raw: value, display: String(value), isNull: false, isNaN: false };
}

function nullCell(): CellValue {
  return { kind: "null", raw: null, display: "", isNull: true, isNaN: false };
}

function nanCell(): CellValue {
  return { kind: "nan", raw: "NaN", display: "NaN", isNull: false, isNaN: true };
}
