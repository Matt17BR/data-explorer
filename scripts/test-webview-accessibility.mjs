import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const harnessDir = resolve(root, "tmp", "screenshots");
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const executablePath = process.env.CHROME_BIN ?? chromium.executablePath();
const harnesses = readdirSync(harnessDir)
  .filter((file) => file.endsWith(".html"))
  .sort();

if (harnesses.length === 0) {
  throw new Error("No generated webview harnesses found. Run capture:screenshots first.");
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"]
});
const failures = [];

try {
  for (const harness of harnesses) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await page.goto(pathToFileURL(resolve(harnessDir, harness)).href, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      return globalThis.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
        }
      });
    });
    const violations = result.violations.filter((violation) => violation.impact !== "minor");
    if (violations.length === 0) {
      console.log(`Accessibility verified: ${harness}`);
    } else {
      failures.push({ harness, violations });
    }
    await page.close();
  }
  await verifyNotebookExpansion(browser);
  await verifyCleaningKeyboardShortcuts(browser);
  await verifyWideGridPerformance(browser);
} finally {
  await browser.close();
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
  await page.close();
  console.log("Notebook MIME v2 full-view expansion verified.");
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

  const discard = page.getByRole("button", { name: "Discard" });
  await discard.focus();
  await page.keyboard.press("Escape");
  await waitForRuntimeRequest(page, "discardDraft");

  await page.evaluate(() => {
    const payload = globalThis.openWranglerSessionPayload;
    const step = payload.metadata.draftStep;
    const metadata = { ...payload.metadata, draftStep: undefined, steps: [step] };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "planUpdated", revision: metadata.revision, metadata, page: payload.page, code: payload.code }
      })
    );
  });
  const undo = page.getByRole("button", { name: "Undo" });
  await undo.waitFor();
  await undo.focus();
  await page.keyboard.press("Control+Alt+z");
  await waitForRuntimeRequest(page, "undoStep");

  const edit = page.getByRole("button", { name: "Edit latest" });
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

async function waitForRuntimeRequest(page, kind) {
  await page.waitForFunction(
    (requestKind) =>
      globalThis.openWranglerMessages.some(
        (message) => message.kind === "runtimeRequest" && message.request?.kind === requestKind
      ),
    kind
  );
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}
