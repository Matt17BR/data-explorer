import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import type { DataExplorerRequest, DataExplorerResponse } from "../shared/protocol";
import { resolvePythonExecutable } from "./pythonPath";

interface PendingRequest {
  resolve: (response: DataExplorerResponse) => void;
  reject: (error: Error) => void;
}

interface RuntimeEnvelope {
  id: string;
  request: DataExplorerRequest;
}

interface RuntimeResponseEnvelope {
  id: string;
  response?: DataExplorerResponse;
  error?: string;
  detail?: string;
}

export class PythonBridge implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private runtimeExitError: Error | undefined;
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  async request(request: DataExplorerRequest): Promise<DataExplorerResponse> {
    const proc = this.ensureProcess();
    const id = randomUUID();
    const envelope: RuntimeEnvelope = { id, request };

    return new Promise<DataExplorerResponse>((resolve, reject) => {
      if (this.runtimeExitError) {
        reject(this.runtimeExitError);
        return;
      }
      if (proc.stdin.destroyed || !proc.stdin.writable) {
        reject(this.runtimeUnavailableError());
        return;
      }

      this.pending.set(id, { resolve, reject });
      try {
        proc.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
          if (error) {
            this.pending.delete(id);
            reject(this.runtimeUnavailableError(error));
          }
        });
      } catch (error) {
        this.pending.delete(id);
        reject(this.runtimeUnavailableError(error));
      }
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const request of this.pending.values()) {
      request.reject(new Error("Data Explorer runtime stopped."));
    }
    this.pending.clear();
    this.process?.kill();
    this.process = undefined;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    this.runtimeExitError = undefined;
    this.stderrBuffer = "";

    const config = vscode.workspace.getConfiguration("dataExplorer");
    const configuredPythonPath = config.get<string>("pythonPath", ".venv/bin/python");
    const pythonPath = resolvePythonExecutable(
      configuredPythonPath,
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      this.context.extensionPath,
      existsSync
    );
    const workspacePythonPath = path.join(this.context.extensionPath, "python");

    const proc = spawn(pythonPath, ["-m", "data_wrangler_runtime.server"], {
      cwd: this.context.extensionPath,
      env: {
        ...process.env,
        PYTHONPATH: [workspacePythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      }
    });

    const reader = readline.createInterface({ input: proc.stdout });
    reader.on("line", (line) => this.handleRuntimeLine(line));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-4000);
      console.error(`[Data Explorer runtime] ${text}`);
    });
    proc.on("error", (error) => {
      this.runtimeExitError = this.runtimeUnavailableError(error, pythonPath);
      for (const request of this.pending.values()) {
        request.reject(this.runtimeExitError);
      }
      this.pending.clear();
      this.process = undefined;
    });
    proc.on("exit", (code, signal) => {
      this.runtimeExitError = this.runtimeUnavailableError(
        new Error(`Runtime exited with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`),
        pythonPath
      );
      for (const request of this.pending.values()) {
        request.reject(this.runtimeExitError);
      }
      this.pending.clear();
      this.process = undefined;
    });

    this.disposables.push({ dispose: () => reader.close() });
    this.process = proc;
    return proc;
  }

  private handleRuntimeLine(line: string): void {
    let envelope: RuntimeResponseEnvelope;
    try {
      envelope = JSON.parse(line) as RuntimeResponseEnvelope;
    } catch (error) {
      console.error(`[Data Explorer runtime] Invalid JSON response: ${line}`, error);
      return;
    }

    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }

    this.pending.delete(envelope.id);
    if (envelope.response) {
      pending.resolve(envelope.response);
      return;
    }

    pending.reject(new Error(envelope.error ?? "Unknown Data Explorer runtime error."));
  }

  private runtimeUnavailableError(error?: unknown, pythonPath?: string): Error {
    const reason = error instanceof Error ? error.message : error ? String(error) : "runtime stream is not writable";
    const stderr = this.stderrBuffer.trim();
    const pathHint = pythonPath ? ` Python executable: ${pythonPath}.` : "";
    const stderrHint = stderr ? ` Runtime stderr: ${stderr}` : "";
    return new Error(
      `Data Explorer could not talk to its Python runtime (${reason}).${pathHint}${stderrHint} ` +
        "Check the dataExplorer.pythonPath setting and make sure the runtime dependencies are installed with `.venv/bin/python -m pip install -e \"python[dev]\"`."
    );
  }
}
