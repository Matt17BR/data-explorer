import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectVsixEntries } from "./vsix-contents.mjs";

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
const { forbidden, missing } = inspectVsixEntries(entries);
const webviewCss = execFileSync("unzip", ["-p", vsix, "extension/media/webview.css"], { encoding: "utf8" });
const webviewPanel = execFileSync("unzip", ["-p", vsix, "extension/dist/extension/webviewPanel.js"], {
  encoding: "utf8"
});
const bundleRelativeCodicon = /url\((?:["'])?\.\/codicon\.ttf(?:\?[^)"']*)?(?:["'])?\)/u;
const webviewFontPolicy = /font-src \$\{webview\.cspSource\};/u;

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
if (!bundleRelativeCodicon.test(webviewCss)) {
  throw new Error(`Invalid ${basename(vsix)}. webview.css must load codicon.ttf from its own bundle directory.`);
}
if (!webviewFontPolicy.test(webviewPanel)) {
  throw new Error(`Invalid ${basename(vsix)}. The main webview CSP must allow its bundled font origin.`);
}

console.log(`Verified ${basename(vsix)} (${entries.length} archive entries).`);
