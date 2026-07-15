import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = resolve(root, "tmp", "screenshots");
const docsDir = resolve(root, "docs", "images");
const python = resolve(root, ".venv", "bin", "python");
const chrome = process.env.CHROME_BIN ?? "google-chrome";

mkdirSync(tmpDir, { recursive: true });
mkdirSync(docsDir, { recursive: true });

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
from data_wrangler_runtime.session import SessionManager

root = Path.cwd()
manager = SessionManager()
opened = manager.open_session(
    {"kind": "file", "label": "sample.csv", "path": str(root / "fixtures" / "sample.csv")},
    backend="polars",
    page_size=4,
)
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
            "leftColumn": "sales",
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

notebook = nbformat.read(root / "fixtures" / "example.ipynb", as_version=4)
client = NotebookClient(notebook, timeout=60, kernel_name="python3", resources={"metadata": {"path": str(root)}})
client.execute()
mime_payload = None
for cell in notebook.cells:
    for output in cell.get("outputs", []):
        data = output.get("data", {})
        if "application/vnd.data-explorer.viewer.v1+json" in data:
            mime_payload = data["application/vnd.data-explorer.viewer.v1+json"]
            break
    if mime_payload:
        break
if mime_payload is None:
    raise RuntimeError("Notebook did not emit a Data Explorer MIME payload")

print(json.dumps({
    "opened": opened,
    "filtered": {
        "kind": "sessionOpened",
        "metadata": filtered_page["metadata"],
        "page": filtered_page["page"],
        "summaries": filtered_summary["summaries"],
    },
    "values": values,
    "draft": draft,
    "wide": wide,
    "widePages": wide_pages,
    "notebook": mime_payload,
}))
`
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  )
);

writeWebviewHarness("grid-view.html", payloads.opened, {}, "grid-view.png");
writeWebviewHarness(
  "operation-dialog.html",
  payloads.opened,
  {},
  "acceptance/operation-dialog-dark-1280.png",
  {},
  { editorAction: { kind: "editorAction", action: "openOperation", operationKind: "formula" } }
);
writeWebviewHarness("draft-preview.html", payloads.draft, {}, "acceptance/draft-preview-dark-1280.png");
writeCodePreviewHarness("code-preview.html", payloads.draft.code, "acceptance/code-preview-dark-1280.png");
writeWebviewHarness(
  "filter-panel.html",
  payloads.filtered,
  { [payloads.values.column]: payloads.values },
  "filter-panel.png"
);
writeNotebookHarness("notebook-preview.html", payloads.notebook, "notebook-preview.png");
writeWebviewHarness("wide-view.html", payloads.wide, {}, "wide-grid.png", payloads.widePages);
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
  const outputPath = resolve(docsDir, outputName);
  const mediaDir = "../../media";
  const theme = appearance.theme ?? "dark";
  const zoom = appearance.zoom ?? 1;
  const width = appearance.width ?? 1280;
  const height = appearance.height ?? 760;
  const editorAction = appearance.editorAction;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${mediaDir}/webview.css" />
  <style>
    ${themeTokens(theme)}
    body { background: var(--vscode-editor-background); color: var(--vscode-foreground); zoom: ${zoom}; }
  </style>
  <script>
    const sessionPayload = ${JSON.stringify(sessionPayload)};
    const columnValues = ${JSON.stringify(columnValues)};
    const pages = ${JSON.stringify(suppliedPages)};
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.kind === "ready") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: sessionPayload })), 20);
          ${editorAction ? `setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(editorAction)} })), 90);` : ""}
          for (const value of Object.values(columnValues)) {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: value })), 80);
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getColumnValues") {
          const value = columnValues[message.request.column];
          if (value) {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: value })), 20);
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getPage") {
          const metadata = { ...sessionPayload.metadata, filterModel: message.request.filterModel };
          const page = pages[String(message.request.offset)] ?? sessionPayload.page;
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "page", revision: metadata.revision, metadata, page }
          })), 20);
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getSummary") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "summary", revision: sessionPayload.metadata.revision, summaries: sessionPayload.summaries }
          })), 20);
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getDatasetStats") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "datasetStats", revision: sessionPayload.metadata.revision, stats: sessionPayload.metadata.stats }
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
  <script src="${mediaDir}/webview.js"></script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath, width, height);
}

function writeNotebookHarness(fileName, payload, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = resolve(docsDir, outputName);
  const rendererUrl = "../../media/notebookRenderer.js";
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --vscode-panel-border: #3c3c3c;
      color: #d4d4d4;
      background: #1e1e1e;
      font-family: Inter, "Segoe UI", sans-serif;
    }
    body { margin: 0; padding: 32px; background: #1e1e1e; }
    .notebook-shell { border: 1px solid #3c3c3c; border-radius: 10px; overflow: hidden; background: #202020; }
    .cell { padding: 18px 22px; border-bottom: 1px solid #3c3c3c; font-family: "JetBrains Mono", Consolas, monospace; white-space: pre; color: #d4d4d4; }
    .data-explorer-notebook header { padding: 14px 18px; background: #252526; font-weight: 700; }
    .data-explorer-notebook table { background: #202020; }
    .data-explorer-notebook th { background: #2d2d30; }
  </style>
</head>
<body>
  <div class="notebook-shell">
    <div class="cell">from pathlib import Path

import polars as pl
from data_wrangler_runtime.notebook import show

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
    const renderer = activate({});
    renderer.renderOutputItem({ json: () => (${JSON.stringify(payload)}) }, document.getElementById("notebook-output"));
  </script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath);
}

function writeCodePreviewHarness(fileName, code, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = resolve(docsDir, outputName);
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    ${themeTokens("dark")}
    html, body, #root { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); }
  </style>
  <script>
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.kind === "ready") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "codePreview", code: ${JSON.stringify(code)} }
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
      "--hide-scrollbars",
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
      focus: "#007fd4"
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
      focus: "#0090f1"
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
      focus: "#ffff00"
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
    --vscode-notifications-background: ${palette.header};
    --vscode-notifications-border: ${palette.border};
  }`;
}
