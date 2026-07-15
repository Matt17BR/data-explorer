import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function writeEditorAcceptanceHarness(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({
      name: "data-explorer-packaged-test-harness",
      displayName: "Data Explorer packaged test harness",
      version: "0.0.0",
      publisher: "data-explorer-tests",
      engines: { vscode: "^1.105.0" },
      main: "./extension.js",
      activationEvents: ["*"]
    })
  );
  writeFileSync(
    resolve(directory, "extension.js"),
    `const fs = require("node:fs");
const vscode = require("vscode");

exports.activate = async function () {
  let outcome;
  try {
    await require(process.env.DATA_EXPLORER_TEST_MODULE).run();
    outcome = { ok: true };
  } catch (error) {
    console.error(error);
    outcome = { ok: false, error: error instanceof Error ? error.stack || error.message : String(error) };
  }
  fs.writeFileSync(process.env.DATA_EXPLORER_TEST_RESULT, JSON.stringify(outcome));
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.quit"), 2_000);
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.closeWindow"), 500);
};
`
  );
}

export function writeFakeJupyterExtension(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({
      name: "jupyter",
      displayName: "Data Explorer stable Jupyter API acceptance double",
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
            exec(compile(code, "<data-explorer-kernel>", "exec"), namespace, namespace)
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
    this.process = undefined;
    this.pending = new Map();
    this.invalidated = false;
    this.executions = 0;
  }

  executeCode(code, token) {
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
    const executable = process.env.DATA_EXPLORER_TEST_PYTHON || "python3";
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
      return kernelFor(uri).executeCode(code);
    },
    async restart(uri, setupCode) {
      const key = keyFor(uri);
      const previous = kernels.get(key);
      if (previous) previous.invalidate();
      const replacement = new AcceptanceKernel(key);
      kernels.set(key, replacement);
      if (setupCode) await replacement.executeCode(setupCode);
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
  const cdpPort = process.env.DATA_EXPLORER_CAPTURE_EDITOR_SCREENSHOTS ? await reservePort() : undefined;
  const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
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
        DATA_EXPLORER_EXTENSION_TESTS: "1",
        DATA_EXPLORER_TEST_PHASE: phase,
        DATA_EXPLORER_TEST_EDITOR: editor.key ?? editor.name.toLowerCase().replaceAll(" ", "-"),
        ...(cdpPort ? { DATA_EXPLORER_EDITOR_CDP_PORT: String(cdpPort) } : {}),
        DATA_EXPLORER_TEST_PYTHON: python,
        DATA_EXPLORER_TEST_MODULE: testModule,
        DATA_EXPLORER_TEST_RESULT: resultPath
      },
      encoding: "utf8",
      stdio: "inherit"
    }
  );

  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 180_000;
  while (!existsSync(resultPath) && isRunning() && Date.now() < deadline) {
    await delay(100);
  }

  if (!existsSync(resultPath)) {
    if (isRunning()) child.kill("SIGTERM");
    throw new Error(`${editor.name} ${phase} acceptance exited without writing a result.`);
  }
  const outcome = JSON.parse(readFileSync(resultPath, "utf8"));

  const closedInApp = await Promise.race([exit.then(() => true), delay(3_500).then(() => false)]);
  if (!closedInApp && isRunning()) {
    child.kill("SIGTERM");
    const terminated = await Promise.race([exit.then(() => true), delay(10_000).then(() => false)]);
    if (!terminated && isRunning()) child.kill("SIGKILL");
  }

  if (!outcome.ok) {
    throw new Error(`${editor.name} ${phase} acceptance failed:\n${outcome.error ?? "Unknown error"}`);
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
