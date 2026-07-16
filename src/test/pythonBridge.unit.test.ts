import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
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

interface EnvironmentBridgeInternals {
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
  startProcess(request: OpenWranglerRequest, epoch: number): Promise<ChildProcessWithoutNullStreams>;
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
    disposed: options.disposed ?? false,
    environmentPromise: undefined,
    dependencyCache: new Map<string, string[]>(),
    output: { appendLine: vi.fn() }
  });
  return { context, internals: bridge as unknown as EnvironmentBridgeInternals };
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
    cancellationCount: () => internals.cancellationTargets.size
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
