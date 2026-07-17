import { randomUUID } from "node:crypto";
import type {
  FilterModel,
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata
} from "../../shared/protocol";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { normalizeNotebookOutputPayload, type NotebookOutputPayload } from "../../shared/notebookOutput";
import { isOpenWranglerRequest } from "../../shared/protocolValidation";
import {
  applySnapshotFilters,
  snapshotColumnValues,
  snapshotDatasetStats,
  snapshotPage,
  snapshotSummaries
} from "../../shared/snapshotModel";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../dataBridge";

const SNAPSHOT_REVISION = 0;
const SNAPSHOT_RUNTIME_VERSION = "snapshot";
const NORMALIZED_PAYLOAD = Symbol("normalized notebook output payload");
const READ_ONLY_CAPABILITIES = {
  editable: false,
  lazy: false,
  cancel: false,
  exportCsv: false,
  exportParquet: false,
  notebookInsert: false
} as const;
const EMPTY_VIEW: FilterModel = { logic: "and", filters: [], sort: [] };

type SnapshotState = "new" | "open" | "closed";
type ViewRequest = Extract<
  OpenWranglerRequest,
  { kind: "getPage" | "getSummary" | "getDatasetStats" | "getColumnValues" }
>;

/**
 * Serves one validated MIME-v2 payload as an immutable protocol-v2 session.
 * The bridge owns its session identity and treats only the captured rows as data.
 */
export class SnapshotBridge implements OpenWranglerBridge {
  private readonly sessionId: string;
  private readonly metadata: SessionMetadata;
  private readonly rows: NotebookOutputPayload["page"]["rows"];
  private state: SnapshotState = "new";

  static fromNormalized(payload: NotebookOutputPayload, createSessionId: () => string = randomUUID): SnapshotBridge {
    return new SnapshotBridge(payload, createSessionId, NORMALIZED_PAYLOAD);
  }

  constructor(
    payload: NotebookOutputPayload,
    createSessionId: () => string = randomUUID,
    normalizedPayload?: typeof NORMALIZED_PAYLOAD
  ) {
    const normalized = normalizedPayload === NORMALIZED_PAYLOAD ? payload : normalizeNotebookOutputPayload(payload);
    if (!normalized) throw new Error("Cannot create a snapshot session from a malformed notebook output payload.");

    const sessionId = createSessionId();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Snapshot session identity generation returned an invalid identifier.");
    }

    this.sessionId = sessionId;
    this.rows = structuredClone(normalized.page.rows);
    this.metadata = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      revision: SNAPSHOT_REVISION,
      backend: normalized.metadata.backend,
      mode: "viewing",
      source: { kind: "notebookOutput", label: normalized.metadata.source.label },
      capabilities: { ...READ_ONLY_CAPABILITIES },
      shape: { rows: this.rows.length, columns: normalized.metadata.schema.length },
      filteredShape: { rows: this.rows.length, columns: normalized.metadata.schema.length },
      schema: structuredClone(normalized.metadata.schema),
      filterModel: structuredClone(EMPTY_VIEW),
      steps: []
    };
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (!isOpenWranglerRequest(request)) {
      return snapshotError(
        "invalid_request",
        "The saved notebook snapshot received a malformed protocol-v2 request.",
        false,
        requestIdentity(request)
      );
    }
    if (options.cancellation?.isCancellationRequested) {
      return snapshotError(
        "snapshot_cancellation_unsupported",
        "Saved notebook snapshots do not support request cancellation.",
        false,
        requestIdentity(request)
      );
    }

    try {
      switch (request.kind) {
        case "initialize":
          return {
            kind: "initialized",
            protocolVersion: PROTOCOL_VERSION,
            runtimeVersion: SNAPSHOT_RUNTIME_VERSION,
            capabilities: { ...READ_ONLY_CAPABILITIES }
          };
        case "openSession":
          return this.open(request);
        case "cancelRequest":
          return snapshotError(
            "snapshot_cancellation_unsupported",
            "Saved notebook snapshots do not support request cancellation.",
            false
          );
        default: {
          const correlationError = this.correlateSession(request);
          if (correlationError) return correlationError;
          if (isBackgroundViewRequest(request, options)) {
            // Snapshot queries execute in-process. Give interactive page/value
            // requests one host-loop turn to overtake background profiling.
            await yieldToHostEventLoop();
            if (options.cancellation?.isCancellationRequested) {
              return snapshotError(
                "snapshot_cancellation_unsupported",
                "Saved notebook snapshots do not support request cancellation.",
                false,
                requestIdentity(request)
              );
            }
            const resumedCorrelationError = this.correlateSession(request);
            if (resumedCorrelationError) return resumedCorrelationError;
          }
          switch (request.kind) {
            case "getPage":
              return this.page(request);
            case "getSummary":
              return this.summary(request);
            case "getDatasetStats":
              return this.datasetStats(request);
            case "getColumnValues":
              return this.columnValues(request);
            case "closeSession":
              this.state = "closed";
              return { kind: "sessionClosed", sessionId: this.sessionId };
            case "inspectStep":
              return snapshotError(
                "snapshot_inspection_unsupported",
                "Saved notebook snapshots do not retain inspectable cleaning-step history.",
                false,
                requestIdentity(request)
              );
            case "exportData":
              return snapshotError(
                "snapshot_export_unsupported",
                "Saved notebook snapshots cannot export uncaptured dataframe data.",
                false,
                requestIdentity(request)
              );
            case "previewStep":
            case "applyDraft":
            case "discardDraft":
            case "undoStep":
              return snapshotError(
                "snapshot_read_only",
                "Saved notebook snapshots are immutable and do not support cleaning operations.",
                false,
                requestIdentity(request)
              );
          }
        }
      }
    } catch (error) {
      return snapshotError(
        "snapshot_query_failed",
        "The saved notebook snapshot could not complete the requested read.",
        true,
        requestIdentity(request),
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private open(request: OpenSessionRequest): OpenWranglerResponse {
    if (this.state === "open") {
      return snapshotError(
        "snapshot_session_exists",
        "This saved notebook snapshot already owns an open session.",
        false
      );
    }
    if (this.state === "closed") {
      return snapshotError(
        "snapshot_session_closed",
        "A closed saved notebook snapshot bridge cannot be reopened.",
        false
      );
    }
    if (
      request.source.kind !== "notebookOutput" ||
      request.source.label !== this.metadata.source.label ||
      request.source.path !== undefined ||
      request.source.uri !== undefined ||
      request.source.variableName !== undefined ||
      request.source.importOptions !== undefined
    ) {
      return snapshotError(
        "snapshot_source_mismatch",
        "The open request did not match this saved notebook output.",
        false
      );
    }
    if (request.backend !== undefined && request.backend !== this.metadata.backend) {
      return snapshotError(
        "snapshot_backend_mismatch",
        "The requested backend did not match the saved notebook output provenance.",
        false
      );
    }

    const metadata = this.metadataFor(EMPTY_VIEW, this.rows.length);
    const page = snapshotPage(metadata, this.rows, EMPTY_VIEW, {
      offset: 0,
      limit: request.pageSize,
      columnOffset: request.columnOffset,
      columnLimit: request.columnLimit
    });
    this.assertPageCorrelation(page, 0, request.pageSize, request.columnOffset, request.columnLimit, this.rows.length);
    this.state = "open";
    return { kind: "sessionOpened", metadata, page, summaries: [] };
  }

  private page(request: Extract<ViewRequest, { kind: "getPage" }>): OpenWranglerResponse {
    const page = snapshotPage(this.metadata, this.rows, request.filterModel, {
      offset: request.offset,
      limit: request.limit,
      columnOffset: request.columnOffset,
      columnLimit: request.columnLimit
    });
    const metadata = this.metadataFor(request.filterModel, page.totalRows);
    this.assertPageCorrelation(
      page,
      request.offset,
      request.limit,
      request.columnOffset,
      request.columnLimit,
      page.totalRows
    );
    return {
      kind: "page",
      revision: SNAPSHOT_REVISION,
      viewRequestId: request.viewRequestId,
      page,
      metadata
    };
  }

  private summary(request: Extract<ViewRequest, { kind: "getSummary" }>): OpenWranglerResponse {
    const filteredRows = applySnapshotFilters(this.metadata, this.rows, request.filterModel);
    const summaries = snapshotSummaries(
      this.metadataFor(request.filterModel, filteredRows.length),
      filteredRows,
      request.columns
    );
    return {
      kind: "summary",
      revision: SNAPSHOT_REVISION,
      viewRequestId: request.viewRequestId,
      summaries
    };
  }

  private datasetStats(request: Extract<ViewRequest, { kind: "getDatasetStats" }>): OpenWranglerResponse {
    return {
      kind: "datasetStats",
      revision: SNAPSHOT_REVISION,
      viewRequestId: request.viewRequestId,
      stats: snapshotDatasetStats(this.metadata, this.rows, request.filterModel)
    };
  }

  private columnValues(request: Extract<ViewRequest, { kind: "getColumnValues" }>): OpenWranglerResponse {
    const response = snapshotColumnValues(
      this.metadata,
      this.rows,
      request.filterModel,
      request.column,
      request.search,
      request.viewRequestId,
      request.limit
    );
    if (
      response.revision !== SNAPSHOT_REVISION ||
      response.viewRequestId !== request.viewRequestId ||
      response.column !== request.column ||
      response.values.length > request.limit
    ) {
      throw new Error("The snapshot model returned values for the wrong request correlation.");
    }
    return response;
  }

  private correlateSession(
    request: Exclude<OpenWranglerRequest, { kind: "initialize" | "openSession" | "cancelRequest" }>
  ): OpenWranglerResponse | undefined {
    if (this.state === "new") {
      return snapshotError(
        "snapshot_session_not_open",
        "Open the saved notebook snapshot before requesting its data.",
        true,
        requestIdentity(request)
      );
    }
    if (request.sessionId !== this.sessionId) {
      return snapshotError(
        "unknown_session",
        `Unknown saved notebook snapshot session: ${request.sessionId}`,
        true,
        requestIdentity(request)
      );
    }
    if (this.state === "closed") {
      return snapshotError(
        "snapshot_session_closed",
        "The saved notebook snapshot session is closed.",
        false,
        requestIdentity(request)
      );
    }
    if (request.kind !== "closeSession" && request.revision !== SNAPSHOT_REVISION) {
      return snapshotError(
        "stale_request",
        `Ignored snapshot request revision ${request.revision}; current revision is ${SNAPSHOT_REVISION}.`,
        true,
        requestIdentity(request)
      );
    }
    return undefined;
  }

  private metadataFor(filterModel: FilterModel, filteredRows: number): SessionMetadata {
    return {
      ...this.metadata,
      capabilities: { ...READ_ONLY_CAPABILITIES },
      source: { ...this.metadata.source },
      shape: { ...this.metadata.shape },
      filteredShape: { rows: filteredRows, columns: this.metadata.schema.length },
      schema: structuredClone(this.metadata.schema),
      filterModel: structuredClone(filterModel),
      steps: []
    };
  }

  private assertPageCorrelation(
    page: NotebookOutputPayload["page"],
    offset: number,
    limit: number,
    columnOffset: number,
    columnLimit: number,
    totalRows: number
  ): void {
    const expectedColumnIds = this.metadata.schema
      .slice(columnOffset, columnOffset + columnLimit)
      .map((column) => column.id);
    if (
      page.offset !== offset ||
      page.limit !== limit ||
      page.totalRows !== totalRows ||
      page.columnIds.length !== expectedColumnIds.length ||
      !page.columnIds.every((columnId, index) => columnId === expectedColumnIds[index]) ||
      page.rows.length > limit ||
      page.rows.some((row, index) => row.rowNumber !== offset + index || row.values.length !== expectedColumnIds.length)
    ) {
      throw new Error("The snapshot model returned a page for the wrong row or column projection.");
    }
  }
}

function isBackgroundViewRequest(request: OpenWranglerRequest, options: BridgeRequestOptions): request is ViewRequest {
  if (
    request.kind !== "getPage" &&
    request.kind !== "getSummary" &&
    request.kind !== "getDatasetStats" &&
    request.kind !== "getColumnValues"
  ) {
    return false;
  }
  if (options.priority !== undefined) return options.priority === "background";
  return request.kind === "getSummary" || request.kind === "getDatasetStats";
}

function yieldToHostEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function snapshotError(
  code: string,
  message: string,
  recoverable: boolean,
  correlation: { sessionId?: string; viewRequestId?: string } = {},
  detail?: string
): OpenWranglerResponse {
  return {
    kind: "error",
    code,
    message,
    recoverable,
    ...(detail === undefined ? {} : { detail }),
    ...correlation
  };
}

function requestIdentity(request: unknown): { sessionId?: string; viewRequestId?: string } {
  if (typeof request !== "object" || request === null) return {};
  const candidate = request as { sessionId?: unknown; viewRequestId?: unknown };
  return {
    ...(typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
      ? { sessionId: candidate.sessionId }
      : {}),
    ...(typeof candidate.viewRequestId === "string" && candidate.viewRequestId.length > 0
      ? { viewRequestId: candidate.viewRequestId }
      : {})
  };
}
