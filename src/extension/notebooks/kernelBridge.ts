import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope
} from "../../shared/protocol";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../dataBridge";
import { RestartableKernel, withKernelTimeout } from "./kernelLifecycle";
import { buildKernelBootstrapCode, readRuntimeFiles } from "./kernelRuntimeBundle";
import { getSetting } from "../configuration";

interface JupyterExtensionApi {
  kernels: {
    getKernel(uri: vscode.Uri): Promise<JupyterKernel | undefined> | JupyterKernel | undefined;
  };
}

interface JupyterKernel {
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<unknown> | Promise<unknown> | unknown;
}

export class KernelBridge implements OpenWranglerBridge {
  private readonly lifecycle: RestartableKernel<JupyterKernel>;
  private readonly bootstrapCode: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookUri: vscode.Uri
  ) {
    this.lifecycle = new RestartableKernel(() => this.acquireKernel());
    this.bootstrapCode = buildKernelBootstrapCode(readRuntimeFiles(path.join(this.context.extensionPath, "python")));
  }

  async request(request: OpenWranglerRequest, options: BridgeRequestOptions = {}): Promise<OpenWranglerResponse> {
    const requestId = randomUUID();
    const envelope: RuntimeRequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      priority:
        options.priority ??
        (request.kind === "getSummary" || request.kind === "getDatasetStats" ? "background" : "interactive"),
      request
    };
    const marker = requestId.replace(/-/g, "");
    const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    const code = `
import base64 as __ow_base64
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
__ow_payload = __ow_base64.b64decode("${payload}").decode("utf-8")
print("__OPEN_WRANGLER_START_${marker}__")
print(__ow_kernel_agent.dispatch_json(__ow_payload))
print("__OPEN_WRANGLER_END_${marker}__")
`;

    const output = await this.lifecycle.run(
      (kernel) => this.ensureKernelAgent(kernel, options),
      (kernel) => this.executePython(kernel, code, options),
      () => !options.cancellation?.isCancellationRequested
    );

    const parsed: unknown = JSON.parse(parseMarkedJson(output, marker));
    if (!isRuntimeResponseEnvelope(parsed) || parsed.requestId !== requestId) {
      throw new Error("Open Wrangler kernel agent returned an invalid or stale protocol response.");
    }
    return parsed.response;
  }

  private async ensureKernelAgent(kernel: JupyterKernel, options: BridgeRequestOptions): Promise<void> {
    await this.executePython(
      kernel,
      `${this.bootstrapCode}
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
import openwrangler_runtime.notebook as __ow_notebook
__ow_notebook.register_formatters()
`,
      options
    );
  }

  private async executePython(kernel: JupyterKernel, code: string, options: BridgeRequestOptions): Promise<string> {
    const tokenSource = new vscode.CancellationTokenSource();
    const cancellation = options.cancellation?.onCancellationRequested(() => tokenSource.cancel());
    if (options.cancellation?.isCancellationRequested) tokenSource.cancel();
    const timeoutMs = options.timeoutMs ?? getSetting<number>("requestTimeoutMs", 30_000);
    try {
      return await withKernelTimeout(outputsToText(kernel.executeCode(code, tokenSource.token)), timeoutMs, () =>
        tokenSource.cancel()
      );
    } finally {
      cancellation?.dispose();
      tokenSource.dispose();
    }
  }

  private async acquireKernel(): Promise<JupyterKernel> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before Open Wrangler accesses a notebook kernel.");
    }

    const jupyter = vscode.extensions.getExtension<JupyterExtensionApi>("ms-toolsai.jupyter");
    if (!jupyter) {
      throw new Error("Install or enable the VS Code Jupyter extension to open live notebook dataframes.");
    }
    const api = await jupyter.activate();
    const kernel = await api.kernels.getKernel(this.notebookUri);
    if (!kernel) {
      throw new Error("Open Wrangler could not access the selected Jupyter kernel for this notebook.");
    }
    return kernel;
  }
}

async function outputsToText(output: unknown): Promise<string> {
  const resolved = await output;
  if (isAsyncIterable(resolved)) {
    const chunks: string[] = [];
    for await (const item of resolved) chunks.push(outputItemToText(item));
    return chunks.join("");
  }
  if (Array.isArray(resolved)) return resolved.map(outputItemToText).join("");
  return outputItemToText(resolved);
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
  return normalizeText(output.items?.find((candidate) => candidate.mime === "text/plain")?.data);
}

function normalizeText(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalizeText).join("");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isRuntimeResponseEnvelope(value: unknown): value is RuntimeResponseEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeResponseEnvelope>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.requestId === "string" &&
    typeof candidate.response === "object" &&
    candidate.response !== null
  );
}
