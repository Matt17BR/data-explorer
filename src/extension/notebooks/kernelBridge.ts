import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  DataExplorerRequest,
  DataExplorerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope
} from "../../shared/protocol";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import type { BridgeRequestOptions, DataExplorerBridge } from "../dataBridge";

interface JupyterExtensionApi {
  kernels: {
    getKernel(uri: vscode.Uri): Promise<JupyterKernel | undefined> | JupyterKernel | undefined;
  };
}

interface JupyterKernel {
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<unknown> | Promise<unknown> | unknown;
}

export class KernelBridge implements DataExplorerBridge {
  private bootstrapped = false;
  private kernel: JupyterKernel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly notebookUri: vscode.Uri
  ) {}

  async request(request: DataExplorerRequest, options: BridgeRequestOptions = {}): Promise<DataExplorerResponse> {
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
import base64 as __de_base64
import data_wrangler_runtime.kernel_agent as __de_kernel_agent
__de_payload = __de_base64.b64decode("${payload}").decode("utf-8")
print("__DATA_EXPLORER_START_${marker}__")
print(__de_kernel_agent.dispatch_json(__de_payload))
print("__DATA_EXPLORER_END_${marker}__")
`;

    await this.ensureKernelAgent(options);
    let output: string;
    try {
      output = await this.executePython(code, options);
    } catch {
      this.kernel = undefined;
      this.bootstrapped = false;
      await this.ensureKernelAgent(options);
      output = await this.executePython(code, options);
    }

    const parsed: unknown = JSON.parse(parseMarkedJson(output, marker));
    if (!isRuntimeResponseEnvelope(parsed) || parsed.requestId !== requestId) {
      throw new Error("Data Explorer kernel agent returned an invalid or stale protocol response.");
    }
    return parsed.response;
  }

  private async ensureKernelAgent(options: BridgeRequestOptions): Promise<void> {
    if (this.bootstrapped) return;
    const pythonRoot = path.join(this.context.extensionPath, "python");
    await this.executePython(
      `
import sys as __de_sys
__de_python_root = ${JSON.stringify(pythonRoot)}
if __de_python_root not in __de_sys.path:
    __de_sys.path.insert(0, __de_python_root)
import data_wrangler_runtime.kernel_agent as __de_kernel_agent
import data_wrangler_runtime.notebook as __de_notebook
__de_notebook.register_formatters()
`,
      options
    );
    this.bootstrapped = true;
  }

  private async executePython(code: string, options: BridgeRequestOptions): Promise<string> {
    const kernel = await this.getKernel();
    const tokenSource = new vscode.CancellationTokenSource();
    const cancellation = options.cancellation?.onCancellationRequested(() => tokenSource.cancel());
    if (options.cancellation?.isCancellationRequested) tokenSource.cancel();
    try {
      return await outputsToText(kernel.executeCode(code, tokenSource.token));
    } finally {
      cancellation?.dispose();
      tokenSource.dispose();
    }
  }

  private async getKernel(): Promise<JupyterKernel> {
    if (this.kernel) return this.kernel;
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before Data Explorer accesses a notebook kernel.");
    }

    const jupyter = vscode.extensions.getExtension<JupyterExtensionApi>("ms-toolsai.jupyter");
    if (!jupyter) {
      throw new Error("Install or enable the VS Code Jupyter extension to open live notebook dataframes.");
    }
    const api = await jupyter.activate();
    const kernel = await api.kernels.getKernel(this.notebookUri);
    if (!kernel) {
      throw new Error("Data Explorer could not access the selected Jupyter kernel for this notebook.");
    }
    this.kernel = kernel;
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
  const start = `__DATA_EXPLORER_START_${marker}__`;
  const end = `__DATA_EXPLORER_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Data Explorer could not parse the kernel response. Output: ${output.trim()}`);
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
