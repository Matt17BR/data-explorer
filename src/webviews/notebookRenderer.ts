import { normalizeNotebookOutputPayload, type NotebookOutputPayload } from "../shared/notebookOutput";

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
  title.textContent = `Open Wrangler preview: ${payload.metadata.source.label} (${payload.metadata.backend}) - ${payload.metadata.shape.rows} x ${payload.metadata.shape.columns}`;
  header.appendChild(title);

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Open in Open Wrangler";
  openButton.title = "Open this notebook output in the full Open Wrangler view";
  openButton.style.background = "var(--vscode-button-background)";
  openButton.style.border = "0";
  openButton.style.borderRadius = "3px";
  openButton.style.color = "var(--vscode-button-foreground)";
  openButton.style.cursor = "pointer";
  openButton.style.padding = "4px 8px";
  openButton.addEventListener("click", () => {
    context.postMessage?.({
      kind: "openInOpenWrangler",
      payload
    });
  });
  header.appendChild(openButton);

  root.appendChild(header);

  const scroller = document.createElement("div");
  scroller.style.overflow = "auto";
  scroller.style.maxHeight = "320px";
  root.appendChild(scroller);

  const table = document.createElement("table");
  table.setAttribute("aria-label", `Open Wrangler snapshot of ${payload.metadata.source.label}`);
  table.style.borderCollapse = "collapse";
  table.style.width = "max-content";
  table.style.minWidth = "100%";
  scroller.appendChild(table);

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  payload.metadata.schema.forEach((column) => {
    const cell = document.createElement("th");
    cell.textContent = column.name;
    cell.title = column.rawType;
    cell.style.textAlign = "left";
    cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
    cell.style.padding = "4px 8px";
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  payload.page.rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    row.values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value.display;
      cell.title = value.display;
      cell.style.borderBottom = "1px solid var(--vscode-panel-border)";
      cell.style.padding = "4px 8px";
      tableRow.appendChild(cell);
    });
    body.appendChild(tableRow);
  });
  table.appendChild(body);

  return root;
}
