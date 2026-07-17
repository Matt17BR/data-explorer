import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const harnessDir = resolve(root, "tmp", "screenshots");
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const executablePath = process.env.CHROME_BIN;
const harnesses = readdirSync(harnessDir)
  .filter((file) => file.endsWith(".html"))
  .sort();

if (harnesses.length === 0) {
  throw new Error("No generated webview harnesses found. Run capture:screenshots first.");
}

const workspaceTmp = resolve(root, "tmp");
mkdirSync(workspaceTmp, { recursive: true });
const browserRoot = mkdtempSync(join(workspaceTmp, "accessibility-browser-"));
chmodSync(browserRoot, 0o700);
const browserEnvironment = {
  ...process.env,
  HOME: join(browserRoot, "home"),
  XDG_CACHE_HOME: join(browserRoot, "cache"),
  XDG_CONFIG_HOME: join(browserRoot, "config"),
  XDG_DATA_HOME: join(browserRoot, "data"),
  XDG_RUNTIME_DIR: join(browserRoot, "runtime"),
  TMPDIR: join(browserRoot, "temp")
};
for (const directory of Object.values(browserEnvironment).filter(
  (value) => typeof value === "string" && value.startsWith(browserRoot)
)) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
let browser;
const failures = [];

try {
  browser = await chromium.launchPersistentContext(join(browserRoot, "profile"), {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
    env: browserEnvironment,
    timeout: 30_000
  });
  for (const harness of harnesses) {
    console.log(`Accessibility checking: ${harness}`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(15_000);
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load", timeout: 15_000 });
    await page.waitForTimeout(500);
    if (harness === "filter-panel.html") {
      await page.getByRole("checkbox").first().waitFor();
    }
    await page.addScriptTag({ path: axePath });
    const result = await withTimeout(
      page.evaluate(async () => {
        return globalThis.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
          }
        });
      }),
      30_000,
      `${harness} axe scan`
    );
    const violations = result.violations.filter((violation) => violation.impact !== "minor");
    if (violations.length === 0) {
      console.log(`Accessibility verified: ${harness}`);
    } else {
      failures.push({ harness, violations });
    }
    await page.close();
  }
  await verifyNotebookExpansion(browser);
  await verifyCodePreviewOrigin(browser);
  await verifyCleaningKeyboardShortcuts(browser);
  await verifyStepInspectionWorkflow(browser);
  await verifyFilterKeyboardWorkflow(browser);
  await verifyGridKeyboardWorkflow(browser);
  await verifyWideGridPerformance(browser);
} finally {
  try {
    await browser?.close();
  } finally {
    rmSync(browserRoot, { recursive: true, force: true });
  }
}

async function verifyNotebookExpansion(browser) {
  const harness = "notebook-preview.html";
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });
  const open = page.getByRole("button", { name: "Open in Open Wrangler" });
  await open.waitFor();
  await open.click();
  await page.waitForFunction(() =>
    globalThis.openWranglerNotebookMessages.some((message) => message.kind === "openInOpenWrangler")
  );
  const payload = await page.evaluate(
    () => globalThis.openWranglerNotebookMessages.find((message) => message.kind === "openInOpenWrangler")?.payload
  );
  if (!payload || payload.metadata?.protocolVersion !== 2) {
    throw new Error(`${harness} did not send a protocol v2 full-view payload.`);
  }
  const capturedRows = payload.page?.rows?.length;
  const totalRows = payload.page?.totalRows;
  if (!Number.isInteger(capturedRows) || !Number.isInteger(totalRows) || capturedRows >= totalRows) {
    throw new Error(`${harness} did not exercise a truncated saved output.`);
  }
  const notice = await page.getByTestId("capture-limit").textContent();
  if (
    !notice?.includes(`first ${capturedRows} of ${totalRows} rows`) ||
    !notice.includes("expanded Open Wrangler view can query only these captured rows")
  ) {
    throw new Error(`${harness} did not label the captured-row limit honestly.`);
  }
  await page.close();
  console.log("Notebook MIME v2 full-view expansion and truncation disclosure verified.");
}

async function verifyCodePreviewOrigin(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "code-preview.html")).href, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("def clean_data"));
  const before = await page.locator(".cm-content").textContent();
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "codePreview", code: "# untrusted replacement", editable: true },
        origin: "https://untrusted.invalid"
      })
    );
  });
  const after = await page.locator(".cm-content").textContent();
  if (after !== before) {
    throw new Error("Code preview accepted a message from another origin.");
  }

  const readOnlyCode = "# Read-only saved notebook snapshot.";
  await page.evaluate((code) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "codePreview", code, editable: false },
        origin: window.location.origin
      })
    );
  }, readOnlyCode);
  const content = page.locator(".cm-content");
  await page.waitForFunction((code) => document.querySelector(".cm-content")?.textContent === code, readOnlyCode);
  if ((await content.getAttribute("aria-label")) !== "Read-only Open Wrangler code preview") {
    throw new Error("Code preview did not publish its read-only accessible label.");
  }
  if ((await content.getAttribute("contenteditable")) !== "false") {
    throw new Error("Code preview remained editable after a read-only host update.");
  }
  await content.click({ force: true });
  await page.keyboard.type("\nraise RuntimeError('must not be inserted')");
  if ((await content.textContent()) !== readOnlyCode) {
    throw new Error("Read-only Code Preview accepted keyboard input.");
  }
  await page.close();
  console.log("Code-preview host origin and read-only behavior verified.");
}

if (failures.length > 0) {
  const detail = failures
    .flatMap(({ harness, violations }) =>
      violations.map(
        (violation) =>
          `${harness}: [${violation.impact ?? "unknown"}] ${violation.id} — ${violation.help}\n` +
          violation.nodes
            .slice(0, 5)
            .map((node) => `  ${node.target.join(" ")}: ${node.failureSummary ?? "failed"}`)
            .join("\n")
      )
    )
    .join("\n");
  throw new Error(`Webview accessibility scan failed:\n${detail}`);
}

console.log(`Accessibility verified for ${harnesses.length} production webview harnesses.`);

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyWideGridPerformance(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "wide-view.html")).href, { waitUntil: "load" });
  await page.waitForSelector('[data-grid-row="0"]');

  const cached = [];
  for (const row of [1, 4, 8, 12, 16, 20, 24, 28]) {
    cached.push(
      await page.evaluate(async (targetRow) => {
        const scroller = document.querySelector("[data-testid='data-grid-scroller']");
        const started = performance.now();
        scroller.scrollTop = targetRow * 29;
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        return performance.now() - started;
      }, row)
    );
  }

  const uncached = [];
  for (const row of [200, 400, 600, 800]) {
    const started = performance.now();
    await page.locator("[data-testid='data-grid-scroller']").evaluate((scroller, targetRow) => {
      scroller.scrollTop = targetRow * 29;
    }, row);
    await page.waitForSelector(`[data-grid-row="${row}"]`);
    uncached.push(performance.now() - started);
  }
  await assertProjectedHarnessClean(page, "wide-grid performance");
  await page.close();

  const cachedP95 = percentile(cached, 0.95);
  const uncachedP95 = percentile(uncached, 0.95);
  if (cachedP95 > 100 || uncachedP95 > 500) {
    throw new Error(
      `Wide-grid performance failed: cached p95 ${cachedP95.toFixed(1)}ms (limit 100ms), uncached p95 ${uncachedP95.toFixed(1)}ms (limit 500ms).`
    );
  }
  console.log(
    `Wide-grid performance verified: cached p95 ${cachedP95.toFixed(1)}ms, uncached p95 ${uncachedP95.toFixed(1)}ms.`
  );
}

async function verifyCleaningKeyboardShortcuts(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "draft-preview.html")).href, { waitUntil: "load" });
  const apply = page.getByRole("button", { name: "Apply step" });
  await apply.waitFor();
  await apply.focus();
  await page.keyboard.press("Control+Enter");
  await waitForRuntimeRequest(page, "applyDraft");

  await resetDraftHarness(page);
  const discard = page.getByRole("button", { name: "Discard" });
  await discard.focus();
  await page.keyboard.press("Escape");
  await waitForRuntimeRequest(page, "discardDraft");

  await resetDraftHarness(page);
  await showAppliedStep(page);
  const undo = page.getByRole("button", { name: "Undo" });
  await undo.waitFor();
  await undo.focus();
  await page.keyboard.press("Control+Alt+z");
  await waitForRuntimeRequest(page, "undoStep");

  await resetDraftHarness(page);
  await showAppliedStep(page);
  const edit = page.getByRole("button", { name: "Edit latest" });
  await edit.waitFor();
  await edit.focus();
  await page.keyboard.press("Control+Shift+e");
  await page.getByRole("dialog", { name: "Edit cleaning step" }).waitFor();
  await page.keyboard.press("Escape");
  if (await page.getByRole("dialog", { name: "Edit cleaning step" }).isVisible()) {
    throw new Error("Escape did not close the operation dialog.");
  }
  await page.close();
  console.log("Cleaning-plan keyboard shortcuts verified.");
}

async function verifyStepInspectionWorkflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "step-inspection.html")).href, { waitUntil: "load" });
  await waitForRuntimeRequest(page, "inspectStep");

  const inspection = page.getByLabel("Selected applied-step inspection");
  await inspection.waitFor();
  const filters = page.getByRole("button", { name: "Filters paused during inspection" });
  if (!(await filters.isDisabled())) {
    throw new Error("Applied-step inspection did not disable filters and insights.");
  }

  const diffSummary = page.getByLabel("Selected step data diff summary");
  await diffSummary.waitFor();
  if (!(await diffSummary.textContent())?.includes("+1 columns")) {
    throw new Error("Applied-step inspection did not report its added column.");
  }

  const addedHeader = page.getByRole("columnheader", { name: "adjusted_sales, added column" });
  await addedHeader.waitFor();
  if ((await addedHeader.getAttribute("data-diff-state")) !== "added") {
    throw new Error("Applied-step inspection did not expose the added-column diff state.");
  }
  const addedCell = page.getByRole("gridcell", {
    name: /adjusted_sales, row 1: added column; before column absent; after/u
  });
  await addedCell.waitFor();
  if ((await addedCell.getAttribute("data-diff-state")) !== "added") {
    throw new Error("Applied-step inspection did not expose an accessible added-cell diff state.");
  }

  const pageRequestsBeforeClear = await runtimeRequestCount(page, "getPage");
  const showConfirmed = page.getByRole("button", { name: "Show confirmed data" });
  await showConfirmed.focus();
  await page.keyboard.press("Escape");
  await inspection.waitFor({ state: "detached" });
  await page.waitForFunction(() =>
    globalThis.openWranglerMessages.some((message) => message.kind === "clearStepInspection")
  );

  if ((await runtimeRequestCount(page, "getPage")) !== pageRequestsBeforeClear) {
    throw new Error("Clearing applied-step inspection fetched the confirmed grid again.");
  }
  const restoredFilters = page.getByRole("button", { name: "Insights & filters" });
  await restoredFilters.waitFor();
  if (await restoredFilters.isDisabled()) {
    throw new Error("Clearing applied-step inspection did not restore filter controls.");
  }
  const restoredHeader = page.locator('th[data-column="adjusted_sales"]');
  await restoredHeader.waitFor();
  if (await restoredHeader.getAttribute("data-diff-state")) {
    throw new Error("Clearing applied-step inspection left diff state on the confirmed grid.");
  }
  if ((await page.locator("[data-diff-state]").count()) !== 0) {
    throw new Error("Clearing applied-step inspection left diff annotations in the confirmed grid.");
  }

  await page.close();
  console.log("Applied-step diff, accessibility, Escape clear, and local confirmed-grid restoration verified.");
}

async function verifyFilterKeyboardWorkflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  await page.goto(pathToFileURL(resolve(harnessDir, "filter-panel.html")).href, { waitUntil: "load" });
  await page.getByRole("complementary", { name: "Insights and filters" }).waitFor();
  await waitForRuntimeRequestCount(page, "getColumnValues", 1);
  await page.getByRole("checkbox").first().waitFor();

  const columnMenu = page.locator("details.columnMenu[open] .columnMenuContent");
  await columnMenu.waitFor();
  const menuBackground = await columnMenu.evaluate((element) => {
    const color = getComputedStyle(element).backgroundColor;
    const alpha = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u)?.[1];
    return { color, alpha: color === "transparent" ? 0 : alpha === undefined ? 1 : Number(alpha) };
  });
  if (menuBackground.alpha < 1) {
    throw new Error(`Column menu background is not opaque (${menuBackground.color}).`);
  }

  const search = page.getByRole("textbox", { name: /Search values for/ });
  await search.focus();
  await page.keyboard.type("ber");
  await page.keyboard.press("Enter");
  await waitForRuntimeRequestCount(page, "getColumnValues", 2);

  const predicate = page.getByRole("textbox", { name: /predicate value/ });
  await predicate.focus();
  await page.keyboard.type("Berlin");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitForRuntimeRequestCount(page, "getPage", 1);

  const sorts = page.locator("details").filter({ hasText: "SORTS" });
  if (!(await sorts.evaluate((element) => element.open))) {
    await sorts.locator("summary").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("details")].some(
        (element) => element.textContent?.includes("SORTS") && element.open
      )
    );
  }
  const direction = page.getByRole("combobox", { name: "Sort direction" });
  await direction.focus();
  await page.keyboard.press("End");
  if (!(await sorts.evaluate((element) => element.open))) {
    throw new Error("Changing sort direction closed the sort disclosure.");
  }
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitForRuntimeRequestCount(page, "getPage", 2);

  const close = page.getByRole("button", { name: "Close panel" });
  await close.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Insights and filters" }).waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Filter…");
  await page.close();
  console.log("Filter, sort, and drawer-focus keyboard workflow verified.");
}

async function verifyGridKeyboardWorkflow(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(pathToFileURL(resolve(harnessDir, "wide-view.html")).href, { waitUntil: "load" });
  const scroller = page.locator("[data-testid='data-grid-scroller']");
  const firstCell = page.locator('[data-grid-row="0"][data-grid-column="0"]');
  await firstCell.waitFor();
  const initialProjectionIsExact = await page.evaluate(() => {
    const payload = globalThis.openWranglerSessionPayload;
    const expected = payload.metadata.schema.slice(0, 16).map((column) => column.id);
    return (
      payload.page.columnIds.length === expected.length &&
      payload.page.columnIds.every((columnId, index) => columnId === expected[index]) &&
      payload.page.rows.every((row) => row.values.length === expected.length)
    );
  });
  if (!initialProjectionIsExact) {
    throw new Error("Wide-grid browser harness did not start from an exact 16-column projected page.");
  }
  await firstCell.focus();
  await waitForFocusedGridCell(page, 0, 0);

  await page.keyboard.press("ArrowRight");
  await waitForFocusedGridCell(page, 0, 1);
  await page.keyboard.press("ArrowDown");
  await waitForFocusedGridCell(page, 1, 1);
  await page.keyboard.press("ArrowLeft");
  await waitForFocusedGridCell(page, 1, 0);
  await page.keyboard.press("ArrowUp");
  await waitForFocusedGridCell(page, 0, 0);

  await page.keyboard.press("End");
  await waitForFocusedGridCell(page, 0, 39);
  await page.waitForFunction(() => {
    const cell = document.querySelector('td[data-grid-row="0"][data-grid-column="39"]');
    return (
      cell?.textContent?.trim() === "39" &&
      globalThis.openWranglerProjectedResponses.some(
        (response) =>
          response.columnOffset > 0 &&
          response.columnOffset + response.columnIds.length ===
            globalThis.openWranglerSessionPayload.metadata.schema.length
      )
    );
  });
  const farProjection = await page.evaluate(() => {
    const schema = globalThis.openWranglerSessionPayload.metadata.schema;
    return globalThis.openWranglerProjectedResponses.find(
      (response) => response.columnOffset > 0 && response.columnOffset + response.columnIds.length === schema.length
    );
  });
  const expectedFarIds = await page.evaluate(
    ({ columnOffset, columnLimit }) =>
      globalThis.openWranglerSessionPayload.metadata.schema
        .slice(columnOffset, columnOffset + columnLimit)
        .map((column) => column.id),
    farProjection
  );
  const maximumPrefetchWidth = 2 * 16;
  if (
    !farProjection ||
    farProjection.columnLimit > maximumPrefetchWidth ||
    farProjection.columnIds.length > farProjection.columnLimit ||
    farProjection.columnIds.some((columnId, index) => columnId !== expectedFarIds[index]) ||
    farProjection.rowWidths.some((width) => width !== farProjection.columnIds.length)
  ) {
    throw new Error(`Far-column projection was not exact and bounded: ${JSON.stringify(farProjection)}.`);
  }
  if ((await scroller.evaluate((element) => element.scrollLeft)) <= 0) {
    throw new Error("End did not horizontally virtualize and focus the final grid column.");
  }
  await page.keyboard.press("Home");
  await waitForFocusedGridCell(page, 0, 0);
  await page.waitForFunction(
    () => document.querySelector('td[data-grid-row="0"][data-grid-column="0"]')?.textContent?.trim() === "0"
  );

  await scroller.evaluate((element) => {
    element.style.flex = "none";
    element.style.height = "560px";
  });
  const pageRowCount = await scroller.evaluate((element) => Math.max(1, Math.floor(element.clientHeight / 29)));
  await page.keyboard.press("PageDown");
  await waitForFocusedGridCell(page, pageRowCount, 0);
  const pageDownRow = await focusedGridRow(page);
  await page.keyboard.press("PageUp");
  await waitForFocusedGridCell(page, 0, 0);
  if (pageDownRow !== pageRowCount) {
    throw new Error(`PageDown focused row ${pageDownRow}; expected one visible page (${pageRowCount} rows).`);
  }
  await scroller.evaluate((element) => {
    element.style.removeProperty("flex");
    element.style.removeProperty("height");
    window.dispatchEvent(new Event("resize"));
  });

  await scroller.evaluate((element) => {
    element.scrollTop = 199 * 29;
  });
  const finalCellInBlock = page.locator('[data-grid-row="199"][data-grid-column="0"]');
  await finalCellInBlock.waitFor();
  await finalCellInBlock.focus();
  await waitForFocusedGridCell(page, 199, 0);
  await page.keyboard.press("ArrowDown");
  await waitForFocusedGridCell(page, 200, 0);
  await page.waitForFunction(() =>
    globalThis.openWranglerMessages.some(
      (message) =>
        message.kind === "runtimeRequest" && message.request?.kind === "getPage" && message.request.offset === 200
    )
  );

  await scroller.evaluate((element) => {
    element.scrollTop = 230 * 29;
    element.scrollLeft = 3000;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => {
    const roving = document.querySelectorAll('td[tabindex="0"]');
    return roving.length === 1 && document.activeElement === roving[0];
  });
  const rovingCell = page.locator('td[tabindex="0"]');
  const rovingRow = Number(await rovingCell.getAttribute("data-grid-row"));
  const rovingColumn = Number(await rovingCell.getAttribute("data-grid-column"));
  if (rovingRow <= 200 || rovingColumn <= 0) {
    throw new Error(`Mouse virtualization left an unexpected roving cell at ${rovingRow}, ${rovingColumn}.`);
  }
  await page.keyboard.press("ArrowRight");
  await waitForFocusedGridCell(page, rovingRow, rovingColumn + 1);

  await assertProjectedHarnessClean(page, "wide-grid keyboard workflow");
  await page.close();
  console.log(
    "Grid arrows, two-dimensional projected paging, exact far-column rendering, and cross-block focus verified."
  );
}

async function assertProjectedHarnessClean(page, label) {
  const errors = await page.evaluate(() => [...globalThis.openWranglerHarnessErrors]);
  if (errors.length) throw new Error(`${label} reported projected-page fixture errors: ${errors.join(" ")}`);
}

async function resetDraftHarness(page) {
  await page.reload({ waitUntil: "load" });
  await page.getByRole("button", { name: "Apply step" }).waitFor();
}

async function showAppliedStep(page) {
  await page.evaluate(() => {
    const payload = globalThis.openWranglerSessionPayload;
    const step = payload.metadata.draftStep;
    const metadata = { ...payload.metadata, draftStep: undefined, steps: [step] };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "planUpdated", revision: metadata.revision, metadata, page: payload.page, code: payload.code },
        origin: window.location.origin
      })
    );
  });
}

async function waitForFocusedGridCell(page, row, column) {
  await page.waitForFunction(
    ({ expectedRow, expectedColumn }) => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.dataset.gridRow === String(expectedRow) &&
        active.dataset.gridColumn === String(expectedColumn)
      );
    },
    { expectedRow: row, expectedColumn: column }
  );
}

async function focusedGridRow(page) {
  return page.evaluate(() => Number(document.activeElement?.getAttribute("data-grid-row")));
}

async function waitForRuntimeRequest(page, kind) {
  await page.waitForFunction(
    (requestKind) =>
      globalThis.openWranglerMessages.some(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ),
    kind
  );
}

async function waitForRuntimeRequestCount(page, kind, count) {
  await page.waitForFunction(
    ({ requestKind, minimum }) =>
      globalThis.openWranglerMessages.filter(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ).length >= minimum,
    { requestKind: kind, minimum: count }
  );
}

async function runtimeRequestCount(page, kind) {
  return page.evaluate(
    (requestKind) =>
      globalThis.openWranglerMessages.filter(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ).length,
    kind
  );
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}
