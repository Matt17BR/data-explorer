import { describe, expect, it } from "vitest";
import { buildKernelBootstrapCode } from "../extension/notebooks/kernelRuntimeBundle";

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
