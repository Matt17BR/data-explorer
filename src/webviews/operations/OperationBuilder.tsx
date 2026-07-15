import { useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { FilterModel } from "../../shared/filterModel";
import type { OperationKind, SessionMetadata, TransformStep } from "../../shared/protocol";
import { operationCatalog, operationGroups, operationByKind } from "../../shared/operations";

interface OperationBuilderProps {
  metadata: SessionMetadata;
  filterModel: FilterModel;
  initialKind?: OperationKind;
  initialStep?: TransformStep;
  onClose(): void;
  onPreview(step: TransformStep, replaceStepId?: string): void;
}

const formulaOperators = ["add", "subtract", "multiply", "divide", "modulo", "power"] as const;
const aggregationOperations = ["sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"];

export function OperationBuilder({
  metadata,
  filterModel,
  initialKind,
  initialStep,
  onClose,
  onPreview
}: OperationBuilderProps) {
  const [selectedKind, setSelectedKind] = useState<OperationKind | undefined>(initialKind ?? initialStep?.kind);
  const [search, setSearch] = useState("");
  const [sortRows, setSortRows] = useState(1);
  const [aggregationRows, setAggregationRows] = useState(1);
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedKind) return;
    const form = new FormData(event.currentTarget);
    const params = buildParams(selectedKind, form, filterModel);
    onPreview(
      {
        id: activeInitial?.id ?? `${selectedKind}-${Date.now().toString(36)}`,
        kind: selectedKind,
        params
      },
      activeInitial?.id
    );
  };

  return (
    <div
      className="operationDialogBackdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="operationDialog" role="dialog" aria-modal="true" aria-labelledby="operation-dialog-title">
        <header className="operationDialogHeader">
          <div>
            <strong id="operation-dialog-title">{activeInitial ? "Edit cleaning step" : "Add cleaning step"}</strong>
            <span>Every step is previewed before it changes the cleaning plan.</span>
          </div>
          <button
            type="button"
            className="iconButton codicon codicon-close"
            aria-label="Close operation picker"
            onClick={onClose}
          />
        </header>
        <div className="operationDialogBody">
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
                <OperationFields
                  kind={selectedKind}
                  metadata={metadata}
                  filterModel={filterModel}
                  initialStep={activeInitial}
                  sortRows={sortRows}
                  aggregationRows={aggregationRows}
                  onAddSort={() => setSortRows((count) => count + 1)}
                  onAddAggregation={() => setAggregationRows((count) => count + 1)}
                />
                <footer className="operationFormActions">
                  <button type="button" className="secondaryButton" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      selectedKind === "filterRows" && filterModel.filters.length === 0 && filterModel.sort.length === 0
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
        </div>
      </section>
    </div>
  );
}

interface OperationFieldsProps {
  kind: OperationKind;
  metadata: SessionMetadata;
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
  filterModel,
  initialStep,
  sortRows,
  aggregationRows,
  onAddSort,
  onAddAggregation
}: OperationFieldsProps) {
  const params = initialStep?.params ?? {};
  const [formulaOperandMode, setFormulaOperandMode] = useState(params.rightColumn ? "column" : "value");
  const param = (name: string, fallback = "") => String(params[name] ?? fallback);
  const columns = (
    initialStep && metadata.latestStepInputSchema ? metadata.latestStepInputSchema : metadata.schema
  ).map((column) => column.name);
  const initialColumns = (name: string) => (Array.isArray(params[name]) ? (params[name] as string[]) : []);

  if (kind === "sortRows") {
    const rules = Array.isArray(params.rules) ? (params.rules as Record<string, unknown>[]) : [];
    return (
      <Fieldset legend="Sort rules">
        {Array.from({ length: Math.max(sortRows, rules.length) }, (_, index) => (
          <div className="compoundRow" key={index}>
            <ColumnSelect
              name="sortColumn"
              label={`Column ${index + 1}`}
              columns={columns}
              defaultValue={String(rules[index]?.column ?? columns[0] ?? "")}
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
    return (
      <Fieldset legend="Current viewing query">
        <p className="panelNote">
          This explicit action copies the current viewing filters and sorts into the cleaning plan. Later viewing
          changes remain independent.
        </p>
        <div className="querySummary">
          <strong>{filterModel.filters.length} filters</strong>
          <strong>{filterModel.sort.length} sorts</strong>
        </div>
      </Fieldset>
    );
  }
  if (kind === "dropMissingRows") {
    return (
      <>
        <ColumnsSelect
          name="columns"
          label="Columns (none means all)"
          columns={columns}
          defaultValue={initialColumns("columns")}
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
        <ColumnsSelect
          name="columns"
          label="Compare columns (none means all)"
          columns={columns}
          defaultValue={initialColumns("columns")}
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
  if (kind === "selectColumns" || kind === "dropColumns" || kind === "oneHotEncode") {
    return (
      <>
        <ColumnsSelect
          name="columns"
          label={
            kind === "selectColumns"
              ? "Columns to keep"
              : kind === "dropColumns"
                ? "Columns to drop"
                : "Categorical columns"
          }
          columns={columns}
          defaultValue={initialColumns("columns")}
        />
        {kind === "oneHotEncode" && (
          <>
            <TextField
              name="prefixSeparator"
              label="Prefix separator"
              defaultValue={param("prefixSeparator", "_")}
              required
            />
            <CheckboxField
              name="dropOriginal"
              label="Drop original columns"
              defaultChecked={params.dropOriginal !== false}
            />
          </>
        )}
      </>
    );
  }
  if (kind === "renameColumn" || kind === "cloneColumn") {
    return (
      <>
        <ColumnSelect name="column" label="Column" columns={columns} defaultValue={param("column", columns[0])} />
        <TextField name="newName" label="New name" defaultValue={param("newName")} required />
      </>
    );
  }
  if (kind === "castColumn") {
    return (
      <>
        <ColumnSelect name="column" label="Column" columns={columns} defaultValue={param("column", columns[0])} />
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
        <ColumnSelect
          name="leftColumn"
          label="Left column"
          columns={columns}
          defaultValue={param("leftColumn", columns[0])}
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
          <ColumnSelect
            name="rightColumn"
            label="Right column"
            columns={columns}
            defaultValue={param("rightColumn", columns[0])}
          />
        )}
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn")} required />
      </>
    );
  }
  if (kind === "textLength") {
    return (
      <>
        <ColumnSelect name="column" label="Text column" columns={columns} defaultValue={param("column", columns[0])} />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "text_length")} required />
      </>
    );
  }
  if (kind === "multiLabelBinarize") {
    return (
      <>
        <ColumnSelect
          name="column"
          label="Labels column"
          columns={columns}
          defaultValue={param("column", columns[0])}
        />
        <TextField name="delimiter" label="Delimiter" defaultValue={param("delimiter", ",")} required />
        <TextField name="prefix" label="Output prefix" defaultValue={param("prefix")} />
        <CheckboxField name="dropOriginal" label="Drop original column" defaultChecked={params.dropOriginal === true} />
      </>
    );
  }
  if (kind === "findReplace") {
    return (
      <>
        <ColumnSelect name="column" label="Text column" columns={columns} defaultValue={param("column", columns[0])} />
        <TextField name="find" label="Find" defaultValue={param("find")} required />
        <TextField name="replacement" label="Replace with" defaultValue={param("replacement")} />
        <CheckboxField name="regex" label="Use regular expression" defaultChecked={params.regex === true} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "stripText") {
    return (
      <>
        <ColumnSelect name="column" label="Text column" columns={columns} defaultValue={param("column", columns[0])} />
        <TextField name="characters" label="Characters (blank means whitespace)" defaultValue={param("characters")} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "splitText") {
    return (
      <>
        <ColumnSelect name="column" label="Text column" columns={columns} defaultValue={param("column", columns[0])} />
        <TextField name="delimiter" label="Delimiter" defaultValue={param("delimiter", ",")} required />
        <TextField name="index" label="Part index" type="number" min={0} defaultValue={param("index", "0")} required />
        <TextField name="newColumn" label="New column" defaultValue={param("newColumn", "split_value")} required />
      </>
    );
  }
  if (["capitalizeText", "lowerText", "upperText", "minMaxScale", "floorNumber", "ceilNumber"].includes(kind)) {
    return (
      <>
        <ColumnSelect name="column" label="Column" columns={columns} defaultValue={param("column", columns[0])} />
        <TextField name="newColumn" label="Output column (blank replaces in place)" defaultValue={param("newColumn")} />
      </>
    );
  }
  if (kind === "roundNumber") {
    return (
      <>
        <ColumnSelect
          name="column"
          label="Numeric column"
          columns={columns}
          defaultValue={param("column", columns[0])}
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
        <ColumnSelect
          name="column"
          label="Date or datetime column"
          columns={columns}
          defaultValue={param("column", columns[0])}
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
        <ColumnsSelect name="keys" label="Group keys" columns={columns} defaultValue={initialColumns("keys")} />
        <Fieldset legend="Aggregations">
          {Array.from({ length: Math.max(aggregationRows, aggregations.length) }, (_, index) => (
            <div className="compoundRow aggregationRow" key={index}>
              <ColumnSelect
                name="aggregationColumn"
                label={`Value ${index + 1}`}
                columns={columns}
                defaultValue={String(aggregations[index]?.column ?? columns[0] ?? "")}
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
          Assign a Pandas or Polars dataframe to <code>result</code>. Custom code runs only in a trusted workspace.
        </small>
      </label>
    );
  }
  return null;
}

function buildParams(kind: OperationKind, form: FormData, filterModel: FilterModel): Record<string, unknown> {
  const value = (name: string) => String(form.get(name) ?? "");
  const optional = (target: Record<string, unknown>, name: string, transformed = value(name)) => {
    if (transformed !== "") target[name] = transformed;
  };
  if (kind === "sortRows") {
    const columns = form.getAll("sortColumn").map(String);
    const directions = form.getAll("sortDirection").map(String);
    const nulls = form.getAll("sortNulls").map(String);
    return { rules: columns.map((column, index) => ({ column, direction: directions[index], nulls: nulls[index] })) };
  }
  if (kind === "filterRows") return { filterModel };
  if (kind === "dropMissingRows") return { columns: form.getAll("columns").map(String), how: value("how") };
  if (kind === "dropDuplicates") {
    const params: Record<string, unknown> = { keep: value("keep") };
    const columns = form.getAll("columns").map(String);
    if (columns.length) params.columns = columns;
    return params;
  }
  if (kind === "selectColumns" || kind === "dropColumns") return { columns: form.getAll("columns").map(String) };
  if (kind === "oneHotEncode")
    return {
      columns: form.getAll("columns").map(String),
      prefixSeparator: value("prefixSeparator"),
      dropOriginal: form.has("dropOriginal")
    };
  if (kind === "renameColumn" || kind === "cloneColumn") return { column: value("column"), newName: value("newName") };
  if (kind === "castColumn") return { column: value("column"), dtype: value("dtype") };
  if (kind === "formula")
    return {
      leftColumn: value("leftColumn"),
      operator: value("operator"),
      newColumn: value("newColumn"),
      ...(value("operandMode") === "column" ? { rightColumn: value("rightColumn") } : { value: Number(value("value")) })
    };
  if (kind === "textLength") return { column: value("column"), newColumn: value("newColumn") };
  if (kind === "multiLabelBinarize") {
    const params: Record<string, unknown> = {
      column: value("column"),
      delimiter: value("delimiter"),
      dropOriginal: form.has("dropOriginal")
    };
    optional(params, "prefix");
    return params;
  }
  if (kind === "findReplace") {
    const params: Record<string, unknown> = {
      column: value("column"),
      find: value("find"),
      replacement: value("replacement"),
      regex: form.has("regex")
    };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "stripText") {
    const params: Record<string, unknown> = { column: value("column") };
    optional(params, "characters");
    optional(params, "newColumn");
    return params;
  }
  if (kind === "splitText")
    return {
      column: value("column"),
      delimiter: value("delimiter"),
      index: Number(value("index")),
      newColumn: value("newColumn")
    };
  if (["capitalizeText", "lowerText", "upperText", "minMaxScale", "floorNumber", "ceilNumber"].includes(kind)) {
    const params: Record<string, unknown> = { column: value("column") };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "roundNumber") {
    const params: Record<string, unknown> = { column: value("column"), decimals: Number(value("decimals")) };
    optional(params, "newColumn");
    return params;
  }
  if (kind === "formatDatetime") {
    const params: Record<string, unknown> = { column: value("column"), format: value("format") };
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
  return { code: value("code") };
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="formFieldset">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
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
