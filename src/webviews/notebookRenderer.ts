import {
  isPythonIdentifier,
  normalizeNotebookOutputPayload,
  type NotebookOutputPayload
} from "../shared/notebookOutput";

interface RendererOutputItem {
  json(): unknown;
}

interface RendererContext {
  setState?(state: unknown): void;
  getState?(): unknown;
  postMessage?(message: unknown): void;
}

interface RendererApi {
  renderOutputItem(outputItem: RendererOutputItem, element: HTMLElement): void;
}

const INLINE_PREVIEW_ROWS = 20;
const INLINE_PREVIEW_COLUMNS = 20;
const INLINE_LABEL_CHARACTERS = 256;
const INLINE_COLUMN_CHARACTERS = 128;
const INLINE_CELL_CHARACTERS = 512;

export function activate(context: RendererContext): RendererApi {
  return {
    renderOutputItem(outputItem, element) {
      const payload = normalizeNotebookOutputPayload(outputItem.json());
      element.innerHTML = "";
      if (!payload) {
        const error = document.createElement("p");
        error.setAttribute("role", "alert");
        error.textContent = "This Open Wrangler output is malformed or uses an unsupported MIME version.";
        element.appendChild(error);
        return;
      }
      element.appendChild(renderPayload(payload, context));
    }
  };
}

function renderPayload(payload: NotebookOutputPayload, context: RendererContext): HTMLElement {
  const root = document.createElement("section");
  root.className = "openwrangler-notebook";

  const header = document.createElement("header");
  header.style.alignItems = "center";
  header.style.display = "flex";
  header.style.gap = "12px";
  header.style.justifyContent = "space-between";

  const title = document.createElement("span");
  const sourceLabel = boundedText(payload.metadata.source.label, INLINE_LABEL_CHARACTERS);
  title.textContent = `Open Wrangler preview: ${sourceLabel.text} (${payload.metadata.backend}) - ${payload.metadata.shape.rows} x ${payload.metadata.shape.columns}`;
  applyTruncationDescription(title, sourceLabel, "Source label");
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  if (context.postMessage) {
    actions.appendChild(
      actionButton("Open in Open Wrangler", "Open the captured notebook output in Open Wrangler", () => {
        context.postMessage?.({ kind: "openInOpenWrangler", payload });
      })
    );
    const variableName = payload.metadata.source.variableName;
    if (variableName && isPythonIdentifier(variableName)) {
      const variablePreview = boundedText(variableName, INLINE_COLUMN_CHARACTERS);
      actions.appendChild(
        actionButton("Open live variable", `Open the current value of ${variablePreview.text} through Jupyter`, () => {
          context.postMessage?.({ kind: "openLiveInOpenWrangler", payload });
        })
      );
    }
  }
  header.appendChild(actions);

  root.appendChild(header);

  if (payload.page.rows.length < payload.page.totalRows) {
    const captureNotice = document.createElement("p");
    captureNotice.setAttribute("role", "status");
    captureNotice.dataset.testid = "capture-limit";
    captureNotice.textContent = `Saved output contains the first ${payload.page.rows.length.toLocaleString()} of ${payload.page.totalRows.toLocaleString()} rows. The expanded Open Wrangler view can query only these captured rows.`;
    captureNotice.style.color = "var(--vscode-descriptionForeground)";
    captureNotice.style.margin = "6px 0";
    root.appendChild(captureNotice);
  }

  const previewRows = payload.page.rows.slice(0, INLINE_PREVIEW_ROWS);
  const previewSchema = payload.metadata.schema.slice(0, INLINE_PREVIEW_COLUMNS);
  if (previewRows.length < payload.page.rows.length || previewSchema.length < payload.metadata.schema.length) {
    const previewNotice = document.createElement("p");
    previewNotice.setAttribute("role", "status");
    previewNotice.dataset.testid = "inline-preview-limit";
    previewNotice.textContent = `Inline preview shows ${previewRows.length.toLocaleString()} of ${payload.page.rows.length.toLocaleString()} captured rows and ${previewSchema.length.toLocaleString()} of ${payload.metadata.schema.length.toLocaleString()} columns. Open the snapshot to explore the complete capture.`;
    previewNotice.style.color = "var(--vscode-descriptionForeground)";
    previewNotice.style.margin = "6px 0";
    root.appendChild(previewNotice);
  }

  const scroller = document.createElement("div");
  scroller.style.overflow = "auto";
  scroller.style.maxHeight = "320px";
  root.appendChild(scroller);

  const table = document.createElement("table");
  table.setAttribute("aria-label", `Open Wrangler snapshot of ${sourceLabel.text}`);
  table.style.borderCollapse = "collapse";
  table.style.width = "max-content";
  table.style.minWidth = "100%";
  scroller.appendChild(table);

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  previewSchema.forEach((column) => {
    const cell = document.createElement("th");
    const columnName = boundedText(column.name, INLINE_COLUMN_CHARACTERS);
    const rawType = boundedText(column.rawType, INLINE_COLUMN_CHARACTERS);
    cell.textContent = columnName.text;
    cell.title = rawType.truncated
      ? `Raw type preview (${rawType.length.toLocaleString()} characters): ${rawType.text}`
      : rawType.text;
    applyTruncationDescription(cell, columnName, "Column name");
    cell.style.textAlign = "left";
    cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
    cell.style.padding = "4px 8px";
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  previewRows.forEach((row) => {
    const tableRow = document.createElement("tr");
    row.values.slice(0, previewSchema.length).forEach((value) => {
      const cell = document.createElement("td");
      const display = boundedText(value.display, INLINE_CELL_CHARACTERS);
      cell.textContent = display.text;
      cell.title = display.truncated
        ? `Value preview (${display.length.toLocaleString()} characters): ${display.text}`
        : display.text;
      applyTruncationDescription(cell, display, "Cell value");
      cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
      cell.style.padding = "4px 8px";
      tableRow.appendChild(cell);
    });
    body.appendChild(tableRow);
  });
  table.appendChild(body);

  return root;
}

function actionButton(label: string, title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.background = "var(--vscode-button-background)";
  button.style.border = "0";
  button.style.borderRadius = "3px";
  button.style.color = "var(--vscode-button-foreground)";
  button.style.cursor = "pointer";
  button.style.padding = "4px 8px";
  button.addEventListener("click", action);
  return button;
}

function boundedText(value: string, maximum: number): { text: string; truncated: boolean; length: number } {
  const characters = Array.from(value);
  if (characters.length <= maximum) return { text: value, truncated: false, length: characters.length };
  return { text: `${characters.slice(0, maximum).join("")}…`, truncated: true, length: characters.length };
}

function applyTruncationDescription(
  element: HTMLElement,
  value: { text: string; truncated: boolean; length: number },
  label: string
): void {
  if (!value.truncated) return;
  element.dataset.truncatedValue = "true";
  element.setAttribute(
    "aria-label",
    `${label} preview, truncated from ${value.length.toLocaleString()} characters: ${value.text}`
  );
}
