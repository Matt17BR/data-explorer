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

interface MissingDependencies {
  readonly environment: PythonEnvironment;
  readonly requirements: readonly string[];
  readonly selectionEpoch: number;
}

const PROCESS_SHUTDOWN_AGGREGATE_MESSAGE = "Open Wrangler encountered multiple Python runtime shutdown failures.";
const execFileAsync = promisify(execFile);

async function joinProcessStops(previous: Promise<void>, current: Promise<void>): Promise<void> {
  const results = await Promise.allSettled([previous, current]);
  const failures = results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    if (result.reason instanceof AggregateError && result.reason.message === PROCESS_SHUTDOWN_AGGREGATE_MESSAGE) {
      return [...result.reason.errors];
    }
    return [result.reason];
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, PROCESS_SHUTDOWN_AGGREGATE_MESSAGE);
}

export class PythonBridge implements OpenWranglerBridge, vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  private processStop: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private readonly stoppingProcesses = new Set<ChildProcessWithoutNullStreams>();
  private runtimeExitError: Error | undefined;
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancellationTargets = new Map<string, string>();
  private readonly output = vscode.window.createOutputChannel("Open Wrangler");
  private readonly executeFile = execFileAsync;
  private readonly spawnProcess = spawn;
  private readonly configurationSubscription: vscode.Disposable;
  private generation = 0;
  private runtimeEpoch = 0;
  private selectionEpoch = 0;
  private disposed = false;
  private environmentPromise: Promise<PythonEnvironment> | undefined;
  private readonly dependencyCache = new Map<string, string[]>();
  private lastMissingDependencies: MissingDependencies | undefined;
  private dependencyInstallPromise: Promise<boolean> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!this.disposed && event.affectsConfiguration("openWrangler.pythonPath")) {
        this.clearRuntimeSelection();
      }
    });
  }

  get runtimeGeneration(): number {
    return this.generation;
  }

  get runtimeRunning(): boolean {
    return Boolean(this.process || this.processStart || this.processStop);
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (this.disposed) {
      throw new Error("Open Wrangler runtime bridge has been disposed.");
    }
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }

    const selectionEpoch =
      request.kind === "openSession" && request.source.kind === "file" ? this.selectionEpoch : undefined;
    const prepared = await this.prepareRequest(request);
    if (selectionEpoch !== undefined && selectionEpoch !== this.selectionEpoch) {
      return this.runtimeSelectionChangedError();
    }
    if (prepared.kind === "error") return prepared;
    if (options.cancellation?.isCancellationRequested) {
      return { kind: "cancelled", targetRequestId: "not-started" };
    }
    const runtimeRequest = prepared;
    const proc = await this.ensureProcess(runtimeRequest);
    if (selectionEpoch !== undefined && selectionEpoch !== this.selectionEpoch) {
      return this.runtimeSelectionChangedError();
    }
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
    if (proc) this.trackProcessStop(proc, 0);
  }

  reportDiagnostic(message: string): void {
    this.output.appendLine(message);
  }

  onIdle(): void {
    if (this.process || this.processStart) {
      this.stopGracefully("Open Wrangler runtime stopped after its last session closed.");
    }
  }

  clearRuntimeSelection(): void {
    this.invalidateRuntimeSelection("Python runtime selection changed.");
  }

  private invalidateRuntimeSelection(reason: string, force = false): void {
    if (
      !force &&
      !this.environmentPromise &&
      this.dependencyCache.size === 0 &&
      !this.lastMissingDependencies &&
      !this.process &&
      !this.processStart
    ) {
      return;
    }
    this.selectionEpoch += 1;
    this.environmentPromise = undefined;
    this.dependencyCache.clear();
    this.lastMissingDependencies = undefined;
    if (!this.disposed) this.stopGracefully(reason);
  }

  async installMissingDependencies(): Promise<boolean> {
    return this.beginDependencyInstallation();
  }

  async declineMissingDependencyInstallForTesting(): Promise<boolean> {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") {
      throw new Error("Dependency-install decline is available only to the Open Wrangler test harness.");
    }
    const missing = this.lastMissingDependencies;
    if (!missing || missing.requirements.length === 0) {
      await vscode.window.showInformationMessage("Open Wrangler has no unresolved runtime dependencies.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
    }
    return false;
  }

  private beginDependencyInstallation(): Promise<boolean> {
    if (this.dependencyInstallPromise) return this.dependencyInstallPromise;
    const installation = this.installMissingDependenciesWithDecision();
    this.dependencyInstallPromise = installation;
    const clear = (): void => {
      if (this.dependencyInstallPromise === installation) this.dependencyInstallPromise = undefined;
    };
    void installation.then(clear, clear);
    return installation;
  }

  private async installMissingDependenciesWithDecision(): Promise<boolean> {
    const missing = this.lastMissingDependencies;
    if (!missing || missing.requirements.length === 0) {
      await vscode.window.showInformationMessage("Open Wrangler has no unresolved runtime dependencies.");
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
      return false;
    }
    const selectionEpoch = this.selectionEpoch;
    const executable = missing.environment.executable;
    const requirements = [...missing.requirements];
    if (!this.isCurrentDependencyInstallTarget(missing, selectionEpoch, executable, requirements)) {
      await this.reportInvalidDependencyInstallTarget();
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      `Install ${requirements.join(", ")} into ${executable}?`,
      { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
      "Install"
    );
    if (choice !== "Install") return false;
    if (!this.isCurrentDependencyInstallTarget(missing, selectionEpoch, executable, requirements)) {
      await this.reportInvalidDependencyInstallTarget();
      return false;
    }

    let installationStarted = false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Open Wrangler dependencies" },
      async () => {
        if (!this.isCurrentDependencyInstallTarget(missing, selectionEpoch, executable, requirements)) return;
        installationStarted = true;
        await this.executeFile(executable, ["-m", "pip", "install", ...requirements], {
          timeout: 10 * 60_000
        });
      }
    );
    if (!installationStarted) {
      await this.reportInvalidDependencyInstallTarget();
      return false;
    }
    if (this.selectionEpoch === selectionEpoch) {
      this.invalidateRuntimeSelection("Python dependencies changed; restarting the Open Wrangler runtime.", true);
      if (!this.disposed) {
        await vscode.window.showInformationMessage("Open Wrangler runtime dependencies were installed.");
      }
    } else if (!this.disposed) {
      await vscode.window.showInformationMessage(
        `Installed ${requirements.join(", ")} into ${executable}, but the active runtime selection, dependency target, or workspace trust changed and the current runtime was not restarted.`
      );
    }
    return true;
  }

  private isCurrentDependencyInstallTarget(
    missing: MissingDependencies,
    selectionEpoch: number,
    executable: string,
    requirements: readonly string[]
  ): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      this.selectionEpoch === selectionEpoch &&
      missing.selectionEpoch === selectionEpoch &&
      this.lastMissingDependencies === missing &&
      missing.environment.executable === executable &&
      missing.requirements.length === requirements.length &&
      missing.requirements.every((requirement, index) => requirement === requirements[index])
    );
  }

  private async reportInvalidDependencyInstallTarget(): Promise<void> {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage("Trust this workspace before installing Python dependencies.");
      return;
    }
    await vscode.window.showInformationMessage(
      "The selected Python runtime or its missing dependencies changed before installation. Run Install Runtime Dependencies again."
    );
  }

  dispose(): void {
    void this.shutdown().catch(() => undefined);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownBridge();
    return this.shutdownPromise;
  }

  private async shutdownBridge(): Promise<void> {
    this.disposed = true;
    const failures: unknown[] = [];
    try {
      this.configurationSubscription.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.stopGracefully("Open Wrangler runtime stopped.");
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.processStop;
    } catch (error) {
      failures.push(error);
    }
    try {
      this.output.dispose();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Open Wrangler Python bridge shutdown encountered multiple failures.");
    }
  }

  private stopGracefully(reason: string): void {
    try {
      this.output.appendLine(reason);
    } catch {
      // Lifecycle cleanup must continue even if the diagnostic channel is unavailable.
    }
    this.runtimeEpoch += 1;
    const proc = this.process;
    this.process = undefined;
    this.processStart = undefined;
    if (proc) this.trackProcessStop(proc);
    this.rejectAll(new Error(reason));
  }

  private async ensureProcess(request: OpenWranglerRequest): Promise<ChildProcessWithoutNullStreams> {
    if (this.process) {
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
    const stopping = this.processStop;
    if (stopping) {
      try {
        await stopping;
      } catch (error) {
        throw new Error(
          `Open Wrangler could not confirm shutdown of its previous Python runtime: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (stopping && (this.disposed || epoch !== this.runtimeEpoch)) {
      throw new Error("Open Wrangler runtime start was cancelled.");
    }
    if (this.process) return this.process;

    this.runtimeExitError = undefined;
    this.stderrBuffer = "";

    const resource = request.kind === "openSession" ? sourceResource(request.source) : undefined;
    const environment = await this.environment(resource);
    if (this.disposed || epoch !== this.runtimeEpoch) {
      throw new Error("Open Wrangler runtime start was cancelled.");
    }
    if (this.process) return this.process;
    const pythonPath = environment.executable;
    const runtimeRoot = path.join(this.context.extensionPath, "python");

    const proc = this.spawnProcess(pythonPath, ["-m", "openwrangler_runtime.server"], {
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

  private trackProcessStop(proc: ChildProcessWithoutNullStreams, gracefulTimeoutMs?: number): void {
    const current = stopChildProcessGracefully(proc, gracefulTimeoutMs);
    const previous = this.processStop;
    const stopping = previous ? joinProcessStops(previous, current) : current;
    this.stoppingProcesses.add(proc);
    this.processStop = stopping;
    const confirmLateExit = (): void => {
      this.stoppingProcesses.delete(proc);
      if (this.stoppingProcesses.size === 0) this.processStop = undefined;
    };
    proc.once("exit", confirmLateExit);
    void current.then(
      () => {
        proc.off("exit", confirmLateExit);
        this.stoppingProcesses.delete(proc);
        if (this.stoppingProcesses.size === 0) this.processStop = undefined;
      },
      (error: unknown) => {
        try {
          this.output.appendLine(
            `Open Wrangler could not confirm Python runtime shutdown: ${error instanceof Error ? error.message : String(error)}`
          );
        } catch {
          // Disposal may close the output channel before a bounded shutdown settles.
        }
      }
    );
    void stopping.catch(() => undefined);
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
    const selectionEpoch = this.selectionEpoch;
    const environment = await this.environment(sourceResource(request.source));
    if (selectionEpoch !== this.selectionEpoch) return this.runtimeSelectionChangedError();
    const backends = request.backend ? [request.backend] : automaticBackends(request.source);
    const failures: Array<{ backend: DataBackend; missing: string[] }> = [];
    for (const backend of backends) {
      if (selectionEpoch !== this.selectionEpoch) return this.runtimeSelectionChangedError();
      const dependencies = requiredDependencies(backend, request.source);
      const key = `${environment.executable}:${dependencies.map((dependency) => dependency.installSpec).join(",")}`;
      let missing = this.dependencyCache.get(key);
      if (!missing) {
        const result = await probeDependencies(environment.executable, dependencies);
        if (selectionEpoch !== this.selectionEpoch) return this.runtimeSelectionChangedError();
        missing = result.missing;
        this.dependencyCache.set(key, missing);
      }
      if (selectionEpoch !== this.selectionEpoch) return this.runtimeSelectionChangedError();
      if (missing.length === 0) {
        this.lastMissingDependencies = undefined;
        return { ...request, backend };
      }
      failures.push({ backend, missing });
    }
    const missing = [...new Set(failures.flatMap((failure) => failure.missing))];
    if (selectionEpoch !== this.selectionEpoch) return this.runtimeSelectionChangedError();
    this.lastMissingDependencies = {
      environment,
      requirements: [...(failures[0]?.missing ?? missing)],
      selectionEpoch
    };
    return {
      kind: "error",
      code: "missing_dependencies",
      message: `The selected Python ${environment.version} environment cannot open this source. Missing: ${missing.join(", ")}.`,
      detail: "Use Open Wrangler: Install Runtime Dependencies to review and confirm installation.",
      recoverable: true
    };
  }

  private runtimeSelectionChangedError(): ErrorResponse {
    return {
      kind: "error",
      code: "runtime_selection_changed",
      message: "The selected Python runtime changed while its dependencies were being checked.",
      detail: "Retry the request with the current Open Wrangler runtime selection.",
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
