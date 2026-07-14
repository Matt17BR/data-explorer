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
from data_wrangler_runtime.session import SessionManager

root = Path.cwd()
manager = SessionManager()
opened = manager.open_session(
    {"kind": "file", "label": "sample.csv", "path": str(root / "fixtures" / "sample.csv")},
    backend="polars",
    page_size=4,
)
filter_model = {
    "filters": [
        {
            "column": "city",
            "type": "string",
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
filtered_page = manager.get_page(opened["metadata"]["sessionId"], 0, 4, filter_model)
filtered_summary = manager.get_summary(opened["metadata"]["sessionId"], filter_model)
values = manager.get_column_values(opened["metadata"]["sessionId"], "city", filter_model, None, 100)

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
    "notebook": mime_payload,
}))
`
    ],
    { cwd: root, encoding: "utf8" }
  )
);

writeWebviewHarness("grid-view.html", payloads.opened, {}, "grid-view.png");
writeWebviewHarness(
  "filter-panel.html",
  payloads.filtered,
  { [payloads.values.column]: payloads.values },
  "filter-panel.png"
);
writeNotebookHarness("notebook-preview.html", payloads.notebook, "notebook-preview.png");

function writeWebviewHarness(fileName, sessionPayload, columnValues, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = resolve(docsDir, outputName);
  const mediaDir = pathToFileURL(resolve(root, "media")).href;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${mediaDir}/webview.css" />
  <style>
    body { background: #1e1e1e; color: #d4d4d4; }
  </style>
  <script>
    const sessionPayload = ${JSON.stringify(sessionPayload)};
    const columnValues = ${JSON.stringify(columnValues)};
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.kind === "ready") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: sessionPayload })), 20);
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
      },
      getState() { return undefined; },
      setState() {}
    });
  </script>
</head>
<body>
  <div id="root"></div>
  <script src="${mediaDir}/webview.js"></script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath);
}

function writeNotebookHarness(fileName, payload, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = resolve(docsDir, outputName);
  const rendererUrl = `${pathToFileURL(resolve(root, "media", "notebookRenderer.js")).href}`;
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

function screenshot(htmlPath, outputPath) {
  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--allow-file-access-from-files",
      "--hide-scrollbars",
      "--window-size=1280,760",
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
