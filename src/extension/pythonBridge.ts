import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type {
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  ErrorResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  SessionSource
} from "../shared/protocol";
import { PROTOCOL_VERSION } from "../shared/protocol";
import { isRuntimeResponseEnvelope } from "../shared/protocolValidation";
import type { BridgeRequestOptions, OpenWranglerBridge } from "./dataBridge";
import { getSetting } from "./configuration";
import {
  automaticBackends,
  probeDependencies,
  requiredDependencies,
  resolvePythonEnvironment,
  type PythonEnvironment
} from "./pythonEnvironment";
import { stopChildProcessGracefully } from "./processShutdown";

interface PendingRequest {
  resolve: (response: OpenWranglerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancellation?: { dispose(): void };
  cancellationRequestId?: string;
  cancellationRequested: boolean;
  dispatched: boolean;
}

const execFileAsync = promisify(execFile);

export class PythonBridge implements OpenWranglerBridge, vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  private runtimeExitError: Error | undefined;
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancellationTargets = new Map<string, string>();
  private readonly output = vscode.window.createOutputChannel("Open Wrangler");
  private generation = 0;
  private runtimeEpoch = 0;
  private disposed = false;
  private environmentPromise: Promise<PythonEnvironment> | undefined;
  private readonly dependencyCache = new Map<string, string[]>();
  private lastMissingDependencies: { environment: PythonEnvironment; requirements: string[] } | undefined;

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
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }
    const runtimeRequest = prepared;
    const proc = await this.ensureProcess(runtimeRequest);
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }
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
        this.sendCancellation(requestId, false);
        pending.reject(
          new Error(`Open Wrangler runtime request ${runtimeRequest.kind} timed out after ${timeoutMs} ms.`)
        );
        if (options.restartRuntimeOnTimeout !== false) {
          this.restart("Runtime request timed out; restarting so sessions can be replayed.");
        }
      }, timeoutMs);
      const pending: PendingRequest = {
        resolve,
        reject,
        timer,
        cancellationRequested: false,
        dispatched: false
      };
      this.pending.set(requestId, pending);
      const cancellation = options.cancellation?.onCancellationRequested(() => this.cancelRequest(requestId));
      pending.cancellation = cancellation;
      if (!this.pending.has(requestId)) cancellation?.dispose();
      if (options.cancellation?.isCancellationRequested) this.cancelRequest(requestId);
      if (!this.pending.has(requestId)) return;

      try {
        pending.dispatched = true;
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

  reportDiagnostic(message: string): void {
    this.output.appendLine(message);
  }

  onIdle(): void {
    if (this.runtimeRunning) {
      this.stopGracefully("Open Wrangler runtime stopped after its last session closed.");
    }
  }

  clearRuntimeSelection(): void {
    this.environmentPromise = undefined;
    this.dependencyCache.clear();
    this.stopGracefully("Python runtime selection changed.");
  }

  async installMissingDependencies(confirmed?: boolean): Promise<boolean> {
    const missing = this.lastMissingDependencies;
    if (!missing || missing.requirements.length === 0) {
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
        `Install ${missing.requirements.join(", ")} into ${missing.environment.executable}?`,
        { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
        "Install"
      );
      if (choice !== "Install") return false;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Open Wrangler dependencies" },
      async () => {
        await execFileAsync(missing.environment.executable, ["-m", "pip", "install", ...missing.requirements], {
          timeout: 10 * 60_000
        });
      }
    );
    this.lastMissingDependencies = undefined;
    this.dependencyCache.clear();
    this.stopGracefully("Python dependencies changed; restarting the Open Wrangler runtime.");
    await vscode.window.showInformationMessage("Open Wrangler runtime dependencies were installed.");
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopGracefully("Open Wrangler runtime stopped.");
    this.output.dispose();
  }

  private stopGracefully(reason: string): void {
    this.output.appendLine(reason);
    this.runtimeEpoch += 1;
    const proc = this.process;
    this.process = undefined;
    this.processStart = undefined;
    this.rejectAll(new Error(reason));
    if (!proc) return;
    stopChildProcessGracefully(proc);
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

    const resource = request.kind === "openSession" ? sourceResource(request.source) : undefined;
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

    const cancellationTarget = this.cancellationTargets.get(envelope.requestId);
    if (cancellationTarget) {
      this.cancellationTargets.delete(envelope.requestId);
      const target = this.pending.get(cancellationTarget);
      if (target?.cancellationRequestId === envelope.requestId) target.cancellationRequestId = undefined;
      if (envelope.response.kind === "cancelled" && envelope.response.targetRequestId === cancellationTarget) {
        this.output.appendLine(
          `Open Wrangler runtime accepted cancellation for queued request ${cancellationTarget}; waiting for that request's correlated response.`
        );
      } else if (envelope.response.kind !== "error" || envelope.response.code !== "cancellation_unavailable") {
        this.output.appendLine(
          `Open Wrangler runtime returned ${envelope.response.kind} while cancelling request ${cancellationTarget}; waiting for the authoritative result.`
        );
      }
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
    if (pending.cancellationRequestId) this.cancellationTargets.delete(pending.cancellationRequestId);
    return pending;
  }

  private rejectAll(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      this.takePending(requestId)?.reject(error);
    }
    this.cancellationTargets.clear();
  }

  private cancelRequest(targetRequestId: string): void {
    const pending = this.pending.get(targetRequestId);
    if (!pending || pending.cancellationRequested) return;
    pending.cancellationRequested = true;
    if (!pending.dispatched) {
      this.takePending(targetRequestId)?.resolve({ kind: "cancelled", targetRequestId: "not-started" });
      return;
    }
    this.sendCancellation(targetRequestId, true);
  }

  private sendCancellation(targetRequestId: string, trackResponse: boolean): void {
    const proc = this.process;
    if (!proc?.stdin.writable) return;
    const requestId = randomUUID();
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority: "interactive",
      request: { kind: "cancelRequest", targetRequestId }
    };
    if (trackResponse) {
      const pending = this.pending.get(targetRequestId);
      if (!pending) return;
      pending.cancellationRequestId = requestId;
      this.cancellationTargets.set(requestId, targetRequestId);
    }
    try {
      proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error || !trackResponse) return;
        this.clearCancellationRequest(requestId, targetRequestId);
        this.output.appendLine(
          `Open Wrangler could not request cancellation for ${targetRequestId}: ${error.message}. Waiting for the authoritative result.`
        );
      });
    } catch (error) {
      if (!trackResponse) return;
      this.clearCancellationRequest(requestId, targetRequestId);
      this.output.appendLine(
        `Open Wrangler could not request cancellation for ${targetRequestId}: ${error instanceof Error ? error.message : String(error)}. Waiting for the authoritative result.`
      );
    }
  }

  private clearCancellationRequest(requestId: string, targetRequestId: string): void {
    this.cancellationTargets.delete(requestId);
    const pending = this.pending.get(targetRequestId);
    if (pending?.cancellationRequestId === requestId) pending.cancellationRequestId = undefined;
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
    const environment = await this.environment(sourceResource(request.source));
    const backends = request.backend ? [request.backend] : automaticBackends(request.source);
    const failures: Array<{ backend: DataBackend; missing: string[] }> = [];
    for (const backend of backends) {
      const dependencies = requiredDependencies(backend, request.source);
      const key = `${environment.executable}:${dependencies.map((dependency) => dependency.installSpec).join(",")}`;
      let missing = this.dependencyCache.get(key);
      if (!missing) {
        missing = (await probeDependencies(environment.executable, dependencies)).missing;
        this.dependencyCache.set(key, missing);
      }
      if (missing.length === 0) return { ...request, backend };
      failures.push({ backend, missing });
    }
    const missing = [...new Set(failures.flatMap((failure) => failure.missing))];
    this.lastMissingDependencies = { environment, requirements: failures[0]?.missing ?? missing };
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

function sourceResource(source: SessionSource): vscode.Uri | undefined {
  if (source.uri) {
    try {
      return vscode.Uri.parse(source.uri, true);
    } catch {
      // Malformed URI metadata can still fall back to its concrete file path.
    }
  }
  return source.path ? vscode.Uri.file(source.path) : undefined;
}
