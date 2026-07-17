import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DISPLAY_MODE_ENV = "OPEN_WRANGLER_EDITOR_DISPLAY";
const XVFB_EXECUTABLE_ENV = "OPEN_WRANGLER_XVFB_EXECUTABLE";
const XVFB_START_TIMEOUT_MS = 10_000;
const XVFB_STOP_TIMEOUT_MS = 5_000;
const ISOLATED_EDITOR_ARGS = [
  "--force-disable-user-env",
  "--disable-updates",
  "--disable-crash-reporter",
  "--disable-telemetry",
  "--use-inmemory-secretstorage",
  "--password-store=basic",
  "--skip-add-to-recently-opened"
];
const DETACHED_SESSION_ENVIRONMENT_KEYS = [
  "DESKTOP_SESSION",
  "ELECTRON_RENDERER_URL",
  "GDMSESSION",
  "GNOME_DESKTOP_SESSION_ID",
  "GNOME_KEYRING_CONTROL",
  "GNOME_SETUP_DISPLAY",
  "ICEAUTHORITY",
  "KDE_FULL_SESSION",
  "KDE_SESSION_UID",
  "SESSION_MANAGER",
  "SSH_AUTH_SOCK",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP"
];

export async function startIsolatedEditorDisplay({
  platform = process.platform,
  environment = process.env,
  spawnProcess = spawn,
  startupTimeoutMs = XVFB_START_TIMEOUT_MS
} = {}) {
  const mode = editorDisplayMode(environment);
  if (platform !== "linux" || mode === "current") {
    if (platform === "linux") {
      console.warn(
        `Linux editor acceptance is using the current desktop because ${DISPLAY_MODE_ENV}=current was set explicitly.`
      );
    }
    return { display: environment.DISPLAY, isolated: false, mode: "current", stop: async () => undefined };
  }

  if (mode === "headless") {
    const runtime = isolateLinuxEditorEnvironment(environment, mode);
    console.log(
      "Editor acceptance is using Chromium's zero-window headless platform; it cannot open or focus a desktop window."
    );
    let stopped = false;
    return {
      display: undefined,
      isolated: true,
      mode,
      async stop() {
        if (stopped) return;
        stopped = true;
        runtime.restore();
      }
    };
  }

  const executable = environment[XVFB_EXECUTABLE_ENV] || "Xvfb";
  const child = spawnProcess(
    executable,
    ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-dpi", "96", "-nolisten", "tcp", "-noreset"],
    {
      env: { ...environment },
      stdio: ["ignore", "ignore", "pipe", "pipe"]
    }
  );
  const exit = childExit(child);
  let displayNumber;
  try {
    displayNumber = await readXvfbDisplayNumber(child, exit, startupTimeoutMs);
  } catch (error) {
    await stopChild(child, exit).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Linux editor acceptance could not start its private Xvfb display: ${detail} Install Xvfb (for example, \`sudo apt-get install xvfb\` on Ubuntu/Debian), configure ${XVFB_EXECUTABLE_ENV}, or set ${DISPLAY_MODE_ENV}=current only when a visible, focus-stealing debug run is intentional.`,
      { cause: error }
    );
  }

  const display = `:${displayNumber}`;
  const runtime = isolateLinuxEditorEnvironment(environment, mode, display);
  console.log(`Editor acceptance is isolated on private Xvfb display ${display}; it cannot take desktop focus.`);

  let stopped = false;
  return {
    display,
    isolated: true,
    mode,
    async stop() {
      if (stopped) return;
      stopped = true;
      runtime.restore();
      await stopChild(child, exit);
    }
  };
}

export function editorDisplayLaunchArgs(platform = process.platform, environment = process.env) {
  if (platform !== "linux") return [];
  const mode = editorDisplayMode(environment);
  if (mode === "headless") return ["--ozone-platform=headless", "--disable-gpu", ...ISOLATED_EDITOR_ARGS];
  if (mode === "xvfb") return ["--ozone-platform=x11", ...ISOLATED_EDITOR_ARGS];
  return [];
}

function editorDisplayMode(environment) {
  const mode = environment[DISPLAY_MODE_ENV] ?? "headless";
  if (mode !== "headless" && mode !== "xvfb" && mode !== "current") {
    throw new Error(`${DISPLAY_MODE_ENV} must be "headless", "xvfb", or "current"; received ${JSON.stringify(mode)}.`);
  }
  return mode;
}

function isolateLinuxEditorEnvironment(environment, mode, display) {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "openwrangler-editor-runtime-"));
  chmodSync(runtimeDirectory, 0o700);
  const homeDirectory = join(runtimeDirectory, "home");
  const configDirectory = join(runtimeDirectory, "config");
  const cacheDirectory = join(runtimeDirectory, "cache");
  const dataDirectory = join(runtimeDirectory, "data");
  for (const directory of [homeDirectory, configDirectory, cacheDirectory, dataDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const changedEnvironment = new Map();
  setEnvironmentValue(environment, changedEnvironment, "HOME", homeDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_RUNTIME_DIR", runtimeDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_CONFIG_HOME", configDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_CACHE_HOME", cacheDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_DATA_HOME", dataDirectory);
  setEnvironmentValue(environment, changedEnvironment, "DISPLAY", display);
  setEnvironmentValue(environment, changedEnvironment, "WAYLAND_DISPLAY", undefined);
  setEnvironmentValue(environment, changedEnvironment, "GDK_BACKEND", mode === "xvfb" ? "x11" : undefined);
  setEnvironmentValue(environment, changedEnvironment, "XDG_SESSION_TYPE", mode === "xvfb" ? "x11" : "tty");
  for (const key of DETACHED_SESSION_ENVIRONMENT_KEYS) {
    setEnvironmentValue(environment, changedEnvironment, key, undefined);
  }
  for (const key of Object.keys(environment)) {
    if (/^(?:VSCODE|CURSOR).*IPC/iu.test(key)) {
      setEnvironmentValue(environment, changedEnvironment, key, undefined);
    }
  }
  return {
    restore() {
      restoreEnvironment(environment, changedEnvironment);
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}

async function readXvfbDisplayNumber(child, exit, timeoutMs) {
  const displayOutput = child.stdio?.[3];
  if (!displayOutput || typeof displayOutput.on !== "function") {
    throw new Error("Xvfb did not expose its display-number pipe.");
  }
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
  });

  let timer;
  let output = "";
  try {
    return await Promise.race([
      new Promise((resolveDisplay, rejectDisplay) => {
        displayOutput.on("data", (chunk) => {
          output += String(chunk);
          const lineEnd = output.indexOf("\n");
          if (lineEnd < 0) return;
          const value = output.slice(0, lineEnd).trim();
          if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) {
            rejectDisplay(new Error(`Xvfb returned an invalid display number: ${JSON.stringify(value)}.`));
            return;
          }
          resolveDisplay(Number(value));
        });
        child.once("error", rejectDisplay);
      }),
      exit.then(({ code, signal }) => {
        const suffix = stderr.trim() ? ` ${stderr.trim()}` : "";
        throw new Error(`Xvfb exited before it became ready (code ${code}, signal ${signal}).${suffix}`);
      }),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          const suffix = stderr.trim() ? ` ${stderr.trim()}` : "";
          rejectTimeout(new Error(`Xvfb did not become ready within ${timeoutMs}ms.${suffix}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function setEnvironmentValue(environment, previousValues, key, value) {
  previousValues.set(key, {
    existed: Object.prototype.hasOwnProperty.call(environment, key),
    value: environment[key]
  });
  if (value === undefined) delete environment[key];
  else environment[key] = value;
}

function restoreEnvironment(environment, previousValues) {
  for (const [key, previous] of previousValues) {
    if (previous.existed) environment[key] = previous.value;
    else delete environment[key];
  }
}

function childExit(child) {
  return new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopChild(child, exit) {
  const isRunning = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  if (!isRunning()) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(exit, XVFB_STOP_TIMEOUT_MS)) return;
  if (isRunning()) child.kill("SIGKILL");
  if (await waitForChildExit(exit, XVFB_STOP_TIMEOUT_MS)) return;
  throw new Error(`The private Xvfb process ${child.pid ?? "(unknown pid)"} did not exit after SIGKILL.`);
}

export async function downloadEditorWithRetry(download, version, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await download(version);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const waitMs = attempt * 2_000;
      console.warn(
        `Editor download ${version} failed on attempt ${attempt}/${attempts}; retrying in ${waitMs}ms.`,
        error instanceof Error ? error.message : String(error)
      );
      await delay(waitMs);
    }
  }
  throw lastError;
}

export function writeEditorAcceptanceHarness(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({
      name: "openwrangler-packaged-test-harness",
      displayName: "Open Wrangler packaged test harness",
      version: "0.0.0",
      publisher: "openwrangler-tests",
      engines: { vscode: "^1.105.0" },
      main: "./extension.js",
      activationEvents: ["*"],
      contributes: {
        customEditors: [
          {
            viewType: "openwrangler-tests.csvEditor",
            displayName: "Acceptance CSV Editor",
            selector: [{ filenamePattern: "*.csv" }],
            priority: "option"
          }
        ]
      }
    })
  );
  writeFileSync(
    resolve(directory, "extension.js"),
    `const fs = require("node:fs");
const vscode = require("vscode");

exports.activate = async function (context) {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider("openwrangler-tests.csvEditor", {
    openCustomDocument(uri) {
      return { uri, dispose() {} };
    },
    resolveCustomEditor(document, panel) {
      panel.webview.html = '<!doctype html><html><body><main aria-label="Acceptance CSV Editor">Third-party CSV editor acceptance double</main></body></html>';
    }
  }));
  let outcome;
  try {
    await require(process.env.OPEN_WRANGLER_TEST_MODULE).run();
    outcome = { ok: true };
  } catch (error) {
    console.error(error);
    outcome = { ok: false, error: error instanceof Error ? error.stack || error.message : String(error) };
  }
  const resultPath = process.env.OPEN_WRANGLER_TEST_RESULT;
  const temporaryResultPath = resultPath + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(temporaryResultPath, JSON.stringify(outcome), { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryResultPath, resultPath);
  } finally {
    try { fs.rmSync(temporaryResultPath, { force: true }); } catch {}
  }
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.quit"), 2_000);
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.closeWindow"), 500);
};
`
  );
}

export function writeEditorSettings(userDataDirectory, settings) {
  const userDirectory = resolve(userDataDirectory, "User");
  const settingsPath = resolve(userDirectory, "settings.json");
  mkdirSync(userDirectory, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export function writeFakeJupyterExtension(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({
      name: "jupyter",
      displayName: "Open Wrangler stable Jupyter API acceptance double",
      version: "0.0.0",
      publisher: "ms-toolsai",
      engines: { vscode: "^1.105.0" },
      main: "./extension.js",
      activationEvents: []
    })
  );
  writeFileSync(
    resolve(directory, "kernel_server.py"),
    `import base64
import contextlib
import io
import json
import sys
import traceback

namespace = vars(sys.modules["__main__"])
for line in sys.stdin:
    try:
        request = json.loads(line)
        code = base64.b64decode(request["code"]).decode("utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(code, "<openwrangler-kernel>", "exec"), namespace, namespace)
        response = {"id": request["id"], "ok": True, "text": output.getvalue()}
    except BaseException:
        response = {
            "id": request.get("id", "unknown") if "request" in locals() else "unknown",
            "ok": False,
            "error": traceback.format_exc(),
        }
    print(json.dumps(response), flush=True)
`
  );
  writeFileSync(
    resolve(directory, "extension.js"),
    `const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

let denied = false;
let denialCalls = 0;
let generation = 0;
const kernels = new Map();

class AcceptanceKernel {
  constructor(key) {
    this.key = key;
    this.generation = ++generation;
    this.status = "idle";
    this.language = "python";
    this.onDidChangeStatus = () => ({ dispose() {} });
    this.process = undefined;
    this.pending = new Map();
    this.invalidated = false;
    this.executions = 0;
  }

  executeCode(code, token) {
    const execution = this.executeText(code, token);
    return (async function* () {
      const text = await execution;
      yield {
        items: [{ mime: "application/x.notebook.stream.stdout", data: Buffer.from(text, "utf8") }],
        metadata: {}
      };
    })();
  }

  executeText(code, token) {
    if (this.invalidated) return Promise.reject(new Error("kernel restarted"));
    if (token && token.isCancellationRequested) return Promise.reject(new Error("cancelled"));
    const process = this.ensureProcess();
    const id = String(this.generation) + "-" + String(++this.executions);
    return new Promise((resolve, reject) => {
      const cancellation = token && token.onCancellationRequested
        ? token.onCancellationRequested(() => {
            this.pending.delete(id);
            reject(new Error("cancelled"));
          })
        : undefined;
      this.pending.set(id, {
        resolve: (value) => {
          if (cancellation) cancellation.dispose();
          resolve(value);
        },
        reject: (error) => {
          if (cancellation) cancellation.dispose();
          reject(error);
        }
      });
      process.stdin.write(JSON.stringify({ id, code: Buffer.from(code, "utf8").toString("base64") }) + "\\n");
    });
  }

  ensureProcess() {
    if (this.process) return this.process;
    const executable = process.env.OPEN_WRANGLER_TEST_PYTHON || "python3";
    const child = spawn(executable, [path.join(__dirname, "kernel_server.py")], {
      cwd: __dirname,
      env: { ...process.env, PYTHONPATH: "" }
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response;
      try { response = JSON.parse(line); } catch (error) { return; }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.text || "");
      else pending.reject(new Error(response.error || "kernel execution failed"));
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", () => {
      if (this.process === child) this.process = undefined;
      for (const pending of this.pending.values()) pending.reject(new Error("kernel process exited"));
      this.pending.clear();
    });
    this.process = child;
    return child;
  }

  invalidate() {
    this.invalidated = true;
    const child = this.process;
    this.process = undefined;
    if (child) child.kill();
    for (const pending of this.pending.values()) pending.reject(new Error("kernel restarted"));
    this.pending.clear();
  }
}

function keyFor(uri) {
  return uri && uri.toString ? uri.toString() : String(uri);
}

function kernelFor(uri) {
  const key = keyFor(uri);
  let kernel = kernels.get(key);
  if (!kernel) {
    kernel = new AcceptanceKernel(key);
    kernels.set(key, kernel);
  }
  return kernel;
}

async function executeForTesting(kernel, code) {
  let text = "";
  for await (const output of kernel.executeCode(code)) {
    for (const item of output.items || []) {
      if (item.mime === "application/x.notebook.stream.stdout") text += Buffer.from(item.data).toString("utf8");
    }
  }
  return text;
}

const api = {
  kernels: {
    getKernel(uri) {
      if (denied) {
        denialCalls += 1;
        throw new Error("Jupyter kernel access denied for acceptance testing");
      }
      return kernelFor(uri);
    }
  },
  testing: {
    execute(uri, code) {
      return executeForTesting(kernelFor(uri), code);
    },
    async restart(uri, setupCode) {
      const key = keyFor(uri);
      const previous = kernels.get(key);
      if (previous) previous.invalidate();
      const replacement = new AcceptanceKernel(key);
      kernels.set(key, replacement);
      if (setupCode) await executeForTesting(replacement, setupCode);
      return replacement.generation;
    },
    setDenied(value) {
      denied = Boolean(value);
    },
    denialCalls() {
      return denialCalls;
    },
    stats(uri) {
      const kernel = kernels.get(keyFor(uri));
      return kernel ? { generation: kernel.generation, executions: kernel.executions } : undefined;
    }
  }
};

exports.activate = function () { return api; };
exports.deactivate = function () {
  for (const kernel of kernels.values()) kernel.invalidate();
  kernels.clear();
};
`
  );
}

export async function runEditorAcceptancePhase({
  editor,
  workspace,
  userData,
  extensions,
  developmentPaths,
  testModule,
  python,
  phase,
  resultPath
}) {
  rmSync(resultPath, { force: true });
  const cdpPort =
    phase === "verify" || process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS ? await reservePort() : undefined;
  const sandboxArgs = process.platform === "linux" ? ["--no-sandbox", ...editorDisplayLaunchArgs()] : [];
  const sharedDataArgs = editor.sharedDataDir ? ["--shared-data-dir", resolve(userData, "shared-data")] : [];
  const child = spawn(
    editor.executable,
    [
      workspace,
      "--user-data-dir",
      userData,
      "--extensions-dir",
      extensions,
      ...sharedDataArgs,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      ...(editor.key === "cursor" ? ["--skip-onboarding"] : []),
      "--new-window",
      "--wait",
      ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
      ...developmentPaths.map((value) => `--extensionDevelopmentPath=${value}`),
      ...sandboxArgs
    ],
    {
      env: {
        ...process.env,
        OPEN_WRANGLER_EXTENSION_TESTS: "1",
        OPEN_WRANGLER_TEST_PHASE: phase,
        OPEN_WRANGLER_TEST_EDITOR: editor.key ?? editor.name.toLowerCase().replaceAll(" ", "-"),
        ...(cdpPort ? { OPEN_WRANGLER_EDITOR_CDP_PORT: String(cdpPort) } : {}),
        OPEN_WRANGLER_TEST_PYTHON: python,
        OPEN_WRANGLER_TEST_MODULE: testModule,
        OPEN_WRANGLER_TEST_RESULT: resultPath
      },
      encoding: "utf8",
      stdio: "inherit"
    }
  );

  const exit = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  let outcome;
  let acceptanceError;
  try {
    const deadline = Date.now() + 180_000;
    while (!existsSync(resultPath) && isRunning() && Date.now() < deadline) {
      await delay(100);
    }

    if (!existsSync(resultPath)) {
      throw new Error(`${editor.name} ${phase} acceptance exited without writing a result.`);
    }

    try {
      outcome = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${editor.name} ${phase} acceptance wrote an unreadable result: ${detail}`);
    }
    if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean") {
      throw new Error(`${editor.name} ${phase} acceptance wrote a malformed result payload.`);
    }
  } catch (error) {
    acceptanceError = error;
  }

  try {
    await terminateEditorChild(child, exit, isRunning);
  } catch (error) {
    acceptanceError = acceptanceError
      ? new AggregateError(
          [acceptanceError, error],
          `${editor.name} ${phase} acceptance failed and its editor process did not shut down cleanly.`
        )
      : error;
  }

  if (acceptanceError) throw acceptanceError;

  if (!outcome.ok) {
    throw new Error(`${editor.name} ${phase} acceptance failed:\n${outcome.error ?? "Unknown error"}`);
  }
}

async function terminateEditorChild(child, exit, isRunning) {
  if (await waitForChildExit(exit, 3_500)) return;

  if (isRunning()) child.kill("SIGTERM");
  if (await waitForChildExit(exit, 10_000)) return;

  if (isRunning()) child.kill("SIGKILL");
  if (await waitForChildExit(exit, 10_000)) return;

  throw new Error(`The spawned editor process ${child.pid ?? "(unknown pid)"} did not exit after SIGKILL.`);
}

async function waitForChildExit(exit, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (!port) rejectPort(new Error("Could not reserve an editor debugging port."));
        else resolvePort(port);
      });
    });
  });
}
