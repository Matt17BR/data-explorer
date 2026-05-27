import { describe, expect, it } from "vitest";
import { resolvePythonExecutable } from "../extension/pythonPath";

describe("resolvePythonExecutable", () => {
  it("keeps absolute paths unchanged", () => {
    expect(resolvePythonExecutable("/opt/python/bin/python", ["/workspace"], "/extension", () => false)).toBe(
      "/opt/python/bin/python"
    );
  });

  it("resolves relative paths from the workspace before the extension", () => {
    const existing = new Set(["/workspace/.venv/bin/python", "/extension/.venv/bin/python"]);

    expect(
      resolvePythonExecutable(".venv/bin/python", ["/workspace"], "/extension", (candidate) => existing.has(candidate))
    ).toBe("/workspace/.venv/bin/python");
  });

  it("falls back to the configured path when no relative candidate exists", () => {
    expect(resolvePythonExecutable("python3", ["/workspace"], "/extension", () => false)).toBe("python3");
  });
});
