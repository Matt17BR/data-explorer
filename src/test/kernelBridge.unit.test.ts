import { describe, expect, it } from "vitest";
import { buildKernelBootstrapCode } from "../extension/notebooks/kernelRuntimeBundle";

describe("remote kernel runtime bootstrap", () => {
  it("embeds a deterministic runtime bundle without referencing the extension filesystem", () => {
    const code = buildKernelBootstrapCode({
      "data_wrangler_runtime/__init__.py": "VERSION = 2\n",
      "data_wrangler_runtime/kernel_agent.py": "def dispatch_json(value): return value\n"
    });

    expect(code).toContain('Path(__de_bundle_tempfile.gettempdir()) / "data-explorer-runtime"');
    expect(code).toContain("base64.b64decode");
    expect(code).toContain(".complete");
    expect(code).not.toContain("VERSION = 2");
    expect(code).not.toContain("extensionPath");
  });

  it("rejects incomplete or unsafe bundles", () => {
    expect(() => buildKernelBootstrapCode({ "data_wrangler_runtime/kernel_agent.py": "" })).toThrow(
      "missing data_wrangler_runtime/__init__.py"
    );
    expect(() =>
      buildKernelBootstrapCode({
        "data_wrangler_runtime/__init__.py": "",
        "data_wrangler_runtime/../escape.py": ""
      })
    ).toThrow("Unsafe bundled kernel runtime path");
  });
});
