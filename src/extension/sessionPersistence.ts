import type { DataBackend, SessionMetadata, SessionSource, TransformStep } from "../shared/protocol";
import { isFilterModel, isRetainedTransformStep } from "../shared/protocolValidation";
import { decodeGridViewState, type GridViewState, type PersistedViewingState } from "../shared/viewState";

export const SESSION_STORAGE_KEY = "openWrangler.persistedSessions.v4";

export interface PersistedCleaningState {
  steps: TransformStep[];
  draftStep?: TransformStep;
  draftReplacesStepId?: string;
}

export interface PersistedSessionState {
  backend: DataBackend;
  cleaning: PersistedCleaningState;
  view: PersistedViewingState;
}

export interface DecodedPersistedSessionState {
  backend: DataBackend;
  cleaning: PersistedCleaningState;
  view?: PersistedViewingState;
}

export function persistenceKey(source: SessionSource, backend: DataBackend): string {
  return JSON.stringify({
    backend,
    kind: source.kind,
    path: source.path ?? null,
    uri: source.uri ?? null,
    variableName: source.variableName ?? null,
    label: source.label,
    importOptions: source.importOptions ?? null
  });
}

export function persistedSessionState(metadata: SessionMetadata, gridViewState: GridViewState): PersistedSessionState {
  return {
    backend: metadata.backend,
    cleaning: {
      steps: metadata.steps,
      draftStep: metadata.draftStep,
      draftReplacesStepId: metadata.draftReplacesStepId
    },
    view: {
      ...gridViewState,
      filterModel: metadata.filterModel
    }
  };
}

export function decodePersistedSession(value: unknown): DecodedPersistedSessionState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["backend", "cleaning"], ["view"]) ||
    !isDataBackend(value.backend) ||
    !isRecord(value.cleaning) ||
    !hasExactKeys(value.cleaning, ["steps"], ["draftStep", "draftReplacesStepId"]) ||
    !Array.isArray(value.cleaning.steps)
  ) {
    return undefined;
  }
  const steps = value.cleaning.steps.map(decodeStep);
  if (steps.some((step) => step === undefined)) return undefined;
  const draftStep = value.cleaning.draftStep === undefined ? undefined : decodeStep(value.cleaning.draftStep);
  if (value.cleaning.draftStep !== undefined && !draftStep) return undefined;
  const draftReplacesStepId = value.cleaning.draftReplacesStepId;
  if (draftReplacesStepId !== undefined && (typeof draftReplacesStepId !== "string" || !draftReplacesStepId)) {
    return undefined;
  }
  const view = decodePersistedView(value.view);
  return {
    backend: value.backend,
    cleaning: {
      steps: steps as TransformStep[],
      draftStep,
      draftReplacesStepId
    },
    ...(view ? { view } : {})
  };
}

function decodePersistedView(value: unknown): PersistedViewingState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["filterModel", "columnWidths", "viewport"], ["selectedColumnId"]) ||
    !isFilterModel(value.filterModel)
  ) {
    return undefined;
  }
  const gridViewState = decodeGridViewState({
    columnWidths: value.columnWidths,
    ...(value.selectedColumnId === undefined ? {} : { selectedColumnId: value.selectedColumnId }),
    viewport: value.viewport
  });
  return gridViewState ? { ...gridViewState, filterModel: value.filterModel } : undefined;
}

function isDataBackend(value: unknown): value is DataBackend {
  return value === "polars" || value === "duckdb" || value === "pandas";
}

function decodeStep(value: unknown): TransformStep | undefined {
  return isRetainedTransformStep(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
