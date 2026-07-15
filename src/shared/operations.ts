import type { OperationKind } from "./protocol";

export type OperationGroup =
  "Rows / order" | "Columns / types" | "Categorical / text" | "Numeric / datetime" | "Aggregation" | "Custom";

export interface OperationCatalogItem {
  kind: OperationKind;
  title: string;
  description: string;
  group: OperationGroup;
  icon: string;
}

export const operationGroups: readonly OperationGroup[] = [
  "Rows / order",
  "Columns / types",
  "Categorical / text",
  "Numeric / datetime",
  "Aggregation",
  "Custom"
];

export const operationCatalog: readonly OperationCatalogItem[] = [
  item("sortRows", "Sort rows", "Create a persistent multi-column ordering step.", "Rows / order", "list-ordered"),
  item(
    "filterRows",
    "Filter rows",
    "Commit the current viewing filters as an explicit step.",
    "Rows / order",
    "filter"
  ),
  item(
    "dropMissingRows",
    "Drop missing rows",
    "Remove rows with missing values in selected columns.",
    "Rows / order",
    "clear-all"
  ),
  item(
    "dropDuplicates",
    "Drop duplicates",
    "Keep one row for each repeated value combination.",
    "Rows / order",
    "copy"
  ),
  item("selectColumns", "Select columns", "Keep selected columns in the chosen order.", "Columns / types", "checklist"),
  item("dropColumns", "Drop columns", "Remove selected columns from the result.", "Columns / types", "trash"),
  item("renameColumn", "Rename column", "Change a column name without touching the source.", "Columns / types", "edit"),
  item("cloneColumn", "Clone column", "Create a copy of a column under a new name.", "Columns / types", "files"),
  item(
    "castColumn",
    "Convert type",
    "Convert values to a supported deterministic type.",
    "Columns / types",
    "symbol-field"
  ),
  item(
    "formula",
    "Formula column",
    "Create a numeric column from a column and value or column.",
    "Columns / types",
    "symbol-operator"
  ),
  item(
    "textLength",
    "Text length",
    "Create a column containing character counts.",
    "Columns / types",
    "symbol-numeric"
  ),
  item(
    "oneHotEncode",
    "One-hot encode",
    "Expand categorical columns into indicator columns.",
    "Categorical / text",
    "symbol-enum"
  ),
  item(
    "multiLabelBinarize",
    "Multi-label binarize",
    "Expand delimiter-separated labels into indicators.",
    "Categorical / text",
    "list-selection"
  ),
  item(
    "findReplace",
    "Find and replace",
    "Replace literal text or regular-expression matches.",
    "Categorical / text",
    "replace-all"
  ),
  item(
    "stripText",
    "Strip text",
    "Remove surrounding whitespace or selected characters.",
    "Categorical / text",
    "whitespace"
  ),
  item(
    "splitText",
    "Split text",
    "Take one indexed part of delimiter-separated text.",
    "Categorical / text",
    "split-horizontal"
  ),
  item(
    "capitalizeText",
    "Capitalize",
    "Uppercase the first character and lowercase the rest.",
    "Categorical / text",
    "case-sensitive"
  ),
  item("lowerText", "Lowercase", "Convert text to lowercase.", "Categorical / text", "case-sensitive"),
  item("upperText", "Uppercase", "Convert text to uppercase.", "Categorical / text", "case-sensitive"),
  item(
    "minMaxScale",
    "Min-max scale",
    "Scale numeric values into the zero-to-one range.",
    "Numeric / datetime",
    "graph"
  ),
  item("roundNumber", "Round", "Round numeric values to a selected precision.", "Numeric / datetime", "symbol-numeric"),
  item("floorNumber", "Floor", "Round numeric values downward.", "Numeric / datetime", "arrow-down"),
  item("ceilNumber", "Ceiling", "Round numeric values upward.", "Numeric / datetime", "arrow-up"),
  item(
    "formatDatetime",
    "Format datetime",
    "Format parsed dates and datetimes with strftime syntax.",
    "Numeric / datetime",
    "calendar"
  ),
  item(
    "groupBy",
    "Group and aggregate",
    "Group by keys and calculate named aggregations.",
    "Aggregation",
    "group-by-ref-type"
  ),
  item("customCode", "Custom code", "Run an engine-native step that assigns a dataframe to result.", "Custom", "code")
];

export function operationByKind(kind: OperationKind): OperationCatalogItem {
  const operation = operationCatalog.find((candidate) => candidate.kind === kind);
  if (!operation) throw new Error(`Unknown operation: ${kind}`);
  return operation;
}

function item(
  kind: OperationKind,
  title: string,
  description: string,
  group: OperationGroup,
  icon: string
): OperationCatalogItem {
  return { kind, title, description, group, icon };
}
