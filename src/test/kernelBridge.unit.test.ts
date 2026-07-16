import type { Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KernelBridge,
  isIdempotentKernelReadRequest,
  kernelOutputsToText,
  parseKernelResponse,
  withKernelSessionIdentity
} from "../extension/notebooks/kernelBridge";
import { buildKernelBootstrapCode } from "../extension/notebooks/kernelRuntimeBundle";
import type { OpenSessionRequest, OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";

const HANG = Symbol("hang kernel request");

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote kernel runtime bootstrap", () => {
  it("embeds a deterministic runtime bundle without referencing the extension filesystem", () => {
    const code = buildKernelBootstrapCode({
      "openwrangler_runtime/__init__.py": "VERSION = 2\n",
      "openwrangler_runtime/kernel_agent.py": "def dispatch_json(value): return value\n"
    });

    expect(code).toContain('Path(__ow_bundle_tempfile.gettempdir()) / "openwrangler-runtime"');
    expect(code).toContain("base64.b64decode");
    expect(code).toContain(".complete");
    expect(code).not.toContain("VERSION = 2");
    expect(code).not.toContain("extensionPath");
  });

  it("rejects incomplete or unsafe bundles", () => {
    expect(() => buildKernelBootstrapCode({ "openwrangler_runtime/kernel_agent.py": "" })).toThrow(
      "missing openwrangler_runtime/__init__.py"
    );
    expect(() =>
      buildKernelBootstrapCode({
        "openwrangler_runtime/__init__.py": "",
        "openwrangler_runtime/../escape.py": ""
      })
    ).toThrow("Unsafe bundled kernel runtime path");
  });
});

describe("kernel protocol responses", () => {
  const marker = "requestmarker";
  const requestId = "request-id";

  function marked(response: unknown): string {
    return [`__OPEN_WRANGLER_START_${marker}__`, JSON.stringify(response), `__OPEN_WRANGLER_END_${marker}__`].join(
      "\n"
    );
  }

  it("returns a logical runtime error without treating it as a transport failure", () => {
    const response = {
      kind: "error" as const,
      code: "engine_error",
      message: "Unknown session: missing-session",
      recoverable: true,
      viewRequestId: "view-unknown-session"
    };

    expect(parseKernelResponse(marked({ protocolVersion: 2, requestId, response }), marker, requestId)).toEqual(
      response
    );
  });

  it("rejects malformed and stale response envelopes", () => {
    expect(() =>
      parseKernelResponse(marked({ requestId, response: { kind: "initialized" } }), marker, requestId)
    ).toThrow("invalid or stale protocol response");
    expect(() =>
      parseKernelResponse(
        marked({ protocolVersion: 2, requestId: "other-request", response: { kind: "initialized" } }),
        marker,
        requestId
      )
    ).toThrow("invalid or stale protocol response");
  });

  it("collects marker output from the stable Jupyter stdout MIME", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [{ mime: "application/x.notebook.stream.stderr", data: encoder.encode("kernel warning\n") }]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(`__OPEN_WRANGLER_START_${marker}__\n`)
          }
        ]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(
              `${JSON.stringify({ protocolVersion: 2, requestId, response: initializedResponse })}\n`
            )
          }
        ]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(`__OPEN_WRANGLER_END_${marker}__\n`)
          }
        ]
      };
    }

    const text = await kernelOutputsToText(outputs());
    expect(text).toContain(`__OPEN_WRANGLER_START_${marker}__`);
    expect(text).toContain(`__OPEN_WRANGLER_END_${marker}__`);
    expect(parseKernelResponse(text, marker, requestId)).toEqual(initializedResponse);
  });

  it("surfaces stable Jupyter kernel error output instead of reporting a missing marker", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: encoder.encode(JSON.stringify({ name: "ModuleNotFoundError", message: "No module named 'polars'" }))
          }
        ]
      };
    }

    await expect(kernelOutputsToText(outputs())).rejects.toThrow(
      "Open Wrangler kernel execution failed (ModuleNotFoundError): No module named 'polars'"
    );
  });
});

describe("kernel retry classification", () => {
  it("assigns a stable host-known identity to kernel session opens", () => {
    const request: OpenSessionRequest = {
      kind: "openSession",
      source: { kind: "notebookVariable", label: "df", variableName: "df" },
      backend: "polars",
      mode: "viewing",
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };

    expect(withKernelSessionIdentity(request, () => "candidate-session")).toEqual({
      ...request,
      requestedSessionId: "candidate-session"
    });
    expect(
      withKernelSessionIdentity({ ...request, requestedSessionId: "existing-session" }, () => "unused-session")
    ).toMatchObject({ requestedSessionId: "existing-session" });
  });

  it.each(["getPage", "getSummary", "getDatasetStats", "getColumnValues"] as const)(
    "marks %s as an explicitly idempotent read",
    (kind) => {
      expect(isIdempotentKernelReadRequest({ kind } as OpenWranglerRequest)).toBe(true);
    }
  );

  it.each([
    "initialize",
    "openSession",
    "previewStep",
    "applyDraft",
    "discardDraft",
    "undoStep",
    "exportData",
    "closeSession",
    "cancelRequest"
  ] as const)("never treats %s as replay-safe after dispatch", (kind) => {
    expect(isIdempotentKernelReadRequest({ kind } as OpenWranglerRequest)).toBe(false);
  });

  it.each(["error", "cancelled"] as const)(
    "closes the host-known candidate after an open returns %s",
    async (outcome) => {
      const requests: OpenWranglerRequest[] = [];
      const kernel = fakeKernel((request, requestId) => {
        requests.push(request);
        if (request.kind === "openSession") {
          return outcome === "error"
            ? { kind: "error", code: "engine_error", message: "open failed", recoverable: true }
            : { kind: "cancelled", targetRequestId: requestId };
        }
        if (request.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        return initializedResponse;
      });
      mockKernel(kernel);
      const bridge = createKernelBridge();

      const response = await bridge.request(openRequest());

      expect(response.kind).toBe(outcome);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ kind: "openSession", requestedSessionId: expect.any(String) });
      expect(requests[1]).toEqual({
        kind: "closeSession",
        sessionId: (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId,
        revision: 0
      });
    }
  );

  it("closes the host-known candidate after a malformed open response", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return { kind: "sessionOpened" };
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest())).rejects.toThrow("invalid or stale protocol response");

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      kind: "closeSession",
      sessionId: (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId,
      revision: 0
    });
  });

  it("closes the host-known candidate after an open times out", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return HANG;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest(), { timeoutMs: 5 })).rejects.toThrow("timed out after 5 ms");

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      kind: "closeSession",
      sessionId: (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId,
      revision: 0
    });
  });

  it("closes both identities after an open response names the wrong session", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse("unexpected-runtime-session");
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest())).rejects.toThrow("session identity that did not match");

    const candidate = (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId;
    expect(
      new Set(
        requests
          .slice(1)
          .map((request) => (request.kind === "closeSession" ? request.sessionId : `unexpected:${request.kind}`))
      )
    ).toEqual(new Set([candidate, "unexpected-runtime-session"]));
  });
});

function openRequest(): OpenWranglerRequest {
  return {
    kind: "openSession",
    source: { kind: "notebookVariable", label: "df", variableName: "df" },
    backend: "polars",
    mode: "viewing",
    pageSize: 200,
    columnOffset: 0,
    columnLimit: 16
  };
}

function createKernelBridge(): KernelBridge {
  return new KernelBridge(
    { extensionPath: process.cwd() } as vscode.ExtensionContext,
    vscode.Uri.file("/workspace/notebook.ipynb")
  );
}

function mockKernel(kernel: Kernel): void {
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
    activate: async () => ({ kernels: { getKernel: async () => kernel } })
  } as never);
}

function fakeKernel(respond: (request: OpenWranglerRequest, requestId: string) => unknown): Kernel {
  return {
    language: "python",
    executeCode: (code: string) => kernelExecution(code, respond)
  } as unknown as Kernel;
}

async function* kernelExecution(
  code: string,
  respond: (request: OpenWranglerRequest, requestId: string) => unknown
): AsyncIterable<unknown> {
  const markerMatch = code.match(/__OPEN_WRANGLER_START_([A-Za-z0-9]+)__/);
  if (!markerMatch) return;
  const payloadMatch = code.match(/__ow_payload = __ow_base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
  if (!payloadMatch) throw new Error("Kernel test request did not contain an encoded protocol payload.");
  const envelope = JSON.parse(Buffer.from(payloadMatch[1], "base64").toString("utf8")) as {
    protocolVersion: 2;
    requestId: string;
    request: OpenWranglerRequest;
  };
  const response = respond(envelope.request, envelope.requestId);
  if (response === HANG) {
    await new Promise<never>(() => undefined);
  }
  yield {
    text: [
      `__OPEN_WRANGLER_START_${markerMatch[1]}__`,
      JSON.stringify({ protocolVersion: 2, requestId: envelope.requestId, response }),
      `__OPEN_WRANGLER_END_${markerMatch[1]}__`
    ].join("\n")
  };
}

function openedResponse(sessionId: string): OpenWranglerResponse {
  return {
    kind: "sessionOpened",
    metadata: {
      protocolVersion: 2,
      sessionId,
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: { kind: "notebookVariable", label: "df", variableName: "df" },
      capabilities: {
        editable: true,
        lazy: true,
        cancel: false,
        exportCsv: true,
        exportParquet: true,
        notebookInsert: true
      },
      shape: { rows: 0, columns: 0 },
      filteredShape: { rows: 0, columns: 0 },
      schema: [],
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    },
    page: { offset: 0, limit: 200, totalRows: 0, columnIds: [], rows: [] },
    summaries: []
  };
}
