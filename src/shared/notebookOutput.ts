import type { ColumnSummary, GridPage, SessionMetadata, SessionOpenedResponse } from "./protocol";
import { isOpenWranglerResponse } from "./protocolValidation";

export const OPEN_WRANGLER_MIME_V2 = "application/vnd.openwrangler.viewer.v2+json";

export interface NotebookOutputPayload {
  mimeVersion: 2;
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
}

export function normalizeNotebookOutputPayload(value: unknown): NotebookOutputPayload | undefined {
  if (!isRecord(value) || value.mimeVersion !== 2) return undefined;
  const page = migrateLegacyFullWidthPage(value.metadata, value.page);
  const opened = {
    kind: "sessionOpened",
    metadata: value.metadata,
    page,
    summaries: value.summaries
  };
  if (!isOpenWranglerResponse(opened) || opened.kind !== "sessionOpened") return undefined;
  if (opened.page.offset !== 0 || (opened.page.totalRows > 0 && opened.page.rows.length === 0)) {
    return undefined;
  }
  if (
    opened.page.columnIds.length !== opened.metadata.schema.length ||
    !opened.page.columnIds.every((columnId, position) => columnId === opened.metadata.schema[position]?.id)
  ) {
    // Saved notebook outputs are self-contained snapshots. Unlike live pages,
    // they have no runtime session from which a missing horizontal block can be
    // fetched, so accept only a complete schema-aligned page.
    return undefined;
  }
  return {
    mimeVersion: 2,
    metadata: opened.metadata,
    page: opened.page,
    summaries: opened.summaries
  };
}

function migrateLegacyFullWidthPage(metadata: unknown, page: unknown): unknown {
  if (!isRecord(metadata) || !isRecord(page) || Object.prototype.hasOwnProperty.call(page, "columnIds")) {
    return page;
  }
  if (!Array.isArray(metadata.schema) || !Array.isArray(page.rows)) return page;
  const columnIds = metadata.schema.map((column) => (isRecord(column) ? column.id : undefined));
  if (!columnIds.every((columnId): columnId is string => typeof columnId === "string" && columnId.length > 0)) {
    return page;
  }
  const isFullWidth = page.rows.every(
    (row) => isRecord(row) && Array.isArray(row.values) && row.values.length === columnIds.length
  );
  return isFullWidth ? { ...page, columnIds } : page;
}

export function notebookPayloadAsOpened(payload: NotebookOutputPayload): SessionOpenedResponse {
  return { kind: "sessionOpened", metadata: payload.metadata, page: payload.page, summaries: payload.summaries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
