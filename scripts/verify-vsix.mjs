import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2];
if (!requested) {
  throw new Error("Pass the exact VSIX path to verify; implicit artifact selection is intentionally disabled.");
}
const vsix = resolve(root, requested);

if (!existsSync(vsix)) {
  throw new Error(`VSIX not found: ${requested}`);
}

const entries = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
const allowed = [
  /^\[Content_Types\]\.xml$/u,
  /^extension\.vsixmanifest$/u,
  /^extension\/$/u,
  /^extension\/(package\.json|LICENSE\.txt|README\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md)$/iu,
  /^extension\/dist\/$/u,
  /^extension\/dist\/(extension|shared)\/$/u,
  /^extension\/dist\/(extension|shared)\/.+\.js$/u,
  /^extension\/media\/$/u,
  /^extension\/media\/(activity-icon\.svg|codicon\.ttf|icon(-128)?\.png|icon\.svg|codePreview\.js|notebookRenderer\.js|webview\.(css|js))$/u,
  /^extension\/python\/$/u,
  /^extension\/python\/openwrangler_runtime\/$/u,
  /^extension\/python\/openwrangler_runtime\/[^/]+\.py$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/[^/]+\.py$/u
];
const forbidden = entries.filter((entry) => !allowed.some((pattern) => pattern.test(entry)));
const required = [
  "extension/package.json",
  "extension/dist/extension/activate.js",
  "extension/media/webview.js",
  "extension/media/webview.css",
  "extension/media/icon.png",
  "extension/python/openwrangler_runtime/server.py"
];
const missing = required.filter((entry) => !entries.includes(entry));

if (forbidden.length > 0 || missing.length > 0) {
  throw new Error(
    [
      `Invalid ${basename(vsix)}.`,
      forbidden.length ? `Forbidden: ${forbidden.join(", ")}` : "",
      missing.length ? `Missing: ${missing.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join(" ")
  );
}

console.log(`Verified ${basename(vsix)} (${entries.length} archive entries).`);
