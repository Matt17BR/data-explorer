import type { ColumnFilter, ColumnType, FilterModel, PredicateFilter } from "./protocol.generated";

export type { ColumnFilter, ColumnType, FilterModel, PredicateFilter };
export type SortRule = FilterModel["sort"][number];
export type SortDirection = SortRule["direction"];
export type PredicateOperator = PredicateFilter["operator"];
export type ValueFilter = NonNullable<ColumnFilter["valueFilter"]>;

const comparableColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "duration"
]);

const nullPredicateOperators: readonly PredicateOperator[] = ["isNull", "isNotNull"];
const orderedPredicateOperators: readonly PredicateOperator[] = [
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  ...nullPredicateOperators
];
const predicateOperatorsByType: Readonly<Record<ColumnType, readonly PredicateOperator[]>> = {
  string: ["contains", "startsWith", "endsWith", ...orderedPredicateOperators],
  integer: orderedPredicateOperators,
  float: [...orderedPredicateOperators, "isNaN", "isNotNaN"],
  decimal: orderedPredicateOperators,
  boolean: ["equals", "notEquals", ...nullPredicateOperators],
  datetime: orderedPredicateOperators,
  date: orderedPredicateOperators,
  duration: orderedPredicateOperators,
  binary: nullPredicateOperators,
  list: nullPredicateOperators,
  struct: nullPredicateOperators,
  unknown: nullPredicateOperators
};

export const supportsTypedViewComparison = (type: ColumnType): boolean => comparableColumnTypes.has(type);

export const viewPredicateOperators = (type: ColumnType): readonly PredicateOperator[] =>
  predicateOperatorsByType[type];

export const supportsViewPredicate = (type: ColumnType, operator: PredicateOperator): boolean =>
  viewPredicateOperators(type).includes(operator);

export const emptyFilterModel = (): FilterModel => ({
  logic: "and",
  filters: [],
  sort: []
});

export const hasActiveFilters = (model: FilterModel): boolean =>
  model.filters.some(
    (filter) =>
      filter.predicates.length > 0 ||
      (filter.valueFilter !== undefined &&
        (filter.valueFilter.selectedValues.length > 0 ||
          filter.valueFilter.includeNulls ||
          filter.valueFilter.includeNaN))
  );

export const hasActiveSort = (model: FilterModel): boolean => model.sort.length > 0;
