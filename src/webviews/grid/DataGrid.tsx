import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  CellDiff,
  CellValue,
  ColumnSchema,
  ColumnSummary,
  ColumnVisualization,
  DataDiff,
  GridPage,
  SessionMetadata
} from "../../shared/protocol";
import type { SortDirection } from "../../shared/filterModel";
import { supportsTypedViewComparison } from "../../shared/filterModel";
import type { GridViewState } from "../../shared/viewState";

interface DataGridProps {
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
  pageSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  busy?: boolean;
  projecting?: boolean;
  viewContextId?: string;
  goToColumn?: string;
  viewState?: GridViewState;
  viewStateRestoreVersion?: number;
  diff?: DataDiff;
  beforePage?: GridPage;
  beforeSchema?: ColumnSchema[];
  viewControlsDisabled?: boolean;
  onPage(offset: number): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onOpenFilter(column: string): void;
  onVisibleColumnRangeChange?(range: VisibleColumnRange): void;
  onVisibleSummaryColumnsChange(columns: string[]): void;
  onViewStateChange?(state: GridViewState): void;
}

export interface VisibleColumnRange {
  start: number;
  end: number;
}

interface ProgrammaticViewportTarget {
  firstVisibleRow: number;
  scrollTop: number;
  scrollLeft: number;
}

const rowHeight = 29;
const rowHeaderWidth = 58;
const overscanRows = 8;
const overscanColumns = 2;
const scrollQuantizationTolerance = 1;
const maximumRenderedCellCharacters = 4_096;
const defaultViewState: GridViewState = { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } };
const ignoreViewStateChange = (): void => undefined;
const ignoreVisibleColumnRangeChange = (): void => undefined;

export function DataGrid({
  metadata,
  page,
  summaries,
  pageSize,
  defaultColumnWidth,
  insightsOnOpen,
  busy = false,
  projecting = false,
  viewContextId,
  goToColumn,
  viewState = defaultViewState,
  viewStateRestoreVersion = 0,
  diff,
  beforePage,
  beforeSchema,
  viewControlsDisabled = false,
  onPage,
  onSortColumn,
  onOpenFilter,
  onVisibleColumnRangeChange = ignoreVisibleColumnRangeChange,
  onVisibleSummaryColumnsChange,
  onViewStateChange = ignoreViewStateChange
}: DataGridProps) {
  const summaryByColumn = useMemo(() => new Map(summaries.map((summary) => [summary.column, summary])), [summaries]);
  const diffPresentation = useMemo(
    () => buildDiffPresentation(diff, page, metadata.schema, beforePage, beforeSchema),
    [beforePage, beforeSchema, diff, metadata.schema, page]
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const visibleColumnRangeHandler = useRef(onVisibleColumnRangeChange);
  const requestedOffset = useRef(page.offset);
  const logicalViewContext = viewContextId ?? `${metadata.sessionId}:${metadata.revision}`;
  const previousViewContext = useRef(logicalViewContext);
  const focusRequested = useRef(false);
  const preserveGridFocusAfterScroll = useRef(false);
  const programmaticViewportTarget = useRef<ProgrammaticViewportTarget | undefined>(undefined);
  const viewStateRef = useRef(viewState);
  const restorationRef = useRef({ viewState, metadata, page, pageSize });
  useLayoutEffect(() => {
    restorationRef.current = { viewState, metadata, page, pageSize };
  }, [metadata, page, pageSize, viewState]);
  const [showInsights, setShowInsights] = useState(insightsOnOpen);
  const [viewport, setViewport] = useState({ scrollLeft: 0, scrollTop: 0, width: 1200, height: 600 });
  const [focusedCell, setFocusedCell] = useState({
    row: viewState.viewport.firstVisibleRow,
    column: selectedColumnPosition(metadata.schema, viewState.selectedColumnId)
  });

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    visibleColumnRangeHandler.current = onVisibleColumnRangeChange;
  }, [onVisibleColumnRangeChange]);

  const reportViewState = useCallback(
    (next: GridViewState): void => {
      viewStateRef.current = next;
      onViewStateChange(next);
    },
    [onViewStateChange]
  );

  useLayoutEffect(() => {
    if (previousViewContext.current === logicalViewContext) return;
    previousViewContext.current = logicalViewContext;
    requestedOffset.current = page.offset;
    focusRequested.current = false;
    preserveGridFocusAfterScroll.current = false;
    const column = selectedColumnPosition(metadata.schema, viewStateRef.current.selectedColumnId);
    const selectedColumnId = metadata.schema[column]?.id;
    setFocusedCell({ row: page.rows[0]?.rowNumber ?? page.offset, column });
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollTop = page.offset * rowHeight;
    const scrollLeft = viewStateRef.current.viewport.scrollLeft;
    programmaticViewportTarget.current = { firstVisibleRow: page.offset, scrollTop, scrollLeft };
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = scrollLeft;
    setViewport({
      scrollLeft,
      scrollTop,
      width: scroller.clientWidth,
      height: scroller.clientHeight
    });
    reportViewState({
      ...viewStateRef.current,
      ...(selectedColumnId ? { selectedColumnId } : {}),
      viewport: { firstVisibleRow: page.offset, scrollLeft }
    });
  }, [logicalViewContext, metadata.schema, page.offset, page.rows, reportViewState]);

  useLayoutEffect(() => {
    const restoration = restorationRef.current;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const row = Math.max(
      0,
      Math.min(restoration.viewState.viewport.firstVisibleRow, Math.max(0, restoration.page.totalRows - 1))
    );
    const column = selectedColumnPosition(restoration.metadata.schema, restoration.viewState.selectedColumnId);
    requestedOffset.current = Math.floor(row / restoration.pageSize) * restoration.pageSize;
    focusRequested.current = false;
    preserveGridFocusAfterScroll.current = false;
    setFocusedCell({ row, column });
    const scrollTop = row * rowHeight;
    const scrollLeft = restoration.viewState.viewport.scrollLeft;
    programmaticViewportTarget.current = { firstVisibleRow: row, scrollTop, scrollLeft };
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = scrollLeft;
    setViewport({
      scrollLeft,
      scrollTop,
      width: scroller.clientWidth,
      height: scroller.clientHeight
    });
  }, [viewStateRestoreVersion]);

  useEffect(() => {
    requestedOffset.current = page.offset;
  }, [page.offset]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      preserveGridFocusAfterScroll.current = !focusRequested.current && scroller.contains(document.activeElement);
      const target = programmaticViewportTarget.current;
      const targetStillQuantized =
        target !== undefined &&
        Math.abs(scroller.scrollTop - target.scrollTop) <= scrollQuantizationTolerance &&
        Math.abs(scroller.scrollLeft - target.scrollLeft) <= scrollQuantizationTolerance;
      if (target && !targetStillQuantized) programmaticViewportTarget.current = undefined;
      const scrollTop = targetStillQuantized ? target.scrollTop : scroller.scrollTop;
      const scrollLeft = targetStillQuantized ? target.scrollLeft : scroller.scrollLeft;
      const next = {
        scrollLeft,
        scrollTop,
        width: scroller.clientWidth,
        height: scroller.clientHeight
      };
      setViewport(next);
      const row = targetStillQuantized
        ? target.firstVisibleRow
        : firstVisibleRowFromScrollTop(next.scrollTop, page.totalRows);
      const currentViewState = viewStateRef.current;
      if (
        currentViewState.viewport.firstVisibleRow !== row ||
        currentViewState.viewport.scrollLeft !== next.scrollLeft
      ) {
        reportViewState({
          ...currentViewState,
          viewport: { firstVisibleRow: row, scrollLeft: next.scrollLeft }
        });
      }
      const offset = Math.floor(row / pageSize) * pageSize;
      if (!busy && offset !== requestedOffset.current && offset < page.totalRows) {
        requestedOffset.current = offset;
        preserveGridFocusAfterScroll.current = false;
        focusRequested.current = true;
        setFocusedCell((current) => ({ row, column: current.column }));
        onPage(offset);
      }
    };
    const clearProgrammaticTarget = () => {
      programmaticViewportTarget.current = undefined;
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    scroller.addEventListener("wheel", clearProgrammaticTarget, { passive: true });
    scroller.addEventListener("pointerdown", clearProgrammaticTarget, { passive: true });
    scroller.addEventListener("touchstart", clearProgrammaticTarget, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      scroller.removeEventListener("wheel", clearProgrammaticTarget);
      scroller.removeEventListener("pointerdown", clearProgrammaticTarget);
      scroller.removeEventListener("touchstart", clearProgrammaticTarget);
      window.removeEventListener("resize", update);
    };
  }, [busy, onPage, page.totalRows, pageSize, reportViewState]);

  const widths = useMemo(
    () => metadata.schema.map((column) => viewState.columnWidths[column.id] ?? defaultColumnWidth),
    [defaultColumnWidth, metadata.schema, viewState.columnWidths]
  );
  const visibleColumnRange = columnRange(widths, viewport.scrollLeft, viewport.width);
  const visibleColumns = useMemo(
    () => metadata.schema.slice(visibleColumnRange.start, visibleColumnRange.end),
    [metadata.schema, visibleColumnRange.end, visibleColumnRange.start]
  );
  const pageColumnPositionById = useMemo(
    () => new Map(page.columnIds.map((columnId, position) => [columnId, position])),
    [page.columnIds]
  );
  const loadedColumnSignature = page.columnIds.join("\u0000");
  const leftSpacerWidth = sum(widths.slice(0, visibleColumnRange.start));
  const rightSpacerWidth = sum(widths.slice(visibleColumnRange.end));
  const renderedColumnCount = 1 + visibleColumns.length + Number(leftSpacerWidth > 0) + Number(rightSpacerWidth > 0);
  const viewScope = `${metadata.sessionId}:${metadata.revision}:${JSON.stringify({
    logic: metadata.filterModel.logic ?? "and",
    filters: metadata.filterModel.filters,
    sort: metadata.filterModel.sort
  })}`;
  const globalFirstRow = firstVisibleRowFromScrollTop(viewport.scrollTop, page.totalRows);
  const localStart = Math.max(0, globalFirstRow - page.offset - overscanRows);
  const visibleRowCount = Math.ceil(viewport.height / rowHeight) + overscanRows * 2;
  const localEnd = Math.min(page.rows.length, localStart + visibleRowCount);
  const visibleRows = page.rows.slice(localStart, localEnd);
  const rovingRow = visibleRows.some((row) => row.rowNumber === focusedCell.row)
    ? focusedCell.row
    : visibleRows[0]?.rowNumber;
  const rovingColumn = visibleColumns.some((column) => column.position === focusedCell.column)
    ? focusedCell.column
    : visibleColumns[0]?.position;
  const topSpacerHeight = (page.offset + localStart) * rowHeight;
  const bottomSpacerHeight = Math.max(0, page.totalRows - (page.offset + localEnd)) * rowHeight;

  useLayoutEffect(() => {
    if (!preserveGridFocusAfterScroll.current) return;
    preserveGridFocusAfterScroll.current = false;
    if (focusRequested.current) return;
    if (rovingRow === undefined || rovingColumn === undefined) return;
    const selector = `[data-grid-row="${rovingRow}"][data-grid-column="${rovingColumn}"]`;
    scrollerRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [rovingColumn, rovingRow]);

  useEffect(() => {
    onVisibleSummaryColumnsChange(showInsights ? visibleColumns.map((column) => column.name) : []);
  }, [onVisibleSummaryColumnsChange, showInsights, viewScope, visibleColumns]);

  useEffect(() => {
    visibleColumnRangeHandler.current({ start: visibleColumnRange.start, end: visibleColumnRange.end });
  }, [busy, loadedColumnSignature, logicalViewContext, page.offset, visibleColumnRange.end, visibleColumnRange.start]);

  useEffect(
    () => () => {
      onVisibleSummaryColumnsChange([]);
    },
    [onVisibleSummaryColumnsChange]
  );

  useEffect(() => {
    if (!goToColumn) return;
    const index = metadata.schema.findIndex((column) => column.name === goToColumn);
    if (index < 0) return;
    const animationFrame = window.requestAnimationFrame(() => {
      preserveGridFocusAfterScroll.current = false;
      focusRequested.current = true;
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollLeft = Math.max(0, sum(widths.slice(0, index)) - scroller.clientWidth / 3);
      setFocusedCell((current) => ({ ...current, column: index }));
      const currentViewState = viewStateRef.current;
      reportViewState({
        ...currentViewState,
        selectedColumnId: metadata.schema[index].id,
        viewport: {
          ...currentViewState.viewport,
          scrollLeft: scroller?.scrollLeft ?? currentViewState.viewport.scrollLeft
        }
      });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [goToColumn, metadata.schema, reportViewState, widths]);

  useEffect(() => {
    if (!focusRequested.current) return;
    const selector = `[data-grid-row="${focusedCell.row}"][data-grid-column="${focusedCell.column}"]`;
    const target = scrollerRef.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    focusRequested.current = false;
    target.focus({ preventScroll: true });
  }, [focusedCell, page.offset, visibleColumnRange.start, localStart]);

  const goToPage = (offset: number, restoreFocus = false) => {
    if (busy) return;
    programmaticViewportTarget.current = undefined;
    const bounded = Math.max(0, Math.min(offset, Math.max(0, page.totalRows - 1)));
    const block = Math.floor(bounded / pageSize) * pageSize;
    requestedOffset.current = block;
    if (restoreFocus) {
      preserveGridFocusAfterScroll.current = false;
      focusRequested.current = true;
    }
    setFocusedCell((current) => ({ row: bounded, column: current.column }));
    if (scrollerRef.current) scrollerRef.current.scrollTop = bounded * rowHeight;
    onPage(block);
  };

  return (
    <div className="dataGrid">
      <div className="gridControls" aria-live="polite">
        <button type="button" disabled={busy || page.offset === 0} onClick={() => goToPage(page.offset - pageSize)}>
          Previous block
        </button>
        <span>
          {page.totalRows === 0
            ? "No rows"
            : `Loaded rows ${page.offset + 1}–${Math.min(page.offset + page.rows.length, page.totalRows)} of ${page.totalRows.toLocaleString()}`}
        </span>
        <button
          type="button"
          disabled={busy || page.offset + pageSize >= page.totalRows}
          onClick={() => goToPage(page.offset + pageSize)}
        >
          Next block
        </button>
        <button type="button" className="secondaryButton" onClick={() => setShowInsights((current) => !current)}>
          {showInsights ? "Hide" : "Show"} insights
        </button>
      </div>

      {diffPresentation && (diffPresentation.addedColumns.length > 0 || diffPresentation.removedColumns.length > 0) && (
        <section className="gridColumnChanges" aria-label="Column changes">
          <strong>Column changes</strong>
          <ul>
            {diffPresentation.addedColumns.map((column, index) => (
              <li
                key={`added-${column.name}-${index}`}
                className="gridColumnChange"
                data-diff-state="added"
                aria-label={`Added column ${column.name}${column.rawType ? `, type ${column.rawType}` : ""}`}
              >
                <span className="codicon codicon-add" aria-hidden="true" />
                <span>Added: {column.name}</span>
              </li>
            ))}
            {diffPresentation.removedColumns.map((column, index) => (
              <li
                key={`removed-${column.name}-${index}`}
                className="gridColumnChange"
                data-diff-state="removed"
                aria-label={`Removed column ${column.name}${column.rawType ? `, previous type ${column.rawType}` : ""}`}
              >
                <span className="codicon codicon-remove" aria-hidden="true" />
                <span>Removed: {column.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="tableScroller" ref={scrollerRef} data-testid="data-grid-scroller">
        <table
          role="grid"
          aria-busy={busy || projecting}
          aria-label={`Data grid for ${metadata.source.label}`}
          aria-rowcount={page.totalRows + 1}
          aria-colcount={metadata.schema.length + 1}
        >
          <colgroup>
            <col style={{ width: rowHeaderWidth }} />
            {leftSpacerWidth > 0 && <col style={{ width: leftSpacerWidth }} />}
            {visibleColumns.map((column) => (
              <col key={column.id} style={{ width: widths[column.position] }} />
            ))}
            {rightSpacerWidth > 0 && <col style={{ width: rightSpacerWidth }} />}
          </colgroup>
          <thead>
            <tr>
              <th className="rowHeader" aria-label="Row number">
                #
              </th>
              {leftSpacerWidth > 0 && <th className="virtualSpacer" aria-hidden="true" />}
              {visibleColumns.map((column) => (
                <ColumnHeader
                  key={column.id}
                  column={column}
                  ariaColumnIndex={column.position + 2}
                  width={widths[column.position]}
                  selected={viewState.selectedColumnId === column.id}
                  added={diffPresentation?.addedColumnIds.has(column.id) ?? false}
                  showInsights={showInsights}
                  summary={summaryByColumn.get(column.name)}
                  viewControlsDisabled={viewControlsDisabled}
                  onOpenFilter={(name) => {
                    reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                    onOpenFilter(name);
                  }}
                  onSortColumn={onSortColumn}
                  onResize={(width) =>
                    reportViewState({
                      ...viewStateRef.current,
                      columnWidths: { ...viewStateRef.current.columnWidths, [column.id]: width }
                    })
                  }
                />
              ))}
              {rightSpacerWidth > 0 && <th className="virtualSpacer" aria-hidden="true" />}
            </tr>
          </thead>
          <tbody>
            {topSpacerHeight > 0 && (
              <tr className="virtualRowSpacer" aria-hidden="true">
                <td colSpan={renderedColumnCount} style={{ height: topSpacerHeight }} />
              </tr>
            )}
            {visibleRows.map((row) => (
              <tr key={row.id} aria-rowindex={row.rowNumber + 2} style={{ height: rowHeight }}>
                <td className="rowHeader">{row.rowNumber + 1}</td>
                {leftSpacerWidth > 0 && <td className="virtualSpacer" aria-hidden="true" />}
                {visibleColumns.map((column) => {
                  const localColumnPosition = pageColumnPositionById.get(column.id);
                  const cell = localColumnPosition === undefined ? undefined : row.values[localColumnPosition];
                  const cellUnavailable = localColumnPosition === undefined;
                  const cellDiff = diffPresentation?.changedCells.get(diffCellKey(row.rowNumber, column.id));
                  const addedColumn = diffPresentation?.addedColumnIds.has(column.id) ?? false;
                  const renderedCell = boundedGridText(cell?.display);
                  const diffLabel = cellDiff
                    ? changedCellLabel(column.name, row.rowNumber, cellDiff)
                    : addedColumn
                      ? addedCellLabel(column.name, row.rowNumber, cell)
                      : undefined;
                  const accessibleLabel =
                    diffLabel ?? (cellUnavailable ? `Loading ${column.name}, row ${row.rowNumber + 1}` : undefined);
                  return (
                    <td
                      key={`${row.id}-${column.id}`}
                      data-grid-row={row.rowNumber}
                      data-grid-column={column.position}
                      aria-colindex={column.position + 2}
                      aria-selected={viewState.selectedColumnId === column.id}
                      aria-label={accessibleLabel}
                      data-diff-state={cellDiff ? "changed" : addedColumn ? "added" : undefined}
                      tabIndex={rovingRow === row.rowNumber && rovingColumn === column.position ? 0 : -1}
                      className={[
                        cell?.isNull || cell?.isNaN ? "missingCell" : "",
                        viewState.selectedColumnId === column.id ? "selectedColumn" : "",
                        cellDiff ? "diffChangedCell" : "",
                        addedColumn ? "diffAddedColumn" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={accessibleLabel ?? renderedCell}
                      onFocus={() => {
                        focusRequested.current = false;
                        setFocusedCell({ row: row.rowNumber, column: column.position });
                        reportViewState({ ...viewStateRef.current, selectedColumnId: column.id });
                      }}
                      onKeyDown={(event) =>
                        navigateGrid(event, row.rowNumber, column.position, metadata.schema.length, page.totalRows)
                      }
                    >
                      {renderedCell}
                    </td>
                  );
                })}
                {rightSpacerWidth > 0 && <td className="virtualSpacer" aria-hidden="true" />}
              </tr>
            ))}
            {bottomSpacerHeight > 0 && (
              <tr className="virtualRowSpacer" aria-hidden="true">
                <td colSpan={renderedColumnCount} style={{ height: bottomSpacerHeight }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  function navigateGrid(
    event: ReactKeyboardEvent<HTMLTableCellElement>,
    row: number,
    column: number,
    columnCount: number,
    rowCount: number
  ): void {
    let nextRow = row;
    let nextColumn = column;
    const measuredViewportHeight = scrollerRef.current?.clientHeight ?? viewport.height;
    const pageRowCount = Math.max(1, Math.floor(measuredViewportHeight / rowHeight));
    if (event.key === "ArrowRight") nextColumn += 1;
    else if (event.key === "ArrowLeft") nextColumn -= 1;
    else if (event.key === "ArrowDown") nextRow += 1;
    else if (event.key === "ArrowUp") nextRow -= 1;
    else if (event.key === "Home") nextColumn = 0;
    else if (event.key === "End") nextColumn = columnCount - 1;
    else if (event.key === "PageDown") nextRow += pageRowCount;
    else if (event.key === "PageUp") nextRow -= pageRowCount;
    else return;
    programmaticViewportTarget.current = undefined;
    nextRow = Math.max(0, Math.min(nextRow, rowCount - 1));
    nextColumn = Math.max(0, Math.min(nextColumn, columnCount - 1));
    const block = Math.floor(nextRow / pageSize) * pageSize;
    if (busy && block !== page.offset) return;
    event.preventDefault();
    preserveGridFocusAfterScroll.current = false;
    focusRequested.current = true;
    setFocusedCell({ row: nextRow, column: nextColumn });
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTop = Math.max(0, nextRow * rowHeight - scroller.clientHeight / 2);
      scroller.scrollLeft = Math.max(0, sum(widths.slice(0, nextColumn)) - scroller.clientWidth / 3);
    }
    const currentViewState = viewStateRef.current;
    reportViewState({
      ...currentViewState,
      selectedColumnId: metadata.schema[nextColumn]?.id,
      viewport: {
        firstVisibleRow: firstVisibleRowFromScrollTop(scroller?.scrollTop ?? 0, page.totalRows),
        scrollLeft: scroller?.scrollLeft ?? currentViewState.viewport.scrollLeft
      }
    });
    if (block !== page.offset) goToPage(nextRow, true);
  }
}

function boundedGridText(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= maximumRenderedCellCharacters) return value;
  let end = maximumRenderedCellCharacters;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function firstVisibleRowFromScrollTop(scrollTop: number, totalRows: number): number {
  const unboundedRow = scrollTop / rowHeight;
  const nearestRow = Math.round(unboundedRow);
  const row =
    Math.abs(scrollTop - nearestRow * rowHeight) <= scrollQuantizationTolerance ? nearestRow : Math.floor(unboundedRow);
  return Math.max(0, Math.min(row, Math.max(0, totalRows - 1)));
}

interface GridDiffPresentation {
  addedColumnIds: Set<string>;
  addedColumns: Array<{ name: string; rawType: string | undefined }>;
  removedColumns: Array<{ name: string; rawType: string | undefined }>;
  changedCells: Map<string, CellDiff>;
}

function buildDiffPresentation(
  diff: DataDiff | undefined,
  page: GridPage,
  schema: ColumnSchema[],
  beforePage: GridPage | undefined,
  beforeSchema: ColumnSchema[] | undefined
): GridDiffPresentation | undefined {
  if (!diff) return undefined;

  const addedColumnIds = resolveAddedColumnIds(diff.addedColumns, schema, beforeSchema);
  const changedCells = new Map<string, CellDiff>();
  const rowsByNumber = new Map(page.rows.map((row) => [row.rowNumber, row]));
  const beforeRowsById = new Map(beforePage?.rows.map((row) => [row.id, row]) ?? []);
  const pagePositionById = new Map(page.columnIds.map((columnId, position) => [columnId, position]));
  const beforePositionById = new Map(beforePage?.columnIds.map((columnId, position) => [columnId, position]) ?? []);
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  const comparableColumns = page.columnIds.flatMap((columnId, afterPosition) => {
    const column = schemaById.get(columnId);
    const beforePosition = beforePositionById.get(columnId);
    return column && beforePosition !== undefined ? [{ column, beforePosition, afterPosition }] : [];
  });
  const rememberChangedCell = (columnId: string, cellDiff: CellDiff) => {
    changedCells.set(diffCellKey(cellDiff.rowNumber, columnId), cellDiff);
  };

  if (beforePage && beforeSchema) {
    for (const row of page.rows) {
      const beforeRow = beforeRowsById.get(row.id);
      if (!beforeRow) continue;
      for (const { column, beforePosition, afterPosition } of comparableColumns) {
        const before = beforeRow.values[beforePosition];
        const after = row.values[afterPosition];
        if (!before || !after || sameCellValue(before, after)) continue;
        rememberChangedCell(column.id, {
          rowNumber: row.rowNumber,
          columnId: column.id,
          column: column.name,
          before,
          after
        });
      }
    }
  }

  for (const cellDiff of diff.cells) {
    const key = diffCellKey(cellDiff.rowNumber, cellDiff.columnId);
    if (changedCells.has(key)) continue;
    const row = rowsByNumber.get(cellDiff.rowNumber);
    if (!row) continue;
    const afterPosition = pagePositionById.get(cellDiff.columnId);
    if (afterPosition === undefined || !sameCellValue(row.values[afterPosition], cellDiff.after)) continue;
    rememberChangedCell(cellDiff.columnId, cellDiff);
  }

  return {
    addedColumnIds,
    addedColumns: diff.addedColumns.map((name) => ({
      name,
      rawType: schema.find((column) => column.name === name)?.rawType
    })),
    removedColumns: diff.removedColumns.map((name) => ({
      name,
      rawType: beforeSchema?.find((column) => column.name === name)?.rawType
    })),
    changedCells
  };
}

function resolveAddedColumnIds(
  addedColumnNames: string[],
  schema: ColumnSchema[],
  beforeSchema: ColumnSchema[] | undefined
): Set<string> {
  const remainingByName = countNames(addedColumnNames);
  const beforeIds = new Set(beforeSchema?.map((column) => column.id) ?? []);
  const addedIds = new Set<string>();
  const takeMatchingColumns = (columns: ColumnSchema[]) => {
    for (const column of columns) {
      const remaining = remainingByName.get(column.name) ?? 0;
      if (remaining <= 0 || addedIds.has(column.id)) continue;
      addedIds.add(column.id);
      remainingByName.set(column.name, remaining - 1);
    }
  };
  if (beforeSchema) takeMatchingColumns(schema.filter((column) => !beforeIds.has(column.id)));
  takeMatchingColumns(schema);
  return addedIds;
}

function countNames(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function sameCellValue(left: CellValue | null | undefined, right: CellValue | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.kind === right.kind &&
    left.display === right.display &&
    left.isNull === right.isNull &&
    left.isNaN === right.isNaN &&
    left.sign === right.sign &&
    sameJsonValue(left.raw, right.raw)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]))
  );
}

function diffCellKey(rowNumber: number, columnId: string): string {
  return `${rowNumber}\u0000${columnId}`;
}

function changedCellLabel(column: string, rowNumber: number, diff: CellDiff): string {
  return `${column}, row ${rowNumber + 1}: changed from ${describeCellValue(diff.before)} to ${describeCellValue(diff.after)}`;
}

function addedCellLabel(column: string, rowNumber: number, value: CellValue | undefined): string {
  return `${column}, row ${rowNumber + 1}: added column; before column absent; after ${describeCellValue(value)}`;
}

function describeCellValue(value: CellValue | null | undefined): string {
  if (!value) return "no value";
  if (value.isNull) return "null";
  if (value.isNaN) return "NaN";
  if (value.display.length === 0) return value.kind === "string" ? "empty string" : "empty value";
  const normalized = value.display.replace(/\s+/gu, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
}

function ColumnHeader({
  column,
  ariaColumnIndex,
  width,
  selected,
  added,
  showInsights,
  summary,
  viewControlsDisabled,
  onOpenFilter,
  onSortColumn,
  onResize
}: {
  column: ColumnSchema;
  ariaColumnIndex: number;
  width: number;
  selected: boolean;
  added: boolean;
  showInsights: boolean;
  summary: ColumnSummary | undefined;
  viewControlsDisabled: boolean;
  onOpenFilter(column: string): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onResize(width: number): void;
}) {
  const disabledDescriptionId = `column-view-controls-disabled-${column.position}`;
  const comparisonUnavailable = !supportsTypedViewComparison(column.type);
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const move = (moveEvent: PointerEvent) => onResize(Math.max(80, Math.min(640, width + moveEvent.clientX - start)));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") onResize(Math.max(80, width - 10));
    else if (event.key === "ArrowRight") onResize(Math.min(640, width + 10));
    else if (event.key === "Home") onResize(80);
    else if (event.key === "End") onResize(640);
    else return;
    event.preventDefault();
  };

  return (
    <th
      data-column={column.name}
      aria-colindex={ariaColumnIndex}
      aria-selected={selected}
      aria-label={added ? `${column.name}, added column` : undefined}
      data-diff-state={added ? "added" : undefined}
      className={[selected ? "selectedColumn" : "", added ? "diffAddedColumn" : ""].filter(Boolean).join(" ")}
      title={`${column.rawType}${column.nullable ? " nullable" : ""}${added ? ", added column" : ""}`}
    >
      <div className="columnHeader">
        <span className={`typeIcon codicon ${typeIcon(column.type)}`} aria-hidden="true" />
        <span className="columnTitle">{column.name}</span>
        <details className="columnMenu">
          <summary aria-label={`Column actions for ${column.name}`} className="codicon codicon-ellipsis" />
          <div className="columnMenuContent">
            {viewControlsDisabled && (
              <span id={disabledDescriptionId} className="columnMenuNotice">
                View controls are unavailable while inspecting an applied step.
              </span>
            )}
            <button
              type="button"
              disabled={viewControlsDisabled}
              aria-describedby={viewControlsDisabled ? disabledDescriptionId : undefined}
              title={viewControlsDisabled ? "Unavailable while inspecting an applied step" : undefined}
              onClick={() => onOpenFilter(column.name)}
            >
              Filter…
            </button>
            <button
              type="button"
              disabled={viewControlsDisabled || comparisonUnavailable}
              aria-describedby={viewControlsDisabled ? disabledDescriptionId : undefined}
              title={
                viewControlsDisabled
                  ? "Unavailable while inspecting an applied step"
                  : comparisonUnavailable
                    ? `Sorting is unavailable for ${column.type} columns`
                    : undefined
              }
              onClick={() => onSortColumn(column.name, "asc")}
            >
              Sort ascending
            </button>
            <button
              type="button"
              disabled={viewControlsDisabled || comparisonUnavailable}
              aria-describedby={viewControlsDisabled ? disabledDescriptionId : undefined}
              title={
                viewControlsDisabled
                  ? "Unavailable while inspecting an applied step"
                  : comparisonUnavailable
                    ? `Sorting is unavailable for ${column.type} columns`
                    : undefined
              }
              onClick={() => onSortColumn(column.name, "desc")}
            >
              Sort descending
            </button>
          </div>
        </details>
        <button
          type="button"
          className="columnResizeHandle codicon codicon-gripper"
          aria-label={`Resize ${column.name} column`}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
        />
      </div>
      <small>{column.rawType}</small>
      {showInsights &&
        (summary ? (
          <div className="columnInsight">
            <span>Missing {formatPercent(summary.nullCount + summary.nanCount, summary.totalCount)}</span>
            <span>Distinct {formatPercent(summary.distinctCount ?? 0, summary.totalCount)}</span>
            {summary.sampled && <span className="sampledLabel">Sampled</span>}
            <MiniChart visualization={summary.visualization} />
          </div>
        ) : (
          <span className="columnInsight emptyInsight">Profiling…</span>
        ))}
    </th>
  );
}

function MiniChart({ visualization }: { visualization: ColumnVisualization | undefined }) {
  if (!visualization) return <span className="miniChart emptyInsight">No chart</span>;
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
          <i
            key={category.value}
            title={`${category.value}: ${category.count}`}
            style={{ width: `${(category.count / max) * 100}%` }}
          />
        ))}
      </span>
    );
  }
  return (
    <span className="datetimeMiniChart" title={`${visualization.min ?? "n/a"} – ${visualization.max ?? "n/a"}`}>
      {visualization.min ?? "n/a"} – {visualization.max ?? "n/a"}
    </span>
  );
}

function columnRange(widths: number[], scrollLeft: number, viewportWidth: number): { start: number; end: number } {
  let position = 0;
  let start = 0;
  while (start < widths.length && position + widths[start] < Math.max(0, scrollLeft - rowHeaderWidth)) {
    position += widths[start];
    start += 1;
  }
  let end = start;
  let visibleWidth = position;
  while (end < widths.length && visibleWidth < scrollLeft + viewportWidth) {
    visibleWidth += widths[end];
    end += 1;
  }
  return {
    start: Math.max(0, start - overscanColumns),
    end: Math.min(widths.length, end + overscanColumns)
  };
}

function selectedColumnPosition(schema: ColumnSchema[], selectedColumnId: string | undefined): number {
  if (!schema.length) return 0;
  const selected = selectedColumnId ? schema.findIndex((column) => column.id === selectedColumnId) : -1;
  return selected >= 0 ? selected : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function typeIcon(type: string): string {
  if (["integer", "float", "decimal"].includes(type)) return "codicon-symbol-numeric";
  if (type === "boolean") return "codicon-symbol-boolean";
  if (type === "datetime" || type === "date") return "codicon-calendar";
  if (type === "list" || type === "struct") return "codicon-json";
  return "codicon-symbol-string";
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return "0%";
  const percentage = (value / total) * 100;
  return `${percentage < 1 && percentage > 0 ? "<1" : Math.round(percentage).toLocaleString()}%`;
}
