import { useId, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { FilterModel } from "../../shared/filterModel";
import type {
  ColumnReference,
  ColumnSchema,
  OperationKind,
  SessionMetadata,
  TransformFilterModel,
  TransformStep
} from "../../shared/protocol";
import { operationCatalog, operationGroups, operationByKind } from "../../shared/operations";
import { isTransformStep } from "../../shared/protocolValidation";

interface OperationBuilderProps {
  metadata: SessionMetadata;
  filterModel: FilterModel;
  initialKind?: OperationKind;
  initialStep?: TransformStep;
  busy?: boolean;
  onClose(): void;
  onPreview(step: TransformStep, replaceStepId?: string): void;
}

const formulaOperators = ["add", "subtract", "multiply", "divide", "modulo", "power"] as const;
const aggregationOperations = ["sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"];

interface SavedReferenceCheck {
  label: string;
  reference: ColumnReference;
  expectedType?: ColumnSchema["type"];
}

interface SavedReferenceGroup {
  label: string;
  references: SavedReferenceCheck[];
  rejectRepeatedIds: boolean;
}

function savedReferenceGroups(step: TransformStep): SavedReferenceGroup[] {
  switch (step.kind) {
    case "sortRows":
      return [
        {
          label: "sort rules",
          references: step.params.rules.map((rule, index) => ({
            label: `sort rule ${index + 1}`,
            reference: rule.column
          })),
          rejectRepeatedIds: true
        }
      ];
    case "filterRows":
      return [
        {
          label: "filters",
          references: step.params.filterModel.filters.map((filter, index) => ({
            label: `filter ${index + 1}`,
            reference: filter.column,
            expectedType: filter.type
          })),
          rejectRepeatedIds: true
        },
        {
          label: "filter-step sorts",
          references: step.params.filterModel.sort.map((rule, index) => ({
            label: `filter-step sort ${index + 1}`,
            reference: rule.column
          })),
          rejectRepeatedIds: true
        }
      ];
    case "dropMissingRows":
    case "dropDuplicates":
      return [
        {
          label: "column list",
          references: (step.params.columns ?? []).map((reference, index) => ({
            label: `column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "selectColumns":
    case "dropColumns":
    case "oneHotEncode":
      return [
        {
          label: "column list",
          references: step.params.columns.map((reference, index) => ({
            label: `column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "formula":
      return [
        {
          label: "formula operands",
          references: [
            { label: "left formula column", reference: step.params.leftColumn },
            ...(step.params.rightColumn ? [{ label: "right formula column", reference: step.params.rightColumn }] : [])
          ],
          rejectRepeatedIds: false
        }
      ];
    case "renameColumn":
    case "cloneColumn":
    case "castColumn":
    case "textLength":
    case "multiLabelBinarize":
    case "findReplace":
    case "stripText":
    case "splitText":
    case "capitalizeText":
    case "lowerText":
    case "upperText":
    case "minMaxScale":
    case "roundNumber":
    case "floorNumber":
    case "ceilNumber":
    case "formatDatetime":
      return [
        {
          label: "input column",
          references: [{ label: "input column", reference: step.params.column }],
          rejectRepeatedIds: false
        }
      ];
    default:
      return [];
  }
}

function savedStepEditError(step: TransformStep, inputSchema: ColumnSchema[] | undefined): string | undefined {
  const recovery = "Cancel editing, then reload the session or undo and recreate this step.";
  if (!inputSchema) {
    return `This saved step cannot be edited safely because its recorded input schema is unavailable. ${recovery}`;
  }

  const columnsById = new Map(inputSchema.map((column) => [column.id, column]));
  if (columnsById.size !== inputSchema.length) {
    return `This saved step cannot be edited safely because its recorded input schema contains duplicate column IDs. ${recovery}`;
  }

  for (const group of savedReferenceGroups(step)) {
    const seenIds = new Set<string>();
    for (const check of group.references) {
      const column = columnsById.get(check.reference.id);
      if (!column) {
        return `The saved ${check.label} refers to column ID “${check.reference.id}”, which is absent from the recorded input schema. ${recovery}`;
      }
      if (column.name !== check.reference.name) {
        return `The saved ${check.label} expects column name “${check.reference.name}” for ID “${check.reference.id}”, but the recorded input schema names it “${column.name}”. ${recovery}`;
      }
      if (check.expectedType !== undefined && column.type !== check.expectedType) {
        return `The saved ${check.label} declares type “${check.expectedType}”, but its recorded input column has type “${column.type}”. ${recovery}`;
      }
      if (group.rejectRepeatedIds && seenIds.has(check.reference.id)) {
        return `The saved ${group.label} repeats column ID “${check.reference.id}”. ${recovery}`;
      }
      seenIds.add(check.reference.id);
    }
  }
  return undefined;
}

export function OperationBuilder({
  metadata,
  filterModel,
  initialKind,
  initialStep,
  busy = false,
  onClose,
  onPreview
}: OperationBuilderProps) {
  const [selectedKind, setSelectedKind] = useState<OperationKind | undefined>(initialKind ?? initialStep?.kind);
  const [search, setSearch] = useState("");
  const [sortRows, setSortRows] = useState(1);
  const [aggregationRows, setAggregationRows] = useState(1);
  const [formError, setFormError] = useState<string>();
  const filteredCatalog = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? operationCatalog.filter(
          (operation) =>
            operation.title.toLowerCase().includes(query) || operation.description.toLowerCase().includes(query)
        )
      : operationCatalog;
  }, [search]);
  const activeInitial = initialStep?.kind === selectedKind ? initialStep : undefined;
  const availableColumns = initialStep ? (metadata.latestStepInputSchema ?? []) : metadata.schema;
  const editPreflightError = initialStep ? savedStepEditError(initialStep, metadata.latestStepInputSchema) : undefined;
  const savedFilterModel = activeInitial?.kind === "filterRows" ? activeInitial.params.filterModel : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !selectedKind || editPreflightError) return;
    try {
      const form = new FormData(event.currentTarget);
      const params = buildParams(selectedKind, form, filterModel, availableColumns, savedFilterModel);
      const step = {
        id: initialStep?.id ?? `${selectedKind}-${Date.now().toString(36)}`,
        kind: selectedKind,
        params
      };
      if (!isTransformStep(step)) {
        throw new Error("The operation contains invalid or incomplete parameters.");
      }
      setFormError(undefined);
      onPreview(step, initialStep?.id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      className="operationDialogBackdrop"
      role="presentation"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}
    >
      <section
        className="operationDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-dialog-title"
        aria-busy={busy}
      >
        <header className="operationDialogHeader">
          <div>
            <strong id="operation-dialog-title">{initialStep ? "Edit cleaning step" : "Add cleaning step"}</strong>
            <span role="status" aria-live="polite">
              {busy ? "Previewing changes…" : "Every step is previewed before it changes the cleaning plan."}
            </span>
          </div>
          <button
            type="button"
            className="iconButton codicon codicon-close"
            aria-label="Close operation picker"
            disabled={busy}
            onClick={onClose}
          />
        </header>
        <fieldset className="operationDialogBody" disabled={busy}>
          <nav className="operationCatalog" aria-label="Operation catalog">
            <label className="operationSearch">
              <span className="codicon codicon-search" aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search operations"
                autoFocus
              />
            </label>
            {operationGroups.map((group) => {
              const operations = filteredCatalog.filter((operation) => operation.group === group);
              if (!operations.length) return null;
              return (
                <section key={group} className="operationGroup">
                  <h3>{group}</h3>
                  {operations.map((operation) => (
                    <button
                      type="button"
                      key={operation.kind}
                      className={`operationChoice${selectedKind === operation.kind ? " selected" : ""}`}
                      aria-pressed={selectedKind === operation.kind}
                      onClick={() => setSelectedKind(operation.kind)}
                    >
                      <span className={`codicon codicon-${operation.icon}`} aria-hidden="true" />
                      <span>
                        <strong>{operation.title}</strong>
                        <small>{operation.description}</small>
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
            {filteredCatalog.length === 0 && <p className="mutedText">No operations match “{search}”.</p>}
          </nav>
          <form className="operationForm" key={selectedKind ?? "none"} onSubmit={submit}>
            {selectedKind ? (
              <>
                <div className="operationFormTitle">
                  <span className={`codicon codicon-${operationByKind(selectedKind).icon}`} aria-hidden="true" />
                  <div>
                    <h2>{operationByKind(selectedKind).title}</h2>
                    <p>{operationByKind(selectedKind).description}</p>
                  </div>
                </div>
                {editPreflightError ? (
                  <p className="operationFormError" role="alert">
                    {editPreflightError}
                  </p>
                ) : (
                  <>
                    <OperationFields
                      kind={selectedKind}
                      metadata={metadata}
                      columns={availableColumns}
                      filterModel={filterModel}
                      initialStep={activeInitial}
                      sortRows={sortRows}
                      aggregationRows={aggregationRows}
                      onAddSort={() => setSortRows((count) => count + 1)}
                      onAddAggregation={() => setAggregationRows((count) => count + 1)}
                    />
                    {formError && (
                      <p className="operationFormError" role="alert">
                        {formError}
                      </p>
                    )}
                  </>
                )}
                <footer className="operationFormActions">
                  <button type="button" className="secondaryButton" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      editPreflightError !== undefined ||
                      (selectedKind === "filterRows" &&
                        (savedFilterModel ?? filterModel).filters.length === 0 &&
                        (savedFilterModel ?? filterModel).sort.length === 0)
                    }
                  >
                    Preview changes
                  </button>
                </footer>
              </>
            ) : (
              <div className="operationPrompt">
                <span className="codicon codicon-wand" aria-hidden="true" />
                <h2>Choose an operation</h2>
                <p>Search or browse the catalog. Your source dataframe remains unchanged.</p>
              </div>
            )}
          </form>
        </fieldset>
      </section>
    </div>
  );
}

interface OperationFieldsProps {
  kind: OperationKind;
  metadata: SessionMetadata;
  columns: ColumnSchema[];
  filterModel: FilterModel;
  initialStep?: TransformStep;
  sortRows: number;
  aggregationRows: number;
  onAddSort(): void;
  onAddAggregation(): void;
}

function OperationFields({
  kind,
  metadata,
  columns,
  filterModel,
  initialStep,
  sortRows,
  aggregationRows,
  onAddSort,
  onAddAggregation
}: OperationFieldsProps) {
  const params = initialStep?.params ?? {};
  const [formulaOperandMode, setFormulaOperandMode] = useState(params.rightColumn ? "column" : "value");
  const [multiLabelPrefixMode, setMultiLabelPrefixMode] = useState(
    Object.prototype.hasOwnProperty.call(params, "prefix") ? "custom" : "default"
  );
  const param = (name: string, fallback = "") => String(params[name] ?? fallback);
  const columnNames = columns.map((column) => column.name);
  const initialColumns = (name: string) => (Array.isArray(params[name]) ? (params[name] as string[]) : []);
  const initialColumnReference = (name: string, fallback = columns[0]?.id ?? "") =>
    columnReferenceId(params[name]) ?? fallback;
  const initialColumnReferences = (name: string) =>
    Array.isArray(params[name]) ? params[name].map(columnReferenceId).filter(isDefined) : [];

  if (kind === "sortRows") {
    const rules = Array.isArray(params.rules) ? (params.rules as Record<string, unknown>[]) : [];
    return (
      <Fieldset legend="Sort rules">
        {Array.from({ length: Math.max(sortRows, rules.length) }, (_, index) => (
          <div className="compoundRow" key={index}>
            <ColumnReferenceSelect
              name="sortColumn"
              label={`Column ${index + 1}`}
              columns={columns}
              defaultValue={columnReferenceId(rules[index]?.column) ?? columns[0]?.id}
            />
            <SelectField
              name="sortDirection"
              label="Direction"
              defaultValue={String(rules[index]?.direction ?? "asc")}
              options={[
                ["asc", "Ascending"],
                ["desc", "Descending"]
              ]}
            />
            <SelectField
              name="sortNulls"
              label="Missing"
              defaultValue={String(rules[index]?.nulls ?? "last")}
              options={[
                ["last", "Last"],
                ["first", "First"]
              ]}
            />
          </div>
        ))}
        <button type="button" className="secondaryButton" onClick={onAddSort}>
          Add sort column
        </button>
      </Fieldset>
    );
  }
  if (kind === "filterRows") {
    const savedFilterModel = initialStep?.kind === "filterRows" ? initialStep.params.filterModel : undefined;
    const displayedFilterModel = savedFilterModel ?? filterModel;
    const currentQueryIsEmpty = filterModel.filters.length === 0 && filterModel.sort.length === 0;
    return (
      <Fieldset legend={savedFilterModel ? "Saved cleaning query" : "Current viewing query"}>
        <p className="panelNote">
          {savedFilterModel
            ? "This edit previews the stable filters and sorts already stored in the cleaning step. Current viewing changes remain independent."
            : "This explicit action copies the current viewing filters and sorts into the cleaning plan. Later viewing changes remain independent."}
        </p>
        <div className="querySummary">
          <strong>{displayedFilterModel.filters.length} filters</strong>
          <strong>{displayedFilterModel.sort.length} sorts</strong>
        </div>
        {savedFilterModel && (
          <div className="formField" role="radiogroup" aria-label="Filter step source">
            <label className="checkboxField">
              <input name="filterSource" type="radio" value="saved" defaultChecked />
              <span>Keep the saved cleaning query</span>
            </label>
            <label className="checkboxField">
              <input name="filterSource" type="radio" value="current" disabled={currentQueryIsEmpty} />
              <span>
                Replace it with the current viewing query ({filterModel.filters.length} filters,{" "}
                {filterModel.sort.length} sorts)
              </span>
            </label>
            {currentQueryIsEmpty && <small>Add a viewing filter or sort before replacing the saved query.</small>}
          </div>
        )}
      </Fieldset>
    );
  }
  if (kind === "dropMissingRows") {
    return (
      <>
        <ColumnReferencesSelect
          name="columns"
          label="Columns (none means all)"
          columns={columns}
          defaultValue={initialColumnReferences("columns")}
          required={false}
        />
        <SelectField
          name="how"
          label="Drop when"
          defaultValue={param("how", "any")}
          options={[
            ["any", "Any selected value is missing"],
            ["all", "All selected values are missing"]
          ]}
        />
      </>
    );
  }
  if (kind === "dropDuplicates") {
    return (
      <>
        <ColumnReferencesSelect
          name="columns"
          label="Compare columns (none means all)"
          columns={columns}
          defaultValue={initialColumnReferences("columns")}
          required={false}
        />
        <SelectField
          name="keep"
          label="Keep"
          defaultValue={param("keep", "first")}
          options={[
            ["first", "First row"],
            ["last", "Last row"],
            ["none", "No duplicates"]
          ]}
        />
      </>
    );
  }
  if (kind === "selectColumns" || kind === "dropColumns") {
    return (
      <ColumnReferencesSelect
        name="columns"
        label={kind === "selectColumns" ? "Columns to keep" : "Columns to drop"}
        columns={columns}
        defaultValue={initialColumnReferences("columns")}
        preserveSelectionOrder={kind === "selectColumns"}
      />
    );
  }
  if (kind === "oneHotEncode") {
    return (
      <>
        <ColumnReferencesSelect
          name="columns"
          label="Categorical columns"
          columns={columns}
          defaultValue={initialColumnReferences("columns")}
        />
        <TextField name="prefixSeparator" label="Prefix separator" defaultValue={param("prefixSeparator", "_")} />
        <CheckboxField
          name="dropOriginal"
          label="Drop original columns"
          defaultChecked={params.dropOriginal !== false}
        />
      </>
    );
  }
  if (kind === "renameColumn" || kind === "cloneColumn") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="newName" label="New name" defaultValue={param("newName")} required />
      </>
    );
  }
  if (kind === "castColumn") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <SelectField
          name="dtype"
          label="Target type"
          defaultValue={param("dtype", "string")}
          options={["string", "integer", "float", "boolean", "date", "datetime"].map((value) => [value, value])}
        />
      </>
    );
  }
  if (kind === "formula") {
    return (
      <>
        <ColumnReferenceSelect
          name="leftColumn"
          label="Left column"
          columns={columns}
          defaultValue={initialColumnReference("leftColumn")}
        />
        <SelectField
          name="operator"
          label="Operator"
          defaultValue={param("operator", "add")}
          options={formulaOperators.map((value) => [value, value])}
        />
        <label className="formField">
          <span>Right operand</span>
          <select
            name="operandMode"
            value={formulaOperandMode}
            onChange={(event) => setFormulaOperandMode(event.target.value)}
          >
            <option value="value">Numeric value</option>
            <option value="column">Column</option>
          </select>
        </label>
        {formulaOperandMode === "value" ? (
          <TextField name="value" label="Numeric value" type="number" defaultValue={param("value", "0")} />
        ) : (
          <ColumnReferenceSelect
            name="rightColumn"
            label="Right column"
            columns={columns}
            defaultValue={initialColumnReference("rightColumn")}
          />
        )}
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn")} required />
      </>
    );
  }
  if (kind === "textLength") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "text_length")} required />
      </>
    );
  }
  if (kind === "multiLabelBinarize") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Labels column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="delimiter" label="Delimiter" defaultValue={param("delimiter", ",")} required />
        <label className="formField">
          <span>Output prefix mode</span>
          <select
            name="prefixMode"
            value={multiLabelPrefixMode}
            onChange={(event) => setMultiLabelPrefixMode(event.target.value)}
          >
            <option value="default">Default (column name + _)</option>
            <option value="custom">Custom (blank means none)</option>
          </select>
        </label>
        {multiLabelPrefixMode === "custom" && (
          <TextField name="prefix" label="Custom output prefix" defaultValue={param("prefix")} />
        )}
        <CheckboxField name="dropOriginal" label="Drop original column" defaultChecked={params.dropOriginal === true} />
      </>
    );
  }
  if (kind === "findReplace") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="find" label="Find (blank matches empty boundaries)" defaultValue={param("find")} />
        <TextField name="replacement" label="Replace with" defaultValue={param("replacement")} />
        <CheckboxField name="regex" label="Use regular expression" defaultChecked={params.regex === true} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "stripText") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="characters" label="Characters (blank means whitespace)" defaultValue={param("characters")} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "splitText") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Text column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="delimiter" label="Delimiter" defaultValue={param("delimiter", ",")} required />
        <TextField name="index" label="Part index" type="number" min={0} defaultValue={param("index", "0")} required />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "split_value")} required />
      </>
    );
  }
  if (["capitalizeText", "lowerText", "upperText", "minMaxScale", "floorNumber", "ceilNumber"].includes(kind)) {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "roundNumber") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Numeric column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField
          name="decimals"
          label="Decimal places"
          type="number"
          defaultValue={param("decimals", "0")}
          required
        />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "formatDatetime") {
    return (
      <>
        <ColumnReferenceSelect
          name="column"
          label="Date or datetime column"
          columns={columns}
          defaultValue={initialColumnReference("column")}
        />
        <TextField name="format" label="strftime format" defaultValue={param("format", "%Y-%m-%d")} required />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "groupBy") {
    const aggregations = Array.isArray(params.aggregations) ? (params.aggregations as Record<string, unknown>[]) : [];
    return (
      <>
        <ColumnsSelect name="keys" label="Group keys" columns={columnNames} defaultValue={initialColumns("keys")} />
        <Fieldset legend="Aggregations">
          {Array.from({ length: Math.max(aggregationRows, aggregations.length) }, (_, index) => (
            <div className="compoundRow aggregationRow" key={index}>
              <ColumnSelect
                name="aggregationColumn"
                label={`Value ${index + 1}`}
                columns={columnNames}
                defaultValue={String(aggregations[index]?.column ?? columnNames[0] ?? "")}
              />
              <SelectField
                name="aggregationOperation"
                label="Calculation"
                defaultValue={String(aggregations[index]?.operation ?? "sum")}
                options={aggregationOperations.map((value) => [value, value])}
              />
              <TextField
                name="aggregationAlias"
                label="Output name"
                defaultValue={String(aggregations[index]?.alias ?? `value_${index + 1}`)}
                required
              />
            </div>
          ))}
          <button type="button" className="secondaryButton" onClick={onAddAggregation}>
            Add aggregation
          </button>
        </Fieldset>
      </>
    );
  }
  if (kind === "byExample") {
    const examples = Array.isArray(params.examples)
      ? JSON.stringify(params.examples, null, 2)
      : JSON.stringify(
          [
            { inputs: { [columnNames[0] ?? "value"]: "example one" }, output: "EXAMPLE ONE" },
            { inputs: { [columnNames[0] ?? "value"]: "example two" }, output: "EXAMPLE TWO" }
          ],
          null,
          2
        );
    return (
      <>
        <ColumnsSelect
          name="sourceColumns"
          label="Source columns"
          columns={columnNames}
          defaultValue={
            initialColumns("sourceColumns").length ? initialColumns("sourceColumns") : columnNames.slice(0, 1)
          }
        />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "example_result")} required />
        <label className="formField codeField">
          <span>Examples (JSON)</span>
          <textarea name="examples" rows={12} required defaultValue={examples} spellCheck={false} />
          <small>
            Provide at least two items with <code>inputs</code> for every selected source column and an{" "}
            <code>output</code>. Preview confirms the selected program and reports ambiguity.
          </small>
        </label>
      </>
    );
  }
  if (kind === "customCode") {
    return (
      <label className="formField codeField">
        <span>Engine-native Python</span>
        <textarea
          name="code"
          rows={12}
          required
          defaultValue={param("code", metadata.backend === "pandas" ? "result = df.copy()" : "result = df")}
          spellCheck={false}
        />
        <small>
          Assign an engine-native dataframe or relation to <code>result</code>. Custom code runs only in a trusted
          workspace.
        </small>
      </label>
    );
  }
  return null;
}

function buildParams(
  kind: OperationKind,
  form: FormData,
  filterModel: FilterModel,
  availableColumns: ColumnSchema[],
  savedFilterModel?: TransformFilterModel
): Record<string, unknown> {
  const value = (name: string) => String(form.get(name) ?? "");
  const optional = (target: Record<string, unknown>, name: string, transformed = value(name)) => {
    if (transformed !== "") target[name] = transformed;
  };
  const columnReference = (name: string) => referenceForId(value(name), availableColumns);
  const columnReferences = (name: string) =>
    form
      .getAll(name)
      .map(String)
      .map((id) => referenceForId(id, availableColumns));
  if (kind === "sortRows") {
    const columns = columnReferences("sortColumn");
    const directions = form.getAll("sortDirection").map(String);
    const nulls = form.getAll("sortNulls").map(String);
    return { rules: columns.map((column, index) => ({ column, direction: directions[index], nulls: nulls[index] })) };
  }
  if (kind === "filterRows") {
    const useSaved = savedFilterModel !== undefined && value("filterSource") !== "current";
    return { filterModel: useSaved ? savedFilterModel : transformFilterModel(filterModel, availableColumns) };
  }
  if (kind === "dropMissingRows") return { columns: columnReferences("columns"), how: value("how") };
  if (kind === "dropDuplicates") {
    const params: Record<string, unknown> = { keep: value("keep") };
    const columns = columnReferences("columns");
    if (columns.length) params.columns = columns;
    return params;
  }
  if (kind === "selectColumns" || kind === "dropColumns") return { columns: columnReferences("columns") };
  if (kind === "oneHotEncode")
    return {
      columns: columnReferences("columns"),
      prefixSeparator: value("prefixSeparator"),
      dropOriginal: form.has("dropOriginal")
    };
  if (kind === "renameColumn" || kind === "cloneColumn") {
    return { column: columnReference("column"), newName: value("newName") };
  }
  if (kind === "castColumn") return { column: columnReference("column"), dtype: value("dtype") };
  if (kind === "formula")
    return {
      leftColumn: columnReference("leftColumn"),
      operator: value("operator"),
      newColumn: value("newColumn"),
      ...(value("operandMode") === "column"
        ? { rightColumn: columnReference("rightColumn") }
        : { value: Number(value("value")) })
    };
  if (kind === "textLength") return { column: columnReference("column"), newColumn: value("newColumn") };
  if (kind === "multiLabelBinarize") {
    const params: Record<string, unknown> = {
      column: columnReference("column"),
      delimiter: value("delimiter"),
      dropOriginal: form.has("dropOriginal")
    };
    if (value("prefixMode") === "custom") params.prefix = value("prefix");
    return params;
  }
  if (kind === "findReplace") {
    const params: Record<string, unknown> = {
      column: columnReference("column"),
      find: value("find"),
      replacement: value("replacement"),
      regex: form.has("regex")
    };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "stripText") {
    const params: Record<string, unknown> = { column: columnReference("column") };
    optional(params, "characters");
    optional(params, "newColumn");
    return params;
  }
  if (kind === "splitText")
    return {
      column: columnReference("column"),
      delimiter: value("delimiter"),
      index: Number(value("index")),
      newColumn: value("newColumn")
    };
  if (["capitalizeText", "lowerText", "upperText", "minMaxScale", "floorNumber", "ceilNumber"].includes(kind)) {
    const params: Record<string, unknown> = { column: columnReference("column") };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "roundNumber") {
    const params: Record<string, unknown> = {
      column: columnReference("column"),
      decimals: Number(value("decimals"))
    };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "formatDatetime") {
    const params: Record<string, unknown> = { column: columnReference("column"), format: value("format") };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "groupBy") {
    const columns = form.getAll("aggregationColumn").map(String);
    const operations = form.getAll("aggregationOperation").map(String);
    const aliases = form.getAll("aggregationAlias").map(String);
    return {
      keys: form.getAll("keys").map(String),
      aggregations: columns.map((column, index) => ({ column, operation: operations[index], alias: aliases[index] }))
    };
  }
  if (kind === "byExample") {
    let examples: unknown;
    try {
      examples = JSON.parse(value("examples"));
    } catch {
      throw new Error("Examples must be valid JSON.");
    }
    if (!Array.isArray(examples)) throw new Error("Examples JSON must be an array.");
    return {
      sourceColumns: form.getAll("sourceColumns").map(String),
      newColumn: value("newColumn"),
      examples
    };
  }
  return { code: value("code") };
}

function columnReferenceId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
    ? value.id
    : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function referenceForId(id: string, columns: ColumnSchema[]): ColumnReference {
  const column = columns.find((candidate) => candidate.id === id);
  if (!column) throw new Error("The selected column is no longer available.");
  return { id: column.id, name: column.name };
}

function transformFilterModel(filterModel: FilterModel, columns: ColumnSchema[]): TransformFilterModel {
  const referenceForName = (name: string): ColumnReference => {
    const matches = columns.filter((column) => column.name === name);
    if (matches.length === 0) {
      throw new Error(`Viewing query column “${name}” is no longer available in the operation input.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Viewing query column “${name}” is ambiguous because ${matches.length} input columns share that name.`
      );
    }
    return { id: matches[0].id, name: matches[0].name };
  };

  return {
    ...(filterModel.logic === undefined ? {} : { logic: filterModel.logic }),
    filters: filterModel.filters.map((filter) => ({ ...filter, column: referenceForName(filter.column) })),
    sort: filterModel.sort.map((rule) => ({ ...rule, column: referenceForName(rule.column) }))
  };
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="formFieldset">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

function ColumnReferenceSelect({
  name,
  label,
  columns,
  defaultValue
}: {
  name: string;
  label: string;
  columns: ColumnSchema[];
  defaultValue?: string;
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue ?? columns[0]?.id} required>
        {columns.map((column) => (
          <option key={column.id} value={column.id}>
            {columnOptionLabel(column)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColumnReferencesSelect({
  name,
  label,
  columns,
  defaultValue,
  required = true,
  preserveSelectionOrder = false
}: {
  name: string;
  label: string;
  columns: ColumnSchema[];
  defaultValue: string[];
  required?: boolean;
  preserveSelectionOrder?: boolean;
}) {
  const selectId = useId();
  const helpId = `${selectId}-help`;
  const orderId = `${selectId}-order`;
  const validColumnIds = new Set(columns.map((column) => column.id));
  const [selectedIds, setSelectedIds] = useState(defaultValue.filter((id) => validColumnIds.has(id)));
  const selectedLabels = selectedIds.map((id) => {
    const column = columns.find((candidate) => candidate.id === id);
    return column ? columnOptionLabel(column) : id;
  });
  return (
    <div className="formField">
      <label htmlFor={selectId}>{label}</label>
      {selectedIds.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
      <select
        id={selectId}
        multiple
        size={Math.min(6, Math.max(3, columns.length))}
        value={selectedIds}
        required={required}
        aria-describedby={preserveSelectionOrder && selectedLabels.length > 0 ? `${helpId} ${orderId}` : helpId}
        onChange={(event) => {
          const selectedInSchemaOrder = Array.from(event.currentTarget.selectedOptions, (option) => option.value);
          const selected = new Set(selectedInSchemaOrder);
          setSelectedIds((current) => [
            ...current.filter((id) => selected.has(id)),
            ...selectedInSchemaOrder.filter((id) => !current.includes(id))
          ]);
        }}
      >
        {columns.map((column) => (
          <option key={column.id} value={column.id}>
            {columnOptionLabel(column)}
          </option>
        ))}
      </select>
      <small id={helpId}>
        {preserveSelectionOrder
          ? "Use Ctrl/Cmd or Shift to select more than one column. Selection order becomes output order."
          : "Use Ctrl/Cmd or Shift to select more than one column."}
      </small>
      {preserveSelectionOrder && selectedLabels.length > 0 && (
        <small id={orderId} aria-live="polite">
          Output order: {selectedLabels.join(" → ")}
        </small>
      )}
    </div>
  );
}

function columnOptionLabel(column: ColumnSchema): string {
  const displayName = column.name === "" ? "(empty name)" : column.name;
  return `${displayName} — column ${column.position + 1}`;
}

function ColumnSelect({
  name,
  label,
  columns,
  defaultValue
}: {
  name: string;
  label: string;
  columns: string[];
  defaultValue?: string;
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue ?? columns[0]} required>
        {columns.map((column) => (
          <option key={column} value={column}>
            {column}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColumnsSelect({
  name,
  label,
  columns,
  defaultValue,
  required = true
}: {
  name: string;
  label: string;
  columns: string[];
  defaultValue: string[];
  required?: boolean;
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <select
        name={name}
        multiple
        size={Math.min(6, Math.max(3, columns.length))}
        defaultValue={defaultValue}
        required={required}
      >
        {columns.map((column) => (
          <option key={column} value={column}>
            {column}
          </option>
        ))}
      </select>
      <small>Use Ctrl/Cmd or Shift to select more than one column.</small>
    </label>
  );
}

function SelectField({
  name,
  label,
  defaultValue,
  options
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: (readonly [string, string])[];
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue}>
        {options.map(([value, title]) => (
          <option key={value} value={value}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  name,
  label,
  defaultValue,
  required = false,
  type = "text",
  min
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  type?: string;
  min?: number;
}) {
  return (
    <label className="formField">
      <span>{label}</span>
      <input name={name} type={type} min={min} defaultValue={defaultValue} required={required} />
    </label>
  );
}

function CheckboxField({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="checkboxField">
      <input name={name} type="checkbox" defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}
