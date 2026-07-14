export type ColumnType = "string" | "integer" | "float" | "boolean" | "datetime" | "date" | "unknown";

export type SortDirection = "asc" | "desc";

export interface SortRule {
  column: string;
  direction: SortDirection;
  nulls: "first" | "last";
}

export type PredicateOperator =
  "equals" | "notEquals" | "contains" | "startsWith" | "endsWith" | "gt" | "gte" | "lt" | "lte" | "between";

export interface PredicateFilter {
  kind: "predicate";
  operator: PredicateOperator;
  value: unknown;
  secondValue?: unknown;
}

export interface ValueFilter {
  kind: "values";
  selectedValues: unknown[];
  includeNulls: boolean;
  includeNaN: boolean;
  search?: string;
}

export interface ColumnFilter {
  column: string;
  type: ColumnType;
  valueFilter?: ValueFilter;
  predicates: PredicateFilter[];
}

export interface FilterModel {
  filters: ColumnFilter[];
  sort: SortRule[];
}

export const emptyFilterModel = (): FilterModel => ({
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
