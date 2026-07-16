import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

export function buildKernelBootstrapCode(files: Readonly<Record<string, string>>): string {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.some(([relativePath]) => relativePath === "openwrangler_runtime/__init__.py")) {
    throw new Error("The bundled kernel runtime is missing openwrangler_runtime/__init__.py.");
  }
  for (const [relativePath] of entries) {
    if (!/^openwrangler_runtime\/[A-Za-z0-9_/-]+\.py$/.test(relativePath) || relativePath.includes("..")) {
      throw new Error(`Unsafe bundled kernel runtime path: ${relativePath}`);
    }
  }
  const serialized = JSON.stringify(Object.fromEntries(entries));
  const payload = Buffer.from(serialized, "utf8").toString("base64");
  const bundleId = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  return `
import base64 as __ow_bundle_base64
import json as __ow_bundle_json
import pathlib as __ow_bundle_pathlib
import sys as __ow_sys
import tempfile as __ow_bundle_tempfile
__ow_bundle_root = __ow_bundle_pathlib.Path(__ow_bundle_tempfile.gettempdir()) / "openwrangler-runtime" / "${bundleId}"
__ow_bundle_marker = __ow_bundle_root / ".complete"
if not __ow_bundle_marker.exists():
    __ow_bundle_files = __ow_bundle_json.loads(__ow_bundle_base64.b64decode("${payload}").decode("utf-8"))
    for __ow_bundle_relative, __ow_bundle_source in __ow_bundle_files.items():
        __ow_bundle_target = __ow_bundle_root / __ow_bundle_relative
        __ow_bundle_target.parent.mkdir(parents=True, exist_ok=True)
        __ow_bundle_target.write_text(__ow_bundle_source, encoding="utf-8")
    __ow_bundle_marker.write_text("${bundleId}", encoding="ascii")
if str(__ow_bundle_root) not in __ow_sys.path:
    __ow_sys.path.insert(0, str(__ow_bundle_root))
`;
}

export function readRuntimeFiles(runtimeRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        files[path.relative(runtimeRoot, absolute).split(path.sep).join("/")] = readFileSync(absolute, "utf8");
      }
    }
  };
  visit(path.join(runtimeRoot, "openwrangler_runtime"));
  return files;
}
