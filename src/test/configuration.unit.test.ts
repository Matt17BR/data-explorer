import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS,
  DEFAULT_SESSION_OPEN_TIMEOUT_MS,
  runtimeRequestTimeoutMs
} from "../extension/configuration";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime request deadlines", () => {
  it("reserves a longer bounded default for cold session initialization", () => {
    expect(runtimeRequestTimeoutMs({ kind: "openSession" })).toBe(DEFAULT_SESSION_OPEN_TIMEOUT_MS);
    expect(DEFAULT_SESSION_OPEN_TIMEOUT_MS).toBe(60_000);
    expect(runtimeRequestTimeoutMs({ kind: "getPage" })).toBe(DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("reads independent configured session-open and steady-state deadlines", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, fallback: T): T =>
        (key === "sessionOpenTimeoutMs" ? 75_000 : key === "requestTimeoutMs" ? 12_000 : fallback) as T
    } as vscode.WorkspaceConfiguration);

    expect(runtimeRequestTimeoutMs({ kind: "openSession" })).toBe(75_000);
    expect(runtimeRequestTimeoutMs({ kind: "getSummary" })).toBe(12_000);
  });

  it("keeps explicit per-call cleanup and test deadlines authoritative", () => {
    expect(runtimeRequestTimeoutMs({ kind: "openSession" }, 2_000)).toBe(2_000);
    expect(runtimeRequestTimeoutMs({ kind: "closeSession" }, 0)).toBe(0);
  });
});
