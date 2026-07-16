import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  ColumnSummary,
  ColumnSchema,
  DataDiff,
  DataRow,
  OpenWranglerResponse,
  GridPage,
  OperationKind,
  SessionMetadata,
  StepInspectionResponse,
  TransformStep,
  ValuesResponse
} from "../shared/protocol";
import { emptyFilterModel, type FilterModel } from "../shared/filterModel";
import { decodeGridViewState, emptyGridViewState, type GridViewState } from "../shared/viewState";
import { canEditLatestStep, canStartOperation, operationByKind } from "../shared/operations";
import { FilterPanel } from "./filters/FilterPanel";
import { DataGrid, type VisibleColumnRange } from "./grid/DataGrid";
import { SummaryPanel } from "./summary/SummaryPanel";
import { OperationBuilder } from "./operations/OperationBuilder";
import { applySnapshotFilters, snapshotColumnValues, snapshotSummaries } from "./snapshotModel";
import { vscode } from "./vscodeApi";

const webviewConfig = readWebviewConfig();
const pageSize = webviewConfig.fetchBlockSize;
const drawerSummaryConcurrency = 4;
const viewRequestEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let lastViewRequestSequence = 0;

export function App() {
  const [metadata, setMetadata] = useState<SessionMetadata | undefined>();
  const [page, setPage] = useState<GridPage | undefined>();
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [filterModel, setFilterModel] = useState<FilterModel>(emptyFilterModel);
  const [columnValues, setColumnValues] = useState<ReadonlyMap<string, ValuesResponse>>(() => new Map());
  const [snapshotRows, setSnapshotRows] = useState<DataRow[] | undefined>();
  const [foregroundError, setForegroundError] = useState<string | undefined>();
  const [backgroundDiagnostics, setBackgroundDiagnostics] = useState<ReadonlyMap<string, BackgroundDiagnostic>>(
    () => new Map()
  );
  const [failedPageRequest, setFailedPageRequest] = useState<PendingPageRequest | undefined>();
  const [loading, setLoading] = useState(true);
  const [projectionLoading, setProjectionLoading] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [goToColumn, setGoToColumn] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [operationOpen, setOperationOpen] = useState(false);
  const [operationKind, setOperationKind] = useState<OperationKind | undefined>();
  const [editingStep, setEditingStep] = useState<TransformStep | undefined>();
  const [diff, setDiff] = useState<DataDiff | undefined>();
  const [generatedCode, setGeneratedCode] = useState("");
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);
  const [stepInspection, setStepInspection] = useState<StepInspectionResponse | undefined>();
  const [pendingStepInspection, setPendingStepInspection] = useState<PendingStepInspection | undefined>();
  const [stepInspectionTarget, setStepInspectionTarget] = useState<PendingStepInspection | undefined>();
  const [stepInspectionError, setStepInspectionError] = useState<string | undefined>();
  const [draftBefore, setDraftBefore] = useState<DiffBeforeState | undefined>();
  const [activeViewContextId, setActiveViewContextId] = useState("");
  const [gridViewState, setGridViewState] = useState<GridViewState>(emptyGridViewState);
  const [viewStateRestoreVersion, setViewStateRestoreVersion] = useState(0);
  const metadataRef = useRef<SessionMetadata | undefined>(undefined);
  const pageRef = useRef<GridPage | undefined>(undefined);
  const stepInspectionRef = useRef<StepInspectionResponse | undefined>(undefined);
  const pendingStepInspectionRef = useRef<PendingStepInspection | undefined>(undefined);
  const stepInspectionTargetRef = useRef<PendingStepInspection | undefined>(undefined);
  const summariesRef = useRef<ColumnSummary[]>([]);
  const columnValuesRef = useRef<ReadonlyMap<string, ValuesResponse>>(new Map());
  const backgroundDiagnosticsRef = useRef<ReadonlyMap<string, BackgroundDiagnostic>>(new Map());
  const filterModelRef = useRef<FilterModel>(emptyFilterModel());
  const snapshotRowsRef = useRef<DataRow[] | undefined>(undefined);
  const sidePanelOpenRef = useRef(false);
  const confirmedView = useRef<ConfirmedView | undefined>(undefined);
  const latestPageRequest = useRef<PendingPageRequest | undefined>(undefined);
  const failedPageRequestRef = useRef<PendingPageRequest | undefined>(undefined);
  const foregroundRequest = useRef<"mutation" | { kind: "page"; viewRequestId: string } | undefined>(undefined);
  const pendingBackgroundRequests = useRef(new Map<string, PendingBackgroundRequest>());
  const pendingSummaryByColumn = useRef(new Map<string, string>());
  const summaryOwnersByColumn = useRef(new Map<string, Set<SummaryRequestOwner>>());
  const drawerSummaryQueue = useRef<string[]>([]);
  const drawerSummaryQueued = useRef(new Set<string>());
  const drawerSummaryActive = useRef(new Set<string>());
  const drawerSummaryExhausted = useRef(new Set<string>());
  const pendingStatsRequest = useRef<string | undefined>(undefined);
  const latestValuesByColumn = useRef(new Map<string, string>());
  const retryTimers = useRef(new Map<number, PendingBackgroundRequest>());
  const restoreGridFocusForPage = useRef<string | undefined>(undefined);
  const mutationSnapshot = useRef<ConfirmedViewState | undefined>(undefined);
  const confirmedColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const desiredColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const inspectionColumnWindow = useRef<ColumnWindow>(initialColumnWindow());
  const sidePanelToggleRef = useRef<HTMLButtonElement | null>(null);
  const sidePanelReturnFocus = useRef<HTMLElement | null>(null);
  const gridViewStateRef = useRef<GridViewState>(emptyGridViewState());
  const pendingGridViewState = useRef<GridViewState | undefined>(undefined);
  const gridViewStateTimer = useRef<number | undefined>(undefined);

  const nextViewRequestId = useCallback(() => {
    lastViewRequestSequence += 1;
    return `view-${viewRequestEpoch}-${lastViewRequestSequence}`;
  }, []);

  const storeMetadata = useCallback((next: SessionMetadata | undefined) => {
    metadataRef.current = next;
    setMetadata(next);
  }, []);

  const storePage = useCallback((next: GridPage | undefined) => {
    pageRef.current = next;
    setPage(next);
  }, []);

  const storeStepInspection = useCallback((next: StepInspectionResponse | undefined) => {
    stepInspectionRef.current = next;
    setStepInspection(next);
  }, []);

  const storePendingStepInspection = useCallback((next: PendingStepInspection | undefined) => {
    pendingStepInspectionRef.current = next;
    setPendingStepInspection(next);
  }, []);

  const storeStepInspectionTarget = useCallback((next: PendingStepInspection | undefined) => {
    stepInspectionTargetRef.current = next;
    setStepInspectionTarget(next);
  }, []);

  const storeFilterModel = useCallback((next: FilterModel) => {
    filterModelRef.current = next;
    setFilterModel(next);
  }, []);

  const storeSummaries = useCallback((next: ColumnSummary[]) => {
    summariesRef.current = next;
    setSummaries(next);
  }, []);

  const storeColumnValues = useCallback((next: ReadonlyMap<string, ValuesResponse>) => {
    columnValuesRef.current = next;
    setColumnValues(next);
  }, []);

  const storeFailedPageRequest = useCallback((next: PendingPageRequest | undefined) => {
    failedPageRequestRef.current = next;
    setFailedPageRequest(next);
  }, []);

  const storeGridViewState = useCallback((next: GridViewState) => {
    gridViewStateRef.current = next;
    setGridViewState(next);
  }, []);

  const flushGridViewState = useCallback(() => {
    if (gridViewStateTimer.current !== undefined) {
      window.clearTimeout(gridViewStateTimer.current);
      gridViewStateTimer.current = undefined;
    }
    const pending = pendingGridViewState.current;
    pendingGridViewState.current = undefined;
    if (pending) vscode.postMessage({ kind: "updateViewState", state: pending });
  }, []);

  const publishGridViewState = useCallback(
    (next: GridViewState) => {
      storeGridViewState(next);
      pendingGridViewState.current = next;
      if (gridViewStateTimer.current === undefined) {
        gridViewStateTimer.current = window.setTimeout(flushGridViewState, 100);
      }
    },
    [flushGridViewState, storeGridViewState]
  );

  useEffect(() => {
    const flushPendingGridViewState = () => flushGridViewState();
    window.addEventListener("pagehide", flushPendingGridViewState);
    window.addEventListener("beforeunload", flushPendingGridViewState);
    return () => {
      window.removeEventListener("pagehide", flushPendingGridViewState);
      window.removeEventListener("beforeunload", flushPendingGridViewState);
      flushGridViewState();
    };
  }, [flushGridViewState]);

  const storeBackgroundDiagnostics = useCallback(
    (
      update:
        | ReadonlyMap<string, BackgroundDiagnostic>
        | ((current: ReadonlyMap<string, BackgroundDiagnostic>) => ReadonlyMap<string, BackgroundDiagnostic>)
    ) => {
      const next = typeof update === "function" ? update(backgroundDiagnosticsRef.current) : update;
      backgroundDiagnosticsRef.current = next;
      setBackgroundDiagnostics(next);
    },
    []
  );

  const clearBackgroundDiagnostic = useCallback(
    (pending: PendingBackgroundRequest) => {
      const key = backgroundDiagnosticKey(pending);
      storeBackgroundDiagnostics((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    },
    [storeBackgroundDiagnostics]
  );

  const releaseBackgroundRequest = useCallback((viewRequestId: string, pending: PendingBackgroundRequest): void => {
    if (pending.kind === "summary" && pendingSummaryByColumn.current.get(pending.column) === viewRequestId) {
      pendingSummaryByColumn.current.delete(pending.column);
    }
    if (pending.kind === "stats" && pendingStatsRequest.current === viewRequestId) {
      pendingStatsRequest.current = undefined;
    }
    if (pending.kind === "values" && latestValuesByColumn.current.get(pending.column) === viewRequestId) {
      latestValuesByColumn.current.delete(pending.column);
    }
  }, []);

  const dropSummaryOwner = useCallback((column: string, owner: SummaryRequestOwner): void => {
    const desiredOwners = summaryOwnersByColumn.current.get(column);
    desiredOwners?.delete(owner);
    if (desiredOwners?.size === 0) summaryOwnersByColumn.current.delete(column);
    for (const pending of pendingBackgroundRequests.current.values()) {
      if (pending.kind === "summary" && pending.column === column) pending.owners.delete(owner);
    }
    for (const pending of retryTimers.current.values()) {
      if (pending.kind === "summary" && pending.column === column) pending.owners.delete(owner);
    }
  }, []);

  const clearDrawerSummaryScheduling = useCallback((): void => {
    drawerSummaryQueue.current = [];
    drawerSummaryQueued.current.clear();
    drawerSummaryActive.current.clear();
    drawerSummaryExhausted.current.clear();
    for (const column of [...summaryOwnersByColumn.current.keys()]) dropSummaryOwner(column, "drawer");
  }, [dropSummaryOwner]);

  const cancelBackgroundRequests = useCallback(
    (shouldCancel: (pending: PendingBackgroundRequest) => boolean = () => true) => {
      const cancelledIds: string[] = [];
      const diagnosticKeys = new Set<string>();
      for (const [viewRequestId, pending] of pendingBackgroundRequests.current) {
        if (!shouldCancel(pending)) continue;
        pendingBackgroundRequests.current.delete(viewRequestId);
        releaseBackgroundRequest(viewRequestId, pending);
        cancelledIds.push(viewRequestId);
        diagnosticKeys.add(backgroundDiagnosticKey(pending));
      }
      for (const [timer, pending] of retryTimers.current) {
        if (!shouldCancel(pending)) continue;
        window.clearTimeout(timer);
        retryTimers.current.delete(timer);
        diagnosticKeys.add(backgroundDiagnosticKey(pending));
      }
      if (cancelledIds.length) {
        vscode.postMessage({ kind: "cancelViewRequests", viewRequestIds: cancelledIds });
      }
      storeBackgroundDiagnostics((current) => {
        const next = new Map<string, BackgroundDiagnostic>();
        for (const [key, diagnostic] of current) {
          if (!diagnosticKeys.has(key) && !shouldCancel(diagnostic.pending)) next.set(key, diagnostic);
        }
        return next;
      });
    },
    [releaseBackgroundRequest, storeBackgroundDiagnostics]
  );

  const clearProgressiveData = useCallback(
    (preserveColumnValues = false) => {
      storeSummaries([]);
      if (!preserveColumnValues) storeColumnValues(new Map());
    },
    [storeColumnValues, storeSummaries]
  );

  const resetViewProfiling = useCallback(
    (preserveColumnValues = false) => {
      cancelBackgroundRequests();
      clearDrawerSummaryScheduling();
      clearProgressiveData(preserveColumnValues);
      storeBackgroundDiagnostics(new Map());
    },
    [cancelBackgroundRequests, clearDrawerSummaryScheduling, clearProgressiveData, storeBackgroundDiagnostics]
  );

  const confirmView = useCallback((next: SessionMetadata, viewContextId: string): ConfirmedView => {
    const confirmed = {
      viewContextId,
      sessionId: next.sessionId,
      revision: next.revision
    };
    confirmedView.current = confirmed;
    setActiveViewContextId(viewContextId);
    vscode.postMessage({ kind: "setViewContext", viewContextId });
    return confirmed;
  }, []);

  const canProfileConfirmedView = useCallback((viewContextId: string): boolean => {
    const confirmed = confirmedView.current;
    const pendingPage = latestPageRequest.current;
    return Boolean(
      confirmed &&
      confirmed.viewContextId === viewContextId &&
      !stepInspectionTargetRef.current &&
      foregroundRequest.current !== "mutation" &&
      (!pendingPage || pendingPage.viewContextId === confirmed.viewContextId)
    );
  }, []);

  const sendSummaryColumn = useCallback(
    (column: string, attempt = 1, owner?: SummaryRequestOwner) => {
      if (owner) {
        const owners = summaryOwnersByColumn.current.get(column) ?? new Set<SummaryRequestOwner>();
        owners.add(owner);
        summaryOwnersByColumn.current.set(column, owners);
      }
      const owners = summaryOwnersByColumn.current.get(column);
      if (!owners?.size) return;
      const currentMetadata = metadataRef.current;
      const confirmed = confirmedView.current;
      if (
        !currentMetadata ||
        snapshotRowsRef.current ||
        !confirmed ||
        !canProfileConfirmedView(confirmed.viewContextId) ||
        !currentMetadata.schema.some((candidate) => candidate.name === column) ||
        summariesRef.current.some((summary) => summary.column === column)
      ) {
        return;
      }
      const existingRequestId = pendingSummaryByColumn.current.get(column);
      if (existingRequestId) {
        const existing = pendingBackgroundRequests.current.get(existingRequestId);
        if (existing?.kind === "summary") existing.owners = new Set(owners);
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingSummaryByColumn.current.set(column, viewRequestId);
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "summary",
        viewContextId: confirmed.viewContextId,
        column,
        attempt,
        owners: new Set(owners)
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        viewContextId: confirmed.viewContextId,
        request: {
          kind: "getSummary",
          viewRequestId,
          filterModel: currentMetadata.filterModel,
          columns: [column]
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId]
  );

  const releaseSummaryOwner = useCallback(
    (column: string, owner: SummaryRequestOwner) => {
      dropSummaryOwner(column, owner);
      cancelBackgroundRequests(
        (pending) =>
          pending.kind === "summary" &&
          pending.column === column &&
          !(summaryOwnersByColumn.current.get(column)?.size ?? 0)
      );
    },
    [cancelBackgroundRequests, dropSummaryOwner]
  );

  const pumpDrawerSummaryProfiling = useCallback((): void => {
    const currentMetadata = metadataRef.current;
    const confirmed = confirmedView.current;
    if (
      !sidePanelOpenRef.current ||
      !currentMetadata ||
      snapshotRowsRef.current ||
      !confirmed ||
      !canProfileConfirmedView(confirmed.viewContextId)
    ) {
      return;
    }

    while (drawerSummaryActive.current.size < drawerSummaryConcurrency && drawerSummaryQueue.current.length > 0) {
      const column = drawerSummaryQueue.current.shift();
      if (!column) continue;
      drawerSummaryQueued.current.delete(column);
      if (
        !currentMetadata.schema.some((candidate) => candidate.name === column) ||
        summariesRef.current.some((summary) => summary.column === column)
      ) {
        continue;
      }

      sendSummaryColumn(column, 1, "drawer");
      if (pendingSummaryByColumn.current.has(column)) {
        drawerSummaryActive.current.add(column);
        continue;
      }

      dropSummaryOwner(column, "drawer");
      drawerSummaryQueue.current.unshift(column);
      drawerSummaryQueued.current.add(column);
      break;
    }
  }, [canProfileConfirmedView, dropSummaryOwner, sendSummaryColumn]);

  const finishDrawerSummaryColumn = useCallback(
    (column: string, exhausted = false): void => {
      if (!drawerSummaryActive.current.delete(column)) return;
      if (exhausted) drawerSummaryExhausted.current.add(column);
      dropSummaryOwner(column, "drawer");
      pumpDrawerSummaryProfiling();
    },
    [dropSummaryOwner, pumpDrawerSummaryProfiling]
  );

  const enqueueDrawerSummaryColumns = useCallback((): void => {
    const currentMetadata = metadataRef.current;
    if (!sidePanelOpenRef.current || !currentMetadata) return;
    for (const { name } of currentMetadata.schema) {
      if (
        summariesRef.current.some((summary) => summary.column === name) ||
        drawerSummaryQueued.current.has(name) ||
        drawerSummaryActive.current.has(name) ||
        drawerSummaryExhausted.current.has(name)
      ) {
        continue;
      }
      drawerSummaryQueue.current.push(name);
      drawerSummaryQueued.current.add(name);
    }
    pumpDrawerSummaryProfiling();
  }, [pumpDrawerSummaryProfiling]);

  const updateVisibleSummaryColumns = useCallback(
    (columns: string[]) => {
      const next = new Set(columns);
      for (const [column, owners] of [...summaryOwnersByColumn.current]) {
        if (owners.has("grid") && !next.has(column)) releaseSummaryOwner(column, "grid");
      }
      for (const column of next) sendSummaryColumn(column, 1, "grid");
    },
    [releaseSummaryOwner, sendSummaryColumn]
  );

  const restartOwnedSummaryProfiling = useCallback(() => {
    for (const [column, owners] of summaryOwnersByColumn.current) {
      if (owners.size) sendSummaryColumn(column);
    }
  }, [sendSummaryColumn]);

  const requestStatsForConfirmedView = useCallback(
    (attempt = 1) => {
      const currentMetadata = metadataRef.current;
      const confirmed = confirmedView.current;
      if (
        !sidePanelOpenRef.current ||
        !currentMetadata ||
        currentMetadata.stats ||
        snapshotRowsRef.current ||
        !confirmed ||
        pendingStatsRequest.current ||
        !canProfileConfirmedView(confirmed.viewContextId)
      ) {
        return;
      }
      const viewRequestId = nextViewRequestId();
      pendingStatsRequest.current = viewRequestId;
      pendingBackgroundRequests.current.set(viewRequestId, {
        kind: "stats",
        viewContextId: confirmed.viewContextId,
        attempt
      });
      vscode.postMessage({
        kind: "runtimeRequest",
        viewContextId: confirmed.viewContextId,
        request: {
          kind: "getDatasetStats",
          viewRequestId,
          filterModel: currentMetadata.filterModel
        }
      });
    },
    [canProfileConfirmedView, nextViewRequestId]
  );

  const restartProfilingForConfirmedView = useCallback(() => {
    restartOwnedSummaryProfiling();
    requestStatsForConfirmedView();
  }, [requestStatsForConfirmedView, restartOwnedSummaryProfiling]);

  const captureConfirmedViewState = useCallback((): ConfirmedViewState | undefined => {
    const currentMetadata = metadataRef.current;
    const currentPage = pageRef.current;
    const currentView = confirmedView.current;
    if (!currentMetadata || !currentPage || !currentView) return undefined;
    return {
      view: { ...currentView },
      metadata: currentMetadata,
      page: currentPage,
      columnWindow: { ...confirmedColumnWindow.current },
      summaries: [...summariesRef.current],
      columnValues: new Map(columnValuesRef.current),
      backgroundDiagnostics: cloneBackgroundDiagnostics(backgroundDiagnosticsRef.current)
    };
  }, []);

  const restoreConfirmedViewState = useCallback(
    (previous: ConfirmedViewState) => {
      storeMetadata(previous.metadata);
      storeFilterModel(previous.metadata.filterModel);
      storeSummaries(previous.summaries);
      storeColumnValues(previous.columnValues);
      storeBackgroundDiagnostics(previous.backgroundDiagnostics);
      confirmedColumnWindow.current = { ...previous.columnWindow };
      desiredColumnWindow.current = { ...previous.columnWindow };
      confirmView(previous.metadata, previous.view.viewContextId);
      restartProfilingForConfirmedView();
    },
    [
      confirmView,
      restartProfilingForConfirmedView,
      storeBackgroundDiagnostics,
      storeColumnValues,
      storeFilterModel,
      storeMetadata,
      storeSummaries
    ]
  );

  const clearStepInspection = useCallback(
    (notifyHost = true, resumeProfiling = true) => {
      storePendingStepInspection(undefined);
      storeStepInspection(undefined);
      storeStepInspectionTarget(undefined);
      inspectionColumnWindow.current = { ...confirmedColumnWindow.current };
      setProjectionLoading(false);
      setStepInspectionError(undefined);
      if (notifyHost) vscode.postMessage({ kind: "clearStepInspection" });
      if (resumeProfiling) restartProfilingForConfirmedView();
    },
    [restartProfilingForConfirmedView, storePendingStepInspection, storeStepInspection, storeStepInspectionTarget]
  );

  const requestStepInspection = useCallback(
    (
      stepId: string,
      offset = 0,
      columnWindow = inspectionColumnWindow.current,
      reason: PendingStepInspection["reason"] = "selection"
    ) => {
      const currentMetadata = metadataRef.current;
      if (foregroundRequest.current) {
        if (latestPageRequest.current?.reason === "projection") {
          setForegroundError("Wait for the visible columns to finish loading before inspecting a cleaning step.");
        }
        return;
      }
      if (!currentMetadata?.steps.some((step) => step.id === stepId)) {
        return;
      }
      const previousTarget = stepInspectionTargetRef.current;
      const requestedWindow =
        previousTarget?.stepId !== stepId && reason === "selection" ? confirmedColumnWindow.current : columnWindow;
      const normalizedWindow = {
        offset: Math.max(0, Math.floor(requestedWindow.offset)),
        limit: Math.max(1, Math.min(256, Math.floor(requestedWindow.limit)))
      };
      inspectionColumnWindow.current = normalizedWindow;
      const pending: PendingStepInspection = { stepId, offset, columnWindow: normalizedWindow, reason };
      storeStepInspectionTarget(pending);
      storePendingStepInspection(pending);
      setProjectionLoading(reason === "projection");
      if (stepInspectionRef.current?.stepId !== stepId) storeStepInspection(undefined);
      setStepInspectionError(undefined);
      cancelBackgroundRequests();
      clearDrawerSummaryScheduling();
      sidePanelOpenRef.current = false;
      setSidePanelOpen(false);
      vscode.postMessage({
        kind: "runtimeRequest",
        request: {
          kind: "inspectStep",
          stepId,
          offset,
          limit: pageSize,
          columnOffset: normalizedWindow.offset,
          columnLimit: normalizedWindow.limit
        }
      });
    },
    [
      cancelBackgroundRequests,
      clearDrawerSummaryScheduling,
      storePendingStepInspection,
      storeStepInspection,
      storeStepInspectionTarget
    ]
  );

  const beginMutation = useCallback((): boolean => {
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before changing the cleaning plan.");
      }
      return false;
    }
    const previous = captureConfirmedViewState();
    if (!previous) return false;
    clearStepInspection(false, false);
    flushGridViewState();
    mutationSnapshot.current = previous;
    resetViewProfiling();
    storeMetadata(withoutDatasetStats(previous.metadata));
    foregroundRequest.current = "mutation";
    setMutationPending(true);
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    setProjectionLoading(false);
    setLoading(true);
    return true;
  }, [
    captureConfirmedViewState,
    clearStepInspection,
    flushGridViewState,
    resetViewProfiling,
    storeFailedPageRequest,
    storeMetadata
  ]);

  const pruneSummaryOwners = useCallback(
    (nextMetadata: SessionMetadata) => {
      const validColumns = new Set(nextMetadata.schema.map((column) => column.name));
      for (const column of summaryOwnersByColumn.current.keys()) {
        if (!validColumns.has(column)) summaryOwnersByColumn.current.delete(column);
      }
      cancelBackgroundRequests((pending) => pending.kind === "summary" && !validColumns.has(pending.column));
    },
    [cancelBackgroundRequests]
  );

  const restoreViewAfterPageFailure = useCallback(
    (pendingPage: PendingPageRequest) => {
      const previous = pendingPage.previousConfirmedState;
      if (!pendingPage.changesView || !previous) return;
      restoreConfirmedViewState(previous);
    },
    [restoreConfirmedViewState]
  );

  useEffect(() => {
    const timers = retryTimers.current;
    const listener = (
      event: MessageEvent<
        | OpenWranglerResponse
        | EditorActionMessage
        | ViewStateMessage
        | StepInspectionResultMessage
        | StepInspectionClearedMessage
      >
    ) => {
      if (event.origin !== window.location.origin) return;
      const response = event.data;
      if (response.kind === "stepInspectionCleared") {
        if (stepInspectionTargetRef.current || pendingStepInspectionRef.current || stepInspectionRef.current) {
          clearStepInspection(false, response.resumeProfiling);
        }
        return;
      }
      if (response.kind === "stepInspectionResult") {
        const pending = pendingStepInspectionRef.current;
        if (
          !pending ||
          pending.stepId !== response.stepId ||
          pending.offset !== response.offset ||
          pageSize !== response.limit ||
          pending.columnWindow.offset !== response.columnOffset ||
          pending.columnWindow.limit !== response.columnLimit
        ) {
          return;
        }
        storePendingStepInspection(undefined);
        setProjectionLoading(false);
        const result = response.response;
        if (result.kind === "error") {
          setStepInspectionError(result.message);
          return;
        }
        if (result.kind === "cancelled") {
          setStepInspectionError("Applied-step inspection was cancelled.");
          return;
        }
        const currentMetadata = metadataRef.current;
        if (
          result.kind !== "stepInspection" ||
          result.stepId !== response.stepId ||
          result.revision !== currentMetadata?.revision ||
          result.inputPage.offset !== response.offset ||
          result.outputPage.offset !== response.offset
        ) {
          setStepInspectionError("Ignored an invalid applied-step inspection response.");
          return;
        }
        inspectionColumnWindow.current = columnWindowFromPage(
          { ...currentMetadata, schema: result.outputSchema },
          result.outputPage,
          pending.columnWindow
        );
        storeStepInspection(result);
        setStepInspectionError(undefined);
        return;
      }
      if (response.kind === "viewState") {
        const state = decodeGridViewState(response.state);
        if (!state) return;
        pendingGridViewState.current = undefined;
        if (gridViewStateTimer.current !== undefined) {
          window.clearTimeout(gridViewStateTimer.current);
          gridViewStateTimer.current = undefined;
        }
        storeGridViewState(state);
        setViewStateRestoreVersion((current) => current + 1);
        return;
      }
      if (response.kind === "editorAction") {
        if (response.action === "openOperation") {
          if (latestPageRequest.current?.reason === "projection") {
            setForegroundError("Wait for the visible columns to finish loading before adding a cleaning step.");
            return;
          }
          if (!canStartOperation(metadataRef.current)) return;
          if (stepInspectionTargetRef.current) clearStepInspection();
          setEditingStep(undefined);
          setOperationKind(response.operationKind);
          setOperationOpen(true);
        } else if (response.action === "editLatest") {
          if (latestPageRequest.current?.reason === "projection") {
            setForegroundError("Wait for the visible columns to finish loading before editing a cleaning step.");
            return;
          }
          if (!canEditLatestStep(metadataRef.current)) return;
          if (stepInspectionTargetRef.current) clearStepInspection();
          setMetadata((current) => {
            const latest = current?.steps.at(-1);
            if (latest) {
              setEditingStep(latest);
              setOperationKind(latest.kind);
              setOperationOpen(true);
            }
            return current;
          });
        } else if (response.action === "selectStep") {
          if (response.stepId) requestStepInspection(response.stepId);
          else clearStepInspection();
        } else {
          if (!beginMutation()) return;
          const columnWindow = desiredColumnWindow.current;
          vscode.postMessage({
            kind: "runtimeRequest",
            request: {
              kind: response.action,
              offset: 0,
              limit: pageSize,
              columnOffset: columnWindow.offset,
              columnLimit: columnWindow.limit
            }
          });
        }
        return;
      }

      if (response.kind === "error") {
        if (response.viewRequestId) {
          const pendingPage = latestPageRequest.current;
          if (pendingPage?.viewRequestId === response.viewRequestId) {
            latestPageRequest.current = undefined;
            if (
              typeof foregroundRequest.current === "object" &&
              foregroundRequest.current.viewRequestId === response.viewRequestId
            ) {
              foregroundRequest.current = undefined;
              if (pendingPage.reason === "projection") setProjectionLoading(false);
              else setLoading(false);
            }
            restoreViewAfterPageFailure(pendingPage);
            storeFailedPageRequest(pendingPage);
            setForegroundError(response.message);
            return;
          }

          const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
          if (!pending) return;
          pendingBackgroundRequests.current.delete(response.viewRequestId);
          releaseBackgroundRequest(response.viewRequestId, pending);
          if (canProfileConfirmedView(pending.viewContextId)) {
            storeBackgroundDiagnostics((current) => {
              const next = new Map(current);
              next.set(backgroundDiagnosticKey(pending), { message: response.message, pending });
              return next;
            });
            const retryScheduled = scheduleBackgroundRetry(pending);
            if (pending.kind === "summary" && !retryScheduled) finishDrawerSummaryColumn(pending.column, true);
          } else if (pending.kind === "summary") {
            finishDrawerSummaryColumn(pending.column, true);
          }
          return;
        }
        const shouldRestoreMutation = foregroundRequest.current === "mutation";
        if (shouldRestoreMutation) {
          const previous = mutationSnapshot.current;
          foregroundRequest.current = undefined;
          mutationSnapshot.current = undefined;
          setMutationPending(false);
          setLoading(false);
          setProjectionLoading(false);
          if (previous) restoreConfirmedViewState(previous);
        } else if (!metadataRef.current) {
          setLoading(false);
          setProjectionLoading(false);
        }
        setForegroundError(response.message);
        return;
      }

      if (response.kind === "cancelled") {
        if (!response.viewRequestId) {
          const shouldRestoreMutation = foregroundRequest.current === "mutation";
          if (shouldRestoreMutation) {
            const previous = mutationSnapshot.current;
            foregroundRequest.current = undefined;
            mutationSnapshot.current = undefined;
            setMutationPending(false);
            setLoading(false);
            setProjectionLoading(false);
            if (previous) restoreConfirmedViewState(previous);
            setForegroundError("The cleaning operation was cancelled.");
          } else if (!metadataRef.current) {
            setLoading(false);
            setProjectionLoading(false);
            setForegroundError("Opening the dataframe was cancelled.");
          }
          return;
        }
        const pendingPage = latestPageRequest.current;
        if (pendingPage?.viewRequestId === response.viewRequestId) {
          latestPageRequest.current = undefined;
          if (
            typeof foregroundRequest.current === "object" &&
            foregroundRequest.current.viewRequestId === response.viewRequestId
          ) {
            foregroundRequest.current = undefined;
            if (pendingPage.reason === "projection") setProjectionLoading(false);
            else setLoading(false);
          }
          restoreViewAfterPageFailure(pendingPage);
          storeFailedPageRequest(pendingPage);
          setForegroundError("Page request was cancelled.");
          return;
        }
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (pending) {
          pendingBackgroundRequests.current.delete(response.viewRequestId);
          releaseBackgroundRequest(response.viewRequestId, pending);
          const retryScheduled = scheduleBackgroundRetry(pending);
          if (pending.kind === "summary" && !retryScheduled) finishDrawerSummaryColumn(pending.column, true);
        }
        return;
      }

      if (response.kind === "sessionOpened") {
        latestPageRequest.current = undefined;
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(false);
        setProjectionLoading(false);
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);
        storeGridViewState(emptyGridViewState());
        storePendingStepInspection(undefined);
        storeStepInspection(undefined);
        storeStepInspectionTarget(undefined);
        setStepInspectionError(undefined);
        setDraftBefore(undefined);
        setDiff(undefined);
        resetViewProfiling();
        summaryOwnersByColumn.current.clear();
        confirmView(response.metadata, nextViewRequestId());
        storeMetadata(response.metadata);
        storeFilterModel(response.metadata.filterModel);
        storePage(response.page);
        const openedWindow = columnWindowFromPage(response.metadata, response.page);
        confirmedColumnWindow.current = openedWindow;
        desiredColumnWindow.current = openedWindow;
        inspectionColumnWindow.current = openedWindow;
        storeSummaries(response.summaries);
        const rows =
          response.metadata.source.kind === "notebookOutput" && isFullWidthPage(response.metadata, response.page)
            ? response.page.rows
            : undefined;
        snapshotRowsRef.current = rows;
        setSnapshotRows(rows);
        return;
      }

      if (response.kind === "page") {
        const pendingPage = latestPageRequest.current;
        if (!pendingPage || pendingPage.viewRequestId !== response.viewRequestId) return;
        latestPageRequest.current = undefined;
        if (
          typeof foregroundRequest.current === "object" &&
          foregroundRequest.current.viewRequestId === response.viewRequestId
        ) {
          foregroundRequest.current = undefined;
          if (pendingPage.reason === "projection") setProjectionLoading(false);
          else setLoading(false);
        }
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);

        const previousView = confirmedView.current;
        const sameView = Boolean(
          previousView &&
          previousView.viewContextId === pendingPage.viewContextId &&
          previousView.sessionId === response.metadata.sessionId
        );
        if (!sameView) {
          resetViewProfiling(true);
        }
        const previousStats = sameView ? metadataRef.current?.stats : undefined;
        const nextMetadata = previousStats
          ? { ...response.metadata, stats: previousStats }
          : withoutDatasetStats(response.metadata);
        confirmView(nextMetadata, pendingPage.viewContextId);
        storeMetadata(nextMetadata);
        storeFilterModel(nextMetadata.filterModel);
        storePage(response.page);
        confirmedColumnWindow.current = columnWindowFromPage(nextMetadata, response.page, pendingPage.columnWindow);
        snapshotRowsRef.current = undefined;
        setSnapshotRows(undefined);
        restartProfilingForConfirmedView();
        if (restoreGridFocusForPage.current === response.viewRequestId) {
          restoreGridFocusForPage.current = undefined;
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [tabindex="0"]')?.focus();
          });
        }
        return;
      }

      if (response.kind === "stepPreview" || response.kind === "planUpdated") {
        const previous = mutationSnapshot.current;
        latestPageRequest.current = undefined;
        foregroundRequest.current = undefined;
        mutationSnapshot.current = undefined;
        setMutationPending(false);
        setLoading(false);
        setProjectionLoading(false);
        setForegroundError(undefined);
        storeFailedPageRequest(undefined);
        resetViewProfiling();
        const nextMetadata = withoutDatasetStats(response.metadata);
        pruneSummaryOwners(nextMetadata);
        confirmView(nextMetadata, nextViewRequestId());
        storeMetadata(nextMetadata);
        storeFilterModel(nextMetadata.filterModel);
        storePage(response.page);
        const mutationWindow = columnWindowFromPage(nextMetadata, response.page, desiredColumnWindow.current);
        confirmedColumnWindow.current = mutationWindow;
        desiredColumnWindow.current = mutationWindow;
        inspectionColumnWindow.current = mutationWindow;
        snapshotRowsRef.current = undefined;
        setSnapshotRows(undefined);
        setGeneratedCode(response.code);
        setDiff(response.kind === "stepPreview" ? response.diff : undefined);
        setDraftBefore(
          response.kind === "stepPreview" && previous
            ? {
                schema:
                  response.metadata.draftReplacesStepId === undefined
                    ? previous.metadata.schema
                    : (response.metadata.latestStepInputSchema ?? previous.metadata.schema),
                ...(response.metadata.draftReplacesStepId === undefined && previous.page.offset === response.page.offset
                  ? { page: previous.page }
                  : {})
              }
            : undefined
        );
        setDraftWarnings(response.kind === "stepPreview" ? (response.warnings ?? []) : []);
        if (response.kind === "stepPreview") setOperationOpen(false);
        restartProfilingForConfirmedView();
        return;
      }

      if (response.kind === "summary") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "summary") return;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (!canProfileConfirmedView(pending.viewContextId) || response.revision !== confirmedView.current?.revision) {
          finishDrawerSummaryColumn(pending.column, true);
          return;
        }
        const merged = new Map(summariesRef.current.map((summary) => [summary.column, summary]));
        for (const summary of response.summaries) merged.set(summary.column, summary);
        storeSummaries([...merged.values()]);
        clearBackgroundDiagnostic(pending);
        finishDrawerSummaryColumn(pending.column);
        return;
      }

      if (response.kind === "columnValues") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "values") return;
        const isLatest = latestValuesByColumn.current.get(response.column) === response.viewRequestId;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (
          !canProfileConfirmedView(pending.viewContextId) ||
          response.revision !== confirmedView.current?.revision ||
          !isLatest
        ) {
          return;
        }
        latestValuesByColumn.current.delete(response.column);
        storeColumnValues(new Map(columnValuesRef.current).set(response.column, response));
        clearBackgroundDiagnostic(pending);
        return;
      }

      if (response.kind === "datasetStats") {
        const pending = pendingBackgroundRequests.current.get(response.viewRequestId);
        if (!pending || pending.kind !== "stats") return;
        pendingBackgroundRequests.current.delete(response.viewRequestId);
        releaseBackgroundRequest(response.viewRequestId, pending);
        if (!canProfileConfirmedView(pending.viewContextId) || response.revision !== confirmedView.current?.revision)
          return;
        const current = metadataRef.current;
        if (current) storeMetadata({ ...current, stats: response.stats });
        clearBackgroundDiagnostic(pending);
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ kind: "ready" });
    return () => {
      window.removeEventListener("message", listener);
      for (const timer of timers.keys()) window.clearTimeout(timer);
      timers.clear();
    };

    function scheduleBackgroundRetry(pending: PendingBackgroundRequest): boolean {
      if (pending.kind === "values" || pending.attempt >= 2 || !canProfileConfirmedView(pending.viewContextId))
        return false;
      const timer = window.setTimeout(() => {
        retryTimers.current.delete(timer);
        if (pending.kind === "summary") sendSummaryColumn(pending.column, pending.attempt + 1);
        else requestStatsForConfirmedView(pending.attempt + 1);
      }, 0);
      retryTimers.current.set(timer, pending);
      return true;
    }
  }, [
    beginMutation,
    canProfileConfirmedView,
    clearBackgroundDiagnostic,
    clearStepInspection,
    confirmView,
    finishDrawerSummaryColumn,
    nextViewRequestId,
    pruneSummaryOwners,
    releaseBackgroundRequest,
    requestStatsForConfirmedView,
    requestStepInspection,
    restartProfilingForConfirmedView,
    restoreConfirmedViewState,
    restoreViewAfterPageFailure,
    resetViewProfiling,
    sendSummaryColumn,
    storeBackgroundDiagnostics,
    storeColumnValues,
    storeFailedPageRequest,
    storeFilterModel,
    storeGridViewState,
    storeMetadata,
    storePage,
    storePendingStepInspection,
    storeStepInspection,
    storeStepInspectionTarget,
    storeSummaries
  ]);

  const schemaByName = useMemo(
    () => new Map(metadata?.schema.map((column) => [column.name, column]) ?? []),
    [metadata]
  );
  const inspectionMode = Boolean(stepInspectionTarget);
  const displayMetadata = useMemo<SessionMetadata | undefined>(() => {
    if (!metadata || !stepInspection) return metadata;
    const shape = { rows: stepInspection.outputPage.totalRows, columns: stepInspection.outputSchema.length };
    return {
      ...metadata,
      shape,
      filteredShape: shape,
      schema: stepInspection.outputSchema
    };
  }, [metadata, stepInspection]);
  const displayPage = inspectionMode
    ? pendingStepInspection?.reason === "selection" || pendingStepInspection?.reason === "row"
      ? undefined
      : stepInspection?.outputPage
    : page;
  const selectedInspectionStep = metadata?.steps.find((step) => step.id === stepInspectionTarget?.stepId);
  const inspectionGridViewState = useMemo<GridViewState>(() => {
    const columnIds = new Set(stepInspection?.outputSchema.map((column) => column.id) ?? []);
    return {
      columnWidths: Object.fromEntries(
        Object.entries(gridViewState.columnWidths).filter(([columnId]) => columnIds.has(columnId))
      ),
      viewport: {
        firstVisibleRow: stepInspection?.outputPage.offset ?? stepInspectionTarget?.offset ?? 0,
        scrollLeft: gridViewState.viewport.scrollLeft
      }
    };
  }, [gridViewState.columnWidths, gridViewState.viewport.scrollLeft, stepInspection, stepInspectionTarget]);
  const snapshotMode = metadata?.source.kind === "notebookOutput" && snapshotRows !== undefined;

  const requestPage = (
    offset: number,
    model = filterModelRef.current,
    options: PageRequestOptions = {}
  ): string | undefined => {
    if (foregroundRequest.current === "mutation" || stepInspectionTargetRef.current) {
      return undefined;
    }
    const currentMetadata = metadataRef.current;
    const currentSnapshotRows = snapshotRowsRef.current;
    if (currentMetadata && currentSnapshotRows) {
      applySnapshotModel(currentMetadata, currentSnapshotRows, model, offset);
      return undefined;
    }

    const viewRequestId = nextViewRequestId();
    const previousContextId = confirmedView.current?.viewContextId;
    const changesView = options.changesView ?? !previousContextId;
    const reason = options.reason ?? (changesView ? "view" : "row");
    const viewContextId = options.viewContextId ?? (changesView ? viewRequestId : (previousContextId ?? viewRequestId));
    const requestedWindow = options.columnWindow ?? desiredColumnWindow.current;
    const columnWindow: ColumnWindow = currentMetadata?.schema.length
      ? {
          offset: Math.max(0, Math.min(Math.floor(requestedWindow.offset), currentMetadata.schema.length - 1)),
          limit: Math.max(1, Math.min(256, Math.floor(requestedWindow.limit)))
        }
      : { offset: 0, limit: Math.max(1, Math.min(256, Math.floor(requestedWindow.limit))) };
    const previousConfirmedState = changesView
      ? (latestPageRequest.current?.previousConfirmedState ?? captureConfirmedViewState())
      : undefined;
    const pendingPage: PendingPageRequest = {
      viewRequestId,
      viewContextId,
      changesView,
      offset,
      model,
      columnWindow,
      reason,
      previousConfirmedState
    };
    latestPageRequest.current = pendingPage;
    foregroundRequest.current = { kind: "page", viewRequestId };
    desiredColumnWindow.current = columnWindow;
    storeFailedPageRequest(undefined);
    setForegroundError(undefined);
    if (changesView) {
      resetViewProfiling(true);
      if (currentMetadata) storeMetadata(withoutDatasetStats(currentMetadata));
    }
    storeFilterModel(model);
    if (reason === "projection") setProjectionLoading(true);
    else {
      setProjectionLoading(false);
      setLoading(true);
    }
    vscode.postMessage({
      kind: "runtimeRequest",
      viewContextId,
      request: {
        kind: "getPage",
        viewRequestId,
        offset,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit,
        filterModel: model
      }
    });
    return viewRequestId;
  };

  const requestValues = (column: string, search?: string) => {
    if (stepInspectionTargetRef.current) return;
    const currentMetadata = metadataRef.current;
    const currentSnapshotRows = snapshotRowsRef.current;
    const confirmed = confirmedView.current;
    if (!currentMetadata?.schema.some((candidate) => candidate.name === column)) return;
    const viewRequestId = nextViewRequestId();
    const valuesFilterModel = filterModelForColumnValues(currentMetadata.filterModel, column);
    if (currentMetadata && currentSnapshotRows) {
      const values = snapshotColumnValues(
        currentMetadata,
        currentSnapshotRows,
        filterModelForColumnValues(filterModelRef.current, column),
        column,
        search,
        viewRequestId
      );
      storeColumnValues(new Map(columnValuesRef.current).set(column, values));
      return;
    }
    if (!currentMetadata || !confirmed || !canProfileConfirmedView(confirmed.viewContextId)) return;

    const previousRequestId = latestValuesByColumn.current.get(column);
    if (previousRequestId) {
      const previous = pendingBackgroundRequests.current.get(previousRequestId);
      if (previous) cancelBackgroundRequests((pending) => pending === previous);
    }

    latestValuesByColumn.current.set(column, viewRequestId);
    pendingBackgroundRequests.current.set(viewRequestId, {
      kind: "values",
      viewContextId: confirmed.viewContextId,
      column
    });
    vscode.postMessage({
      kind: "runtimeRequest",
      viewContextId: confirmed.viewContextId,
      request: {
        kind: "getColumnValues",
        viewRequestId,
        column,
        search,
        limit: 100,
        filterModel: valuesFilterModel
      }
    });
  };

  const handleVisibleColumnRange = (range: VisibleColumnRange): void => {
    if (snapshotMode) return;
    if (stepInspectionTargetRef.current) {
      const currentInspection = stepInspectionRef.current;
      const currentMetadata = metadataRef.current;
      if (!currentInspection || !currentMetadata) return;
      const inspectionMetadata: SessionMetadata = {
        ...currentMetadata,
        schema: currentInspection.outputSchema
      };
      const window = alignedColumnWindow(
        range,
        currentInspection.outputSchema.length,
        webviewConfig.fetchColumnBlockSize
      );
      inspectionColumnWindow.current = window;
      if (pageCoversColumnWindow(inspectionMetadata, currentInspection.outputPage, window)) return;
      const pending = pendingStepInspectionRef.current;
      if (pending) return;
      requestStepInspection(currentInspection.stepId, currentInspection.outputPage.offset, window, "projection");
      return;
    }

    const currentMetadata = metadataRef.current;
    const currentPage = pageRef.current;
    if (!currentMetadata || !currentPage) return;
    const window = alignedColumnWindow(range, currentMetadata.schema.length, webviewConfig.fetchColumnBlockSize);
    desiredColumnWindow.current = window;
    if (pageCoversColumnWindow(currentMetadata, currentPage, window)) return;
    const pending = latestPageRequest.current;
    if (pending) return;
    requestPage(currentPage.offset, currentMetadata.filterModel, {
      changesView: false,
      viewContextId: confirmedView.current?.viewContextId,
      columnWindow: window,
      reason: "projection"
    });
  };

  const applyFilters = (model: FilterModel) => {
    if (foregroundRequest.current === "mutation" || stepInspectionTargetRef.current) {
      return;
    }
    const pendingPage = latestPageRequest.current;
    const sameDesiredModel = sameFilterModel(model, filterModelRef.current);
    if (sameDesiredModel && pendingPage && sameFilterModel(model, pendingPage.model)) {
      return;
    }
    storeFilterModel(model);
    const currentMetadata = metadataRef.current;
    const currentSnapshotRows = snapshotRowsRef.current;
    if (currentMetadata && currentSnapshotRows) {
      applySnapshotModel(currentMetadata, currentSnapshotRows, model, 0);
      return;
    }

    const failed = failedPageRequestRef.current;
    if (sameDesiredModel && failed && sameFilterModel(model, failed.model)) {
      requestPage(failed.offset, failed.model, {
        changesView: failed.changesView,
        viewContextId: failed.viewContextId,
        columnWindow: failed.columnWindow,
        reason: failed.reason
      });
      return;
    }
    if (sameDesiredModel && !pendingPage && currentMetadata && sameFilterModel(model, currentMetadata.filterModel)) {
      return;
    }

    requestPage(0, model, { changesView: true });
  };

  useEffect(() => {
    if (!sidePanelOpen || !metadata) return;
    enqueueDrawerSummaryColumns();
    requestStatsForConfirmedView();
  }, [activeViewContextId, enqueueDrawerSummaryColumns, metadata, requestStatsForConfirmedView, sidePanelOpen]);

  const previewStep = (step: TransformStep, replaceStepId?: string) => {
    if (!beginMutation()) return;
    const columnWindow = desiredColumnWindow.current;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step,
        replaceStepId,
        offset: 0,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit
      }
    });
  };

  const sendPlanAction = (action: "applyDraft" | "discardDraft" | "undoStep") => {
    if (!beginMutation()) return;
    const columnWindow = desiredColumnWindow.current;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: action,
        offset: 0,
        limit: pageSize,
        columnOffset: columnWindow.offset,
        columnLimit: columnWindow.limit
      }
    });
  };

  const openNewOperation = (kind?: OperationKind) => {
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before adding a cleaning step.");
      }
      return;
    }
    if (!canStartOperation(metadataRef.current)) return;
    if (stepInspectionTargetRef.current) clearStepInspection();
    setEditingStep(undefined);
    setOperationKind(kind);
    setOperationOpen(true);
  };

  const editLatestStep = () => {
    if (foregroundRequest.current) {
      if (latestPageRequest.current?.reason === "projection") {
        setForegroundError("Wait for the visible columns to finish loading before editing a cleaning step.");
      }
      return;
    }
    if (!canEditLatestStep(metadataRef.current)) return;
    if (stepInspectionTargetRef.current) clearStepInspection();
    const latest = metadata?.steps.at(-1);
    if (!latest) return;
    setEditingStep(latest);
    setOperationKind(latest.kind);
    setOperationOpen(true);
  };

  const handleKeyboardShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const editableTarget = isEditableKeyboardTarget(event.target);
    let handled = false;

    if (event.key === "Escape") {
      if (operationOpen) {
        if (foregroundRequest.current !== "mutation") {
          setOperationOpen(false);
          handled = true;
        }
      } else if (stepInspectionTargetRef.current) {
        clearStepInspection();
        handled = true;
      } else if (metadata?.draftStep) {
        if (!projectionLoading) {
          sendPlanAction("discardDraft");
          handled = true;
        }
      }
    } else if (
      modifier &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === "Enter" &&
      metadata?.draftStep &&
      !projectionLoading
    ) {
      sendPlanAction("applyDraft");
      handled = true;
    } else if (!editableTarget && modifier && event.altKey && !event.shiftKey && key === "z") {
      if (!projectionLoading && !metadata?.draftStep && metadata?.steps.length) {
        sendPlanAction("undoStep");
        handled = true;
      }
    } else if (!editableTarget && modifier && event.shiftKey && !event.altKey && key === "e") {
      if (!projectionLoading && !metadata?.draftStep && metadata?.steps.length) {
        editLatestStep();
        handled = true;
      }
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const retryFailedPage = () => {
    const failed = failedPageRequestRef.current;
    if (!failed) return;
    restoreGridFocusForPage.current = requestPage(failed.offset, failed.model, {
      changesView: failed.changesView,
      viewContextId: failed.viewContextId,
      columnWindow: failed.columnWindow,
      reason: failed.reason
    });
  };

  const closeSidePanel = () => {
    sidePanelOpenRef.current = false;
    setSidePanelOpen(false);
    clearDrawerSummaryScheduling();
    cancelBackgroundRequests(
      (pending) =>
        pending.kind === "stats" ||
        pending.kind === "values" ||
        (pending.kind === "summary" && !(summaryOwnersByColumn.current.get(pending.column)?.size ?? 0))
    );
    const returnTarget = sidePanelReturnFocus.current;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
      else sidePanelToggleRef.current?.focus();
    });
  };

  const backgroundDiagnosticMessages = [...backgroundDiagnostics.values()].map((diagnostic) => diagnostic.message);
  const projectionStatusId = projectionLoading ? "column-projection-status" : undefined;
  const projectionActionTitle = projectionLoading ? "Wait for the visible columns to finish loading." : undefined;

  if (foregroundError && !metadata) {
    return (
      <main className="app app-error">
        <h1>Open Wrangler</h1>
        <p role="alert">{foregroundError}</p>
      </main>
    );
  }

  return (
    <main className="app" onKeyDown={handleKeyboardShortcut}>
      <header className="toolbar">
        <div className="toolbarIdentity">
          <strong>{metadata?.source.label ?? "Loading dataframe..."}</strong>
          <span>
            {metadata
              ? `${(displayMetadata ?? metadata).filteredShape.rows.toLocaleString()} rows x ${(displayMetadata ?? metadata).filteredShape.columns.toLocaleString()} columns`
              : "Preparing session"}
          </span>
        </div>
        {metadata && (
          <div className="toolbarActions">
            {metadata.mode === "editing" && !snapshotMode && (
              <button
                type="button"
                disabled={loading || projectionLoading || !canStartOperation(metadata)}
                aria-describedby={projectionStatusId}
                title={
                  projectionActionTitle ??
                  (metadata.draftStep ? "Apply or discard the current draft before adding another step." : undefined)
                }
                onClick={() => openNewOperation()}
              >
                <span className="codicon codicon-add" aria-hidden="true" /> Add step
              </button>
            )}
            <button
              ref={sidePanelToggleRef}
              type="button"
              className="toolbarButton"
              aria-expanded={sidePanelOpen}
              disabled={inspectionMode}
              title={inspectionMode ? "Clear the selected-step inspection to use filters and insights." : undefined}
              onClick={(event) => {
                if (sidePanelOpenRef.current) {
                  closeSidePanel();
                  return;
                }
                sidePanelReturnFocus.current = event.currentTarget;
                sidePanelOpenRef.current = true;
                setSidePanelOpen(true);
              }}
            >
              {inspectionMode ? "Filters paused during inspection" : "Insights & filters"}
            </button>
            <label className="goToColumn">
              <span>Column</span>
              <input
                list="openwrangler-columns"
                value={goToColumn}
                placeholder="Search columns"
                onChange={(event) => setGoToColumn(event.target.value)}
              />
              <datalist id="openwrangler-columns">
                {(displayMetadata ?? metadata).schema.map((column) => (
                  <option key={column.id} value={column.name} />
                ))}
              </datalist>
            </label>
            <span className="modeBadge">{metadata.mode}</span>
            <span className="backendBadge">{metadata.backend}</span>
            {snapshotMode && <span className="modeBadge">Snapshot</span>}
            {inspectionMode && <span className="inspectionBadge">Step inspection</span>}
          </div>
        )}
      </header>

      {metadata && metadata.mode === "editing" && (
        <section className="cleaningBar" aria-label="Cleaning plan">
          <div className="cleaningSummary">
            <span className="codicon codicon-layers" aria-hidden="true" />
            <strong>
              {metadata.steps.length} applied {metadata.steps.length === 1 ? "step" : "steps"}
            </strong>
            {metadata.draftStep && <span className="draftBadge">Draft: {metadata.draftStep.kind}</span>}
          </div>
          <div className="cleaningActions">
            {metadata.draftStep ? (
              <>
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={loading || projectionLoading}
                  aria-describedby={projectionStatusId}
                  aria-keyshortcuts="Escape"
                  title={projectionActionTitle ?? "Discard draft (Escape)"}
                  onClick={() => sendPlanAction("discardDraft")}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={loading || projectionLoading}
                  aria-describedby={projectionStatusId}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  title={projectionActionTitle ?? "Apply draft (Ctrl/Cmd+Enter)"}
                  onClick={() => sendPlanAction("applyDraft")}
                >
                  Apply step
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={loading || projectionLoading || metadata.steps.length === 0}
                  aria-describedby={projectionStatusId}
                  aria-keyshortcuts="Control+Shift+E Meta+Shift+E"
                  title={projectionActionTitle ?? "Edit latest step (Ctrl/Cmd+Shift+E)"}
                  onClick={editLatestStep}
                >
                  Edit latest
                </button>
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={loading || projectionLoading || metadata.steps.length === 0}
                  aria-describedby={projectionStatusId}
                  aria-keyshortcuts="Control+Alt+Z Meta+Alt+Z"
                  title={projectionActionTitle ?? "Undo latest step (Ctrl/Cmd+Alt+Z)"}
                  onClick={() => sendPlanAction("undoStep")}
                >
                  <span className="codicon codicon-discard" aria-hidden="true" /> Undo
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {metadata && inspectionMode && (
        <section className="inspectionPanel" aria-label="Selected applied-step inspection">
          <header>
            <div>
              <strong>
                {pendingStepInspection ? "Loading" : "Inspecting"}{" "}
                {selectedInspectionStep ? operationByKind(selectedInspectionStep.kind).title : "applied step"}
              </strong>
              <span>
                This is that step&apos;s input → output boundary. The confirmed dataframe view and filters are
                unchanged.
              </span>
            </div>
            <button type="button" className="secondaryButton" onClick={() => clearStepInspection()}>
              Show confirmed data
            </button>
          </header>
          {pendingStepInspection && (
            <div role="status" aria-live="polite">
              Loading inspection rows {pendingStepInspection.offset + 1}–{pendingStepInspection.offset + pageSize}…
            </div>
          )}
          {stepInspectionError && (
            <div className="errorBanner" role="alert">
              {stepInspectionError}
            </div>
          )}
          {stepInspection && (
            <>
              <div className="diffStats" aria-label="Selected step data diff summary">
                <span>+{stepInspection.diff.addedRows} rows</span>
                <span>-{stepInspection.diff.removedRows} rows</span>
                <span>+{stepInspection.diff.addedColumns.length} columns</span>
                <span>-{stepInspection.diff.removedColumns.length} columns</span>
                <span>
                  {stepInspection.diff.changedCells} changed cells
                  {stepInspection.diff.truncated ? " in this block" : ""}
                </span>
              </div>
              <details className="draftCode">
                <summary>Generated code through this applied step</summary>
                <pre tabIndex={0} aria-label="Selected step generated Python code">
                  <code>{stepInspection.code}</code>
                </pre>
              </details>
            </>
          )}
        </section>
      )}

      <section className={`layout${sidePanelOpen ? " sidePanelOpen" : ""}`}>
        <section className="gridShell">
          {foregroundError && (
            <div className="errorBanner" role="alert">
              <span>{foregroundError}</span>
              {failedPageRequest && (
                <button type="button" className="secondaryButton" onClick={retryFailedPage}>
                  Retry page
                </button>
              )}
            </div>
          )}
          {backgroundDiagnosticMessages.length > 0 && (
            <div className="errorBanner" role="status" aria-label="Profiling diagnostics">
              Insights warning: {backgroundDiagnosticMessages.join(" ")}
            </div>
          )}
          {loading && (
            <div className="loading" role="status" aria-live="polite">
              Loading...
            </div>
          )}
          {projectionLoading && (
            <div id="column-projection-status" className="loading" role="status" aria-live="polite">
              Loading visible columns… Cleaning actions are temporarily unavailable.
            </div>
          )}
          {displayMetadata && displayPage ? (
            <DataGrid
              key={
                inspectionMode
                  ? `inspection:${stepInspectionTarget?.stepId ?? "loading"}`
                  : `confirmed:${displayMetadata.sessionId}`
              }
              metadata={displayMetadata}
              page={displayPage}
              summaries={inspectionMode ? [] : summaries}
              onPage={(offset) => {
                const stepId = stepInspectionTarget?.stepId;
                if (stepId) requestStepInspection(stepId, offset, inspectionColumnWindow.current, "row");
                else
                  requestPage(offset, filterModelRef.current, {
                    columnWindow: desiredColumnWindow.current,
                    reason: "row"
                  });
              }}
              pageSize={pageSize}
              defaultColumnWidth={webviewConfig.defaultColumnWidth}
              insightsOnOpen={inspectionMode ? false : webviewConfig.insightsOnOpen}
              busy={loading || Boolean(pendingStepInspection && pendingStepInspection.reason !== "projection")}
              projecting={projectionLoading || pendingStepInspection?.reason === "projection"}
              viewContextId={
                inspectionMode ? `inspection:${stepInspectionTarget?.stepId ?? "loading"}` : activeViewContextId
              }
              goToColumn={goToColumn}
              viewState={inspectionMode ? inspectionGridViewState : gridViewState}
              viewStateRestoreVersion={
                inspectionMode ? (stepInspection?.outputPage.offset ?? 0) : viewStateRestoreVersion
              }
              diff={stepInspection?.diff ?? (metadata?.draftStep ? diff : undefined)}
              beforePage={stepInspection?.inputPage ?? draftBefore?.page}
              beforeSchema={stepInspection?.inputSchema ?? draftBefore?.schema}
              viewControlsDisabled={inspectionMode}
              onSortColumn={(column, direction) =>
                inspectionMode
                  ? undefined
                  : applyFilters({
                      ...filterModel,
                      sort: [
                        ...filterModel.sort.filter((rule) => rule.column !== column),
                        { column, direction, nulls: "last" }
                      ]
                    })
              }
              onOpenFilter={(column) => {
                if (inspectionMode) return;
                sidePanelReturnFocus.current =
                  document.activeElement instanceof HTMLElement ? document.activeElement : sidePanelToggleRef.current;
                setFilterColumn(column);
                sidePanelOpenRef.current = true;
                setSidePanelOpen(true);
                requestValues(column);
              }}
              onVisibleSummaryColumnsChange={inspectionMode ? () => undefined : updateVisibleSummaryColumns}
              onVisibleColumnRangeChange={handleVisibleColumnRange}
              onViewStateChange={inspectionMode ? () => undefined : publishGridViewState}
            />
          ) : (
            <div className="emptyState">
              {inspectionMode ? "Loading selected-step inspection…" : "Opening session..."}
            </div>
          )}
        </section>
        {sidePanelOpen && !inspectionMode && (
          <aside className="sidebar" aria-label="Insights and filters">
            <div className="drawerHeader">
              <strong>Insights & filters</strong>
              <button
                type="button"
                className="iconButton codicon codicon-close"
                aria-label="Close panel"
                onClick={closeSidePanel}
              />
            </div>
            <SummaryPanel metadata={metadata} summaries={summaries} schemaByName={schemaByName} />
            <FilterPanel
              key={filterColumn}
              metadata={metadata}
              model={filterModel}
              values={columnValues}
              activeColumn={filterColumn}
              defaultAdvanced={webviewConfig.filterMode === "advanced"}
              disabled={mutationPending}
              onApply={applyFilters}
              onRequestValues={requestValues}
            />
          </aside>
        )}
      </section>
      {metadata?.draftStep && !inspectionMode && (
        <section className="draftPanel" aria-label="Draft preview">
          <header>
            <div>
              <strong>Previewing {metadata.draftStep.kind}</strong>
              <span>The grid shows the draft result. Apply or discard it explicitly.</span>
            </div>
            {diff && (
              <div className="diffStats" aria-label="Data diff summary">
                <span>+{diff.addedRows} rows</span>
                <span>-{diff.removedRows} rows</span>
                <span>+{diff.addedColumns.length} columns</span>
                <span>-{diff.removedColumns.length} columns</span>
                <span>
                  {diff.changedCells} changed cells{diff.truncated ? " in this block" : ""}
                </span>
              </div>
            )}
            {draftWarnings.length > 0 && (
              <div className="draftWarnings" role="alert">
                {draftWarnings.map((warning) => (
                  <span key={warning}>
                    <span className="codicon codicon-warning" aria-hidden="true" /> {warning}
                  </span>
                ))}
              </div>
            )}
          </header>
          <details className="draftCode" open>
            <summary>
              Generated {metadata.backend === "duckdb" ? "DuckDB" : metadata.backend === "pandas" ? "Pandas" : "Polars"}
              code · edit in Code Preview panel
            </summary>
            <pre tabIndex={0} aria-label="Generated Python code preview">
              <code>{generatedCode}</code>
            </pre>
          </details>
        </section>
      )}
      {metadata && operationOpen && (
        <OperationBuilder
          key={`${operationKind ?? "none"}:${editingStep?.id ?? "new"}`}
          metadata={metadata}
          filterModel={filterModel}
          initialKind={operationKind}
          initialStep={editingStep}
          busy={mutationPending || projectionLoading}
          onClose={() => {
            if (foregroundRequest.current !== "mutation") setOperationOpen(false);
          }}
          onPreview={previewStep}
        />
      )}
    </main>
  );

  function applySnapshotModel(metadata: SessionMetadata, rows: DataRow[], model: FilterModel, offset: number): void {
    resetViewProfiling(true);
    const filteredRows = applySnapshotFilters(metadata, rows, model);
    const nextMetadata: SessionMetadata = {
      ...metadata,
      filteredShape: {
        rows: filteredRows.length,
        columns: metadata.shape.columns
      },
      filterModel: model
    };

    setMetadata(nextMetadata);
    metadataRef.current = nextMetadata;
    filterModelRef.current = model;
    setFilterModel(model);
    storePage({
      offset,
      limit: pageSize,
      totalRows: filteredRows.length,
      columnIds: nextMetadata.schema.map((column) => column.id),
      rows: filteredRows.slice(offset, offset + pageSize)
    });
    const snapshotWindow = {
      offset: 0,
      limit: Math.max(1, Math.min(256, nextMetadata.schema.length || webviewConfig.fetchColumnBlockSize))
    };
    confirmedColumnWindow.current = snapshotWindow;
    desiredColumnWindow.current = snapshotWindow;
    const nextSummaries = snapshotSummaries(nextMetadata, filteredRows);
    summariesRef.current = nextSummaries;
    setSummaries(nextSummaries);
    confirmView(nextMetadata, nextViewRequestId());
    setLoading(false);
    setProjectionLoading(false);
    setForegroundError(undefined);
    storeFailedPageRequest(undefined);
  }
}

interface EditorActionMessage {
  kind: "editorAction";
  action: "openOperation" | "editLatest" | "selectStep" | "applyDraft" | "discardDraft" | "undoStep";
  operationKind?: OperationKind;
  stepId?: string;
}

interface ViewStateMessage {
  kind: "viewState";
  state: unknown;
}

interface StepInspectionResultMessage {
  kind: "stepInspectionResult";
  stepId: string;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
  response: OpenWranglerResponse;
}

interface StepInspectionClearedMessage {
  kind: "stepInspectionCleared";
  resumeProfiling: boolean;
}

interface ConfirmedView {
  viewContextId: string;
  sessionId: string;
  revision: number;
}

interface ConfirmedViewState {
  view: ConfirmedView;
  metadata: SessionMetadata;
  page: GridPage;
  columnWindow: ColumnWindow;
  summaries: ColumnSummary[];
  columnValues: ReadonlyMap<string, ValuesResponse>;
  backgroundDiagnostics: ReadonlyMap<string, BackgroundDiagnostic>;
}

interface PendingStepInspection {
  stepId: string;
  offset: number;
  columnWindow: ColumnWindow;
  reason: "selection" | "row" | "projection";
}

interface DiffBeforeState {
  schema: ColumnSchema[];
  page?: GridPage;
}

interface PendingPageRequest {
  viewRequestId: string;
  viewContextId: string;
  changesView: boolean;
  offset: number;
  model: FilterModel;
  columnWindow: ColumnWindow;
  reason: PageRequestReason;
  previousConfirmedState?: ConfirmedViewState;
}

export interface ColumnWindow {
  offset: number;
  limit: number;
}

type PageRequestReason = "view" | "row" | "projection";

type SummaryRequestOwner = "grid" | "drawer";

type PendingBackgroundRequest =
  | {
      kind: "summary";
      viewContextId: string;
      column: string;
      attempt: number;
      owners: Set<SummaryRequestOwner>;
    }
  | { kind: "stats"; viewContextId: string; attempt: number }
  | { kind: "values"; viewContextId: string; column: string };

interface BackgroundDiagnostic {
  message: string;
  pending: PendingBackgroundRequest;
}

interface PageRequestOptions {
  changesView?: boolean;
  viewContextId?: string;
  columnWindow?: ColumnWindow;
  reason?: PageRequestReason;
}

function backgroundDiagnosticKey(pending: PendingBackgroundRequest): string {
  if (pending.kind === "stats") return "stats";
  return `${pending.kind}:${pending.column}`;
}

function cloneBackgroundDiagnostics(
  diagnostics: ReadonlyMap<string, BackgroundDiagnostic>
): ReadonlyMap<string, BackgroundDiagnostic> {
  return new Map(
    [...diagnostics].map(([key, diagnostic]) => [
      key,
      {
        ...diagnostic,
        pending:
          diagnostic.pending.kind === "summary"
            ? { ...diagnostic.pending, owners: new Set(diagnostic.pending.owners) }
            : { ...diagnostic.pending }
      }
    ])
  );
}

function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...rest } = metadata;
  return rest;
}

function isEditableKeyboardTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function sameFilterModel(left: FilterModel, right: FilterModel): boolean {
  return filterModelScope(left) === filterModelScope(right);
}

function filterModelForColumnValues(model: FilterModel, column: string): FilterModel {
  return {
    ...model,
    filters: model.filters.filter((filter) => filter.column !== column)
  };
}

function filterModelScope(model: FilterModel): string {
  return JSON.stringify({ logic: model.logic ?? "and", filters: model.filters, sort: model.sort });
}

function initialColumnWindow(): ColumnWindow {
  return { offset: 0, limit: webviewConfig.fetchColumnBlockSize };
}

export function alignedColumnWindow(range: VisibleColumnRange, totalColumns: number, blockSize: number): ColumnWindow {
  const boundedBlockSize = Math.max(1, Math.min(256, Math.floor(blockSize)));
  if (totalColumns <= 0) return { offset: 0, limit: boundedBlockSize };
  const start = Math.max(0, Math.min(Math.floor(range.start), totalColumns - 1));
  const end = Math.max(start + 1, Math.min(Math.ceil(range.end), totalColumns));
  const offset = Math.floor(start / boundedBlockSize) * boundedBlockSize;
  const alignedEnd = Math.min(totalColumns, Math.ceil(end / boundedBlockSize) * boundedBlockSize);
  if (alignedEnd - offset <= 256) return { offset, limit: Math.max(1, alignedEnd - offset) };

  const shiftedOffset = Math.min(start, Math.max(0, totalColumns - 256));
  return { offset: shiftedOffset, limit: Math.max(1, Math.min(256, totalColumns - shiftedOffset)) };
}

function columnWindowFromPage(
  metadata: SessionMetadata,
  page: GridPage,
  fallback: ColumnWindow = initialColumnWindow()
): ColumnWindow {
  if (!metadata.schema.length) return { offset: 0, limit: Math.max(1, fallback.limit) };
  const firstId = page.columnIds[0];
  const firstPosition = firstId === undefined ? -1 : metadata.schema.findIndex((column) => column.id === firstId);
  if (firstPosition < 0 || page.columnIds.length === 0) {
    return {
      offset: Math.max(0, Math.min(fallback.offset, metadata.schema.length - 1)),
      limit: Math.max(1, Math.min(256, fallback.limit))
    };
  }
  return { offset: firstPosition, limit: Math.max(1, Math.min(256, page.columnIds.length)) };
}

function pageCoversColumnWindow(metadata: SessionMetadata, page: GridPage, window: ColumnWindow): boolean {
  if (!metadata.schema.length) return page.columnIds.length === 0;
  const expectedIds = metadata.schema
    .slice(window.offset, Math.min(metadata.schema.length, window.offset + window.limit))
    .map((column) => column.id);
  if (!expectedIds.length) return false;
  const first = page.columnIds.indexOf(expectedIds[0]);
  return (
    first >= 0 &&
    first + expectedIds.length <= page.columnIds.length &&
    expectedIds.every((columnId, index) => page.columnIds[first + index] === columnId)
  );
}

function isFullWidthPage(metadata: SessionMetadata, page: GridPage): boolean {
  return (
    page.columnIds.length === metadata.schema.length &&
    page.columnIds.every((columnId, index) => columnId === metadata.schema[index]?.id)
  );
}

function readWebviewConfig(): {
  fetchBlockSize: number;
  fetchColumnBlockSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  filterMode: "basic" | "advanced";
} {
  const fetchBlockSize = Number(document.body.dataset.fetchBlockSize ?? 200);
  const fetchColumnBlockSize = Number(document.body.dataset.fetchColumnBlockSize ?? 16);
  const defaultColumnWidth = Number(document.body.dataset.defaultColumnWidth ?? 190);
  return {
    fetchBlockSize: Number.isFinite(fetchBlockSize) ? Math.max(25, Math.min(2000, fetchBlockSize)) : 200,
    fetchColumnBlockSize: Number.isFinite(fetchColumnBlockSize)
      ? Math.max(1, Math.min(256, Math.floor(fetchColumnBlockSize)))
      : 16,
    defaultColumnWidth: Number.isFinite(defaultColumnWidth) ? Math.max(80, Math.min(640, defaultColumnWidth)) : 190,
    insightsOnOpen: document.body.dataset.insightsOnOpen !== "false",
    filterMode: document.body.dataset.filterMode === "advanced" ? "advanced" : "basic"
  };
}
