import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FilterModel, PredicateOperator } from "../shared/filterModel";
import type { CellValue, DataRow, SessionMetadata } from "../shared/protocol";
import {
  applySnapshotFilters,
  snapshotColumnValues,
  snapshotDatasetStats,
  snapshotPage,
  snapshotSummaries
} from "../shared/snapshotModel";

interface ViewLiteralCase {
  type: SessionMetadata["schema"][number]["type"];
  value: string;
}

const viewLiteralContract = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures", "view-literal-contract.json"), "utf8")
) as { accepted: ViewLiteralCase[]; rejected: ViewLiteralCase[] };

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

const duplicateMetadata: SessionMetadata = {
  ...metadata,
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  schema: [
    { id: "c:left", name: "duplicate", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:right", name: "duplicate", position: 1, rawType: "Int64", type: "integer", nullable: false }
  ]
};

const duplicateRows: DataRow[] = [row(0, stringCell("a"), numberCell(1)), row(1, stringCell("b"), numberCell(2))];

describe("saved notebook snapshot model", () => {
  it.each(viewLiteralContract.accepted)("accepts portable $type view literal $value", ({ type, value }) => {
    expect(() => applyLiteralPredicate(type, value)).not.toThrow();
  });

  it.each(viewLiteralContract.rejected)("rejects non-portable $type view literal $value", ({ type, value }) => {
    expect(() => applyLiteralPredicate(type, value)).toThrow();
  });

  it("validates every operator and literal before evaluating empty or all-null captures", () => {
    const integerMetadata = singleColumnMetadata("integer", "Int64", 0);
    expect(() =>
      applySnapshotFilters(integerMetadata, [], {
        filters: [
          {
            column: "value",
            type: "integer",
            predicates: [{ kind: "predicate", operator: "equals", value: "1_000" }]
          }
        ],
        sort: []
      })
    ).toThrow("optional sign and decimal digits");

    expect(() =>
      applySnapshotFilters(
        { ...integerMetadata, shape: { rows: 1, columns: 1 }, filteredShape: { rows: 1, columns: 1 } },
        [row(0, nullCell())],
        {
          filters: [
            {
              column: "value",
              type: "integer",
              predicates: [{ kind: "predicate", operator: "between", value: "1", secondValue: "bad" }]
            }
          ],
          sort: []
        }
      )
    ).toThrow("optional sign and decimal digits");

    const structMetadata = singleColumnMetadata("struct", "Struct", 0);
    expect(() =>
      applySnapshotFilters(structMetadata, [], {
        filters: [
          {
            column: "value",
            type: "struct",
            predicates: [{ kind: "predicate", operator: "equals", value: "{}" }]
          }
        ],
        sort: []
      })
    ).toThrow("predicate equals is unavailable");

    expect(() =>
      applySnapshotFilters(singleColumnMetadata("string", "object", 0), [], {
        filters: [
          {
            column: "value",
            type: "string",
            valueFilter: {
              kind: "values",
              selectedValues: [
                {
                  kind: "typedSelection",
                  version: 2,
                  columnType: "string",
                  cell: integerCell(1)
                }
              ],
              includeNulls: false,
              includeNaN: false
            },
            predicates: []
          }
        ],
        sort: []
      })
    ).toThrow("unsupported version");
  });

  it.each<[PredicateOperator, unknown, unknown, number]>([
    ["equals", "Berlin", undefined, 2],
    ["equals", "berlin", undefined, 0],
    ["notEquals", "Berlin", undefined, 3],
    ["notEquals", "berlin", undefined, 5],
    ["contains", "LI", undefined, 2],
    ["startsWith", "To", undefined, 1],
    ["startsWith", "to", undefined, 0],
    ["endsWith", "is", undefined, 1],
    ["endsWith", "IS", undefined, 0],
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
    const column = ["gt", "gte", "lt", "lte", "between", "isNull", "isNotNull", "isNaN", "isNotNaN"].includes(operator)
      ? "sales"
      : "city";
    const predicateRows =
      operator === "isNaN" || operator === "isNotNaN"
        ? rows.map((item, index) =>
            index === 3 ? { ...item, values: [item.values[0]!, nanCell(), item.values[2]!] } : item
          )
        : rows;
    const model: FilterModel = {
      filters: [
        {
          column,
          type: column === "sales" ? "float" : "string",
          predicates: [{ kind: "predicate", operator, value, secondValue }]
        }
      ],
      sort: []
    };
    expect(applySnapshotFilters(metadata, predicateRows, model)).toHaveLength(expected);
  });

  it("combines value, null, NaN, AND, and OR filters", () => {
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
          {
            column: "sales",
            type: "float",
            predicates: [{ kind: "predicate", operator: "lt", value: 9 }]
          }
        ],
        sort: []
      })
    ).toHaveLength(3);
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

  it("never lets selected display text stand in for null or NaN inclusion", () => {
    const selectedRows = [row(0, stringCell("NaN")), row(1, nanCell()), row(2, nullCell())];
    const selectedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 3, columns: 1 },
      filteredShape: { rows: 3, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "String", type: "string", nullable: true }]
    };
    const apply = (includeNulls: boolean, includeNaN: boolean) =>
      applySnapshotFilters(selectedMetadata, selectedRows, {
        filters: [
          {
            column: "value",
            type: "string",
            valueFilter: {
              kind: "values",
              selectedValues: ["NaN", ""],
              includeNulls,
              includeNaN,
              search: ""
            },
            predicates: []
          }
        ],
        sort: []
      }).map((item) => item.rowNumber);

    expect(apply(false, false)).toEqual([0]);
    expect(apply(true, false)).toEqual([0, 2]);
    expect(apply(false, true)).toEqual([0, 1]);
    expect(apply(true, true)).toEqual([0, 1, 2]);
  });

  it("uses Pandas numeric equality without collapsing mixed semantic-string selections", () => {
    const mixedMetadata = singleColumnMetadata("string", "object", 5);
    const mixedRows = [
      row(0, integerCell(1)),
      row(1, numberCell(1)),
      row(2, booleanCell(true)),
      row(3, decimalCell("1.00")),
      row(4, stringCell("1"))
    ];
    const model: FilterModel = {
      filters: [
        {
          column: "value",
          type: "string",
          valueFilter: {
            kind: "values",
            selectedValues: ["1"],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: []
    };

    expect(applySnapshotFilters(mixedMetadata, mixedRows, model).map((item) => item.rowNumber)).toEqual([4]);

    const values = snapshotColumnValues(mixedMetadata, mixedRows, { filters: [], sort: [] }, "value").values;
    expect(values).toEqual([
      {
        value: "1",
        count: 4,
        selectionValue: {
          kind: "typedSelection",
          version: 1,
          columnType: "string",
          cell: integerCell(1)
        }
      },
      { value: "1", count: 1 }
    ]);
    expect(
      applySnapshotFilters(mixedMetadata, mixedRows, {
        filters: [
          {
            column: "value",
            type: "string",
            valueFilter: {
              kind: "values",
              selectedValues: [values[0]!.selectionValue],
              includeNulls: false,
              includeNaN: false
            },
            predicates: []
          }
        ],
        sort: []
      }).map((item) => item.rowNumber)
    ).toEqual([0, 1, 2, 3]);
    expect(snapshotSummaries(mixedMetadata, mixedRows)[0]).toMatchObject({
      distinctCount: 2,
      topValues: [
        { value: "1", count: 4 },
        { value: "1", count: 1 }
      ]
    });
    expect(snapshotDatasetStats(mixedMetadata, mixedRows).duplicateRows).toBe(3);
  });

  it("uses portable ASCII case folding for literal search and contains", () => {
    const textMetadata = singleColumnMetadata("string", "String", 4);
    const textRows = [
      row(0, stringCell("İ")),
      row(1, stringCell("I")),
      row(2, stringCell("ſ")),
      row(3, stringCell("S"))
    ];

    expect(
      snapshotColumnValues(textMetadata, textRows, { filters: [], sort: [] }, "value", "i").values.map(
        (item) => item.value
      )
    ).toEqual(["I"]);
    expect(
      applySnapshotFilters(textMetadata, textRows, {
        filters: [
          { column: "value", type: "string", predicates: [{ kind: "predicate", operator: "contains", value: "s" }] }
        ],
        sort: []
      }).map((item) => item.rowNumber)
    ).toEqual([3]);
  });

  it("requires float NaN selection to use the explicit includeNaN option", () => {
    expect(() =>
      applySnapshotFilters(metadata, rows, {
        filters: [
          {
            column: "sales",
            type: "float",
            valueFilter: {
              kind: "values",
              selectedValues: ["NaN"],
              includeNulls: false,
              includeNaN: false
            },
            predicates: []
          }
        ],
        sort: []
      })
    ).toThrow("explicit includeNaN");
  });

  it("sorts numeric, string, null, and stable ties", () => {
    const sorted = applySnapshotFilters(metadata, rows, {
      filters: [],
      sort: [
        { column: "sales", direction: "desc", nulls: "last" },
        { column: "city", direction: "asc", nulls: "last" }
      ]
    });
    expect(sorted.map((item) => item.values[0]?.display)).toEqual(["Berlin", "Berlin", "Milan", "Tokyo", "Paris"]);
    const textSorted = applySnapshotFilters(metadata, rows, {
      filters: [],
      sort: [{ column: "city", direction: "asc", nulls: "last" }]
    });
    expect(textSorted.map((item) => item.values[0]?.display)).toEqual(["Berlin", "Berlin", "Milan", "Paris", "Tokyo"]);
    expect(applySnapshotFilters(metadata, rows, { filters: [], sort: [] })).toEqual(rows);
  });

  it("places nulls independently from sort direction while retaining stable ties", () => {
    const sorted = applySnapshotFilters(metadata, rows, {
      filters: [],
      sort: [
        { column: "sales", direction: "desc", nulls: "first" },
        { column: "city", direction: "desc", nulls: "last" }
      ]
    });
    expect(sorted.map((item) => item.values[0]?.display)).toEqual(["Paris", "Berlin", "Berlin", "Milan", "Tokyo"]);
    expect(sorted[1]?.rowNumber).toBe(0);
    expect(sorted[2]?.rowNumber).toBe(3);
  });

  it.each([
    ["pandas", "asc", "first", [1, 2, 4, 3, 0]],
    ["pandas", "asc", "last", [3, 0, 1, 2, 4]],
    ["pandas", "desc", "first", [1, 2, 4, 0, 3]],
    ["pandas", "desc", "last", [0, 3, 1, 2, 4]],
    ["polars", "asc", "first", [2, 3, 0, 1, 4]],
    ["polars", "asc", "last", [3, 0, 1, 4, 2]],
    ["polars", "desc", "first", [2, 1, 4, 0, 3]],
    ["polars", "desc", "last", [1, 4, 0, 3, 2]],
    ["duckdb", "asc", "first", [2, 3, 0, 1, 4]],
    ["duckdb", "desc", "last", [1, 4, 0, 3, 2]]
  ] as const)("matches %s float ordering for %s/nulls-%s", (backend, direction, nulls, expected) => {
    const floatMetadata: SessionMetadata = {
      ...metadata,
      backend,
      shape: { rows: 5, columns: 1 },
      filteredShape: { rows: 5, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "Float64", type: "float", nullable: true }]
    };
    const floatRows = [
      row(0, numberCell(2)),
      row(1, nanCell()),
      row(2, nullCell()),
      row(3, numberCell(1)),
      row(4, nanCell())
    ];

    expect(
      applySnapshotFilters(floatMetadata, floatRows, {
        filters: [],
        sort: [{ column: "value", direction, nulls }]
      }).map((item) => item.rowNumber)
    ).toEqual(expected);
  });

  it("sorts engine-typed values exactly instead of sorting their display strings", () => {
    const typedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 7 },
      filteredShape: { rows: 4, columns: 7 },
      schema: [
        { id: "c:int", name: "int", position: 0, rawType: "Int128", type: "integer", nullable: false },
        { id: "c:decimal", name: "decimal", position: 1, rawType: "Decimal", type: "decimal", nullable: false },
        { id: "c:boolean", name: "boolean", position: 2, rawType: "Boolean", type: "boolean", nullable: false },
        { id: "c:date", name: "date", position: 3, rawType: "Date", type: "date", nullable: false },
        { id: "c:datetime", name: "datetime", position: 4, rawType: "Datetime", type: "datetime", nullable: false },
        { id: "c:duration", name: "duration", position: 5, rawType: "Duration", type: "duration", nullable: false },
        { id: "c:text", name: "text", position: 6, rawType: "String", type: "string", nullable: false }
      ]
    };
    const typedRows = [
      row(
        0,
        integerCell("10"),
        decimalCell("10.01"),
        booleanCell(true),
        dateCell("2024-01-10"),
        datetimeCell("2024-01-01T12:00:00+02:00"),
        durationCell(10),
        stringCell("z")
      ),
      row(
        1,
        integerCell("2"),
        decimalCell("2"),
        booleanCell(false),
        dateCell("2024-01-02"),
        datetimeCell("2024-01-01T09:30:00Z"),
        durationCell(2),
        stringCell("A")
      ),
      row(
        2,
        integerCell("900719925474099312345"),
        decimalCell("1.0000000000000000001"),
        booleanCell(true),
        dateCell("2025-01-01"),
        datetimeCell("2024-01-01T10:00:00.000000001Z"),
        durationCell(3_600),
        stringCell("ä")
      ),
      row(
        3,
        integerCell("-900719925474099312345"),
        decimalCell("-0.5"),
        booleanCell(false),
        dateCell("2023-12-31"),
        datetimeCell("2023-12-31T23:59:59Z"),
        durationCell(-1),
        stringCell("😀")
      )
    ];
    const sortedRows = (column: string) =>
      applySnapshotFilters(typedMetadata, typedRows, {
        filters: [],
        sort: [{ column, direction: "asc", nulls: "last" }]
      }).map((item) => item.rowNumber);

    expect(sortedRows("int")).toEqual([3, 1, 0, 2]);
    expect(sortedRows("decimal")).toEqual([3, 2, 1, 0]);
    expect(sortedRows("boolean")).toEqual([1, 3, 0, 2]);
    expect(sortedRows("date")).toEqual([3, 1, 0, 2]);
    expect(sortedRows("datetime")).toEqual([3, 1, 0, 2]);
    expect(sortedRows("duration")).toEqual([3, 1, 0, 2]);
    expect(sortedRows("text")).toEqual([1, 0, 2, 3]);
  });

  it("sorts canonical time-only typed values chronologically", () => {
    const timeMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 3, columns: 1 },
      filteredShape: { rows: 3, columns: 1 },
      schema: [{ id: "c:time", name: "time", position: 0, rawType: "Time", type: "datetime", nullable: false }]
    };
    const timeRows = [
      row(0, datetimeCell("12:00:00")),
      row(1, datetimeCell("09:30:00.000000001")),
      row(2, datetimeCell("09:30:00"))
    ];
    expect(
      applySnapshotFilters(timeMetadata, timeRows, {
        filters: [],
        sort: [{ column: "time", direction: "asc", nulls: "last" }]
      }).map((item) => item.rowNumber)
    ).toEqual([2, 1, 0]);
  });

  it("normalizes persisted boolean predicate text exactly like live engines", () => {
    const booleanMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [{ id: "c:flag", name: "flag", position: 0, rawType: "Boolean", type: "boolean", nullable: false }]
    };
    expect(
      applySnapshotFilters(booleanMetadata, [row(0, booleanCell(true)), row(1, booleanCell(false))], {
        filters: [
          {
            column: "flag",
            type: "boolean",
            predicates: [{ kind: "predicate", operator: "equals", value: " TrUe " }]
          }
        ],
        sort: []
      }).map((item) => item.rowNumber)
    ).toEqual([0]);
  });

  it("uses exact scale-independent decimal identity for predicates, counts, and duplicates", () => {
    const decimalMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 1 },
      filteredShape: { rows: 4, columns: 1 },
      schema: [{ id: "c:decimal", name: "decimal", position: 0, rawType: "Decimal", type: "decimal", nullable: false }]
    };
    const decimalRows = [
      row(0, decimalCell("1.0")),
      row(1, decimalCell("1.00")),
      row(2, decimalCell("900719925474099312345.0000000000000000001")),
      row(3, decimalCell("900719925474099312345.0000000000000000002"))
    ];
    const filtered = (operator: "equals" | "gt", value: string) =>
      applySnapshotFilters(decimalMetadata, decimalRows, {
        filters: [
          {
            column: "decimal",
            type: "decimal",
            predicates: [{ kind: "predicate", operator, value }]
          }
        ],
        sort: []
      }).map((item) => item.rowNumber);

    expect(filtered("equals", "1.000")).toEqual([0, 1]);
    expect(filtered("gt", "900719925474099312345.0000000000000000001")).toEqual([3]);
    expect(snapshotSummaries(decimalMetadata, decimalRows)[0]).toMatchObject({
      distinctCount: 3,
      topValues: [
        { value: "1.0", count: 2 },
        { value: "900719925474099312345.0000000000000000001", count: 1 },
        { value: "900719925474099312345.0000000000000000002", count: 1 }
      ]
    });
    expect(snapshotColumnValues(decimalMetadata, decimalRows, { filters: [], sort: [] }, "decimal").values).toEqual([
      { value: "1.0", count: 2 },
      { value: "900719925474099312345.0000000000000000001", count: 1 },
      { value: "900719925474099312345.0000000000000000002", count: 1 }
    ]);
    expect(
      applySnapshotFilters(decimalMetadata, decimalRows, {
        filters: [
          {
            column: "decimal",
            type: "decimal",
            valueFilter: {
              kind: "values",
              selectedValues: ["1.0"],
              includeNulls: false,
              includeNaN: false
            },
            predicates: []
          }
        ],
        sort: []
      }).map((item) => item.rowNumber)
    ).toEqual([0, 1]);
    expect(snapshotDatasetStats(decimalMetadata, decimalRows).duplicateRows).toBe(1);
  });

  it("returns an exact bounded two-dimensional page without changing captured rows", () => {
    const original = structuredClone(rows);
    const result = snapshotPage(
      metadata,
      rows,
      {
        filters: [{ column: "sales", type: "float", predicates: [{ kind: "predicate", operator: "gte", value: 10 }] }],
        sort: [{ column: "city", direction: "desc", nulls: "last" }]
      },
      { offset: 1, limit: 2, columnOffset: 1, columnLimit: 2 }
    );

    expect(result).toEqual({
      offset: 1,
      limit: 2,
      totalRows: 3,
      columnIds: ["c:sales", "c:tag"],
      rows: [
        { id: "r:0", rowNumber: 1, values: [numberCell(12), stringCell("b")] },
        { id: "r:3", rowNumber: 2, values: [numberCell(12), nanCell()] }
      ]
    });
    expect(rows).toEqual(original);
  });

  it("keeps out-of-range projections and pages bounded and schema-aligned", () => {
    expect(
      snapshotPage(
        metadata,
        rows,
        { filters: [], sort: [] },
        { offset: 50, limit: 10, columnOffset: 50, columnLimit: 16 }
      )
    ).toEqual({ offset: 50, limit: 10, totalRows: 5, columnIds: [], rows: [] });
  });

  it("projects duplicate-name columns by stable ID when no name-addressed query is present", () => {
    expect(
      snapshotPage(
        duplicateMetadata,
        duplicateRows,
        { filters: [], sort: [] },
        { offset: 0, limit: 2, columnOffset: 0, columnLimit: 2 }
      )
    ).toEqual({
      offset: 0,
      limit: 2,
      totalRows: 2,
      columnIds: ["c:left", "c:right"],
      rows: [
        { id: "r:0", rowNumber: 0, values: [stringCell("a"), numberCell(1)] },
        { id: "r:1", rowNumber: 1, values: [stringCell("b"), numberCell(2)] }
      ]
    });
  });

  it("fails closed for missing, ambiguous, and type-mismatched page lookups", () => {
    const window = { offset: 0, limit: 2, columnOffset: 0, columnLimit: 2 };

    expect(() =>
      snapshotPage(
        metadata,
        rows,
        { filters: [{ column: "missing", type: "string", predicates: [] }], sort: [] },
        window
      )
    ).toThrow('Snapshot filter column "missing" is not present in the captured schema.');
    expect(() =>
      snapshotPage(
        duplicateMetadata,
        duplicateRows,
        { filters: [{ column: "duplicate", type: "string", predicates: [] }], sort: [] },
        window
      )
    ).toThrow('Snapshot filter column "duplicate" is ambiguous because 2 captured columns share that name.');
    expect(() =>
      snapshotPage(metadata, rows, { filters: [{ column: "sales", type: "string", predicates: [] }], sort: [] }, window)
    ).toThrow('Snapshot filter column "sales" declares type "string", but the captured schema type is "float".');
    expect(() =>
      snapshotPage(
        metadata,
        rows,
        { filters: [], sort: [{ column: "missing", direction: "asc", nulls: "last" }] },
        window
      )
    ).toThrow('Snapshot sort column "missing" is not present in the captured schema.');
    expect(() =>
      snapshotPage(
        duplicateMetadata,
        duplicateRows,
        { filters: [], sort: [{ column: "duplicate", direction: "asc", nulls: "last" }] },
        window
      )
    ).toThrow('Snapshot sort column "duplicate" is ambiguous because 2 captured columns share that name.');
  });

  it("rejects a captured row that omits even an unprojected schema value", () => {
    const incomplete = row(0, stringCell("Berlin"), numberCell(12));
    const window = { offset: 0, limit: 1, columnOffset: 0, columnLimit: 1 };

    expect(() => snapshotPage(metadata, [incomplete], { filters: [], sort: [] }, window)).toThrow(
      "complete saved schema"
    );
    expect(() => snapshotDatasetStats(metadata, [incomplete])).toThrow("complete saved schema");
    expect(() => snapshotSummaries(metadata, [incomplete])).toThrow("complete saved schema");
    expect(() => snapshotColumnValues(metadata, [incomplete], { filters: [], sort: [] }, "city")).toThrow(
      "complete saved schema"
    );
  });

  it.each([
    { offset: -1, limit: 1, columnOffset: 0, columnLimit: 1 },
    { offset: 0.5, limit: 1, columnOffset: 0, columnLimit: 1 },
    { offset: 0, limit: 0, columnOffset: 0, columnLimit: 1 },
    { offset: 0, limit: 10_001, columnOffset: 0, columnLimit: 1 },
    { offset: 0, limit: 1, columnOffset: -1, columnLimit: 1 },
    { offset: 0, limit: 1, columnOffset: 0, columnLimit: 0 },
    { offset: 0, limit: 1, columnOffset: 0, columnLimit: 257 }
  ])("rejects an invalid snapshot page window %#", (window) => {
    expect(() => snapshotPage(metadata, rows, { filters: [], sort: [] }, window)).toThrow(RangeError);
  });

  it("counts searched values, excludes null/NaN/missing cells, and caps distinct results", () => {
    expect(snapshotColumnValues(metadata, rows, { filters: [], sort: [] }, "city", "ber")).toEqual({
      kind: "columnValues",
      revision: 4,
      viewRequestId: "snapshot",
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

    const limited = snapshotColumnValues(metadata, rows, { filters: [], sort: [] }, "city", undefined, "values-1", 1);
    expect(limited).toMatchObject({
      viewRequestId: "values-1",
      values: [{ value: "Berlin", count: 2 }],
      hasMore: true
    });
    for (const invalidLimit of [0, 10_001, 1.5]) {
      expect(() =>
        snapshotColumnValues(metadata, rows, { filters: [], sort: [] }, "city", undefined, "bad", invalidLimit)
      ).toThrow(RangeError);
    }
  });

  it("fails closed for missing and ambiguous column-value targets and invalid view lookups", () => {
    expect(() => snapshotColumnValues(metadata, rows, { filters: [], sort: [] }, "missing")).toThrow(
      'Snapshot values column "missing" is not present in the captured schema.'
    );
    expect(() =>
      snapshotColumnValues(duplicateMetadata, duplicateRows, { filters: [], sort: [] }, "duplicate")
    ).toThrow('Snapshot values column "duplicate" is ambiguous because 2 captured columns share that name.');
    expect(() =>
      snapshotColumnValues(
        metadata,
        rows,
        { filters: [{ column: "sales", type: "string", predicates: [] }], sort: [] },
        "city"
      )
    ).toThrow('Snapshot filter column "sales" declares type "string", but the captured schema type is "float".');
    expect(() =>
      snapshotColumnValues(
        metadata,
        rows,
        { filters: [], sort: [{ column: "missing", direction: "asc", nulls: "last" }] },
        "city"
      )
    ).toThrow('Snapshot sort column "missing" is not present in the captured schema.');
  });

  it("profiles text and numeric snapshot columns with odd/even medians", () => {
    const summaries = snapshotSummaries(metadata, rows);
    expect(summaries[0]).toMatchObject({ distinctCount: 4, nullCount: 0, nanCount: 0 });
    expect(summaries[0]?.topValues[0]).toEqual({ value: "Berlin", count: 2 });
    expect(summaries[0]?.numeric).toBeUndefined();
    expect(summaries[1]).toMatchObject({ nullCount: 1, distinctCount: 3 });
    expect(summaries[1]?.numeric).toMatchObject({ min: 8, max: 12, mean: 10.5, median: 11 });
    expect(summaries[1]?.numeric?.std).toBeCloseTo(1.9148542155);
    expect(summaries[1]?.visualization).toEqual({
      kind: "numeric",
      bins: [
        { min: 8, max: 8 + 4 / 3, count: 1 },
        { min: 8 + 4 / 3, max: 8 + 8 / 3, count: 1 },
        { min: 8 + 8 / 3, max: 12, count: 2 }
      ]
    });
    expect(summaries[2]).toMatchObject({ nullCount: 1, nanCount: 1, distinctCount: 2 });

    const odd = snapshotSummaries(metadata, rows.slice(0, 3));
    expect(odd[1]?.numeric?.median).toBe(11);

    const numericTextRows = [row(0, stringCell("12"), numberCell(1), stringCell("x"))];
    expect(snapshotSummaries(metadata, numericTextRows)[0]?.numeric).toBeUndefined();
  });

  it("keeps infinities in statistics while omitting non-finite results and histogram inputs", () => {
    const infinityMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "Float64", type: "float", nullable: false }]
    };
    const [positive] = snapshotSummaries(infinityMetadata, [row(0, numberCell(1)), row(1, infinityCell(1))]);
    expect(positive?.numeric).toEqual({ min: 1 });
    expect(positive?.visualization).toEqual({
      kind: "numeric",
      bins: [{ min: 1, max: 1, count: 1 }]
    });

    const mixedRows = [
      row(0, numberCell(1)),
      row(1, infinityCell(-1)),
      row(2, infinityCell(1)),
      row(3, nanCell()),
      row(4, nullCell())
    ];
    const [mixed] = snapshotSummaries(
      { ...infinityMetadata, shape: { rows: 5, columns: 1 }, filteredShape: { rows: 5, columns: 1 } },
      mixedRows
    );
    expect(mixed?.numeric).toEqual({ median: 1 });
    expect(mixed?.visualization).toEqual({
      kind: "numeric",
      bins: [{ min: 1, max: 1, count: 1 }]
    });
  });

  it("uses canonical temporal instants for values, distinct counts, and duplicate rows", () => {
    const temporalMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [{ id: "c:when", name: "when", position: 0, rawType: "Datetime", type: "datetime", nullable: false }]
    };
    const temporalRows = [
      row(0, datetimeCell("2024-01-01T12:00:00+02:00")),
      row(1, datetimeCell("2024-01-01T10:00:00Z"))
    ];

    expect(snapshotSummaries(temporalMetadata, temporalRows)[0]).toMatchObject({
      distinctCount: 1,
      topValues: [{ value: "2024-01-01T12:00:00+02:00", count: 2 }]
    });
    expect(snapshotColumnValues(temporalMetadata, temporalRows, { filters: [], sort: [] }, "when").values).toEqual([
      { value: "2024-01-01T12:00:00+02:00", count: 2 }
    ]);
    expect(
      applySnapshotFilters(temporalMetadata, temporalRows, {
        filters: [
          {
            column: "when",
            type: "datetime",
            valueFilter: {
              kind: "values",
              selectedValues: ["2024-01-01T12:00:00+02:00"],
              includeNulls: false,
              includeNaN: false
            },
            predicates: []
          }
        ],
        sort: []
      }).map((item) => item.rowNumber)
    ).toEqual([0, 1]);
    expect(snapshotDatasetStats(temporalMetadata, temporalRows).duplicateRows).toBe(1);
  });

  it.each([
    ["integer", "Int64", integerCell(1)],
    ["integer", "Int128", integerCell("9007199254740993")],
    ["float", "Float64", numberCell(1.5)],
    ["float", "Float64", infinityCell(1)],
    ["float", "Float64", infinityCell(-1)],
    ["boolean", "Boolean", booleanCell(true)],
    ["decimal", "Decimal", decimalCell("1.00")],
    ["datetime", "Datetime", datetimeCell("2024-01-01T12:00:00+02:00")],
    [
      "duration",
      "Duration",
      { kind: "duration", raw: 93_784, display: "1 day, 2:03:04", isNull: false, isNaN: false } as CellValue
    ]
  ] as const)("round-trips a %s column value through value selection", (type, rawType, cell) => {
    const valueMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType, type, nullable: false }]
    };
    const valueRows = [row(0, cell)];
    const response = snapshotColumnValues(valueMetadata, valueRows, { filters: [], sort: [] }, "value");
    expect(response.values).toHaveLength(1);

    expect(
      applySnapshotFilters(valueMetadata, valueRows, {
        filters: [
          {
            column: "value",
            type,
            valueFilter: {
              kind: "values",
              selectedValues: [response.values[0]!.value],
              includeNulls: false,
              includeNaN: false
            },
            predicates: []
          }
        ],
        sort: []
      }).map((item) => item.rowNumber)
    ).toEqual([0]);
  });

  it("fails closed for fabricated ordering and comparisons on complex captured types", () => {
    const complexMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema: [{ id: "c:nested", name: "nested", position: 0, rawType: "Struct", type: "struct", nullable: false }]
    };
    const complexRows = [row(0, nestedCell({ value: 1 }))];

    expect(() =>
      applySnapshotFilters(complexMetadata, complexRows, {
        filters: [],
        sort: [{ column: "nested", direction: "asc", nulls: "last" }]
      })
    ).toThrow("sorting is unavailable");
    expect(() =>
      applySnapshotFilters(complexMetadata, complexRows, {
        filters: [
          {
            column: "nested",
            type: "struct",
            predicates: [{ kind: "predicate", operator: "equals", value: '{"value":1}' }]
          }
        ],
        sort: []
      })
    ).toThrow("predicate equals is unavailable");
    expect(
      applySnapshotFilters(complexMetadata, complexRows, {
        filters: [{ column: "nested", type: "struct", predicates: [{ kind: "predicate", operator: "isNotNull" }] }],
        sort: []
      })
    ).toEqual(complexRows);
  });

  it("builds deterministic full-capture visualizations for every live summary family", () => {
    const summaryMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 7, columns: 4 },
      filteredShape: { rows: 7, columns: 4 },
      schema: [
        { id: "c:number", name: "number", position: 0, rawType: "Float64", type: "float", nullable: true },
        { id: "c:boolean", name: "boolean", position: 1, rawType: "Boolean", type: "boolean", nullable: true },
        { id: "c:date", name: "date", position: 2, rawType: "Date", type: "date", nullable: true },
        { id: "c:category", name: "category", position: 3, rawType: "String", type: "string", nullable: true }
      ]
    };
    const summaryRows = [
      row(0, numberCell(0), booleanCell(true), dateCell("2024-01-10"), stringCell("g")),
      row(1, numberCell(5), booleanCell(false), dateCell("2024-01-02"), stringCell("f")),
      row(2, numberCell(10), booleanCell(true), dateCell("2024-02-01"), stringCell("e")),
      row(3, nullCell(), nullCell(), nullCell(), stringCell("d")),
      row(4, nanCell(), booleanCell(false), dateCell("2023-12-31"), stringCell("c")),
      row(5, numberCell(5), booleanCell(true), dateCell("2024-01-02"), stringCell("b")),
      row(6, numberCell(10), booleanCell(false), dateCell("2024-01-03"), stringCell("a"))
    ];
    const [numeric, boolean, datetime, categorical] = snapshotSummaries(summaryMetadata, summaryRows);

    expect(numeric?.numeric).toMatchObject({ min: 0, max: 10, mean: 6, median: 5 });
    expect(numeric?.numeric?.std).toBeCloseTo(4.1833001327);
    expect(numeric?.visualization).toEqual({
      kind: "numeric",
      bins: [
        { min: 0, max: 10 / 3, count: 1 },
        { min: 10 / 3, max: 20 / 3, count: 2 },
        { min: 20 / 3, max: 10, count: 2 }
      ]
    });
    expect(boolean?.visualization).toEqual({ kind: "boolean", trueCount: 3, falseCount: 3 });
    expect(datetime?.visualization).toEqual({ kind: "datetime", min: "2023-12-31", max: "2024-02-01" });
    expect(categorical?.visualization).toEqual({
      kind: "categorical",
      categories: [
        { value: "a", count: 1 },
        { value: "b", count: 1 },
        { value: "c", count: 1 },
        { value: "d", count: 1 },
        { value: "e", count: 1 },
        { value: "f", count: 1 }
      ],
      otherCount: 1
    });
    for (const summary of [numeric, boolean, datetime, categorical]) {
      expect(summary?.visualization).not.toHaveProperty("sampled");
    }
  });

  it("fails closed when summaries cannot address duplicate column names", () => {
    expect(() => snapshotSummaries(duplicateMetadata, duplicateRows)).toThrow(
      'Snapshot summaries cannot address column "duplicate" because 2 captured columns share that name.'
    );
    expect(() => snapshotSummaries(duplicateMetadata, duplicateRows, ["duplicate"])).toThrow(
      'Snapshot summary column "duplicate" is ambiguous because 2 captured columns share that name.'
    );
    expect(snapshotSummaries(metadata, rows, ["sales"]).map((summary) => summary.column)).toEqual(["sales"]);
    expect(() => snapshotSummaries(metadata, rows, ["missing"])).toThrow(
      'Snapshot summary column "missing" is not present in the captured schema.'
    );
  });

  it("computes deterministic captured-data missing and duplicate counts after filtering", () => {
    const capturedRows = [...rows, row(5, stringCell("Berlin"), numberCell(12), stringCell("b"))];

    expect(snapshotDatasetStats(metadata, capturedRows)).toEqual({
      missingCells: 3,
      missingRows: 3,
      duplicateRows: 1,
      missingValuesByColumn: [
        { column: "city", count: 0 },
        { column: "sales", count: 1 },
        { column: "tag", count: 2 }
      ]
    });

    expect(
      snapshotDatasetStats(metadata, capturedRows, {
        filters: [
          { column: "city", type: "string", predicates: [{ kind: "predicate", operator: "equals", value: "Berlin" }] }
        ],
        sort: [{ column: "sales", direction: "desc", nulls: "last" }]
      })
    ).toEqual({
      missingCells: 1,
      missingRows: 1,
      duplicateRows: 1,
      missingValuesByColumn: [
        { column: "city", count: 0 },
        { column: "sales", count: 0 },
        { column: "tag", count: 1 }
      ]
    });
  });

  it("does not call distinct zero-column rows duplicates", () => {
    const emptyMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 3, columns: 0 },
      filteredShape: { rows: 3, columns: 0 },
      schema: []
    };
    const emptyRows: DataRow[] = [
      { id: "r:0", rowNumber: 0, values: [] },
      { id: "r:1", rowNumber: 1, values: [] },
      { id: "r:2", rowNumber: 2, values: [] }
    ];

    expect(snapshotDatasetStats(emptyMetadata, emptyRows)).toEqual({
      missingCells: 0,
      missingRows: 0,
      duplicateRows: 0,
      missingValuesByColumn: []
    });
  });

  it("fails closed for missing, ambiguous, and type-mismatched dataset-stat lookups", () => {
    expect(() =>
      snapshotDatasetStats(metadata, rows, {
        filters: [{ column: "missing", type: "string", predicates: [] }],
        sort: []
      })
    ).toThrow('Snapshot filter column "missing" is not present in the captured schema.');
    expect(() =>
      snapshotDatasetStats(metadata, rows, {
        filters: [{ column: "sales", type: "string", predicates: [] }],
        sort: []
      })
    ).toThrow('Snapshot filter column "sales" declares type "string", but the captured schema type is "float".');
    expect(() =>
      snapshotDatasetStats(duplicateMetadata, duplicateRows, {
        filters: [],
        sort: [{ column: "duplicate", direction: "asc", nulls: "last" }]
      })
    ).toThrow('Snapshot sort column "duplicate" is ambiguous because 2 captured columns share that name.');
  });

  it("canonicalizes nested object key order when counting captured duplicates", () => {
    const nestedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [{ id: "c:nested", name: "nested", position: 0, rawType: "Struct", type: "struct", nullable: false }]
    };
    const nestedRows = [row(0, nestedCell({ right: 2, left: 1 })), row(1, nestedCell({ left: 1, right: 2 }))];

    expect(snapshotDatasetStats(nestedMetadata, nestedRows).duplicateRows).toBe(1);
  });
});

function applyLiteralPredicate(type: ViewLiteralCase["type"], value: string): DataRow[] {
  const literalMetadata = singleColumnMetadata(type, type, 1);
  return applySnapshotFilters(literalMetadata, [row(0, representativeCell(type))], {
    filters: [
      {
        column: "value",
        type,
        predicates: [{ kind: "predicate", operator: "equals", value }]
      }
    ],
    sort: []
  });
}

function singleColumnMetadata(
  type: SessionMetadata["schema"][number]["type"],
  rawType: string,
  rowCount: number
): SessionMetadata {
  return {
    ...metadata,
    shape: { rows: rowCount, columns: 1 },
    filteredShape: { rows: rowCount, columns: 1 },
    schema: [{ id: "c:value", name: "value", position: 0, rawType, type, nullable: false }]
  };
}

function representativeCell(type: ViewLiteralCase["type"]): CellValue {
  switch (type) {
    case "integer":
      return integerCell(1000);
    case "float":
      return numberCell(1.25);
    case "decimal":
      return decimalCell("1.25");
    case "boolean":
      return booleanCell(true);
    case "date":
      return dateCell("2024-01-31");
    case "datetime":
      return datetimeCell("2024-01-31T23:59:58.123456+02:30");
    case "duration":
      return durationCell(1.25);
    default:
      return stringCell("value");
  }
}

function row(rowNumber: number, ...values: CellValue[]): DataRow {
  return { id: `r:${rowNumber}`, rowNumber, values };
}

function stringCell(value: string): CellValue {
  return { kind: "string", raw: value, display: value, isNull: false, isNaN: false };
}

function numberCell(value: number): CellValue {
  return { kind: "number", raw: value, display: String(value), isNull: false, isNaN: false };
}

function integerCell(value: string | number): CellValue {
  return { kind: "integer", raw: value, display: String(value), isNull: false, isNaN: false };
}

function decimalCell(value: string): CellValue {
  return { kind: "decimal", raw: value, display: value, isNull: false, isNaN: false };
}

function booleanCell(value: boolean): CellValue {
  return { kind: "boolean", raw: value, display: String(value), isNull: false, isNaN: false };
}

function dateCell(value: string): CellValue {
  return { kind: "date", raw: value, display: value, isNull: false, isNaN: false };
}

function datetimeCell(value: string): CellValue {
  return { kind: "datetime", raw: value, display: value, isNull: false, isNaN: false };
}

function durationCell(seconds: number): CellValue {
  return { kind: "duration", raw: seconds, display: `${seconds}s`, isNull: false, isNaN: false };
}

function nullCell(): CellValue {
  return { kind: "null", raw: null, display: "", isNull: true, isNaN: false };
}

function nanCell(): CellValue {
  return { kind: "nan", raw: "NaN", display: "NaN", isNull: false, isNaN: true };
}

function infinityCell(sign: -1 | 1): CellValue {
  return {
    kind: "infinity",
    raw: null,
    display: sign < 0 ? "-Infinity" : "Infinity",
    isNull: false,
    isNaN: false,
    sign
  };
}

function nestedCell(raw: Record<string, number>): CellValue {
  return { kind: "struct", raw, display: JSON.stringify(raw), isNull: false, isNaN: false };
}
