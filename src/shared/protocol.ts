export * from "./protocol.generated";

import type {
  ColumnVisualization,
  OpenWranglerRequest,
  DatasetStats,
  SessionSource,
  TypedCellKind
} from "./protocol.generated";

export const PROTOCOL_VERSION = 2 as const;

export type SessionSourceKind = SessionSource["kind"];
export type NumericVisualization = Extract<ColumnVisualization, { kind: "numeric" }>;
export type CategoricalVisualization = Extract<ColumnVisualization, { kind: "categorical" }>;
export type BooleanVisualization = Extract<ColumnVisualization, { kind: "boolean" }>;
export type DatetimeVisualization = Extract<ColumnVisualization, { kind: "datetime" }>;
export type MissingValueByColumn = DatasetStats["missingValuesByColumn"][number];
export type SessionBoundRequest = Extract<OpenWranglerRequest, { sessionId: string }>;

export function isSessionBoundRequest(request: OpenWranglerRequest): request is SessionBoundRequest {
  return "sessionId" in request;
}

export function typedCellKind(value: unknown, isNull: boolean, isNaN: boolean): TypedCellKind {
  if (isNull) return "null";
  if (isNaN) return "nan";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return "unknown";
}
