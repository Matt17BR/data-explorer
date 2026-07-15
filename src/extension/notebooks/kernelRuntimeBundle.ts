import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

export function buildKernelBootstrapCode(files: Readonly<Record<string, string>>): string {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.some(([relativePath]) => relativePath === "data_wrangler_runtime/__init__.py")) {
    throw new Error("The bundled kernel runtime is missing data_wrangler_runtime/__init__.py.");
  }
  for (const [relativePath] of entries) {
    if (!/^data_wrangler_runtime\/[A-Za-z0-9_/-]+\.py$/.test(relativePath) || relativePath.includes("..")) {
      throw new Error(`Unsafe bundled kernel runtime path: ${relativePath}`);
    }
  }
  const serialized = JSON.stringify(Object.fromEntries(entries));
  const payload = Buffer.from(serialized, "utf8").toString("base64");
  const bundleId = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  return `
import base64 as __de_bundle_base64
import json as __de_bundle_json
import pathlib as __de_bundle_pathlib
import sys as __de_sys
import tempfile as __de_bundle_tempfile
__de_bundle_root = __de_bundle_pathlib.Path(__de_bundle_tempfile.gettempdir()) / "data-explorer-runtime" / "${bundleId}"
__de_bundle_marker = __de_bundle_root / ".complete"
if not __de_bundle_marker.exists():
    __de_bundle_files = __de_bundle_json.loads(__de_bundle_base64.b64decode("${payload}").decode("utf-8"))
    for __de_bundle_relative, __de_bundle_source in __de_bundle_files.items():
        __de_bundle_target = __de_bundle_root / __de_bundle_relative
        __de_bundle_target.parent.mkdir(parents=True, exist_ok=True)
        __de_bundle_target.write_text(__de_bundle_source, encoding="utf-8")
    __de_bundle_marker.write_text("${bundleId}", encoding="ascii")
if str(__de_bundle_root) not in __de_sys.path:
    __de_sys.path.insert(0, str(__de_bundle_root))
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
  visit(path.join(runtimeRoot, "data_wrangler_runtime"));
  return files;
}
