import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnSummary, ColumnVisualization, GridPage, SessionMetadata } from "../../shared/protocol";
import type { SortDirection } from "../../shared/filterModel";

interface DataGridProps {
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
  pageSize: number;
  goToColumn?: string;
  onPage(offset: number): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onOpenFilter(column: string): void;
}

export function DataGrid({
  metadata,
  page,
  summaries,
  pageSize,
  goToColumn,
  onPage,
  onSortColumn,
  onOpenFilter
}: DataGridProps): JSX.Element {
  const previousOffset = Math.max(0, page.offset - pageSize);
  const nextOffset = page.offset + pageSize;
  const canGoNext = nextOffset < page.totalRows;
  const summaryByColumn = useMemo(() => new Map(summaries.map((summary) => [summary.column, summary])), [summaries]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [showInsights, setShowInsights] = useState(true);

  useEffect(() => {
    if (!goToColumn) {
      return;
    }
    const target = scrollerRef.current?.querySelector<HTMLElement>(`[data-column="${cssEscape(goToColumn)}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    target?.focus();
  }, [goToColumn]);

  return (
    <div className="dataGrid">
      <div className="gridControls">
        <button type="button" disabled={page.offset === 0} onClick={() => onPage(previousOffset)}>
          Previous
        </button>
        <span>
          Rows {page.offset + 1}-{Math.min(page.offset + page.limit, page.totalRows)} of{" "}
          {page.totalRows.toLocaleString()}
        </span>
        <button type="button" disabled={!canGoNext} onClick={() => onPage(nextOffset)}>
          Next
        </button>
      </div>

      <div className="tableScroller" ref={scrollerRef}>
        <table>
          <thead>
            <tr>
              <th className="rowHeader">#</th>
              {metadata.schema.map((column) => (
                <th
                  key={column.name}
                  data-column={column.name}
                  tabIndex={-1}
                  title={`${column.rawType}${column.nullable ? " nullable" : ""}`}
                >
                  <div className="columnHeader">
                    <span className={`typeIcon codicon ${typeIcon(column.type)}`} aria-hidden="true" />
                    <span className="columnTitle">{column.name}</span>
                    <details className="columnMenu">
                      <summary aria-label={`Column actions for ${column.name}`}>...</summary>
                      <div className="columnMenuContent">
                        <button type="button" onClick={() => onOpenFilter(column.name)}>
                          Add filter
                        </button>
                        <button type="button" onClick={() => onSortColumn(column.name, "asc")}>
                          Sort ascending
                        </button>
                        <button type="button" onClick={() => onSortColumn(column.name, "desc")}>
                          Sort descending
                        </button>
                        <button type="button" onClick={() => setShowInsights((current) => !current)}>
                          {showInsights ? "Hide" : "Show"} column insights
                        </button>
                      </div>
                    </details>
                  </div>
                  <small>{column.type}</small>
                </th>
              ))}
            </tr>
            {showInsights && (
              <tr className="insightRow">
                <th className="rowHeader"> </th>
                {metadata.schema.map((column) => {
                  const summary = summaryByColumn.get(column.name);
                  return (
                    <th key={`${column.name}-insight`}>
                      {summary ? (
                        <div className="columnInsight">
                          <span>Missing {formatPercent(summary.nullCount + summary.nanCount, summary.totalCount)}</span>
                          <span>Distinct {formatPercent(summary.distinctCount ?? 0, summary.totalCount)}</span>
                          <MiniChart visualization={summary.visualization} />
                        </div>
                      ) : (
                        <span className="columnInsight emptyInsight">No summary</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.rowNumber}>
                <td className="rowHeader">{row.rowNumber + 1}</td>
                {row.values.map((cell, index) => (
                  <td
                    key={`${row.rowNumber}-${metadata.schema[index]?.name ?? index}`}
                    className={cell.isNull || cell.isNaN ? "missingCell" : undefined}
                    title={cell.display}
                  >
                    {cell.display}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniChart({ visualization }: { visualization: ColumnVisualization | undefined }): JSX.Element {
  if (!visualization) {
    return <span className="miniChart emptyInsight">No chart</span>;
  }
  if (visualization.kind === "numeric") {
    const max = Math.max(1, ...visualization.bins.map((bin) => bin.count));
    const width = 96;
    const height = 28;
    const barWidth = visualization.bins.length ? width / visualization.bins.length : width;
    return (
      <svg className="miniChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Numeric histogram">
        {visualization.bins.map((bin, index) => {
          const barHeight = Math.max(2, (bin.count / max) * height);
          return (
            <rect
              key={`${bin.min}-${bin.max}-${index}`}
              x={index * barWidth}
              y={height - barHeight}
              width={Math.max(1, barWidth - 1)}
              height={barHeight}
            />
          );
        })}
      </svg>
    );
  }
  if (visualization.kind === "boolean") {
    const total = Math.max(1, visualization.trueCount + visualization.falseCount);
    return (
      <span className="stackedMiniChart" title={`True ${visualization.trueCount}, False ${visualization.falseCount}`}>
        <i style={{ width: `${(visualization.trueCount / total) * 100}%` }} />
        <b style={{ width: `${(visualization.falseCount / total) * 100}%` }} />
      </span>
    );
  }
  if (visualization.kind === "categorical") {
    const max = Math.max(1, ...visualization.categories.map((category) => category.count), visualization.otherCount);
    return (
      <span className="categoryMiniChart">
        {visualization.categories.slice(0, 4).map((category) => (
          <i key={category.value} title={`${category.value}: ${category.count}`} style={{ width: `${(category.count / max) * 100}%` }} />
        ))}
      </span>
    );
  }
  return (
    <span className="datetimeMiniChart" title={`${visualization.min ?? "n/a"} - ${visualization.max ?? "n/a"}`}>
      {visualization.min ?? "n/a"} - {visualization.max ?? "n/a"}
    </span>
  );
}

function typeIcon(type: string): string {
  if (type === "integer" || type === "float") {
    return "codicon-symbol-numeric";
  }
  if (type === "boolean") {
    return "codicon-symbol-boolean";
  }
  if (type === "datetime" || type === "date") {
    return "codicon-calendar";
  }
  return "codicon-symbol-string";
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  const percentage = (value / total) * 100;
  return `${percentage < 1 && percentage > 0 ? "<1" : Math.round(percentage).toLocaleString()}%`;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}
