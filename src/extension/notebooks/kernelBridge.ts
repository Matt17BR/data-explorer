import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Jupyter, Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import type {
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope
} from "../../shared/protocol";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { isRuntimeResponseEnvelope } from "../../shared/protocolValidation";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../dataBridge";
import { KernelRequestCancelledError, RestartableKernel, withKernelTimeout } from "./kernelLifecycle";
import { buildKernelBootstrapCode, readRuntimeFiles } from "./kernelRuntimeBundle";
import { getSetting } from "../configuration";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

export class KernelBridge implements OpenWranglerBridge {
  private readonly lifecycle: RestartableKernel<Kernel>;
  private readonly bootstrapCode: string;
  private readonly sessionKernels = new Map<string, Kernel>();
  private readonly retiredSessionIds = new Set<string>();
  private cleanupAttempts = new WeakMap<Kernel, Set<string>>();
  private readonly notebookUri: vscode.Uri;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookDocument: vscode.NotebookDocument
  ) {
    this.notebookUri = notebookDocument.uri;
    this.lifecycle = new RestartableKernel(() => this.acquireKernel());
    this.bootstrapCode = buildKernelBootstrapCode(readRuntimeFiles(path.join(this.context.extensionPath, "python")));
  }

  onIdle(): void {
    // The user's kernel remains owned by Jupyter; Open Wrangler only releases
    // its cached generation and bootstrap state after its final session closes.
    this.lifecycle.invalidate();
    // Coordinator shutdown can reach its outer deadline while an accepted
    // request is still settling. Keep exact-kernel ownership in that case so
    // the delayed terminal close cannot reacquire by notebook URI.
    if (this.sessionKernels.size > 0) return;
    this.sessionKernels.clear();
    this.retiredSessionIds.clear();
    this.cleanupAttempts = new WeakMap();
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    if (options.cancellation?.isCancellationRequested) throw new KernelRequestCancelledError();
    if (request.kind === "closeSession") {
      const kernel = this.sessionKernels.get(request.sessionId);
      if (kernel) return this.closeMappedSession(request, kernel, options);
      if (this.retiredSessionIds.has(request.sessionId)) {
        return {
          kind: "error",
          code: "unknown_session",
          message: `Open Wrangler already attempted to close kernel session ${request.sessionId}.`,
          recoverable: true
        };
      }
    }
    const isCleanup = request.kind === "closeSession";
    if (!isCleanup) this.assertNotebookProvenance();
    const runtimeRequest = withKernelSessionIdentity(request);
    if (runtimeRequest.kind === "openSession") {
      this.assertSessionIdentityAvailable(runtimeRequest.requestedSessionId);
    }
    const framed = frameKernelRequest(runtimeRequest, requestPriority(runtimeRequest, options));
    const tokenSource = new vscode.CancellationTokenSource();
    const timeoutMs = options.timeoutMs ?? getSetting<number>("requestTimeoutMs", 30_000);
    const abort = (): void => {
      tokenSource.cancel();
      // A timed-out acquisition must not trap future cleanup requests behind the
      // same hung promise. Detaching is generation-safe: a late settle cannot
      // replace or invalidate the next kernel.
      this.lifecycle.invalidate();
    };
    let mismatchedRuntimeId: string | undefined;
    let cleanupMismatchedRuntimeId = false;
    let openKernel: Kernel | undefined;
    try {
      const operation = this.lifecycle.run(
        (kernel) => this.ensureKernelAgent(kernel, tokenSource.token),
        async (kernel) => {
          if (runtimeRequest.kind === "openSession") {
            this.assertSessionIdentityAvailable(runtimeRequest.requestedSessionId);
            openKernel = kernel;
            this.sessionKernels.set(runtimeRequest.requestedSessionId, kernel);
          }
          return this.executeFramedRequest(kernel, framed, tokenSource.token);
        },
        {
          retryAfterDispatch: isIdempotentKernelReadRequest(runtimeRequest),
          shouldRetry: (_error, phase) =>
            !tokenSource.token.isCancellationRequested && phase !== "acquire" && phase !== "beforeDispatch",
          beforeDispatch: () => {
            if (tokenSource.token.isCancellationRequested) throw new KernelRequestCancelledError();
            if (!isCleanup) this.assertNotebookProvenance();
          }
        }
      );
      const response = await withKernelTimeout(operation, timeoutMs, abort, options.cancellation, abort);
      if (
        runtimeRequest.kind === "openSession" &&
        response.kind === "sessionOpened" &&
        response.metadata.sessionId !== runtimeRequest.requestedSessionId
      ) {
        mismatchedRuntimeId = response.metadata.sessionId;
        if (openKernel) {
          const existingKernel = this.sessionKernels.get(mismatchedRuntimeId);
          cleanupMismatchedRuntimeId = existingKernel !== openKernel;
          if (!existingKernel) this.sessionKernels.set(mismatchedRuntimeId, openKernel);
        }
      }
      if (!isCleanup) this.assertNotebookProvenance();
      if (runtimeRequest.kind === "openSession") {
        if (response.kind !== "sessionOpened") {
          // A logical error or cancellation is not proof that the open never
          // committed. The kernel may have registered the candidate before its
          // final response was replaced, so close the host-known identity just
          // as we do for transport and parsing failures.
          if (openKernel) await this.cleanupFailedOpen(runtimeRequest.requestedSessionId, openKernel);
        } else if (mismatchedRuntimeId) {
          throw new Error(
            "Open Wrangler kernel returned a session identity that did not match the requested identity."
          );
        }
      }
      return response;
    } catch (error) {
      if (runtimeRequest.kind === "openSession" && openKernel) {
        await this.cleanupFailedOpen(runtimeRequest.requestedSessionId, openKernel);
        if (mismatchedRuntimeId && cleanupMismatchedRuntimeId) {
          await this.cleanupFailedOpen(mismatchedRuntimeId, openKernel);
        }
      }
      throw error;
    } finally {
      tokenSource.dispose();
    }
  }

  private async cleanupFailedOpen(sessionId: string, kernel: Kernel): Promise<void> {
    const attempts = this.cleanupAttempts.get(kernel) ?? new Set<string>();
    if (attempts.has(sessionId)) return;
    attempts.add(sessionId);
    this.cleanupAttempts.set(kernel, attempts);
    const ownsMapping = this.sessionKernels.get(sessionId) === kernel;
    if (ownsMapping) {
      this.sessionKernels.delete(sessionId);
      this.retiredSessionIds.add(sessionId);
    }
    try {
      await this.executeExactKernelRequest(
        kernel,
        { kind: "closeSession", sessionId, revision: 0 },
        { priority: "interactive", timeoutMs: 2_000 }
      );
    } catch {
      // The cleanup has its own hard deadline. Preserve the original open
      // failure when the kernel is unavailable or the candidate never existed.
    }
  }

  private async closeMappedSession(
    request: Extract<OpenWranglerRequest, { kind: "closeSession" }>,
    kernel: Kernel,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const response = await this.executeExactKernelRequest(kernel, request, options);
    if (response.kind === "sessionClosed" && response.sessionId === request.sessionId) {
      if (this.sessionKernels.get(request.sessionId) === kernel) this.sessionKernels.delete(request.sessionId);
      this.retiredSessionIds.add(request.sessionId);
    }
    return response;
  }

  private async executeExactKernelRequest(
    kernel: Kernel,
    request: OpenWranglerRequest,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const framed = frameKernelRequest(request, requestPriority(request, options));
    const tokenSource = new vscode.CancellationTokenSource();
    const abort = (): void => tokenSource.cancel();
    try {
      return await withKernelTimeout(
        this.executeFramedRequest(kernel, framed, tokenSource.token),
        options.timeoutMs ?? getSetting<number>("requestTimeoutMs", 30_000),
        abort,
        options.cancellation,
        abort
      );
    } finally {
      tokenSource.dispose();
    }
  }

  private async executeFramedRequest(
    kernel: Kernel,
    framed: FramedKernelRequest,
    token: vscode.CancellationToken
  ): Promise<OpenWranglerResponse> {
    return parseKernelResponse(await this.executePython(kernel, framed.code, token), framed.marker, framed.requestId);
  }

  private async ensureKernelAgent(kernel: Kernel, token: vscode.CancellationToken): Promise<void> {
    this.assertNotebookProvenance();
    await this.executePython(
      kernel,
      `${this.bootstrapCode}
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
import openwrangler_runtime.notebook as __ow_notebook
__ow_notebook.register_formatters()
`,
      token
    );
    this.assertNotebookProvenance();
  }

  private async executePython(kernel: Kernel, code: string, token: vscode.CancellationToken): Promise<string> {
    if (token.isCancellationRequested) throw new KernelRequestCancelledError();
    return kernelOutputsToText(kernel.executeCode(code, token));
  }

  private async acquireKernel(): Promise<Kernel> {
    this.assertNotebookProvenance();
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before Open Wrangler accesses a notebook kernel.");
    }

    const jupyter = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    if (!jupyter) {
      throw new Error("Install or enable the VS Code Jupyter extension to open live notebook dataframes.");
    }
    const api = await jupyter.activate();
    this.assertNotebookProvenance();
    const kernel = await api.kernels.getKernel(this.notebookUri);
    this.assertNotebookProvenance();
    if (!kernel) {
      throw new Error("Open Wrangler could not access the selected Jupyter kernel for this notebook.");
    }
    if (kernel.language.toLowerCase() !== "python") {
      throw new Error(`Open Wrangler requires a Python notebook kernel; the selected kernel uses ${kernel.language}.`);
    }
    return kernel;
  }

  private assertNotebookProvenance(): void {
    const notebook = this.notebookDocument;
    if (!isSoleOpenNotebookDocument(notebook)) {
      throw new Error("The notebook that originated this Open Wrangler session is no longer open.");
    }
  }

  private assertSessionIdentityAvailable(sessionId: string): void {
    if (this.sessionKernels.has(sessionId)) {
      throw new Error(`Open Wrangler already has a live kernel session named ${sessionId}.`);
    }
    if (this.retiredSessionIds.has(sessionId)) {
      throw new Error(`Open Wrangler has already retired kernel session ${sessionId}.`);
    }
  }
}

interface FramedKernelRequest {
  requestId: string;
  marker: string;
  code: string;
}

function requestPriority(
  request: OpenWranglerRequest,
  options: BridgeRequestOptions
): RuntimeRequestEnvelope["priority"] {
  return (
    options.priority ??
    (request.kind === "getSummary" || request.kind === "getDatasetStats" ? "background" : "interactive")
  );
}

function frameKernelRequest(
  request: OpenWranglerRequest,
  priority: RuntimeRequestEnvelope["priority"]
): FramedKernelRequest {
  const requestId = randomUUID();
  const envelope: RuntimeRequestEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    priority,
    request
  };
  const marker = requestId.replace(/-/g, "");
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  return {
    requestId,
    marker,
    code: `
import base64 as __ow_base64
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
__ow_payload = __ow_base64.b64decode("${payload}").decode("utf-8")
__ow_response = __ow_kernel_agent.dispatch_json(__ow_payload)
print("__OPEN_WRANGLER_START_${marker}__")
print(__ow_response)
print("__OPEN_WRANGLER_END_${marker}__")
`
  };
}

export function isIdempotentKernelReadRequest(request: OpenWranglerRequest): boolean {
  return (
    request.kind === "getPage" ||
    request.kind === "getSummary" ||
    request.kind === "getDatasetStats" ||
    request.kind === "getColumnValues"
  );
}

export function withKernelSessionIdentity(
  request: OpenWranglerRequest,
  createId: () => string = randomUUID
): KernelIdentifiedRequest {
  if (request.kind !== "openSession") return request;
  if (request.requestedSessionId) return { ...request, requestedSessionId: request.requestedSessionId };
  return { ...request, requestedSessionId: createId() };
}

type KernelIdentifiedRequest =
  Exclude<OpenWranglerRequest, OpenSessionRequest> | (OpenSessionRequest & { requestedSessionId: string });

export async function kernelOutputsToText(output: ReturnType<Kernel["executeCode"]>): Promise<string> {
  const chunks: string[] = [];
  for await (const item of output) chunks.push(outputItemToText(item));
  return chunks.join("");
}

function outputItemToText(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return "";
  const output = item as {
    text?: unknown;
    data?: Record<string, unknown>;
    items?: Array<{ mime?: string; data?: unknown }>;
  };
  if (output.text) return normalizeText(output.text);
  if (output.data?.["text/plain"]) return normalizeText(output.data["text/plain"]);
  const executionError = output.items?.find((candidate) => candidate.mime === "application/vnd.code.notebook.error");
  if (executionError) throw new Error(kernelExecutionError(executionError.data));
  return (
    output.items
      ?.filter((candidate) => typeof candidate.mime === "string" && isKernelTextMime(candidate.mime))
      .map((candidate) => normalizeText(candidate.data))
      .join("") ?? ""
  );
}

function isKernelTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/x.notebook.stream.stdout" ||
    mime === "application/x.notebook.stream.stderr" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr"
  );
}

function kernelExecutionError(value: unknown): string {
  const encoded = normalizeText(value);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed === "object" && parsed !== null) {
      const error = parsed as { name?: unknown; message?: unknown };
      const name = typeof error.name === "string" ? error.name : "KernelError";
      const message = typeof error.message === "string" ? error.message : encoded;
      return `Open Wrangler kernel execution failed (${name}): ${message}`;
    }
  } catch {
    // Preserve the raw kernel error when it is not JSON encoded.
  }
  return `Open Wrangler kernel execution failed: ${encoded || "unknown kernel error"}`;
}

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeText).join("");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function parseMarkedJson(output: string, marker: string): string {
  const start = `__OPEN_WRANGLER_START_${marker}__`;
  const end = `__OPEN_WRANGLER_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Open Wrangler could not parse the kernel response. Output: ${output.trim()}`);
  }
  return output.slice(startIndex + start.length, endIndex).trim();
}

export function parseKernelResponse(output: string, marker: string, requestId: string): OpenWranglerResponse {
  const parsed: unknown = JSON.parse(parseMarkedJson(output, marker));
  if (!isRuntimeResponseEnvelope(parsed) || parsed.requestId !== requestId) {
    throw new Error("Open Wrangler kernel agent returned an invalid or stale protocol response.");
  }
  return parsed.response;
}
