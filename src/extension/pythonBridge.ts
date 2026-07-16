import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  ErrorResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope
} from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import { getSetting } from "./configuration";
import {
  probeDependencies,
  requiredModules,
  resolvePythonEnvironment,
  type PythonEnvironment
} from "./pythonEnvironment";

interface PendingRequest {
  resolve: (response: OpenWranglerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancellation?: { dispose(): void };
}

const execFileAsync = promisify(execFile);

export class PythonBridge implements OpenWranglerBridge, vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  private runtimeExitError: Error | undefined;
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly output = vscode.window.createOutputChannel("Open Wrangler");
  private generation = 0;
  private runtimeEpoch = 0;
  private disposed = false;
  private environmentPromise: Promise<PythonEnvironment> | undefined;
  private readonly dependencyCache = new Map<string, string[]>();
  private lastMissingDependencies: { environment: PythonEnvironment; modules: string[] } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get runtimeGeneration(): number {
    return this.generation;
  }

  get runtimeRunning(): boolean {
    return Boolean((this.process && !this.process.killed) || this.processStart);
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      throw new Error("Open Wrangler runtime bridge has been disposed.");
    }
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }

    const prepared = await this.prepareRequest(request);
    if (prepared.kind === "error") return prepared;
    const runtimeRequest = prepared;
    const proc = await this.ensureProcess(runtimeRequest);
    const requestId = randomUUID();
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority:
        options.priority ??
        (runtimeRequest.kind === "getSummary" || runtimeRequest.kind === "getDatasetStats"
          ? "background"
          : "interactive"),
      request: runtimeRequest
    };
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();

    return new Promise<OpenWranglerResponse>((resolve, reject) => {
      if (this.runtimeExitError) {
        reject(this.runtimeExitError);
        return;
      }
      if (proc.stdin.destroyed || !proc.stdin.writable) {
        reject(this.runtimeUnavailableError());
        return;
      }

      const timer = setTimeout(() => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        this.sendCancellation(requestId);
        pending.reject(
          new Error(`Open Wrangler runtime request ${runtimeRequest.kind} timed out after ${timeoutMs} ms.`)
        );
        this.restart("Runtime request timed out; restarting so sessions can be replayed.");
      }, timeoutMs);
      const cancellation = options.cancellation?.onCancellationRequested(() => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        this.sendCancellation(requestId);
        pending.resolve({ kind: "cancelled", targetRequestId: requestId });
      });
      this.pending.set(requestId, { resolve, reject, timer, cancellation });

      try {
        proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
          if (!error) return;
          const pending = this.takePending(requestId);
          pending?.reject(this.runtimeUnavailableError(error));
        });
      } catch (error) {
        const pending = this.takePending(requestId);
        pending?.reject(this.runtimeUnavailableError(error));
      }
    });
  }

  restart(reason = "Open Wrangler runtime restarted."): void {
    this.output.appendLine(reason);
    this.runtimeEpoch += 1;
    const proc = this.process;
    this.process = undefined;
    this.processStart = undefined;
    this.rejectAll(new Error(reason));
    proc?.kill();
  }

  onIdle(): void {
    if (this.runtimeRunning) {
      this.restart("Open Wrangler runtime stopped after its last session closed.");
    }
  }

  clearRuntimeSelection(): void {
    this.environmentPromise = undefined;
    this.dependencyCache.clear();
    this.restart("Python runtime selection changed.");
  }

  async installMissingDependencies(confirmed?: boolean): Promise<boolean> {
    const missing = this.lastMissingDependencies;
    if (!missing || missing.modules.length === 0) {
      await vscode.window.showInformationMessage("Open Wrangler has no unresolved runtime dependencies.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
      return false;
    }
    if (confirmed !== true) {
      if (confirmed === false) return false;
      const choice = await vscode.window.showWarningMessage(
        `Install ${missing.modules.join(", ")} into ${missing.environment.executable}?`,
        { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
        "Install"
      );
      if (choice !== "Install") return false;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Open Wrangler dependencies" },
      async () => {
        await execFileAsync(missing.environment.executable, ["-m", "pip", "install", ...missing.modules], {
          timeout: 10 * 60_000
        });
      }
    );
    this.lastMissingDependencies = undefined;
    this.dependencyCache.clear();
    this.restart("Python dependencies changed; restarting the Open Wrangler runtime.");
    await vscode.window.showInformationMessage("Open Wrangler runtime dependencies were installed.");
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.restart("Open Wrangler runtime stopped.");
    this.output.dispose();
  }

  private async ensureProcess(request: OpenWranglerRequest): Promise<ChildProcessWithoutNullStreams> {
    if (this.process && !this.process.killed) {
      return this.process;
    }
    if (this.processStart) return this.processStart;

    const epoch = this.runtimeEpoch;
    const start = this.startProcess(request, epoch);
    this.processStart = start;
    try {
      return await start;
    } finally {
      if (this.processStart === start) this.processStart = undefined;
    }
  }

  private async startProcess(request: OpenWranglerRequest, epoch: number): Promise<ChildProcessWithoutNullStreams> {
    if (this.process && !this.process.killed) return this.process;

    this.runtimeExitError = undefined;
    this.stderrBuffer = "";

    const resource =
      request.kind === "openSession" && request.source.path ? vscode.Uri.file(request.source.path) : undefined;
    const environment = await this.environment(resource);
    if (this.disposed || epoch !== this.runtimeEpoch) {
      throw new Error("Open Wrangler runtime start was cancelled.");
    }
    if (this.process && !this.process.killed) return this.process;
    const pythonPath = environment.executable;
    const runtimeRoot = path.join(this.context.extensionPath, "python");

    const proc = spawn(pythonPath, ["-m", "openwrangler_runtime.server"], {
      cwd: this.context.extensionPath,
      env: {
        ...process.env,
        PYTHONPATH: [runtimeRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      }
    });
    this.generation += 1;
    this.output.appendLine(
      `Starting protocol v2 runtime with ${pythonPath} (Python ${environment.version}, ${environment.source}, generation ${this.generation}).`
    );

    const reader = readline.createInterface({ input: proc.stdout });
    reader.on("line", (line) => this.handleRuntimeLine(line));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-8000);
      this.output.append(text);
    });
    proc.on("error", (error) => this.handleProcessFailure(proc, this.runtimeUnavailableError(error, pythonPath)));
    proc.on("exit", (code, signal) => {
      reader.close();
      this.handleProcessFailure(
        proc,
        this.runtimeUnavailableError(
          new Error(`Runtime exited with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`),
          pythonPath
        )
      );
    });

    this.process = proc;
    return proc;
  }

  private handleProcessFailure(proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== proc) return;
    this.runtimeExitError = error;
    this.process = undefined;
    this.output.appendLine(error.message);
    this.rejectAll(error);
  }

  private handleRuntimeLine(line: string): void {
    let envelope: RuntimeResponseEnvelope;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRuntimeResponseEnvelope(parsed)) {
        throw new Error("Response does not match the protocol v2 envelope.");
      }
      envelope = parsed;
    } catch (error) {
      this.output.appendLine(`Invalid runtime response: ${line}`);
      this.output.appendLine(error instanceof Error ? error.message : String(error));
      return;
    }

    const pending = this.takePending(envelope.requestId);
    pending?.resolve(envelope.response);
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.cancellation?.dispose();
    return pending;
  }

  private rejectAll(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      this.takePending(requestId)?.reject(error);
    }
  }

  private sendCancellation(targetRequestId: string): void {
    const proc = this.process;
    if (!proc?.stdin.writable) return;
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      priority: "interactive",
      request: { kind: "cancelRequest", targetRequestId }
    };
    proc.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private defaultTimeoutMs(): number {
    return getSetting<number>("requestTimeoutMs", 30_000);
  }

  private environment(resource?: vscode.Uri): Promise<PythonEnvironment> {
    this.environmentPromise ??= resolvePythonEnvironment(this.context, resource);
    return this.environmentPromise;
  }

  private async prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse> {
    if (request.kind !== "openSession" || request.source.kind !== "file") return request;
    const environment = await this.environment(vscode.Uri.file(request.source.path ?? request.source.label));
    const encoding = request.source.importOptions?.encoding?.toLowerCase();
    const polarsEncoding = !encoding || ["utf-8", "utf8", "utf8-lossy"].includes(encoding);
    const backends = request.backend
      ? [request.backend]
      : polarsEncoding
        ? (["polars", "pandas"] as const)
        : (["pandas"] as const);
    const failures: Array<{ backend: "polars" | "pandas"; missing: string[] }> = [];
    for (const backend of backends) {
      const modules = requiredModules(backend, request.source);
      const key = `${environment.executable}:${modules.join(",")}`;
      let missing = this.dependencyCache.get(key);
      if (!missing) {
        missing = (await probeDependencies(environment.executable, modules)).missing;
        this.dependencyCache.set(key, missing);
      }
      if (missing.length === 0) return { ...request, backend };
      failures.push({ backend, missing });
    }
    const missing = [...new Set(failures.flatMap((failure) => failure.missing))];
    this.lastMissingDependencies = { environment, modules: failures[0]?.missing ?? missing };
    return {
      kind: "error",
      code: "missing_dependencies",
      message: `The selected Python ${environment.version} environment cannot open this source. Missing: ${missing.join(", ")}.`,
      detail: "Use Open Wrangler: Install Runtime Dependencies to review and confirm installation.",
      recoverable: true
    };
  }

  private runtimeUnavailableError(error?: unknown, pythonPath?: string): Error {
    const reason = error instanceof Error ? error.message : error ? String(error) : "runtime stream is not writable";
    const stderr = this.stderrBuffer.trim();
    const pathHint = pythonPath ? ` Python executable: ${pythonPath}.` : "";
    const stderrHint = stderr ? ` Runtime stderr: ${stderr}` : "";
    return new Error(
      `Open Wrangler could not talk to its Python runtime (${reason}).${pathHint}${stderrHint} ` +
        "Select a compatible Python 3.10-3.14 environment with the Open Wrangler: Change Runtime command."
    );
  }
}

function isRuntimeResponseEnvelope(value: unknown): value is RuntimeResponseEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeResponseEnvelope>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.requestId === "string" &&
    typeof candidate.response === "object" &&
    candidate.response !== null &&
    typeof (candidate.response as { kind?: unknown }).kind === "string"
  );
}
