import type { ColumnSchema, ColumnSummary, SessionMetadata } from "../../shared/protocol";

interface SummaryPanelProps {
  metadata: SessionMetadata | undefined;
  summaries: ColumnSummary[];
  schemaByName: Map<string, ColumnSchema>;
}

export function SummaryPanel({ metadata, summaries, schemaByName }: SummaryPanelProps) {
  const missingByColumn = metadata?.stats?.missingValuesByColumn.filter((item) => item.count > 0) ?? [];

  return (
    <section className="panel summaryPanel">
      <h2>Data Summary</h2>
      <dl className="dataSummaryStats">
        <dt>Data shape</dt>
        <dd>
          {metadata
            ? `${metadata.filteredShape.rows.toLocaleString()} rows x ${metadata.filteredShape.columns.toLocaleString()} columns`
            : "Loading"}
        </dd>
        <dt>Columns</dt>
        <dd>{metadata?.shape.columns.toLocaleString() ?? "-"}</dd>
        <dt>Rows</dt>
        <dd>{metadata?.filteredShape.rows.toLocaleString() ?? "-"}</dd>
        <dt>Missing cells</dt>
        <dd>{metadata?.stats?.missingCells.toLocaleString() ?? "-"}</dd>
        <dt>Duplicate rows</dt>
        <dd>{metadata?.stats?.duplicateRows.toLocaleString() ?? "-"}</dd>
      </dl>
      <details className="summaryGroup" open={missingByColumn.length > 0}>
        <summary>Missing values (by column)</summary>
        {missingByColumn.length === 0 ? (
          <p className="mutedText">No missing values.</p>
        ) : (
          <div className="missingList">
            {missingByColumn.map((item) => (
              <div key={item.column} className="barRow">
                <span>{item.column}</span>
                <meter min={0} max={metadata?.filteredShape.rows ?? 1} value={item.count} />
                <small>{item.count.toLocaleString()}</small>
              </div>
            ))}
          </div>
        )}
      </details>

      <h3>Column Summary</h3>
      {summaries.length === 0 && <p>No summary data yet.</p>}
      {summaries.map((summary) => {
        const schema = schemaByName.get(summary.column);
        return (
          <details key={summary.column} className="summaryGroup" open={summaries.length <= 6}>
            <summary>
              <span>{summary.column}</span>
              <small>{schema?.rawType ?? summary.rawType}</small>
            </summary>
            <dl>
              <dt>Missing</dt>
              <dd>{summary.nullCount.toLocaleString()}</dd>
              <dt>Distinct</dt>
              <dd>{summary.distinctCount?.toLocaleString() ?? "n/a"}</dd>
              {summary.numeric && (
                <>
                  <dt>Min</dt>
                  <dd>{formatNumber(summary.numeric.min)}</dd>
                  <dt>Max</dt>
                  <dd>{formatNumber(summary.numeric.max)}</dd>
                  <dt>Mean</dt>
                  <dd>{formatNumber(summary.numeric.mean)}</dd>
                </>
              )}
            </dl>
            {summary.topValues.length > 0 && (
              <div className="topValues">
                {summary.topValues.map((item) => (
                  <div key={item.value} className="barRow">
                    <span>{item.value}</span>
                    <meter min={0} max={summary.topValues[0]?.count ?? 1} value={item.count} />
                    <small>{item.count}</small>
                  </div>
                ))}
              </div>
            )}
          </details>
        );
      })}
    </section>
  );
}

const formatNumber = (value: number | undefined): string => {
  if (value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
