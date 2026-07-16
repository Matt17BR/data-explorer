import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = resolve(root, "tmp", "screenshots");
const actualDir = resolve(root, "tmp", "screenshots-actual");
const diffDir = resolve(root, "tmp", "screenshots-diff");
const docsDir = resolve(root, "docs", "images");
const hostedPython = process.env.pythonLocation
  ? process.platform === "win32"
    ? resolve(process.env.pythonLocation, "python.exe")
    : resolve(process.env.pythonLocation, "bin", "python")
  : undefined;
const localPython =
  process.platform === "win32"
    ? resolve(root, ".venv", "Scripts", "python.exe")
    : resolve(root, ".venv", "bin", "python");
const python =
  [process.env.OPEN_WRANGLER_PYTHON, hostedPython, localPython].find(
    (candidate) => candidate && existsSync(candidate)
  ) ?? (process.platform === "win32" ? "python" : "python3");
const chrome = process.env.CHROME_BIN ?? chromium.executablePath();
const verify = process.argv.includes("--verify");

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
mkdirSync(docsDir, { recursive: true });
if (verify) {
  rmSync(actualDir, { recursive: true, force: true });
  rmSync(diffDir, { recursive: true, force: true });
  mkdirSync(actualDir, { recursive: true });
}

const payloads = JSON.parse(
  execFileSync(
    python,
    [
      "-c",
      String.raw`
import json
from pathlib import Path
import nbformat
from nbclient import NotebookClient
import polars as pl
from openwrangler_runtime.session import SessionManager

root = Path.cwd()
manager = SessionManager()
opened = manager.open_session(
    {"kind": "file", "label": "sample.csv", "path": str(root / "fixtures" / "sample.csv")},
    backend="polars",
    page_size=4,
)
opened["harnessSummaries"] = manager.get_summary(
    opened["metadata"]["sessionId"],
    opened["metadata"]["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
filter_model = {
    "logic": "and",
    "filters": [
        {
            "column": "city",
            "type": "string",
            "logic": "and",
            "valueFilter": {
                "kind": "values",
                "selectedValues": ["Berlin", "Milan"],
                "includeNulls": False,
                "includeNaN": False,
                "search": "",
            },
            "predicates": [{"kind": "predicate", "operator": "contains", "value": "i"}],
        }
    ],
    "sort": [{"column": "sales", "direction": "desc", "nulls": "last"}],
}
session_id = opened["metadata"]["sessionId"]
sales_column = next(column for column in opened["metadata"]["schema"] if column["name"] == "sales")
opened["metadata"]["stats"] = manager.get_dataset_stats(session_id, 0, {"logic": "and", "filters": [], "sort": []})["stats"]
filtered_page = manager.get_page(session_id, 0, 0, 4, filter_model)
filtered_page["metadata"]["stats"] = manager.get_dataset_stats(session_id, 0, filter_model)["stats"]
filtered_summary = manager.get_summary(session_id, 0, filter_model)
values = manager.get_column_values(session_id, 0, "city", filter_model, None, 100)
draft = manager.preview_step(
    session_id,
    0,
    {
        "id": "adjusted-sales",
        "kind": "formula",
        "params": {
            "leftColumn": {"id": sales_column["id"], "name": sales_column["name"]},
            "operator": "multiply",
            "value": 1.1,
            "newColumn": "adjusted_sales",
        },
    },
    0,
    4,
)
draft["summaries"] = manager.get_summary(
    session_id,
    draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
draft["metadata"]["stats"] = manager.get_dataset_stats(
    session_id,
    draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["stats"]
applied = manager.apply_draft(session_id, draft["revision"], 0, 4)
applied["harnessSummaries"] = manager.get_summary(
    session_id,
    applied["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
applied["metadata"]["stats"] = manager.get_dataset_stats(
    session_id,
    applied["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["stats"]
inspection = manager.inspect_step(session_id, applied["revision"], "adjusted-sales", 0, 4)

example_path = root / "tmp" / "screenshots" / "by-example.csv"
example_path.write_text("value\na\nb\n", encoding="utf-8")
example_manager = SessionManager()
example_opened = example_manager.open_session(
    {"kind": "file", "label": "by-example.csv", "path": str(example_path)},
    backend="polars",
    page_size=10,
)
example_id = example_opened["metadata"]["sessionId"]
example_draft = example_manager.preview_step(
    example_id,
    0,
    {
        "id": "uppercase-example",
        "kind": "byExample",
        "params": {
            "sourceColumns": ["value"],
            "newColumn": "upper",
            "examples": [
                {"inputs": {"value": "a"}, "output": "A"},
                {"inputs": {"value": "b"}, "output": "B"},
            ],
        },
    },
    0,
    10,
)
example_draft["summaries"] = example_manager.get_summary(
    example_id,
    example_draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
example_draft["metadata"]["stats"] = example_manager.get_dataset_stats(
    example_id,
    example_draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["stats"]

wide_path = root / "tmp" / "screenshots" / "wide.csv"
pl.DataFrame({f"column_{column:02d}": [row + column for row in range(1000)] for column in range(40)}).write_csv(wide_path)
wide = manager.open_session(
    {"kind": "file", "label": "wide.csv", "path": str(wide_path)},
    backend="polars",
    page_size=200,
)
wide_id = wide["metadata"]["sessionId"]
wide["summaries"] = manager.get_summary(wide_id, 0, {"logic": "and", "filters": [], "sort": []})["summaries"]
wide_pages = {
    str(offset): manager.get_page(wide_id, 0, offset, 200, {"logic": "and", "filters": [], "sort": []})["page"]
    for offset in range(0, 1000, 200)
}

empty_path = root / "tmp" / "screenshots" / "empty.csv"
empty_path.write_text("name,value\n", encoding="utf-8")
empty = manager.open_session(
    {"kind": "file", "label": "empty.csv", "path": str(empty_path)},
    backend="polars",
    page_size=20,
)
empty["harnessSummaries"] = manager.get_summary(
    empty["metadata"]["sessionId"],
    empty["metadata"]["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]

unicode_path = root / "tmp" / "screenshots" / "unicode.csv"
pl.DataFrame({
    "city 🧭": ["München", "東京", "São Paulo", "مرحبا"],
    "description": [
        "A very long value designed to verify truncation without losing the full accessible cell title " * 2,
        "combining marks: e\u0301 · emoji: 🧪📊 · CJK: 数据探索",
        "Português — naïve façade — Ελληνικά",
        "bidirectional text and punctuation (مرحبا بالعالم)",
    ],
}).write_csv(unicode_path)
unicode = manager.open_session(
    {"kind": "file", "label": "unicode 🧪.csv", "path": str(unicode_path)},
    backend="polars",
    page_size=20,
)
unicode["harnessSummaries"] = manager.get_summary(
    unicode["metadata"]["sessionId"],
    unicode["metadata"]["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]

notebook = nbformat.read(root / "fixtures" / "example.ipynb", as_version=4)
client = NotebookClient(notebook, timeout=60, kernel_name="python3", resources={"metadata": {"path": str(root)}})
client.execute()
mime_payload = None
for cell in notebook.cells:
    for output in cell.get("outputs", []):
        data = output.get("data", {})
        if "application/vnd.openwrangler.viewer.v2+json" in data:
            mime_payload = data["application/vnd.openwrangler.viewer.v2+json"]
            break
    if mime_payload:
        break
if mime_payload is None:
    raise RuntimeError("Notebook did not emit an Open Wrangler MIME payload")

print(json.dumps({
    "opened": opened,
    "filtered": {
        "kind": "sessionOpened",
        "metadata": filtered_page["metadata"],
        "page": filtered_page["page"],
        "summaries": filtered_summary["summaries"],
        "harnessSummaries": filtered_summary["summaries"],
    },
    "values": values,
    "draft": draft,
    "applied": applied,
    "inspection": inspection,
    "exampleDraft": example_draft,
    "wide": wide,
    "widePages": wide_pages,
    "empty": empty,
    "unicode": unicode,
    "notebook": mime_payload,
}))
`
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  )
);

const duplicateColumnPayload = JSON.parse(JSON.stringify(payloads.opened));
duplicateColumnPayload.metadata.schema = duplicateColumnPayload.metadata.schema.map((column, position) => ({
  ...column,
  id: `c:source:${position}`,
  name: ["value", "value", "7", ""][position]
}));

writeWebviewHarness("grid-view.html", payloads.opened, {}, "grid-view.png");
writeWebviewHarness(
  "operation-dialog.html",
  payloads.opened,
  {},
  "acceptance/operation-dialog-dark-1280.png",
  {},
  { editorAction: { kind: "editorAction", action: "openOperation", operationKind: "formula" } }
);
writeWebviewHarness(
  "operation-dialog-duplicate-columns.html",
  duplicateColumnPayload,
  {},
  "acceptance/operation-dialog-duplicate-columns-dark-1280.png",
  {},
  { editorAction: { kind: "editorAction", action: "openOperation", operationKind: "formula" } }
);
writeWebviewHarness("draft-preview.html", payloads.draft, {}, "acceptance/draft-preview-dark-1280.png");
writeWebviewHarness(
  "step-inspection.html",
  payloads.applied,
  {},
  "acceptance/step-inspection-dark-1280.png",
  {},
  {
    editorAction: { kind: "editorAction", action: "selectStep", stepId: "adjusted-sales" },
    stepInspections: { "adjusted-sales:0": payloads.inspection }
  }
);
writeWebviewHarness(
  "by-example-dialog.html",
  payloads.opened,
  {},
  "acceptance/by-example-dialog-dark-1280.png",
  {},
  { editorAction: { kind: "editorAction", action: "openOperation", operationKind: "byExample" } }
);
writeWebviewHarness(
  "by-example-preview.html",
  payloads.exampleDraft,
  {},
  "acceptance/by-example-preview-dark-1280.png"
);
writeCodePreviewHarness("code-preview.html", payloads.draft.code, "acceptance/code-preview-dark-1280.png");
writeWebviewHarness(
  "filter-panel.html",
  payloads.filtered,
  { [payloads.values.column]: payloads.values },
  "filter-panel.png",
  {},
  { openColumnFilter: "city" }
);
writeNotebookHarness("notebook-preview.html", payloads.notebook, "notebook-preview.png");
writeWebviewHarness("wide-view.html", payloads.wide, {}, "wide-grid.png", payloads.widePages);
writeWebviewHarness("empty-state.html", payloads.empty, {}, "acceptance/empty-state-dark-1280.png");
writeWebviewHarness("unicode-state.html", payloads.unicode, {}, "acceptance/unicode-state-dark-1280.png");
writeWebviewHarness(
  "loading-state.html",
  payloads.opened,
  {},
  "acceptance/loading-state-dark-1280.png",
  {},
  { sendInitial: false }
);
writeWebviewHarness(
  "error-state.html",
  {
    kind: "error",
    code: "fixture_error",
    message: "Open Wrangler could not read this malformed fixture. Review the delimiter and encoding settings.",
    recoverable: true
  },
  {},
  "acceptance/error-state-dark-1280.png"
);
writeWebviewHarness(
  "recovery-state.html",
  payloads.opened,
  {},
  "acceptance/recovery-state-dark-1280.png",
  {},
  {
    followupMessage: {
      kind: "error",
      code: "runtime_restarted",
      message: "The Python runtime restarted. The saved plan is being replayed.",
      recoverable: true
    }
  }
);
writeWebviewHarness("grid-dark-800.html", payloads.opened, {}, "acceptance/grid-dark-800.png", {}, { width: 800 });
writeWebviewHarness("grid-dark-1920.html", payloads.opened, {}, "acceptance/grid-dark-1920.png", {}, { width: 1920 });
writeWebviewHarness(
  "grid-light-1280.html",
  payloads.opened,
  {},
  "acceptance/grid-light-1280.png",
  {},
  { theme: "light" }
);
writeWebviewHarness(
  "grid-high-contrast-1280.html",
  payloads.opened,
  {},
  "acceptance/grid-high-contrast-1280.png",
  {},
  { theme: "highContrast" }
);
writeWebviewHarness(
  "grid-high-contrast-light-1280.html",
  payloads.opened,
  {},
  "acceptance/grid-high-contrast-light-1280.png",
  {},
  { theme: "highContrastLight" }
);
for (const zoom of [0.8, 1.5, 2]) {
  writeWebviewHarness(
    `grid-zoom-${String(zoom).replace(".", "-")}.html`,
    payloads.opened,
    {},
    `acceptance/grid-dark-zoom-${Math.round(zoom * 100)}.png`,
    {},
    { zoom }
  );
}

function writeWebviewHarness(fileName, sessionPayload, columnValues, outputName, suppliedPages = {}, appearance = {}) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = screenshotOutput(outputName);
  const mediaDir = "../../media";
  const theme = appearance.theme ?? "dark";
  const zoom = appearance.zoom ?? 1;
  const width = appearance.width ?? 1280;
  const height = appearance.height ?? 760;
  const editorAction = appearance.editorAction;
  const openColumnFilter = appearance.openColumnFilter;
  const stepInspections = appearance.stepInspections ?? {};
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Wrangler webview acceptance</title>
  <link rel="stylesheet" href="${mediaDir}/webview.css" />
  <style>
    ${themeTokens(theme)}
    body { background: var(--vscode-editor-background); color: var(--vscode-foreground); zoom: ${zoom}; }
  </style>
  <script>
    const sessionPayload = ${JSON.stringify(sessionPayload)};
    window.openWranglerSessionPayload = sessionPayload;
    const profileSummaries = sessionPayload.harnessSummaries ?? sessionPayload.summaries ?? [];
    const columnValues = ${JSON.stringify(columnValues)};
    const pages = ${JSON.stringify(suppliedPages)};
    const stepInspections = ${JSON.stringify(stepInspections)};
    window.openWranglerMessages = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.openWranglerMessages.push(message);
        if (message.kind === "ready") {
          ${appearance.sendInitial === false ? "" : 'setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: sessionPayload, origin: window.location.origin })), 20);'}
          ${editorAction ? `setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(editorAction)}, origin: window.location.origin })), 90);` : ""}
          ${appearance.followupMessage ? `setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(appearance.followupMessage)}, origin: window.location.origin })), 120);` : ""}
          ${
            openColumnFilter
              ? `setTimeout(() => {
            const header = document.querySelector(${JSON.stringify(`th[data-column="${openColumnFilter}"]`)});
            const menu = header?.querySelector("details");
            if (menu) menu.open = true;
            const filter = [...(header?.querySelectorAll("button") ?? [])]
              .find(button => button.textContent?.trim() === "Filter…");
            filter?.focus();
            filter?.click();
          }, 100);`
              : ""
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getColumnValues") {
          const value = columnValues[message.request.column];
          if (value) {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
              data: { ...value, viewRequestId: message.request.viewRequestId },
              origin: window.location.origin
            })), 20);
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getPage") {
          const metadata = { ...sessionPayload.metadata, filterModel: message.request.filterModel };
          const page = pages[String(message.request.offset)] ?? sessionPayload.page;
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "page", revision: metadata.revision, viewRequestId: message.request.viewRequestId, metadata, page },
            origin: window.location.origin
          })), 20);
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "inspectStep") {
          const response = stepInspections[message.request.stepId + ":" + message.request.offset];
          if (response) {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
              data: {
                kind: "stepInspectionResult",
                stepId: message.request.stepId,
                offset: message.request.offset,
                response
              },
              origin: window.location.origin
            })), 20);
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getSummary") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "summary", revision: sessionPayload.metadata.revision, viewRequestId: message.request.viewRequestId, summaries: profileSummaries.filter(summary => message.request.columns?.includes(summary.column)) },
            origin: window.location.origin
          })), 20);
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getDatasetStats") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "datasetStats", revision: sessionPayload.metadata.revision, viewRequestId: message.request.viewRequestId, stats: sessionPayload.metadata.stats },
            origin: window.location.origin
          })), 20);
        }
      },
      getState() { return undefined; },
      setState() {}
    });
  </script>
</head>
<body data-fetch-block-size="200" data-default-column-width="190" data-insights-on-open="true" data-filter-mode="advanced">
  <div id="root"></div>
  <script type="module" src="${mediaDir}/webview.js"></script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath, width, height);
}

function writeNotebookHarness(fileName, payload, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = screenshotOutput(outputName);
  const rendererUrl = "../../media/notebookRenderer.js";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Wrangler notebook renderer acceptance</title>
  <style>
    :root {
      --vscode-panel-border: #3c3c3c;
      color: #d4d4d4;
      background: #1e1e1e;
      font-family: "Liberation Sans", Arial, sans-serif;
    }
    body { margin: 0; padding: 32px; background: #1e1e1e; }
    .notebook-shell { border: 1px solid #3c3c3c; border-radius: 10px; overflow: hidden; background: #202020; }
    .cell { padding: 18px 22px; border-bottom: 1px solid #3c3c3c; font-family: "Liberation Mono", monospace; white-space: pre; color: #d4d4d4; }
    .openwrangler-notebook header { padding: 14px 18px; background: #252526; font-weight: 700; }
    .openwrangler-notebook table { background: #202020; }
    .openwrangler-notebook th { background: #2d2d30; }
  </style>
</head>
<body>
  <div class="notebook-shell">
    <div class="cell">from pathlib import Path

import polars as pl
from openwrangler_runtime.notebook import show

candidates = (Path("fixtures/sample.csv"), Path("sample.csv"))
csv_path = next((path for path in candidates if path.exists()), None)
if csv_path is None:
    raise FileNotFoundError("Could not find sample.csv from the repo root or fixtures directory.")

df = pl.read_csv(csv_path)
show(df, label="sample.csv")</div>
    <div id="notebook-output"></div>
  </div>
  <script type="module">
    import { activate } from "${rendererUrl}";
    window.openWranglerNotebookMessages = [];
    const renderer = activate({
      postMessage(message) { window.openWranglerNotebookMessages.push(message); }
    });
    renderer.renderOutputItem({ json: () => (${JSON.stringify(payload)}) }, document.getElementById("notebook-output"));
  </script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath);
}

function writeCodePreviewHarness(fileName, code, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = screenshotOutput(outputName);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Open Wrangler code preview acceptance</title>
  <style>
    ${themeTokens("dark")}
    html, body, #root { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); }
  </style>
  <script>
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.kind === "ready") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "codePreview", code: ${JSON.stringify(code)} },
            origin: window.location.origin
          })), 20);
        }
      }
    });
  </script>
</head>
<body>
  <div id="root"></div>
  <script src="../../media/codePreview.js"></script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath, 1280, 420);
}

function screenshot(htmlPath, outputPath, width = 1280, height = 760) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--allow-file-access-from-files",
      `--window-size=${width},${height}`,
      "--virtual-time-budget=2500",
      `--screenshot=${outputPath}`,
      pathToFileURL(htmlPath).href
    ],
    { cwd: root, encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`Chrome screenshot failed for ${htmlPath}\n${result.stderr}\n${result.stdout}`);
  }
  const size = readFileSync(outputPath).byteLength;
  console.log(`Captured ${outputPath} (${size} bytes)`);
  if (verify) compareScreenshot(outputPath);
}

function screenshotOutput(outputName) {
  return resolve(verify ? actualDir : docsDir, outputName);
}

function compareScreenshot(actualPath) {
  const relativePath = relative(actualDir, actualPath);
  const baselinePath = resolve(docsDir, relativePath);
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(readFileSync(actualPath));
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    throw new Error(
      `Visual regression for ${relativePath}: expected ${baseline.width}x${baseline.height}, received ${actual.width}x${actual.height}.`
    );
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const changed = pixelmatch(baseline.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.2,
    includeAA: false
  });
  const ratio = changed / (actual.width * actual.height);
  if (ratio > 0.01) {
    const diffPath = resolve(diffDir, relativePath);
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, PNG.sync.write(diff));
    throw new Error(
      `Visual regression for ${relativePath}: ${(ratio * 100).toFixed(2)}% of pixels changed (limit 1.00%). Diff: ${diffPath}`
    );
  }
  console.log(`Verified ${relativePath} (${(ratio * 100).toFixed(3)}% changed).`);
}

function themeTokens(theme) {
  const palettes = {
    dark: {
      foreground: "#d4d4d4",
      description: "#a8a8a8",
      editor: "#1e1e1e",
      header: "#252526",
      sidebar: "#181818",
      border: "#3c3c3c",
      input: "#313131",
      inputForeground: "#f0f0f0",
      button: "#0e639c",
      buttonForeground: "#ffffff",
      badge: "#4d4d4d",
      badgeForeground: "#ffffff",
      focus: "#007fd4",
      scrollbar: "#79797966",
      scrollbarHover: "#646464b3",
      scrollbarActive: "#bfbfbf66",
      selection: "#04395e",
      selectionForeground: "#ffffff"
    },
    light: {
      foreground: "#333333",
      description: "#616161",
      editor: "#ffffff",
      header: "#f3f3f3",
      sidebar: "#f8f8f8",
      border: "#d4d4d4",
      input: "#ffffff",
      inputForeground: "#333333",
      button: "#007acc",
      buttonForeground: "#ffffff",
      badge: "#c4c4c4",
      badgeForeground: "#333333",
      focus: "#0090f1",
      scrollbar: "#64646466",
      scrollbarHover: "#646464b3",
      scrollbarActive: "#00000099",
      selection: "#0060c0",
      selectionForeground: "#ffffff"
    },
    highContrast: {
      foreground: "#ffffff",
      description: "#ffffff",
      editor: "#000000",
      header: "#000000",
      sidebar: "#000000",
      border: "#ffffff",
      input: "#000000",
      inputForeground: "#ffffff",
      button: "#000000",
      buttonForeground: "#ffffff",
      badge: "#000000",
      badgeForeground: "#ffffff",
      focus: "#ffff00",
      scrollbar: "#ffffff99",
      scrollbarHover: "#ffffffcc",
      scrollbarActive: "#ffffff",
      selection: "#000000",
      selectionForeground: "#ffffff"
    },
    highContrastLight: {
      foreground: "#000000",
      description: "#000000",
      editor: "#ffffff",
      header: "#ffffff",
      sidebar: "#ffffff",
      border: "#000000",
      input: "#ffffff",
      inputForeground: "#000000",
      button: "#ffffff",
      buttonForeground: "#000000",
      badge: "#ffffff",
      badgeForeground: "#000000",
      focus: "#0f4a85",
      scrollbar: "#00000099",
      scrollbarHover: "#000000cc",
      scrollbarActive: "#000000",
      selection: "#ffffff",
      selectionForeground: "#000000"
    }
  };
  const palette = palettes[theme] ?? palettes.dark;
  return `:root {
    --vscode-foreground: ${palette.foreground};
    --vscode-descriptionForeground: ${palette.description};
    --vscode-editor-background: ${palette.editor};
    --vscode-editorGroupHeader-tabsBackground: ${palette.header};
    --vscode-sideBar-background: ${palette.sidebar};
    --vscode-panel-border: ${palette.border};
    --vscode-input-background: ${palette.input};
    --vscode-input-foreground: ${palette.inputForeground};
    --vscode-button-background: ${palette.button};
    --vscode-button-foreground: ${palette.buttonForeground};
    --vscode-badge-background: ${palette.badge};
    --vscode-badge-foreground: ${palette.badgeForeground};
    --vscode-focusBorder: ${palette.focus};
    --vscode-scrollbarSlider-background: ${palette.scrollbar};
    --vscode-scrollbarSlider-hoverBackground: ${palette.scrollbarHover};
    --vscode-scrollbarSlider-activeBackground: ${palette.scrollbarActive};
    --vscode-list-activeSelectionBackground: ${palette.selection};
    --vscode-list-activeSelectionForeground: ${palette.selectionForeground};
    --vscode-notifications-background: ${palette.header};
    --vscode-notifications-border: ${palette.border};
    --vscode-font-family: "Liberation Sans", Arial, sans-serif;
    --vscode-editor-font-family: "Liberation Mono", monospace;
    font-kerning: none;
    font-optical-sizing: none;
    font-variant-ligatures: none;
    font-synthesis: none;
  }`;
}
