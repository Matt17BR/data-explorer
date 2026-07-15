import * as path from "path";
import { describe, expect, it } from "vitest";
import { resolvePythonExecutable } from "../extension/pythonPath";

describe("resolvePythonExecutable", () => {
  it("keeps absolute paths unchanged", () => {
    expect(resolvePythonExecutable("/opt/python/bin/python", ["/workspace"], "/extension", () => false)).toBe(
      "/opt/python/bin/python"
    );
  });

  it("resolves relative paths from the workspace before the extension", () => {
    const workspace = path.resolve("workspace");
    const extension = path.resolve("extension");
    const configured = path.join(".venv", "bin", "python");
    const workspacePython = path.join(workspace, configured);
    const existing = new Set([workspacePython, path.join(extension, configured)]);

    expect(resolvePythonExecutable(configured, [workspace], extension, (candidate) => existing.has(candidate))).toBe(
      workspacePython
    );
  });

  it("falls back to the configured path when no relative candidate exists", () => {
    expect(resolvePythonExecutable("python3", ["/workspace"], "/extension", () => false)).toBe("python3");
  });
});
