import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ErrorResponse,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  SessionSource
} from "../shared/protocol";
import type { CancellationTokenLike } from "../extension/dataBridge";
import * as pythonEnvironment from "../extension/pythonEnvironment";
import { PythonBridge } from "../extension/pythonBridge";

vi.mock("../extension/pythonEnvironment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extension/pythonEnvironment")>();
  return {
    ...actual,
    probeDependencies: vi.fn(),
    resolvePythonEnvironment: vi.fn()
  };
});

const initializeRequest: OpenWranglerRequest = { kind: "initialize" };
const initializedResponse: OpenWranglerResponse = {
  kind: "initialized",
  protocolVersion: 2,
  runtimeVersion: "test-runtime",
  capabilities: {
    editable: true,
    lazy: true,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: true
  }
};

describe("PythonBridge cancellation", () => {
  it("waits for the authoritative result when running work cannot be cancelled", async () => {
    const token = new ManualCancellation();
    const harness = createHarness();
    const response = harness.bridge.request(initializeRequest, { cancellation: token, timeoutMs: 5_000 });
    await harness.waitForWrites(1);
    const original = harness.writes()[0];

    token.cancel();
    await harness.waitForWrites(2);
    const cancellation = harness.writes()[1];
    expect(cancellation.request).toEqual({ kind: "cancelRequest", targetRequestId: original.requestId });

    harness.respond(cancellation.requestId, {
      kind: "error",
      code: "cancellation_unavailable",
      message: "The request is already running.",
      recoverable: true
    });
    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.respond(original.requestId, initializedResponse);
    await expect(response).resolves.toEqual(initializedResponse);
    expect(token.dispose).toHaveBeenCalledOnce();
    expect(harness.pendingCount()).toBe(0);
    expect(harness.cancellationCount()).toBe(0);
  });

  it("settles as cancelled only after the original request returns its correlated cancellation", async () => {
    const token = new ManualCancellation();
    const harness = createHarness();
    const response = harness.bridge.request(initializeRequest, { cancellation: token, timeoutMs: 5_000 });
    await harness.waitForWrites(1);
    const original = harness.writes()[0];

    token.cancel();
    await harness.waitForWrites(2);
    const cancellation = harness.writes()[1];
    harness.respond(cancellation.requestId, { kind: "cancelled", targetRequestId: original.requestId });

    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(token.dispose).not.toHaveBeenCalled();
    expect(harness.pendingCount()).toBe(1);
    expect(harness.cancellationCount()).toBe(0);

    harness.respond(original.requestId, { kind: "cancelled", targetRequestId: original.requestId });
    await expect(response).resolves.toEqual({ kind: "cancelled", targetRequestId: original.requestId });
    expect(token.dispose).toHaveBeenCalledOnce();
    expect(harness.pendingCount()).toBe(0);
  });

  it("does not start the runtime when cancellation arrives during request preparation", async () => {
    const prepared = deferred<OpenWranglerRequest | ErrorResponse>();
    const token = new ManualCancellation();
    const harness = createHarness(() => prepared.promise);

    const response = harness.bridge.request(initializeRequest, { cancellation: token, timeoutMs: 5_000 });
    token.cancel();
    prepared.resolve(initializeRequest);

    await expect(response).resolves.toEqual({ kind: "cancelled", targetRequestId: "not-started" });
    expect(harness.ensureProcess).not.toHaveBeenCalled();
    expect(harness.writes()).toEqual([]);
  });

  it("handles synchronous cancellation subscription without dispatching or leaking the listener", async () => {
    const dispose = vi.fn();
    const token: CancellationTokenLike = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        listener();
        return { dispose };
      }
    };
    const harness = createHarness();

    await expect(harness.bridge.request(initializeRequest, { cancellation: token, timeoutMs: 5_000 })).resolves.toEqual(
      { kind: "cancelled", targetRequestId: "not-started" }
    );
    expect(harness.writes()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(harness.pendingCount()).toBe(0);
  });

  it("rejects a file request when selection changes after preparation resolves but before dispatch", async () => {
    const request = openSessionRequest(remoteFileSource());
    const prepared = deferred<OpenWranglerRequest | ErrorResponse>();
    const harness = createHarness(() => prepared.promise);

    const response = harness.bridge.request(request);
    harness.advanceSelectionEpoch();
    prepared.resolve(request);

    await expect(response).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(harness.ensureProcess).not.toHaveBeenCalled();
  });

  it("rejects a file request when selection changes while process acquisition is pending", async () => {
    const request = openSessionRequest(remoteFileSource());
    const processReady = deferred<ChildProcessWithoutNullStreams>();
    const harness = createHarness();
    harness.ensureProcess.mockReturnValue(processReady.promise);

    const response = harness.bridge.request(request);
    await vi.waitFor(() => expect(harness.ensureProcess).toHaveBeenCalledOnce());
    harness.advanceSelectionEpoch();
    processReady.resolve({} as ChildProcessWithoutNullStreams);

    await expect(response).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(harness.writes()).toEqual([]);
  });
});

describe("PythonBridge transport validation and timeout isolation", () => {
  it("ignores a malformed correlated response until a valid response arrives", async () => {
    const harness = createHarness();
    const response = harness.bridge.request(initializeRequest, { timeoutMs: 5_000 });
    await harness.waitForWrites(1);
    const requestId = harness.writes()[0].requestId;

    harness.respondRaw({ protocolVersion: 2, requestId, response: { kind: "initialized" } });
    expect(harness.pendingCount()).toBe(1);

    harness.respond(requestId, initializedResponse);
    await expect(response).resolves.toEqual(initializedResponse);
  });

  it("does not restart the shared runtime when a caller disables restart on timeout", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const response = harness.bridge.request(initializeRequest, {
        timeoutMs: 10,
        restartRuntimeOnTimeout: false
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.writes()).toHaveLength(1);

      const rejection = expect(response).rejects.toThrow("timed out after 10 ms");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(harness.restart).not.toHaveBeenCalled();
      expect(harness.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the dedicated configured deadline for a cold session open", async () => {
    const configuration = vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, fallback: T): T =>
        (key === "sessionOpenTimeoutMs" ? 25 : key === "requestTimeoutMs" ? 5_000 : fallback) as T
    } as vscode.WorkspaceConfiguration);
    try {
      const harness = createHarness();
      const response = harness.bridge.request(openSessionRequest(remoteFileSource()));
      const outcome = response.catch((error: unknown) => error);
      await vi.waitFor(() => expect(harness.writes()[0]?.request.kind).toBe("openSession"));

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("openSession timed out after 25 ms");
      expect(harness.restart).toHaveBeenCalledOnce();
    } finally {
      configuration.mockRestore();
    }
  });
});

describe("PythonBridge process lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
  });

  it("reports the runtime as running until graceful shutdown confirms process exit", async () => {
    const { bridge, internals, process } = createLifecycleHarness();

    expect(bridge.runtimeRunning).toBe(true);
    bridge.onIdle();

    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(bridge.runtimeRunning).toBe(true);
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();

    process.emit("exit", 0, null);
    await expect(stopping).resolves.toBeUndefined();
    await Promise.resolve();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("joins terminal shutdown until the exact process exits and disposes owned resources once", async () => {
    const { bridge, internals, process, configurationSubscription, output } = createLifecycleHarness();

    const first = bridge.shutdown();
    const second = bridge.shutdown();

    expect(second).toBe(first);
    expect(internals.disposed).toBe(true);
    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(configurationSubscription.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).not.toHaveBeenCalled();

    process.emit("exit", 0, null);
    await expect(first).resolves.toBeUndefined();
    expect(output.dispose).toHaveBeenCalledOnce();

    bridge.dispose();
    await expect(bridge.shutdown()).resolves.toBeUndefined();
    expect(configurationSubscription.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  it("still stops the child and disposes output when configuration-listener disposal fails", async () => {
    const { bridge, process, configurationSubscription, output } = createLifecycleHarness();
    const listenerFailure = new Error("configuration listener disposal failed");
    configurationSubscription.dispose.mockImplementation(() => {
      throw listenerFailure;
    });

    const shutdown = bridge.shutdown();
    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(output.dispose).not.toHaveBeenCalled();

    process.emit("exit", 0, null);
    await expect(shutdown).rejects.toBe(listenerFailure);
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  it("still stops the child when the shutdown diagnostic channel is unavailable", async () => {
    const { bridge, process, output } = createLifecycleHarness();
    output.appendLine.mockImplementationOnce(() => {
      throw new Error("diagnostic channel unavailable");
    });

    const shutdown = bridge.shutdown();
    expect(process.stdin.end).toHaveBeenCalledOnce();

    process.emit("exit", 0, null);
    await expect(shutdown).resolves.toBeUndefined();
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  it("retains process-stop and output-disposal failures in cleanup order", async () => {
    vi.useFakeTimers();
    const { bridge, process, output } = createLifecycleHarness();
    const outputFailure = new Error("output disposal failed");
    output.dispose.mockImplementation(() => {
      throw outputFailure;
    });

    const shutdown = bridge.shutdown();
    const rejected = shutdown.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    const error = await rejected;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining("could not confirm that its Python runtime exited")
    });
    expect((error as AggregateError).errors[1]).toBe(outputFailure);
    expect(process.kill).toHaveBeenCalledOnce();

    process.emit("exit", null, "SIGKILL");
  });

  it("surfaces missing exit confirmation through awaited shutdown while synchronous dispose observes it", async () => {
    vi.useFakeTimers();
    const { bridge, process, configurationSubscription, output } = createLifecycleHarness();

    const shutdown = bridge.shutdown();
    bridge.dispose();
    const rejection = expect(shutdown).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(4_000);
    await rejection;
    expect(process.kill).toHaveBeenCalledOnce();
    expect(configurationSubscription.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).toHaveBeenCalledOnce();
    expect(bridge.shutdown()).toBe(shutdown);

    process.emit("exit", null, "SIGKILL");
  });

  it("does not start a replacement until the preceding shutdown settles", async () => {
    const { internals } = createLifecycleHarness();
    const stopping = deferred<void>();
    internals.process = undefined;
    internals.processStop = stopping.promise;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockClear();

    const starting = internals.ensureProcess(initializeRequest);
    await Promise.resolve();
    expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();

    internals.runtimeEpoch += 1;
    stopping.resolve(undefined);
    await expect(starting).rejects.toThrow("runtime start was cancelled");
    expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();
  });

  it("fails closed instead of spawning after forced shutdown lacks exit confirmation", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process } = createLifecycleHarness();

    bridge.onIdle();
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();
    const rejected = expect(stopping).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(4_000);
    await rejected;
    expect(process.kill).toHaveBeenCalledOnce();
    expect(bridge.runtimeRunning).toBe(true);
    await expect(internals.ensureProcess(initializeRequest)).rejects.toThrow(
      "could not confirm shutdown of its previous Python runtime"
    );
    expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();

    process.emit("exit", null, "SIGKILL");
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("releases an overlapping rejected stop barrier after every exact child later exits", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const second = new LifecycleChildProcess();
    internals.process = undefined;

    internals.trackProcessStop(first as unknown as ChildProcessWithoutNullStreams, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    internals.trackProcessStop(second as unknown as ChildProcessWithoutNullStreams, 0);
    const overlappingStop = internals.processStop;
    expect(overlappingStop).toBeDefined();
    let stopSettled = false;
    void overlappingStop?.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      }
    );
    const rejection = expect(overlappingStop).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopSettled).toBe(false);
    expect(bridge.runtimeRunning).toBe(true);

    second.emit("exit", null, "SIGKILL");
    await rejection;
    expect(stopSettled).toBe(true);
    expect(bridge.runtimeRunning).toBe(true);

    first.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(internals.processStop).toBeUndefined();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("waits for and preserves every overlapping bounded stop failure in order", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const second = new LifecycleChildProcess();
    first.kill.mockReturnValue(false);
    second.kill.mockImplementation(() => {
      throw new Error("second child termination threw");
    });
    internals.process = undefined;

    internals.trackProcessStop(first as unknown as ChildProcessWithoutNullStreams, 0);
    internals.trackProcessStop(second as unknown as ChildProcessWithoutNullStreams, 0);
    const overlappingStop = internals.processStop;
    expect(overlappingStop).toBeDefined();
    const rejected = overlappingStop?.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining("operating system did not accept the termination signal")
    });
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: expect.stringContaining("second child termination threw")
    });
    expect(bridge.runtimeRunning).toBe(true);

    first.emit("exit", null, "SIGKILL");
    second.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(internals.processStop).toBeUndefined();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("releases a pre-exited overlapping child independently of an earlier failed stop", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const alreadyExited = new LifecycleChildProcess();
    alreadyExited.exitCode = 0;
    internals.process = undefined;

    internals.trackProcessStop(first as unknown as ChildProcessWithoutNullStreams, 0);
    internals.trackProcessStop(alreadyExited as unknown as ChildProcessWithoutNullStreams, 0);
    const overlappingStop = internals.processStop;
    expect(overlappingStop).toBeDefined();
    const rejection = expect(overlappingStop).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(bridge.runtimeRunning).toBe(true);

    first.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(internals.processStop).toBeUndefined();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("forces restart termination immediately but retains ownership until exit", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process } = createLifecycleHarness();

    bridge.restart("Acceptance restart.");

    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(bridge.runtimeRunning).toBe(true);
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();
    process.emit("exit", null, "SIGTERM");
    await expect(stopping).resolves.toBeUndefined();
    await Promise.resolve();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("spawns one replacement only after restart observes the prior process exit", async () => {
    const { bridge, internals, process } = createLifecycleHarness();
    const replacement = new LifecycleChildProcess();
    internals.spawnProcess.mockReturnValue(replacement as unknown as ChildProcessWithoutNullStreams);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      executable: "/env/bin/python",
      version: "3.12.4",
      source: "configuration"
    });

    bridge.restart("Acceptance restart.");
    const starting = internals.ensureProcess(initializeRequest);
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.spawnProcess).not.toHaveBeenCalled();

    process.emit("exit", null, "SIGKILL");
    await expect(starting).resolves.toBe(replacement);
    expect(internals.spawnProcess).toHaveBeenCalledOnce();

    bridge.restart("Acceptance cleanup.");
    const cleanup = internals.processStop;
    replacement.emit("exit", null, "SIGKILL");
    await expect(cleanup).resolves.toBeUndefined();
  });
});

describe("PythonBridge dependency installation", () => {
  const originalExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;

  beforeEach(() => {
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    setWorkspaceTrust(true);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  afterEach(() => {
    if (originalExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    else process.env.OPEN_WRANGLER_EXTENSION_TESTS = originalExtensionTests;
    setWorkspaceTrust(true);
    vi.restoreAllMocks();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it("requires the exact production modal and retains its diagnostic when the user cancels", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);

    await expect(bridge.installMissingDependencies()).resolves.toBe(false);

    expect(warning).toHaveBeenCalledWith(
      "Install pandas, xlrd>=2.0.1 into /env/bin/python?",
      { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
      "Install"
    );
    expect(executeFile).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toEqual(missingDependencies());
    expect([...internals.dependencyCache]).toEqual([["cached-diagnostic", ["pandas"]]]);
    expect(internals.runtimeEpoch).toBe(0);
  });

  it("installs the exact requirements only after the production modal returns Install", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);

    expect(executeFile).toHaveBeenCalledOnce();
    expect(executeFile).toHaveBeenCalledWith("/env/bin/python", ["-m", "pip", "install", "pandas", "xlrd>=2.0.1"], {
      timeout: 10 * 60_000
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);
    expect(internals.runtimeEpoch).toBe(1);
    expect(internals.selectionEpoch).toBe(1);
    expect(information).toHaveBeenCalledWith("Open Wrangler runtime dependencies were installed.");
  });

  it("exposes only a safe decline behind the environment-gated test method", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");

    await expect(bridge.declineMissingDependencyInstallForTesting()).rejects.toThrow(
      "available only to the Open Wrangler test harness"
    );

    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    await expect(bridge.declineMissingDependencyInstallForTesting()).resolves.toBe(false);
    expect(warning).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toEqual(missingDependencies());
  });

  it("keeps a test decline independent from an already-open production install", async () => {
    const { bridge, executeFile } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const productionInstallation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    const testDecline = bridge.declineMissingDependencyInstallForTesting();
    modal.resolve("Install");

    await expect(Promise.all([productionInstallation, testDecline])).resolves.toEqual([true, false]);
    expect(executeFile).toHaveBeenCalledOnce();
  });

  it("never lets a test decline suppress the next production confirmation modal", async () => {
    const { bridge, executeFile } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockReturnValue(modal.promise as unknown as Thenable<never>);
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const testDecline = bridge.declineMissingDependencyInstallForTesting();
    const productionInstallation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    modal.resolve(undefined);

    await expect(Promise.all([testDecline, productionInstallation])).resolves.toEqual([false, false]);
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("joins concurrent install commands to one modal and one pip invocation", async () => {
    const { bridge, executeFile } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockReturnValue(modal.promise as unknown as Thenable<never>);

    const first = bridge.installMissingDependencies();
    const second = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    modal.resolve("Install");

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(warning).toHaveBeenCalledOnce();
    expect(executeFile).toHaveBeenCalledOnce();
  });

  it("rejects an affirmative modal when its exact dependency target was replaced", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    const replacement = {
      environment: { executable: "/env/bin/python", version: "3.12.4", source: "configuration" as const },
      requirements: ["polars"],
      selectionEpoch: 0
    };
    internals.lastMissingDependencies = replacement;

    modal.resolve("Install");
    await expect(installation).resolves.toBe(false);

    expect(executeFile).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toBe(replacement);
  });

  it("revalidates selection and trust after an affirmative modal before running pip", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());

    setWorkspaceTrust(false);
    modal.resolve("Install");
    await expect(installation).resolves.toBe(false);

    expect(executeFile).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toEqual(missingDependencies());
  });

  it("does not run pip when the bridge is disposed while its modal is open", async () => {
    const { bridge, executeFile } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());

    bridge.dispose();
    modal.resolve("Install");

    await expect(installation).resolves.toBe(false);
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("revalidates the target inside the progress callback immediately before pip", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    const enteredProgress = deferred<void>();
    const releaseProgress = deferred<void>();
    const progressWindow = vscode.window as unknown as TestProgressWindow;
    vi.spyOn(progressWindow, "withProgress").mockImplementation(async (_options, task) => {
      enteredProgress.resolve();
      await releaseProgress.promise;
      return task();
    });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await enteredProgress.promise;
    internals.lastMissingDependencies = {
      environment: { executable: "/env/bin/python", version: "3.12.4", source: "configuration" },
      requirements: ["polars"],
      selectionEpoch: 0
    };
    releaseProgress.resolve();

    await expect(installation).resolves.toBe(false);
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("never clears or restarts a newer selection after an old pip process finishes", async () => {
    const execution = deferred<void>();
    const { bridge, internals, executeFile } = createDependencyHarness(() => execution.promise);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledOnce());

    bridge.clearRuntimeSelection();
    const newerTarget = {
      environment: { executable: "/new/bin/python", version: "3.13.1", source: "configuration" as const },
      requirements: ["polars"],
      selectionEpoch: 1
    };
    internals.lastMissingDependencies = newerTarget;
    internals.dependencyCache.set("new-selection", ["polars"]);
    const runtimeEpochAfterSelectionChange = internals.runtimeEpoch;
    execution.resolve();

    await expect(installation).resolves.toBe(true);
    expect(internals.lastMissingDependencies).toBe(newerTarget);
    expect([...internals.dependencyCache]).toEqual([["new-selection", ["polars"]]]);
    expect(internals.runtimeEpoch).toBe(runtimeEpochAfterSelectionChange);
  });

  it("invalidates an older overlapping probe when pip completes in the same selection epoch", async () => {
    const request = openSessionRequest(remoteFileSource());
    const firstProbe = deferred<{ missing: string[]; available: string[] }>();
    const overlappingProbe = deferred<{ missing: string[]; available: string[] }>();
    const { bridge, internals } = createDependencyHarness();
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockReturnValueOnce(firstProbe.promise)
      .mockReturnValueOnce(overlappingProbe.promise)
      .mockResolvedValueOnce({ missing: [], available: ["polars"] });
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(missingDependencies().environment);

    const firstPreparation = internals.prepareRequest(request);
    const overlappingPreparation = internals.prepareRequest(request);
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledTimes(2));
    firstProbe.resolve({ missing: ["polars"], available: [] });
    await expect(firstPreparation).resolves.toMatchObject({ kind: "error", code: "missing_dependencies" });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);
    expect(internals.selectionEpoch).toBe(1);
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);
    expect(internals.environmentPromise).toBeUndefined();

    overlappingProbe.resolve({ missing: ["polars"], available: [] });
    await expect(overlappingPreparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);

    await expect(internals.prepareRequest(request)).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(1);
  });

  it("enforces Workspace Trust before production confirmation", async () => {
    const { bridge, internals, executeFile } = createDependencyHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    setWorkspaceTrust(false);

    await expect(bridge.installMissingDependencies()).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith("Trust this workspace before installing Python dependencies.");
    expect(warning).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toEqual(missingDependencies());
  });

  it("invalidates an actionable dependency target when runtime selection changes", () => {
    const { bridge, internals } = createDependencyHarness();

    bridge.clearRuntimeSelection();

    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);
    expect(internals.runtimeEpoch).toBe(1);
    expect(internals.selectionEpoch).toBe(1);
  });

  it("does not advance either epoch when a repeated invalidation has no selection state left", () => {
    const { bridge, internals } = createDependencyHarness();
    bridge.clearRuntimeSelection();
    const runtimeEpoch = internals.runtimeEpoch;
    const selectionEpoch = internals.selectionEpoch;

    bridge.clearRuntimeSelection();

    expect(internals.runtimeEpoch).toBe(runtimeEpoch);
    expect(internals.selectionEpoch).toBe(selectionEpoch);
  });

  it("invalidates runtime selection on direct pythonPath configuration changes and disposes the listener", () => {
    const bridge = new PythonBridge({ extensionPath: "/extension" } as vscode.ExtensionContext);
    const internals = bridge as unknown as DependencyBridgeInternals;
    internals.lastMissingDependencies = missingDependencies();
    internals.dependencyCache.set("configured", ["pandas"]);
    const workspace = vscode.workspace as unknown as TestWorkspace;

    workspace.__fireDidChangeConfiguration("editor.fontSize");
    expect(internals.selectionEpoch).toBe(0);
    workspace.__fireDidChangeConfiguration("openWrangler.pythonPath");
    expect(internals.selectionEpoch).toBe(1);
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);

    bridge.dispose();
    workspace.__fireDidChangeConfiguration("openWrangler.pythonPath");
    expect(internals.selectionEpoch).toBe(1);
  });
});

describe("PythonBridge environment resource selection", () => {
  const environment = {
    executable: "/env/bin/python",
    version: "3.12.4",
    source: "pythonExtension" as const
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it("passes the exact remote source URI to dependency preparation without rebuilding it as file://", async () => {
    const source = remoteFileSource();
    const { context, internals } = createEnvironmentHarness();
    const parse = vi.spyOn(vscode.Uri, "parse");
    const file = vi.spyOn(vscode.Uri, "file");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });

    expect(parse).toHaveBeenCalledWith(source.uri, true);
    expect(file).not.toHaveBeenCalled();
    const resource = vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1];
    expect(resource?.scheme).toBe("vscode-remote");
    expect(resource?.authority).toBe("ssh-remote+example");
    expect(resource?.toString()).toBe(source.uri);
    expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledWith(context, resource);
  });

  it("passes the exact remote source URI to process startup without rebuilding it as file://", async () => {
    const source = remoteFileSource();
    const { context, internals } = createEnvironmentHarness({ disposed: true });
    const parse = vi.spyOn(vscode.Uri, "parse");
    const file = vi.spyOn(vscode.Uri, "file");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);

    await expect(internals.startProcess(openSessionRequest(source), 0)).rejects.toThrow("runtime start was cancelled");

    expect(parse).toHaveBeenCalledWith(source.uri, true);
    expect(file).not.toHaveBeenCalled();
    const resource = vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1];
    expect(resource?.scheme).toBe("vscode-remote");
    expect(resource?.authority).toBe("ssh-remote+example");
    expect(resource?.toString()).toBe(source.uri);
    expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledWith(context, resource);
  });

  it("falls back to the concrete path when a persisted source URI is malformed", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    const malformed = { ...source, uri: "missing-scheme" };
    const parse = vi.spyOn(vscode.Uri, "parse");
    const file = vi.spyOn(vscode.Uri, "file");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await internals.prepareRequest(openSessionRequest(malformed));

    expect(parse).toHaveBeenCalledWith(malformed.uri, true);
    expect(file).toHaveBeenCalledWith(malformed.path);
    const resource = vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1];
    expect(resource?.scheme).toBe("file");
    expect(resource?.fsPath).toBe(malformed.path);
  });

  it("clears a stale install target after successful dependency resolution without discarding the probe cache", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    internals.lastMissingDependencies = missingDependencies();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });

    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(1);
    await internals.prepareRequest(openSessionRequest(source));
    expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce();
    expect(internals.dependencyCache.size).toBe(1);
  });

  it("re-publishes a cached missing-dependency diagnostic after an earlier target is cleared", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: ["polars"], available: [] });

    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    internals.lastMissingDependencies = undefined;
    await internals.prepareRequest(openSessionRequest(source));

    expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce();
    expect(internals.lastMissingDependencies).toEqual({
      environment,
      requirements: ["polars"],
      selectionEpoch: 0
    });
  });

  it("does not publish an old deferred probe after runtime selection is cleared", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    const probe = deferred<{ missing: string[]; available: string[] }>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockReturnValue(probe.promise);

    const preparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    internals.clearRuntimeSelection();
    probe.resolve({ missing: ["polars"], available: [] });

    await expect(preparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed",
      recoverable: true
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);
    expect(internals.selectionEpoch).toBe(1);
  });

  it("does not probe or publish an environment resolved after runtime selection is cleared", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    const resolution = deferred<typeof environment>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReturnValue(resolution.promise);

    const preparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());
    internals.clearRuntimeSelection();
    resolution.resolve(environment);

    await expect(preparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyCache.size).toBe(0);
  });
});

class ManualCancellation implements CancellationTokenLike {
  isCancellationRequested = false;
  private listener: (() => void) | undefined;
  readonly dispose = vi.fn();

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: this.dispose };
  }

  cancel(): void {
    if (this.isCancellationRequested) return;
    this.isCancellationRequested = true;
    this.listener?.();
  }
}

interface BridgeInternals {
  process: ChildProcessWithoutNullStreams;
  disposed: boolean;
  stderrBuffer: string;
  pending: Map<string, unknown>;
  cancellationTargets: Map<string, string>;
  output: { appendLine(message: string): void };
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
  ensureProcess(request: OpenWranglerRequest): Promise<ChildProcessWithoutNullStreams>;
  handleRuntimeLine(line: string): void;
}

interface LifecycleBridgeInternals {
  process: ChildProcessWithoutNullStreams | undefined;
  processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  processStop: Promise<void> | undefined;
  disposed: boolean;
  runtimeEpoch: number;
  spawnProcess: ReturnType<typeof vi.fn>;
  ensureProcess(request: OpenWranglerRequest): Promise<ChildProcessWithoutNullStreams>;
  trackProcessStop(proc: ChildProcessWithoutNullStreams, gracefulTimeoutMs?: number): void;
}

class LifecycleChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    vi.spyOn(this.stdin, "end");
  }
}

function createLifecycleHarness(): {
  bridge: PythonBridge;
  internals: LifecycleBridgeInternals;
  process: LifecycleChildProcess;
  configurationSubscription: { dispose: ReturnType<typeof vi.fn> };
  output: { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
} {
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const process = new LifecycleChildProcess();
  const configurationSubscription = { dispose: vi.fn() };
  const output = { appendLine: vi.fn(), dispose: vi.fn() };
  Object.assign(bridge as object, {
    context: { extensionPath: "/extension" } as vscode.ExtensionContext,
    process: process as unknown as ChildProcessWithoutNullStreams,
    processStart: undefined,
    processStop: undefined,
    shutdownPromise: undefined,
    stoppingProcesses: new Set<ChildProcessWithoutNullStreams>(),
    runtimeExitError: undefined,
    stderrBuffer: "",
    runtimeEpoch: 0,
    selectionEpoch: 0,
    generation: 0,
    disposed: false,
    environmentPromise: undefined,
    dependencyCache: new Map<string, string[]>(),
    lastMissingDependencies: undefined,
    pending: new Map<string, unknown>(),
    cancellationTargets: new Map<string, string>(),
    spawnProcess: vi.fn(),
    configurationSubscription,
    output
  });
  return {
    bridge,
    internals: bridge as unknown as LifecycleBridgeInternals,
    process,
    configurationSubscription,
    output
  };
}

interface EnvironmentBridgeInternals {
  dependencyCache: Map<string, string[]>;
  lastMissingDependencies: TestMissingDependencies | undefined;
  selectionEpoch: number;
  clearRuntimeSelection(): void;
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
  startProcess(request: OpenWranglerRequest, epoch: number): Promise<ChildProcessWithoutNullStreams>;
}

interface DependencyBridgeInternals {
  dependencyCache: Map<string, string[]>;
  environmentPromise: Promise<TestPythonEnvironment> | undefined;
  lastMissingDependencies: TestMissingDependencies | undefined;
  runtimeEpoch: number;
  selectionEpoch: number;
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
}

interface TestPythonEnvironment {
  executable: string;
  version: string;
  source: "configuration" | "pythonExtension" | "system";
}

interface TestMissingDependencies {
  environment: TestPythonEnvironment;
  requirements: readonly string[];
  selectionEpoch: number;
}

interface TestWorkspace {
  __fireDidChangeConfiguration(section: string): void;
}

interface TestProgressWindow {
  withProgress<T>(options: unknown, task: () => Promise<T>): Promise<T>;
}

function createEnvironmentHarness(options: { disposed?: boolean } = {}): {
  context: vscode.ExtensionContext;
  internals: EnvironmentBridgeInternals;
} {
  const context = { extensionPath: "/extension" } as vscode.ExtensionContext;
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  Object.assign(bridge as object, {
    context,
    process: undefined,
    processStart: undefined,
    runtimeExitError: undefined,
    stderrBuffer: "",
    runtimeEpoch: 0,
    selectionEpoch: 0,
    disposed: options.disposed ?? false,
    environmentPromise: undefined,
    dependencyCache: new Map<string, string[]>(),
    lastMissingDependencies: undefined,
    pending: new Map<string, unknown>(),
    cancellationTargets: new Map<string, string>(),
    output: { appendLine: vi.fn() }
  });
  return { context, internals: bridge as unknown as EnvironmentBridgeInternals };
}

function createDependencyHarness(execute: () => Promise<unknown> = async () => undefined): {
  bridge: PythonBridge;
  internals: DependencyBridgeInternals;
  executeFile: ReturnType<typeof vi.fn>;
} {
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const executeFile = vi.fn(execute);
  Object.assign(bridge as object, {
    process: undefined,
    processStart: undefined,
    runtimeExitError: undefined,
    stderrBuffer: "",
    pending: new Map<string, unknown>(),
    cancellationTargets: new Map<string, string>(),
    runtimeEpoch: 0,
    selectionEpoch: 0,
    disposed: false,
    environmentPromise: Promise.resolve(missingDependencies().environment),
    dependencyCache: new Map<string, string[]>([["cached-diagnostic", ["pandas"]]]),
    lastMissingDependencies: missingDependencies(),
    dependencyInstallPromise: undefined,
    executeFile,
    configurationSubscription: { dispose: vi.fn() },
    output: { appendLine: vi.fn(), dispose: vi.fn() }
  });
  return { bridge, internals: bridge as unknown as DependencyBridgeInternals, executeFile };
}

function missingDependencies(): TestMissingDependencies {
  return {
    environment: { executable: "/env/bin/python", version: "3.12.4", source: "configuration" },
    requirements: ["pandas", "xlrd>=2.0.1"],
    selectionEpoch: 0
  };
}

function setWorkspaceTrust(value: boolean): void {
  Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value, writable: true });
}

function remoteFileSource(): SessionSource {
  return {
    kind: "file",
    label: "data.csv",
    path: "/workspace/data.csv",
    uri: "vscode-remote://ssh-remote+example/workspace/data.csv"
  };
}

function openSessionRequest(source: SessionSource): OpenWranglerRequest {
  return {
    kind: "openSession",
    source,
    backend: "polars",
    mode: "editing",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 16
  };
}

function createHarness(
  prepareRequest: (request: OpenWranglerRequest) => Promise<OpenWranglerRequest | ErrorResponse> = async (request) =>
    request
): {
  bridge: PythonBridge;
  ensureProcess: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  writes(): RuntimeRequestEnvelope[];
  waitForWrites(count: number): Promise<void>;
  respond(requestId: string, response: OpenWranglerResponse): void;
  respondRaw(value: unknown): void;
  pendingCount(): number;
  cancellationCount(): number;
  advanceSelectionEpoch(): void;
} {
  const rawWrites: string[] = [];
  const stdin = {
    destroyed: false,
    writable: true,
    write: vi.fn((value: string, callback?: (error?: Error | null) => void) => {
      rawWrites.push(value);
      callback?.();
      return true;
    })
  };
  const process = {
    killed: false,
    stdin,
    kill: vi.fn()
  } as unknown as ChildProcessWithoutNullStreams;
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const ensureProcess = vi.fn(async () => process);
  const restart = vi.fn();
  const internals = bridge as unknown as BridgeInternals;
  Object.assign(internals, {
    process,
    selectionEpoch: 0,
    disposed: false,
    stderrBuffer: "",
    pending: new Map<string, unknown>(),
    cancellationTargets: new Map<string, string>(),
    output: { appendLine: vi.fn() },
    prepareRequest: vi.fn(prepareRequest),
    ensureProcess,
    restart
  });

  const writes = (): RuntimeRequestEnvelope[] => rawWrites.map((line) => JSON.parse(line) as RuntimeRequestEnvelope);
  return {
    bridge,
    ensureProcess,
    restart,
    writes,
    waitForWrites: async (count) => {
      await vi.waitFor(() => expect(rawWrites).toHaveLength(count));
    },
    respond: (requestId, response) => {
      const envelope: RuntimeResponseEnvelope = { protocolVersion: 2, requestId, response };
      internals.handleRuntimeLine(JSON.stringify(envelope));
    },
    respondRaw: (value) => internals.handleRuntimeLine(JSON.stringify(value)),
    pendingCount: () => internals.pending.size,
    cancellationCount: () => internals.cancellationTargets.size,
    advanceSelectionEpoch: () => {
      const state = internals as unknown as { selectionEpoch: number };
      state.selectionEpoch += 1;
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
