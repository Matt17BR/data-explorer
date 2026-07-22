import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  bridge: {
    shutdown: vi.fn(),
    reportDiagnostic: vi.fn()
  },
  coordinator: {
    shutdown: vi.fn(),
    createBridge: vi.fn()
  }
}));

vi.mock("../extension/pythonBridge", () => ({
  PythonBridge: vi.fn(function MockPythonBridge() {
    return lifecycle.bridge;
  })
}));

vi.mock("../extension/sessionCoordinator", () => ({
  SessionCoordinator: vi.fn(function MockSessionCoordinator() {
    return lifecycle.coordinator;
  })
}));

vi.mock("../extension/files/fileOpen", () => ({ registerFileCommands: vi.fn() }));
vi.mock("../extension/notebooks/jupyterBridge", () => ({ registerNotebookCommands: vi.fn() }));
vi.mock("../extension/notebooks/rendererMessaging", () => ({ registerNotebookRendererMessaging: vi.fn() }));
vi.mock("../extension/runtimeCommands", () => ({ registerRuntimeCommands: vi.fn() }));
vi.mock("../extension/nativeViews", () => ({ registerNativeViews: vi.fn(() => ({})) }));
vi.mock("../extension/webviewPanel", () => ({
  OpenWranglerPanel: { disposePanelForSession: vi.fn() }
}));

import { activate, deactivate } from "../extension/activate";

describe("extension deactivation", () => {
  const originalExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;

  beforeEach(() => {
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    lifecycle.bridge.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.bridge.reportDiagnostic.mockReset();
    lifecycle.coordinator.shutdown.mockReset().mockResolvedValue(undefined);
    lifecycle.coordinator.createBridge.mockReset().mockReturnValue({ request: vi.fn() });
    activate({ subscriptions: [], workspaceState: {} } as unknown as vscode.ExtensionContext);
  });

  afterEach(async () => {
    lifecycle.bridge.shutdown.mockResolvedValue(undefined);
    lifecycle.coordinator.shutdown.mockResolvedValue(undefined);
    await deactivate();
    if (originalExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    else process.env.OPEN_WRANGLER_EXTENSION_TESTS = originalExtensionTests;
  });

  it("waits for coordinator shutdown before starting bridge shutdown", async () => {
    const coordinatorGate = deferred<void>();
    lifecycle.coordinator.shutdown.mockReturnValue(coordinatorGate.promise);

    const deactivation = deactivate();
    expect(lifecycle.coordinator.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.bridge.shutdown).not.toHaveBeenCalled();

    coordinatorGate.resolve();
    await expect(deactivation).resolves.toBeUndefined();
    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("preserves a sole coordinator failure after still shutting down the bridge", async () => {
    const coordinatorFailure = new Error("coordinator drain failed");
    lifecycle.coordinator.shutdown.mockRejectedValue(coordinatorFailure);

    await expect(deactivate()).rejects.toBe(coordinatorFailure);
    expect(lifecycle.bridge.shutdown).toHaveBeenCalledOnce();
  });

  it("preserves a sole bridge shutdown failure", async () => {
    const bridgeFailure = new Error("runtime exit was not confirmed");
    lifecycle.bridge.shutdown.mockRejectedValue(bridgeFailure);

    await expect(deactivate()).rejects.toBe(bridgeFailure);
  });

  it("aggregates coordinator and bridge failures in shutdown order", async () => {
    const coordinatorFailure = new Error("coordinator drain failed");
    const bridgeFailure = new Error("runtime exit was not confirmed");
    lifecycle.coordinator.shutdown.mockRejectedValue(coordinatorFailure);
    lifecycle.bridge.shutdown.mockRejectedValue(bridgeFailure);

    const error = await deactivate().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([coordinatorFailure, bridgeFailure]);
    expect((error as Error).message).toBe(
      "Open Wrangler extension deactivation encountered multiple shutdown failures."
    );
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
