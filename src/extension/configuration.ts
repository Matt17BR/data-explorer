import * as vscode from "vscode";
import type { OpenWranglerRequest } from "../shared/protocol";

export const CONFIGURATION_SECTION = "openWrangler";
export const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 60_000;

export function getSetting<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, resource).get<T>(key, fallback);
}

export function updateSetting(key: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void> {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).update(key, value, target);
}

export function runtimeRequestTimeoutMs(
  request: Pick<OpenWranglerRequest, "kind">,
  explicitTimeoutMs?: number
): number {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  return request.kind === "openSession"
    ? getSetting<number>("sessionOpenTimeoutMs", DEFAULT_SESSION_OPEN_TIMEOUT_MS)
    : getSetting<number>("requestTimeoutMs", DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS);
}
