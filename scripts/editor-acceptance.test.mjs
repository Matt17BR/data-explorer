import assert from "node:assert/strict";
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { linkSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  acceptanceProgressCheckpoint,
  acceptanceProgressDetail,
  collectEditorAcceptancePrivateDiagnosticPaths,
  configureEditorAcceptanceTempRoot,
  createAcceptanceProgressEnvelope,
  createEditorAcceptanceEnvironment,
  createEditorAcceptanceEnvironmentForPlatform,
  createEditorAcceptanceFailure,
  describeEditorAcceptanceHarnessFailure,
  downloadEditorWithRetry,
  EDITOR_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  EDITOR_ACCEPTANCE_INACTIVITY_TIMEOUT_MS,
  EDITOR_ACCEPTANCE_PHASE_TIMEOUT_MS,
  EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES,
  EDITOR_ACCEPTANCE_RESULT_MAX_BYTES,
  EDITOR_COMMAND_OUTPUT_MAX_BYTES,
  EDITOR_HARNESS_ERROR_MAX_CHARACTERS,
  EDITOR_HARNESS_RESULT_MAX_BYTES,
  EditorAcceptanceFailure,
  editorDisplayLaunchArgs,
  editorAcceptanceProgressPath,
  editorAcceptanceProgressSignalPath,
  editorProcessTreeMayBeLive,
  editorProcessGroupRunning,
  prepareWindowsEditorProcessSupervisor,
  readBoundedAcceptanceText,
  readXvfbDisplayNumber,
  reserveEditorDebugPort,
  resolveDownloadedEditorCliPath,
  resolveEditorCliLaunch,
  runBoundedEditorCommand,
  runBoundedEditorCliCommand,
  serializeEditorAcceptanceHarnessOutcome,
  spawnOwnedEditorProcess,
  runEditorAcceptancePhase,
  sanitizeEditorAcceptanceDiagnostic,
  signalPosixEditorTree,
  startIsolatedEditorDisplay,
  validateEditorAcceptancePrivatePathOverrides,
  waitForEditorAcceptanceObservation,
  writeEditorAcceptanceHarness,
  writeAcceptanceProgress
} from "./editor-acceptance.mjs";

const PROGRESS_RUN_ID = "8be8c321-d21d-4de8-a890-13d18844a3c7";
const progressEnvelope = (phase, checkpoint, runId = PROGRESS_RUN_ID) =>
  createAcceptanceProgressEnvelope(runId, phase, checkpoint);

test("private diagnostic paths include hosted Python and external editor helpers", () => {
  const previousPythonLocation = process.env.pythonLocation;
  const previousXvfb = process.env.OPEN_WRANGLER_XVFB_EXECUTABLE;
  const pythonLocation = resolve(tmpdir(), "private-python-location");
  const xvfb = resolve(tmpdir(), "private-xvfb");
  try {
    process.env.pythonLocation = pythonLocation;
    process.env.OPEN_WRANGLER_XVFB_EXECUTABLE = xvfb;
    const paths = collectEditorAcceptancePrivateDiagnosticPaths();
    assert.equal(paths.includes(pythonLocation), true);
    assert.equal(
      paths.includes(
        process.platform === "win32" ? resolve(pythonLocation, "python.exe") : resolve(pythonLocation, "bin", "python")
      ),
      true
    );
    assert.equal(paths.includes(xvfb), true);
  } finally {
    if (previousPythonLocation === undefined) delete process.env.pythonLocation;
    else process.env.pythonLocation = previousPythonLocation;
    if (previousXvfb === undefined) delete process.env.OPEN_WRANGLER_XVFB_EXECUTABLE;
    else process.env.OPEN_WRANGLER_XVFB_EXECUTABLE = previousXvfb;
  }
});

test("relative editor helper overrides fail before launch without echoing their value", () => {
  const previousXvfb = process.env.OPEN_WRANGLER_XVFB_EXECUTABLE;
  const sentinel = "RAW_RELATIVE_XVFB_SENTINEL/xvfb";
  try {
    process.env.OPEN_WRANGLER_XVFB_EXECUTABLE = sentinel;
    assert.throws(validateEditorAcceptancePrivatePathOverrides, (error) => {
      assert.match(error.message, /must be absolute paths/u);
      assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
      return true;
    });
  } finally {
    if (previousXvfb === undefined) delete process.env.OPEN_WRANGLER_XVFB_EXECUTABLE;
    else process.env.OPEN_WRANGLER_XVFB_EXECUTABLE = previousXvfb;
  }
});

test("D-Bus path and abstract transports cannot survive standalone diagnostics", () => {
  const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const sentinel = "RAW_ENCODED_DBUS_SENTINEL";
  try {
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=%2Ftmp%2F${sentinel}%2Fbus`;
    const paths = collectEditorAcceptancePrivateDiagnosticPaths();
    const decodedPath = `/tmp/${sentinel}/bus`;
    assert.equal(paths.includes(decodedPath), true);
    const pathDiagnostic = sanitizeEditorAcceptanceDiagnostic(
      new Error(`connect failed: unix:path=%2Ftmp%2F${sentinel}%2Fbus then ${decodedPath}`),
      paths
    );
    assert.doesNotMatch(pathDiagnostic, new RegExp(sentinel, "u"));

    const abstract = "RAW_ABSTRACT_DBUS_SENTINEL";
    const abstractDiagnostic = sanitizeEditorAcceptanceDiagnostic(
      new Error(`connect failed: unix:abstract=${abstract}`),
      paths
    );
    assert.doesNotMatch(abstractDiagnostic, new RegExp(abstract, "u"));
    assert.match(abstractDiagnostic, /unix:<redacted>/u);
  } finally {
    if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
  }
});

test("editor subprocesses inherit only an explicit platform and isolation allowlist", () => {
  const environment = createEditorAcceptanceEnvironment(
    {
      PATH: "/safe/bin",
      HOME: "/private/home",
      XDG_RUNTIME_DIR: "/private/runtime",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/editor-bus",
      XAUTHORITY: "/private/xauthority",
      GITHUB_PAT: "github-secret",
      GITHUB_TOKEN: "github-token",
      NODE_AUTH_TOKEN: "npm-secret",
      AWS_ACCESS_KEY_ID: "aws-access-id",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_CONFIG_FILE: "/private/aws-config",
      AWS_SHARED_CREDENTIALS_FILE: "/private/aws-credentials",
      AZURE_CONFIG_DIR: "/private/azure",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/google-credentials.json",
      KUBECONFIG: "/private/kubeconfig",
      NETRC: "/private/netrc",
      NPM_CONFIG_USERCONFIG: "/private/npmrc",
      PIP_CONFIG_FILE: "/private/pip.conf",
      GIT_ASKPASS: "/private/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "/private/helper",
      PYTHONPATH: "/private/python-hook",
      PYTHONHOME: "/private/python-home",
      PYTHONSTARTUP: "/private/python-startup.py",
      NODE_OPTIONS: "--require=/private/node-hook.cjs",
      NODE_PATH: "/private/node-modules",
      ELECTRON_RUN_AS_NODE: "1",
      LD_PRELOAD: "/private/preload.so",
      LD_LIBRARY_PATH: "/private/libraries",
      DYLD_INSERT_LIBRARIES: "/private/injected.dylib",
      BASH_ENV: "/private/bash-env",
      ENV: "/private/shell-env",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      CI_JOB_JWT: "gitlab-jwt",
      HTTPS_PROXY: "https://user:password@example.invalid",
      FTP_PROXY: "ftp://proxy.example.invalid",
      npm_config_proxy: "http://npm-proxy.example.invalid",
      NO_PROXY: "127.0.0.1",
      DATABASE_URL: "postgresql://database-user:database-password@example.invalid/app",
      AUTHORIZATION_HEADER: "Bearer opaque-value",
      PUBLIC_URL: "https://example.invalid/docs",
      OPEN_WRANGLER_TEST_MODULE: "/private/inherited-module.cjs",
      OPEN_WRANGLER_TEST_PYTHON: "/private/inherited-python"
    },
    {
      OPEN_WRANGLER_TEST_PHASE: "verify",
      OPEN_WRANGLER_TEST_PYTHON: undefined
    }
  );
  assert.deepEqual(environment, {
    PATH: "/safe/bin",
    HOME: "/private/home",
    XDG_RUNTIME_DIR: "/private/runtime",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/editor-bus",
    OPEN_WRANGLER_TEST_PHASE: "verify"
  });

  assert.throws(
    () => createEditorAcceptanceEnvironment({ PATH: "/bin" }, { GITHUB_PAT: "override-secret" }),
    /does not allow the "GITHUB_PAT" environment override/u
  );
  assert.throws(
    () => createEditorAcceptanceEnvironment({ PATH: "/bin" }, { PATH: "https://user:password@example.invalid" }),
    /rejected a credential-bearing value for "PATH"/u
  );
});

test("the evidence redactor is the complete credential gate for inherited and controlled values", () => {
  const credentialValues = [
    `ghp_${"a".repeat(24)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVuLXdyYW5nbGVyIn0.signature12345",
    "https://example.invalid/editor?sig=signed-environment-value",
    "PASSWORD=assigned-environment-secret",
    "-----BEGIN PRIVATE KEY-----\nprivate-environment-material",
    "Basic YTo=",
    "AWS_SECRET_ACCESS_KEY whitespace-environment-secret",
    "AZURE_DEVOPS_EXT_PAT=azure-devops-environment-secret",
    "MARKETPLACE_PAT marketplace-environment-secret",
    String.raw`--token\ttextual-tab-environment-secret`,
    "--token\nmultiline-environment-secret",
    "password\u001b[31m=ansi-environment-secret"
  ];

  for (const credentialValue of credentialValues) {
    assert.deepEqual(createEditorAcceptanceEnvironmentForPlatform({ PATH: credentialValue, LANG: "C" }, {}, "linux"), {
      LANG: "C"
    });
    assert.throws(
      () =>
        createEditorAcceptanceEnvironmentForPlatform(
          { PATH: "/safe/bin" },
          { OPEN_WRANGLER_TEST_PHASE: credentialValue },
          "linux"
        ),
      /rejected a credential-bearing value for "OPEN_WRANGLER_TEST_PHASE"/u
    );
  }
});

test("credential screening preserves normalization-only Windows filesystem values", () => {
  const windowsPath = "C:\\Program Files\\Microsoft Visual Studio\\Hostx64\\x64;C:\\tool\\x64\\bin";
  assert.deepEqual(
    createEditorAcceptanceEnvironmentForPlatform(
      {
        Path: windowsPath,
        UserProfile: "C:\\Users\\runner\\x64",
        SystemRoot: "C:\\Windows"
      },
      { open_wrangler_test_module: "C:\\tool\\x64\\acceptance.cjs" },
      "win32"
    ),
    {
      PATH: windowsPath,
      USERPROFILE: "C:\\Users\\runner\\x64",
      SYSTEMROOT: "C:\\Windows",
      OPEN_WRANGLER_TEST_MODULE: "C:\\tool\\x64\\acceptance.cjs"
    }
  );
});

test("POSIX environment matching is exact-case and cannot override private roots through inert aliases", () => {
  const environment = {
    PATH: "/trusted/bin",
    path: "/attacker/bin",
    HOME: "/private/home",
    home: "/escaped/home",
    TMPDIR: "/private/tmp",
    tmpdir: "/escaped/tmp",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/731/bus",
    dbus_session_bus_address: "unixexec:path=/bin/true"
  };
  assert.deepEqual(createEditorAcceptanceEnvironmentForPlatform(environment, {}, "linux"), {
    PATH: "/trusted/bin",
    HOME: "/private/home",
    TMPDIR: "/private/tmp",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/731/bus"
  });
  assert.deepEqual(createEditorAcceptanceEnvironmentForPlatform(environment, {}, "darwin"), {
    PATH: "/trusted/bin",
    HOME: "/private/home",
    TMPDIR: "/private/tmp",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/731/bus"
  });
});

test("Windows environment matching is case-insensitive but rejects ambiguous collisions", () => {
  assert.deepEqual(
    createEditorAcceptanceEnvironmentForPlatform(
      {
        Path: "C:\\safe",
        UserProfile: "C:\\private",
        SystemRoot: "C:\\Windows",
        HomeDrive: "Z:",
        HomePath: "\\escaped-home"
      },
      { open_wrangler_test_phase: "verify" },
      "win32"
    ),
    {
      PATH: "C:\\safe",
      USERPROFILE: "C:\\private",
      SYSTEMROOT: "C:\\Windows",
      OPEN_WRANGLER_TEST_PHASE: "verify"
    }
  );
  assert.throws(
    () => createEditorAcceptanceEnvironmentForPlatform({ PATH: "C:\\safe", Path: "C:\\evil" }, {}, "win32"),
    /colliding Windows inherited environment keys "PATH" and "Path"/u
  );
  assert.throws(
    () =>
      createEditorAcceptanceEnvironmentForPlatform(
        { PATH: "C:\\safe" },
        { OPEN_WRANGLER_TEST_PHASE: "seed", open_wrangler_test_phase: "verify" },
        "win32"
      ),
    /colliding Windows override environment keys/u
  );
});

test("only one local Unix D-Bus transport may reach an editor", () => {
  for (const address of [
    "unix:path=/run/user/731/bus",
    "unix:path=%2Frun%2Fuser%2F731%2Fbus",
    "unix:abstract=open-wrangler",
    "unix:path=/run/user/731/bus,guid=0123456789abcdef0123456789abcdef"
  ]) {
    assert.equal(
      createEditorAcceptanceEnvironmentForPlatform({ DBUS_SESSION_BUS_ADDRESS: address }, {}, "linux")
        .DBUS_SESSION_BUS_ADDRESS,
      address
    );
  }
  for (const address of [
    "unixexec:path=/bin/true",
    "tcp:host=127.0.0.1,port=731",
    "nonce-tcp:host=127.0.0.1,noncefile=/private/token",
    "unix:path=relative/bus",
    "unix:path=/run/user/731/bus;unixexec:path=/bin/true",
    "unix:path=/run/user/731/bus,tmpdir=/tmp"
  ]) {
    assert.throws(
      () => createEditorAcceptanceEnvironmentForPlatform({ DBUS_SESSION_BUS_ADDRESS: address }, {}, "linux"),
      /requires DBUS_SESSION_BUS_ADDRESS to name one local/u
    );
  }
});

test("editor runners keep profiles, runtimes, and subprocess temporaries under one private root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-private-temp-"));
  const root = join(directory, "ow");
  const environment = { HomeDrive: "Z:", HOMEPATH: "\\escaped-home" };
  try {
    assert.equal(configureEditorAcceptanceTempRoot(root, environment), root);
    assert.deepEqual(environment, {
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      OPEN_WRANGLER_EDITOR_TEMP_ROOT: root,
      TMPDIR: root,
      TMP: root,
      TEMP: root
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      for (const path of new Set([
        environment.HOME,
        environment.XDG_RUNTIME_DIR,
        environment.XDG_CONFIG_HOME,
        environment.XDG_CACHE_HOME,
        environment.XDG_DATA_HOME,
        environment.XDG_STATE_HOME
      ])) {
        assert.equal((await stat(path)).mode & 0o777, 0o700);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "bounded editor commands return capped output without a shell",
  { timeout: process.platform === "win32" ? 330_000 : 10_000 },
  async () => {
    let privateRoot;
    let removePrivateRoot = true;
    let environment = {};
    try {
      // A cold Windows PowerShell 5.1 Add-Type compilation can take tens of
      // seconds under CI antivirus scanning. Prepare it once under its own hard
      // bootstrap bound so this invocation's two-second deadline remains a real
      // command bound instead of killing the one-time compiler halfway through.
      if (process.platform === "win32") {
        environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
        const privateParent = join(tmpdir(), "ow");
        await mkdir(privateParent, { recursive: true, mode: 0o700 });
        privateRoot = await mkdtemp(join(privateParent, "x-"));
        configureEditorAcceptanceTempRoot(privateRoot, environment);
        await prepareWindowsEditorProcessSupervisor(environment, { platform: "win32" });
      }
      const result = await runBoundedEditorCommand(
        {
          executable: process.execPath,
          args: ["-e", 'process.stdout.write("version 1.2.3\\n"); process.stderr.write("diagnostic\\n")'],
          environment,
          label: "acceptance command"
        },
        { timeoutMs: 2_000 }
      );
      assert.equal(result.stdout, "version 1.2.3\n");
      assert.equal(result.stderr, "diagnostic\n");
      assert.equal(EDITOR_COMMAND_OUTPUT_MAX_BYTES, 1024 * 1024);
    } catch (error) {
      if (editorProcessTreeMayBeLive(error)) removePrivateRoot = false;
      throw error;
    } finally {
      if (privateRoot && removePrivateRoot) await rm(privateRoot, { recursive: true, force: true });
    }
  }
);

test("editor downloads run each retry through the bounded isolated helper protocol", async () => {
  const calls = [];
  const waits = [];
  const executablePath = resolve(".vscode-test", "downloaded-code");
  const result = await downloadEditorWithRetry("stable", 2, {
    attemptTimeoutMs: 20,
    environment: { HOME: "/private/home" },
    retryWait: async (milliseconds) => waits.push(milliseconds),
    async runCommand(command, options) {
      calls.push({ command, options });
      if (calls.length === 1) throw new Error("isolated attempt timed out and was terminated");
      return {
        stdout: `${JSON.stringify({ protocol: 1, ok: true, executablePath })}\n`,
        stderr: ""
      };
    }
  });
  assert.equal(result, executablePath);
  assert.equal(calls.length, 2);
  for (const { command, options } of calls) {
    assert.equal(command.executable, process.execPath);
    assert.match(command.args[0], /scripts[/\\]download-editor\.mjs$/u);
    assert.equal(command.args[1], "stable");
    assert.deepEqual(command.environment, { HOME: "/private/home" });
    assert.equal(options.timeoutMs, 20);
    assert.equal(options.maxOutputBytes, 64 * 1024);
    assert.equal(options.terminationGraceMs, 0);
  }
  assert.deepEqual(waits, [2_000]);
  assert.equal(EDITOR_DOWNLOAD_ATTEMPT_TIMEOUT_MS, 300_000);
});

test("editor download retries never publish signed helper URLs", async () => {
  const secret = "SIGNED-URL-SECRET-MUST-NOT-REACH-CONSOLE";
  const warnings = [];
  const originalWarn = console.warn;
  let rejection;
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    await assert.rejects(
      downloadEditorWithRetry("stable", 2, {
        retryWait: async () => undefined,
        async runCommand() {
          throw new Error(`download failed at https://example.invalid/editor?sig=${secret}`);
        }
      }),
      (error) => {
        rejection = error;
        return true;
      }
    );
  } finally {
    console.warn = originalWarn;
  }
  const published = `${warnings.join("\n")}\n${rejection?.message ?? ""}`;
  assert.equal(published.includes(secret), false);
  assert.match(published, /sig=<redacted>/u);
});

test("a timed-out isolated downloader cannot retain network-loop handles", async (context) => {
  if (process.platform === "win32") {
    context.skip("The executable process-group proof is POSIX-only; bounded Windows tree cleanup is tested by seam.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-download-bound-"));
  const helperPath = join(directory, "hanging-download.mjs");
  const pidPath = join(directory, "pid.txt");
  try {
    await writeFile(
      helperPath,
      `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "inherit" });\nwriteFileSync(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));\nsetInterval(() => undefined, 1000);\n`
    );
    await assert.rejects(
      downloadEditorWithRetry("stable", 1, {
        helperPath,
        attemptTimeoutMs: 150,
        environment: {}
      }),
      /timed out after 150 ms/u
    );
    const pids = JSON.parse(await readFile(pidPath, "utf8"));
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor download results are strictly bounded and validated before launch", async () => {
  const runWithOutput = (stdout) =>
    downloadEditorWithRetry("1.129.0", 1, {
      runCommand: async () => ({ stdout, stderr: "" })
    });
  await assert.rejects(runWithOutput("x".repeat(32 * 1024 + 1)), /oversized or non-text result/u);
  await assert.rejects(
    runWithOutput(`${JSON.stringify({ protocol: 1, ok: true, executablePath: "relative/editor" })}\n`),
    /invalid executable path/u
  );
  await assert.rejects(
    runWithOutput(`${JSON.stringify({ protocol: 1, ok: false, error: "download failed safely" })}\n`),
    /download failed safely/u
  );
  const successfulResult = `${JSON.stringify({ protocol: 1, ok: true, executablePath: resolve(".vscode-test", "downloaded-code") })}\n`;
  for (const version of ["insiders", "1.129.0"]) {
    let label;
    await downloadEditorWithRetry(version, 1, {
      async runCommand(command) {
        label = command.label;
        return { stdout: successfulResult, stderr: "" };
      }
    });
    assert.equal(label, "Editor download attempt 1/1");
  }
  for (const version of [
    "bad\nversion",
    "stable\n",
    "stable\u2028",
    "latest",
    "01.2.3",
    "1.2",
    "1.129.0-rc.1",
    "1.129.0+password-RAWVERSIONSECRET",
    "stable?sig=unsafe"
  ]) {
    await assert.rejects(
      downloadEditorWithRetry(version, 1),
      /must be "stable", "insiders", or a numeric major\.minor\.patch version/u
    );
  }
});

test("invalid editor versions cannot publish credential-shaped values to the console or command label", async () => {
  const sentinel = "OWVERSIONCREDENTIALSENTINEL";
  const credentialShapedVersion = `1.2.3+password-${sentinel}`;
  const messages = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  let commandRan = false;
  console.log = (...values) => messages.push(values.join(" "));
  console.warn = (...values) => messages.push(values.join(" "));
  console.error = (...values) => messages.push(values.join(" "));
  try {
    await assert.rejects(
      downloadEditorWithRetry(credentialShapedVersion, 1, {
        async runCommand() {
          commandRan = true;
          throw new Error("must not run");
        }
      }),
      /must be "stable", "insiders", or a numeric major\.minor\.patch version/u
    );
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  assert.equal(commandRan, false);
  const published = messages.join("\n");
  assert.equal(published.includes(sentinel), false);
  assert.equal(published.includes(credentialShapedVersion), false);
});

test("editor downloads never retry an attempt whose process tree was not released", async () => {
  let calls = 0;
  const treeFailure = new Error("tree still alive");
  treeFailure.details = { treeVerifiedStopped: false };
  const resourceFailure = new AggregateError([treeFailure], "resource cleanup failed");
  resourceFailure.code = "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED";
  await assert.rejects(
    downloadEditorWithRetry("stable", 3, {
      retryWait: async () => assert.fail("unsafe attempts must not reach the retry delay"),
      async runCommand() {
        calls += 1;
        throw resourceFailure;
      }
    }),
    (error) =>
      error.code === "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED" &&
      error.details?.treeVerifiedStopped === false &&
      editorProcessTreeMayBeLive(error) &&
      /resource cleanup failed/u.test(error.message)
  );
  assert.equal(calls, 1);
});

test("downloaded macOS editors use the official CLI resolver instead of the GUI binary", () => {
  const executable = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
  assert.equal(
    resolveDownloadedEditorCliPath(executable, "darwin"),
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  );
  assert.equal(resolveDownloadedEditorCliPath("C:\\VSCode\\Code.exe", "win32"), "C:\\VSCode\\bin\\code.cmd");
  assert.equal(
    resolveDownloadedEditorCliPath("C:\\VSCode Insiders\\Code - Insiders.exe", "win32"),
    "C:\\VSCode Insiders\\bin\\code-insiders.cmd"
  );
  assert.throws(
    () => resolveDownloadedEditorCliPath("C:\\VSCode\\renamed.exe", "win32"),
    /unsupported product filename/u
  );
});

function windowsEditorCliLayout({ canonicalEntryPoint, versionFolder } = {}) {
  const root = "C:\\Program Files\\Microsoft VS Code";
  const executable = `${root}\\Code.exe`;
  const cli = `${root}\\bin\\code.cmd`;
  const entryPoint = versionFolder
    ? `${root}\\${versionFolder}\\resources\\app\\out\\cli.js`
    : `${root}\\resources\\app\\out\\cli.js`;
  const knownFiles = new Set([executable, cli, entryPoint].map((value) => value.toLowerCase()));
  const knownDirectories = new Set(
    [root, ...(versionFolder ? [`${root}\\${versionFolder}`] : [])].map((value) => value.toLowerCase())
  );
  return {
    editor: { name: "VS Code", key: "vscode", executable, cli },
    entryPoint,
    lstatPath(path) {
      if (knownDirectories.has(path.toLowerCase())) {
        return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      }
      if (!knownFiles.has(path.toLowerCase())) {
        const error = new Error("missing synthetic editor path");
        error.code = "ENOENT";
        throw error;
      }
      return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
    },
    realpathPath(path) {
      if (path.toLowerCase() === entryPoint.toLowerCase() && canonicalEntryPoint) return canonicalEntryPoint;
      return path;
    },
    readInstallationEntries() {
      return versionFolder
        ? [
            {
              name: versionFolder,
              isDirectory: () => true,
              isSymbolicLink: () => false
            }
          ]
        : [];
    }
  };
}

test("Windows editor CLI launches use the verified cli.js entry point and an exact CLI-only environment", () => {
  const layout = windowsEditorCliLayout();
  const sourceEnvironment = {
    Path: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    Temp: "C:\\private\\tmp",
    ELECTRON_RUN_AS_NODE: "0",
    VSCODE_DEV: "C:\\untrusted-development-tree",
    GITHUB_TOKEN: "untrusted-token"
  };
  const launch = resolveEditorCliLaunch(layout.editor, sourceEnvironment, {
    platform: "win32",
    lstatPath: layout.lstatPath,
    realpathPath: layout.realpathPath,
    readInstallationEntries: layout.readInstallationEntries
  });
  assert.deepEqual(launch, {
    executable: layout.editor.executable,
    argsPrefix: [layout.entryPoint],
    environment: {
      PATH: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\private\\tmp",
      ELECTRON_RUN_AS_NODE: "1"
    }
  });
  assert.equal(sourceEnvironment.ELECTRON_RUN_AS_NODE, "0", "the caller's environment must remain immutable");
});

test("Windows editor CLI launch validation rejects wrappers and canonical entry points outside one installation", () => {
  const layout = windowsEditorCliLayout();
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        { ...layout.editor, executable: "relative\\Code.exe" },
        { SYSTEMROOT: "C:\\Windows" },
        { platform: "win32" }
      ),
    /must be one absolute, bounded path/u
  );
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        { ...layout.editor, cli: `${layout.editor.cli}\0escaped` },
        { SYSTEMROOT: "C:\\Windows" },
        { platform: "win32" }
      ),
    /must be one absolute, bounded path/u
  );
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        { ...layout.editor, cli: "C:\\other-product\\bin\\code.cmd" },
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath: layout.lstatPath,
          realpathPath: layout.realpathPath,
          readInstallationEntries: layout.readInstallationEntries
        }
      ),
    /direct child of its installation's bin directory/u
  );

  const escaped = windowsEditorCliLayout({ canonicalEntryPoint: "C:\\outside\\cli.js" });
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        escaped.editor,
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath: escaped.lstatPath,
          realpathPath: escaped.realpathPath,
          readInstallationEntries: escaped.readInstallationEntries
        }
      ),
    /escaped its verified installation root/u
  );

  assert.throws(
    () =>
      resolveEditorCliLaunch(
        layout.editor,
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath(path) {
            if (path.toLowerCase() === layout.entryPoint.toLowerCase()) {
              const error = new Error("missing CLI entry point");
              error.code = "ENOENT";
              throw error;
            }
            return layout.lstatPath(path);
          },
          realpathPath: layout.realpathPath,
          readInstallationEntries: layout.readInstallationEntries
        }
      ),
    /complete regular installation layout/u,
    "an installation without a CLI entry point must fail closed"
  );
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        layout.editor,
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath: layout.lstatPath,
          realpathPath: layout.realpathPath,
          readInstallationEntries: () => Array.from({ length: 4_097 }, () => ({ name: "ordinary-file" }))
        }
      ),
    /complete regular installation layout/u,
    "directory discovery must reject an oversized result before inspecting entries"
  );
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        layout.editor,
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath: layout.lstatPath,
          realpathPath: layout.realpathPath,
          readInstallationEntries: () => [{ name: "bdd88df003", isDirectory: () => true, isSymbolicLink: () => true }]
        }
      ),
    /complete regular installation layout/u,
    "a version-shaped symlink must fail closed"
  );
});

test("Windows editor CLI launch accepts exactly one verified legacy or 10-hex versioned entry point", () => {
  const versioned = windowsEditorCliLayout({ versionFolder: "bdd88df003" });
  const launch = resolveEditorCliLaunch(
    versioned.editor,
    { SYSTEMROOT: "C:\\Windows" },
    {
      platform: "win32",
      lstatPath: versioned.lstatPath,
      realpathPath: versioned.realpathPath,
      readInstallationEntries: versioned.readInstallationEntries
    }
  );
  assert.deepEqual(launch.argsPrefix, [versioned.entryPoint]);

  const legacy = windowsEditorCliLayout();
  const secondVersion = "39d5031f21";
  const secondEntry = `C:\\Program Files\\Microsoft VS Code\\${secondVersion}\\resources\\app\\out\\cli.js`;
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        legacy.editor,
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath(path) {
            if (path.toLowerCase() === `C:\\Program Files\\Microsoft VS Code\\${secondVersion}`.toLowerCase()) {
              return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
            }
            if (path.toLowerCase() === secondEntry.toLowerCase()) {
              return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
            }
            return legacy.lstatPath(path);
          },
          realpathPath: legacy.realpathPath,
          readInstallationEntries() {
            return [{ name: secondVersion, isDirectory: () => true, isSymbolicLink: () => false }];
          }
        }
      ),
    /complete regular installation layout/u,
    "simultaneous legacy and versioned entry points must fail closed"
  );

  const firstVersion = windowsEditorCliLayout({ versionFolder: "bdd88df003" });
  const otherVersion = "39d5031f21";
  const otherVersionRoot = `C:\\Program Files\\Microsoft VS Code\\${otherVersion}`;
  const otherVersionEntry = `${otherVersionRoot}\\resources\\app\\out\\cli.js`;
  assert.throws(
    () =>
      resolveEditorCliLaunch(
        firstVersion.editor,
        { SYSTEMROOT: "C:\\Windows" },
        {
          platform: "win32",
          lstatPath(path) {
            if (path.toLowerCase() === otherVersionRoot.toLowerCase()) {
              return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
            }
            if (path.toLowerCase() === otherVersionEntry.toLowerCase()) {
              return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
            }
            return firstVersion.lstatPath(path);
          },
          realpathPath: firstVersion.realpathPath,
          readInstallationEntries() {
            return [
              { name: "bdd88df003", isDirectory: () => true, isSymbolicLink: () => false },
              { name: otherVersion, isDirectory: () => true, isSymbolicLink: () => false }
            ];
          }
        }
      ),
    /complete regular installation layout/u,
    "two versioned entry points must fail closed"
  );
});

test("bounded Windows CLI commands prepend cli.js without invoking a command shell", async () => {
  const layout = windowsEditorCliLayout();
  const child = fakeCommandChild(17310);
  let invocation;
  const running = runBoundedEditorCliCommand(
    {
      editor: layout.editor,
      args: ["--version"],
      environment: { SystemRoot: "C:\\Windows", Temp: "C:\\private\\tmp", GITHUB_TOKEN: "untrusted-token" },
      label: "shell-free Windows CLI"
    },
    {
      platform: "win32",
      timeoutMs: 1_000,
      lstatPath: layout.lstatPath,
      realpathPath: layout.realpathPath,
      readInstallationEntries: layout.readInstallationEntries,
      spawnProcess(executable, args, options) {
        invocation = { executable, args, options };
        return child;
      },
      windowsTreeKill: async () => undefined
    }
  );
  child.stdout.write("1.129.0\n");
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  assert.deepEqual(await running, { stdout: "1.129.0\n", stderr: "" });
  assert.equal(invocation.executable, layout.editor.executable);
  assert.deepEqual(invocation.args, [layout.entryPoint, "--version"]);
  assert.equal(invocation.options.shell, undefined);
  assert.deepEqual(invocation.options.env, {
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\private\\tmp",
    ELECTRON_RUN_AS_NODE: "1"
  });
});

test("the Windows supervisor clock stays within the Windows PowerShell 5.1 compiler surface", async () => {
  const script = await readFile(new URL("./windows-job-supervisor.ps1", import.meta.url), "utf8");
  const source = /\$nativeSource = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(script)?.[1];
  assert.equal(typeof source, "string");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /\bEnvironment\.TickCount64\b/u);
  assert.match(code, /terminationStarted = unchecked\(\(uint\)Environment\.TickCount\)/u);
  assert.match(
    code,
    /unchecked\(\(uint\)Environment\.TickCount - terminationStarted\)\s*>\s*\(uint\)TerminationDeadlineMilliseconds/u
  );
});

test("the Windows supervisor is compiled once per private root and pinned before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-receipt-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  let compilerLaunches = 0;
  const spawnCompiler = (_executable, args) => {
    compilerLaunches += 1;
    const child = fakeCommandChild(17279);
    const outputIndex = args.indexOf("-CompileTo") + 1;
    assert.ok(outputIndex > 0);
    setImmediate(() => {
      writeFileSync(args[outputIndex], "compiled-supervisor", { encoding: "utf8" });
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  };
  try {
    const first = await prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      spawnProcess: spawnCompiler
    });
    const second = await prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      spawnProcess: () => assert.fail("a private root must compile its supervisor only once")
    });
    assert.equal(second, first);
    assert.equal(compilerLaunches, 1);

    renameSync(first.executable, `${first.executable}.original`);
    writeFileSync(first.executable, "replacement", { encoding: "utf8" });
    assert.throws(
      () =>
        spawnOwnedEditorProcess(
          process.execPath,
          ["--version"],
          { env: environment, stdio: ["ignore", "pipe", "pipe"] },
          {
            platform: "win32",
            supervisorReceipt: first,
            spawnProcess: () => assert.fail("a replaced supervisor must fail before spawn")
          }
        ),
      /changed before launch/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitized Windows setup commands compile their supervisor in the coordinator-owned root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-coordinator-root-"));
  const rootKey = "OPEN_WRANGLER_EDITOR_TEMP_ROOT";
  const previousRoot = process.env[rootKey];
  process.env[rootKey] = directory;
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  assert.equal(rootKey in environment, false);
  let compilerLaunches = 0;
  try {
    const receipt = await prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      spawnProcess(_executable, args) {
        compilerLaunches += 1;
        const child = fakeCommandChild(17285);
        const outputIndex = args.indexOf("-CompileTo") + 1;
        setImmediate(() => {
          writeFileSync(args[outputIndex], "compiled-supervisor", { encoding: "utf8" });
          child.exitCode = 0;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      }
    });
    assert.equal(receipt.buildRoot, resolve(directory));
    assert.equal(compilerLaunches, 1);
  } finally {
    if (previousRoot === undefined) delete process.env[rootKey];
    else process.env[rootKey] = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Windows supervisor root is permanently rejected after unverified compilation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-unsafe-root-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  let compilerLaunches = 0;
  let killed = false;
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 5,
        spawnProcess() {
          compilerLaunches += 1;
          const child = fakeCommandChild(17286);
          child.kill = () => {
            killed = true;
            child.signalCode = "SIGKILL";
            child.stdout.end();
            child.stderr.end();
            child.emit("exit", null, "SIGKILL");
            child.emit("close", null, "SIGKILL");
            return true;
          };
          return child;
        }
      }),
      (error) => editorProcessTreeMayBeLive(error)
    );
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        spawnProcess: () => assert.fail("an unsafe compilation root must never launch another compiler")
      }),
      /previously involved in an unverified process tree/u
    );
    assert.equal(killed, true);
    assert.equal(compilerLaunches, 1);
  } finally {
    // The fake child above synchronously proved its own close to this test. The
    // production runner correctly retains roots whenever that proof is absent.
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows editor commands use a strict Job Object supervisor and control lease", async () => {
  const child = fakeCommandChild(1728);
  child.stdin = new PassThrough();
  const frames = [];
  let buffered = "";
  let supervisorLaunch;
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const boundary = buffered.indexOf("\n");
      const frame = JSON.parse(buffered.slice(0, boundary));
      buffered = buffered.slice(boundary + 1);
      frames.push(frame);
      if (frame.command === "terminate") {
        child.stderr.write(`OPEN_WRANGLER_WINDOWS_JOB_EMPTY:${frames[0].attestationToken}\n`);
        child.exitCode = 143;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 143, null);
        child.emit("close", 143, null);
      }
    }
  });

  await assert.rejects(
    runBoundedEditorCommand(
      {
        executable: "C:\\Program Files\\Open Wrangler Test\\editor.exe",
        args: ["--version"],
        environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
        label: "owned Windows editor command"
      },
      {
        platform: "win32",
        timeoutMs: 10,
        terminationGraceMs: 50,
        killGraceMs: 50,
        spawnProcess(executable, args, options) {
          return spawnOwnedEditorProcess(
            executable,
            args,
            { ...options, cwd: "C:\\private\\workspace" },
            {
              platform: "win32",
              supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
              spawnProcess(supervisor, supervisorArgs, supervisorOptions) {
                supervisorLaunch = { supervisor, supervisorArgs, supervisorOptions };
                return child;
              }
            }
          );
        }
      }
    ),
    /timed out after 10 ms/u
  );

  assert.equal(
    supervisorLaunch.supervisor.replaceAll("/", "\\"),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.deepEqual(supervisorLaunch.supervisorArgs.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy"
  ]);
  assert.deepEqual(supervisorLaunch.supervisorOptions.stdio, ["pipe", "pipe", "pipe"]);
  assert.match(frames[0].attestationToken, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(frames, [
    {
      protocol: 1,
      command: "launch",
      executable: "C:\\Program Files\\Open Wrangler Test\\editor.exe",
      args: ["--version"],
      cwd: "C:\\private\\workspace",
      environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
      attestationToken: frames[0].attestationToken
    },
    { protocol: 1, command: "terminate" }
  ]);
});

test("Windows job attestation is removed before stderr accounting and return", async () => {
  let nextPid = 17281;
  const runWithLimit = (maxOutputBytes) => {
    const child = fakeCommandChild(nextPid++);
    child.stdin = new PassThrough();
    child.stdin.once("data", (chunk) => {
      const launch = JSON.parse(chunk.toString("utf8").trim());
      setImmediate(() => {
        const marker = Buffer.from(`OPEN_WRANGLER_WINDOWS_JOB_EMPTY:${launch.attestationToken}\n`, "ascii");
        child.stderr.write("target ");
        child.stderr.write(marker.subarray(0, 17));
        child.stderr.write(marker.subarray(17));
        child.stdout.end();
        child.stderr.end("stderr");
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
    });
    return runBoundedEditorCommand(
      {
        executable: "C:\\Program Files\\Open Wrangler Test\\editor.exe",
        environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
        label: "filtered Windows editor command"
      },
      {
        platform: "win32",
        maxOutputBytes,
        spawnProcess(executable, args, options) {
          return spawnOwnedEditorProcess(executable, args, options, {
            platform: "win32",
            supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
            spawnProcess: () => child
          });
        }
      }
    );
  };

  const result = await runWithLimit(Buffer.byteLength("target stderr"));
  assert.deepEqual(result, { stdout: "", stderr: "target stderr" });
  await assert.rejects(
    runWithLimit(Buffer.byteLength("target stderr") - 1),
    /exceeded its 12-byte combined output limit/u
  );
});

test("Windows-owned launches reject inherited or ignored stderr before spawning", () => {
  for (const stdio of ["inherit", "ignore", ["ignore", "pipe", "inherit"]]) {
    assert.throws(
      () =>
        spawnOwnedEditorProcess(
          "C:\\Program Files\\Open Wrangler Test\\editor.exe",
          [],
          {
            cwd: "C:\\private\\workspace",
            env: { SYSTEMROOT: "C:\\Windows" },
            stdio
          },
          {
            platform: "win32",
            supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
            spawnProcess: () => assert.fail("invalid stdio must fail before a supervisor can spawn")
          }
        ),
      /require.*piped stderr/iu
    );
  }
});

test("a Windows supervisor missing a protocol pipe is abandoned as an unverified tree", () => {
  for (const missing of ["stdin", "stderr"]) {
    const child = fakeCommandChild(missing === "stdin" ? 17283 : 17284);
    child.stdin = missing === "stdin" ? undefined : new PassThrough();
    if (missing === "stderr") child.stderr = undefined;
    let killed = false;
    child.kill = () => {
      killed = true;
      return true;
    };
    assert.throws(
      () =>
        spawnOwnedEditorProcess(
          "C:\\Program Files\\Open Wrangler Test\\editor.exe",
          [],
          {
            cwd: "C:\\private\\workspace",
            env: { SYSTEMROOT: "C:\\Windows" },
            stdio: ["ignore", "pipe", "pipe"]
          },
          {
            platform: "win32",
            supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
            spawnProcess: () => child
          }
        ),
      (error) =>
        Boolean(
          killed &&
          error &&
          typeof error === "object" &&
          error.details?.treeVerifiedStopped === false &&
          editorProcessTreeMayBeLive(error)
        )
    );
  }
});

test(
  "the real Windows supervisor compiles once, contains descendants, terminates, and rejects malformed frames",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const privateParent = join(tmpdir(), "ow");
    await mkdir(privateParent, { recursive: true, mode: 0o700 });
    const privateRoot = await mkdtemp(join(privateParent, "x-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(privateRoot, environment);
    let removePrivateRoot = true;
    try {
      const supervisorReceipt = await prepareWindowsEditorProcessSupervisor(environment, { platform: "win32" });
      const natural = await runBoundedEditorCommand(
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "const targetStartedAt = Date.now();",
              "process.stdout.write(JSON.stringify({ targetStartedAt }));",
              "process.stderr.write('native stderr');",
              "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { detached: true, stdio: 'ignore' }).unref();"
            ].join(" ")
          ],
          environment,
          label: "real Windows supervisor natural-exit smoke"
        },
        { platform: "win32", timeoutMs: 30_000 }
      );
      assert.equal(natural.stderr, "native stderr");
      const naturalEnvelope = JSON.parse(natural.stdout);
      assert.equal(Number.isSafeInteger(naturalEnvelope.targetStartedAt), true);
      assert.ok(
        Date.now() - naturalEnvelope.targetStartedAt >= 350,
        "the Job Object must remain owned until the descendant that started with the target exits"
      );

      let timeoutRejection;
      try {
        await runBoundedEditorCommand(
          {
            executable: process.execPath,
            args: [
              "-e",
              "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);"
            ],
            environment,
            label: "real Windows supervisor termination smoke"
          },
          {
            platform: "win32",
            timeoutMs: 2_000,
            terminationGraceMs: 5_000,
            killGraceMs: 5_000
          }
        );
      } catch (error) {
        timeoutRejection = error;
      }
      if (editorProcessTreeMayBeLive(timeoutRejection)) removePrivateRoot = false;
      assert.ok(timeoutRejection && typeof timeoutRejection === "object");
      assert.equal(
        "code" in timeoutRejection && timeoutRejection.code === "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED",
        false
      );
      assert.equal("message" in timeoutRejection && typeof timeoutRejection.message === "string", true);
      assert.match(timeoutRejection.message, /timed out after 2000 ms/u);

      const malformedProbe = await runBoundedEditorCommand(
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "const child = spawn(process.argv[1], [], { env: process.env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });",
              "let stderr = ''; let finished = false;",
              "const finish = (code, message) => { if (finished) return; finished = true; clearTimeout(timer); if (message) process.stderr.write(message); process.exitCode = code; };",
              "const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(3, 'inner supervisor timeout'); }, 15000);",
              "child.stderr.setEncoding('utf8');",
              "child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr, 'utf8') > 4096) { try { child.kill('SIGKILL'); } catch {} finish(4, 'inner supervisor output limit'); } });",
              "child.once('error', () => finish(5, 'inner supervisor spawn failure'));",
              "child.once('close', (code, signal) => { const normalized = stderr.replace(/\\r\\n/gu, '\\n'); if (code === 125 && signal === null && normalized === 'OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:protocol\\n') { process.stdout.write('malformed-frame-rejected'); finish(0); } else finish(6, 'inner supervisor protocol mismatch'); });",
              "child.stdin.end('{}\\n', 'utf8');"
            ].join(" "),
            supervisorReceipt.executable
          ],
          environment,
          label: "real Windows supervisor malformed-frame smoke"
        },
        { platform: "win32", timeoutMs: 30_000 }
      );
      assert.deepEqual(malformedProbe, { stdout: "malformed-frame-rejected", stderr: "" });

      renameSync(supervisorReceipt.executable, `${supervisorReceipt.executable}.original`);
      writeFileSync(supervisorReceipt.executable, "replacement", { encoding: "utf8" });
      assert.throws(
        () =>
          spawnOwnedEditorProcess(
            process.execPath,
            ["--version"],
            { env: environment, stdio: ["ignore", "pipe", "pipe"] },
            {
              platform: "win32",
              supervisorReceipt,
              spawnProcess: () => assert.fail("a replaced supervisor must fail before spawn")
            }
          ),
        /changed before launch/u
      );
    } catch (error) {
      if (editorProcessTreeMayBeLive(error)) removePrivateRoot = false;
      throw error;
    } finally {
      if (removePrivateRoot) await rm(privateRoot, { recursive: true, force: true });
    }
  }
);

test("a Windows supervisor exit without exactly one private job-empty attestation fails closed", async () => {
  for (const attestationCount of [0, 2]) {
    const child = fakeCommandChild(17280 + attestationCount);
    child.stdin = new PassThrough();
    let buffered = "";
    child.stdin.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      if (!buffered.includes("\n")) return;
      const launch = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
      setImmediate(() => {
        for (let index = 0; index < attestationCount; index += 1) {
          child.stderr.write(`OPEN_WRANGLER_WINDOWS_JOB_EMPTY:${launch.attestationToken}\n`);
        }
        child.stderr.end();
        child.stdout.end();
        child.exitCode = attestationCount === 0 ? 125 : 0;
        child.emit("exit", child.exitCode, null);
        child.emit("close", child.exitCode, null);
      });
    });

    await assert.rejects(
      runBoundedEditorCommand(
        {
          executable: "C:\\Program Files\\Open Wrangler Test\\editor.exe",
          environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
          label: "unattested Windows editor command"
        },
        {
          platform: "win32",
          timeoutMs: 100,
          spawnProcess(executable, args, options) {
            return spawnOwnedEditorProcess(executable, args, options, {
              platform: "win32",
              supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
              spawnProcess: () => child
            });
          }
        }
      ),
      (error) => {
        assert.equal(error.code, "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED");
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.match(error.message, /did not release all owned process resources/u);
        return true;
      }
    );
  }
});

test("a timed-out Windows job attestation can never become valid later", async () => {
  const child = fakeCommandChild(17282);
  child.stdin = new PassThrough();
  let launch;
  child.stdin.once("data", (chunk) => {
    launch = JSON.parse(chunk.toString("utf8").trim());
  });
  const ownedChild = spawnOwnedEditorProcess(
    "C:\\Program Files\\Open Wrangler Test\\editor.exe",
    [],
    {
      cwd: "C:\\private\\workspace",
      env: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
      stdio: ["ignore", "pipe", "pipe"]
    },
    {
      platform: "win32",
      supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
      spawnProcess: () => child
    }
  );
  const ownershipSymbol = Object.getOwnPropertySymbols(ownedChild).find(
    (symbol) => symbol.description === "openWranglerWindowsJobOwnership"
  );
  assert.ok(ownershipSymbol);
  const ownership = ownedChild[ownershipSymbol];
  await assert.rejects(ownership.verifyEmpty(5), /attestation exceeded 5 ms/u);
  assert.equal(ownership.verificationLost, true);

  child.stderr.write(`OPEN_WRANGLER_WINDOWS_JOB_EMPTY:${launch.attestationToken}\n`);
  child.stderr.end();
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(await ownership.verifyEmpty(100), false);
  child.stdin.destroy();
  child.stdout.destroy();
});

test("force-closing the Windows supervisor can never attest that its Job Object is empty", async () => {
  const child = fakeCommandChild(1729);
  child.stdin = new PassThrough();
  child.stdin.destroy();
  let forced = false;
  child.kill = () => {
    forced = true;
    child.signalCode = "SIGKILL";
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    return true;
  };

  await assert.rejects(
    runBoundedEditorCommand(
      {
        executable: "C:\\Program Files\\Open Wrangler Test\\editor.exe",
        environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
        label: "force-closed Windows editor command"
      },
      {
        platform: "win32",
        timeoutMs: 10,
        terminationGraceMs: 10,
        killGraceMs: 100,
        spawnProcess(executable, args, options) {
          return spawnOwnedEditorProcess(executable, args, options, {
            platform: "win32",
            supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
            spawnProcess: () => child
          });
        }
      }
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.code, "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED");
      assert.equal(editorProcessTreeMayBeLive(error), true);
      assert.match(error.message, /did not release all owned process resources/u);
      return true;
    }
  );
  assert.equal(forced, true);
  assert.equal(child.stdin.destroyed, true);
});

test("a second interruption permanently invalidates an in-flight Windows shutdown attestation", async () => {
  const child = fakeCommandChild(1730);
  child.stdin = new PassThrough();
  const signalSource = new EventEmitter();
  let forced = false;
  child.kill = () => {
    forced = true;
    child.signalCode = "SIGKILL";
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    return true;
  };
  const running = runBoundedEditorCommand(
    {
      executable: "C:\\Program Files\\Open Wrangler Test\\editor.exe",
      environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\private\\tmp" },
      label: "twice-interrupted Windows editor command"
    },
    {
      platform: "win32",
      timeoutMs: 1_000,
      terminationGraceMs: 200,
      killGraceMs: 200,
      signalSource,
      spawnProcess(executable, args, options) {
        return spawnOwnedEditorProcess(executable, args, options, {
          platform: "win32",
          supervisorPath: "C:\\repo\\scripts\\windows-job-supervisor.ps1",
          spawnProcess: () => child
        });
      }
    }
  );
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  signalSource.emit("SIGTERM");
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  signalSource.emit("SIGTERM");
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(editorProcessTreeMayBeLive(error), true);
    return true;
  });
  assert.equal(forced, true);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("bounded editor commands retain output emitted after exit and before stream close", async () => {
  const child = fakeCommandChild(1729);
  const cleanupCalls = [];
  const running = runBoundedEditorCommand(
    { executable: "editor.exe", environment: {}, label: "closing command" },
    {
      platform: "win32",
      spawnProcess: () => child,
      timeoutMs: 1_000,
      async windowsTreeKill(pid, force) {
        cleanupCalls.push([pid, force]);
      }
    }
  );
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.write("complete stdout");
  child.stderr.write("complete stderr");
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  assert.deepEqual(await running, { stdout: "complete stdout", stderr: "complete stderr" });
  assert.deepEqual(cleanupCalls, [[1729, false]]);
});

test("bounded editor commands retain many tiny chunks in fixed-size storage", async () => {
  const child = fakeCommandChild(1730);
  const running = runBoundedEditorCommand(
    { executable: "editor.exe", environment: {}, label: "chunked command" },
    {
      platform: "win32",
      spawnProcess: () => child,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      windowsTreeKill: async () => undefined
    }
  );
  for (let index = 0; index < 1_024; index += 1) child.stdout.write("x");
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  assert.equal((await running).stdout, "x".repeat(1_024));
});

test("a late child error cannot impersonate command process-tree exit", async () => {
  const child = fakeCommandChild(17309);
  const running = runBoundedEditorCommand(
    { executable: "editor.exe", environment: {}, label: "late-error editor command" },
    {
      platform: "win32",
      spawnProcess: () => child,
      timeoutMs: 20,
      terminationGraceMs: 50,
      async windowsTreeKill() {
        child.exitCode = 143;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 143, null);
        child.emit("close", 143, null);
      }
    }
  );
  child.emit("error", new Error("injected nonterminal command error"));
  await assert.rejects(running, /late-error editor command timed out after 20 ms/u);
});

test("bounded editor commands escalate past an ignored graceful termination", async (context) => {
  if (process.platform === "win32") {
    context.skip(
      "The executable process-group escalation check is POSIX-only; Windows uses the injected tree-termination seam."
    );
    return;
  }
  const startedAt = Date.now();
  await assert.rejects(
    runBoundedEditorCommand(
      {
        executable: process.execPath,
        args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => undefined, 1000)'],
        environment: {},
        label: "ignored termination command"
      },
      { timeoutMs: 100, terminationGraceMs: 100, killGraceMs: 2_000 }
    ),
    /ignored termination command timed out after 100 ms/u
  );
  assert.ok(Date.now() - startedAt < 3_000, "SIGKILL escalation must keep the native command deadline bounded.");
});

test("bounded editor commands terminate on output overflow without retaining excess bytes", async (context) => {
  if (process.platform === "win32") {
    context.skip("The executable output-overflow process-group check is POSIX-only.");
    return;
  }
  await assert.rejects(
    runBoundedEditorCommand(
      {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(4096)); setInterval(() => undefined, 1000)'],
        environment: {},
        label: "noisy command"
      },
      { timeoutMs: 2_000, maxOutputBytes: 64, terminationGraceMs: 50, killGraceMs: 2_000 }
    ),
    (error) => {
      assert.match(error.message, /exceeded its 64-byte combined output limit/u);
      assert.ok(error.message.length < 512);
      return true;
    }
  );
});

test("Windows command cleanup uses the injected tree-termination seam", async () => {
  const child = fakeCommandChild(1731);
  const taskkillCalls = [];
  await assert.rejects(
    runBoundedEditorCommand(
      { executable: "editor.exe", environment: {}, label: "Windows editor command" },
      {
        platform: "win32",
        spawnProcess: () => child,
        timeoutMs: 10,
        terminationGraceMs: 100,
        killGraceMs: 100,
        async windowsTreeKill(pid, force) {
          taskkillCalls.push([pid, force]);
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        }
      }
    ),
    /Windows editor command timed out after 10 ms/u
  );
  assert.deepEqual(taskkillCalls, [[1731, false]]);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("Windows command cleanup remains bounded when tree termination never settles", async () => {
  const child = fakeCommandChild(1732);
  const taskkillCalls = [];
  const startedAt = Date.now();
  await assert.rejects(
    runBoundedEditorCommand(
      { executable: "editor.exe", environment: {}, label: "stuck Windows editor command" },
      {
        platform: "win32",
        spawnProcess: () => child,
        timeoutMs: 10,
        terminationGraceMs: 10,
        killGraceMs: 10,
        windowsTreeKillTimeoutMs: 20,
        windowsTreeKill(_pid, force) {
          taskkillCalls.push(force);
          return new Promise(() => undefined);
        }
      }
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /did not release all owned process resources/u);
      assert.ok(error.errors[1] instanceof AggregateError);
      assert.equal(error.errors[1].errors.length, 2);
      assert.match(error.errors[1].errors[0].message, /cleanup exceeded 20 ms/u);
      assert.match(error.errors[1].errors[1].message, /cleanup exceeded 20 ms/u);
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(taskkillCalls, [false, true]);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("Windows cleanup fails closed when an exited root leaves tree ownership unverified", async () => {
  const child = fakeCommandChild(1734);
  const taskkillCalls = [];
  const running = runBoundedEditorCommand(
    { executable: "editor.exe", environment: {}, label: "exited Windows editor command" },
    {
      platform: "win32",
      spawnProcess: () => child,
      timeoutMs: 1_000,
      windowsTreeKillTimeoutMs: 50,
      async windowsTreeKill(_pid, force) {
        taskkillCalls.push(force);
        throw new Error(force ? "forced tree verification failed" : "graceful tree verification failed");
      }
    }
  );
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.code, "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED");
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.match(error.errors[0].message, /could not be verified as stopped/u);
    assert.match(error.errors[0].message, /graceful tree verification failed/u);
    assert.match(error.errors[0].message, /forced tree verification failed/u);
    return true;
  });
  assert.deepEqual(taskkillCalls, [false, true]);
});

test("Windows cleanup escalates to a forced tree kill after graceful cleanup fails", async () => {
  const child = fakeCommandChild(1735);
  const taskkillCalls = [];
  await assert.rejects(
    runBoundedEditorCommand(
      { executable: "editor.exe", environment: {}, label: "escalated Windows editor command" },
      {
        platform: "win32",
        spawnProcess: () => child,
        timeoutMs: 10,
        windowsTreeKillTimeoutMs: 100,
        async windowsTreeKill(_pid, force) {
          taskkillCalls.push(force);
          if (!force) throw new Error("graceful taskkill failed");
          child.signalCode = "SIGKILL";
          child.emit("exit", null, "SIGKILL");
          child.emit("close", null, "SIGKILL");
        }
      }
    ),
    /timed out after 10 ms/u
  );
  assert.deepEqual(taskkillCalls, [false, true]);
});

test("bounded setup commands stop on process interruption and remove signal listeners", async () => {
  const child = fakeCommandChild(1733);
  const signalSource = new EventEmitter();
  const taskkillCalls = [];
  const running = runBoundedEditorCommand(
    { executable: "editor.exe", environment: {}, label: "interruptible setup command" },
    {
      platform: "win32",
      spawnProcess: () => child,
      timeoutMs: 1_000,
      signalSource,
      async windowsTreeKill(pid, force) {
        taskkillCalls.push([pid, force]);
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      }
    }
  );
  signalSource.emit("SIGTERM");
  await assert.rejects(running, /was interrupted by SIGTERM/u);
  assert.deepEqual(taskkillCalls, [[1733, false]]);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("bounded editor commands include receipt validation and spawn in their timeout", async () => {
  const child = fakeCommandChild(17331);
  let clock = 0;
  const treeKillCalls = [];
  await assert.rejects(
    runBoundedEditorCommand(
      { executable: "editor.exe", environment: {}, label: "spawn-budget command" },
      {
        platform: "win32",
        timeoutMs: 100,
        now: () => clock,
        spawnProcess() {
          clock = 101;
          return child;
        },
        async windowsTreeKill(pid, force) {
          treeKillCalls.push([pid, force]);
          child.exitCode = 143;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 143, null);
          child.emit("close", 143, null);
        }
      }
    ),
    /timed out after 100 ms/u
  );
  assert.deepEqual(treeKillCalls, [[17331, false]]);
});

test("debugging-port reservation is bounded, releases its server, and retains phase context", async () => {
  const createStalledServer = () => {
    const server = new EventEmitter();
    server.listening = false;
    server.closeCalls = 0;
    server.abortObserved = false;
    server.unref = () => server;
    server.listen = (options) => {
      server.listening = true;
      options.signal.addEventListener(
        "abort",
        () => {
          server.abortObserved = true;
        },
        { once: true }
      );
      return server;
    };
    server.close = (callback) => {
      server.closeCalls += 1;
      server.listening = false;
      queueMicrotask(() => {
        server.emit("close");
        callback?.();
      });
      return server;
    };
    return server;
  };

  const directServer = createStalledServer();
  await assert.rejects(
    reserveEditorDebugPort(40, { createServerFactory: () => directServer }),
    (error) => error?.code === "EDITOR_ACCEPTANCE_DEADLINE"
  );
  assert.equal(directServer.abortObserved, true);
  assert.equal(directServer.closeCalls, 1);

  const closeRaceError = new Error("injected error while the port server was closing");
  const closeRaceServer = new EventEmitter();
  closeRaceServer.listening = false;
  closeRaceServer.unref = () => closeRaceServer;
  closeRaceServer.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 41733 });
  closeRaceServer.listen = (_options, callback) => {
    closeRaceServer.listening = true;
    queueMicrotask(callback);
    return closeRaceServer;
  };
  closeRaceServer.close = (callback) => {
    queueMicrotask(() => {
      closeRaceServer.emit("error", closeRaceError);
      closeRaceServer.listening = false;
      closeRaceServer.emit("close");
      callback?.();
    });
    return closeRaceServer;
  };
  await assert.rejects(reserveEditorDebugPort(1_000, { createServerFactory: () => closeRaceServer }), closeRaceError);

  const directory = await mkdtemp(join(tmpdir(), "openwrangler-port-reservation-"));
  const resultPath = join(directory, "result.json");
  let spawnCalls = 0;
  let clock = 0;
  let reservedBudget;
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "verify",
          resultPath,
          runId: PROGRESS_RUN_ID
        },
        {
          platform: "darwin",
          phaseTimeoutMs: 60,
          now: () => clock,
          reserveDebugPort(timeoutMs) {
            reservedBudget = timeoutMs;
            clock = 60;
            const error = new Error("injected debugging-port deadline");
            error.code = "EDITOR_ACCEPTANCE_DEADLINE";
            throw error;
          },
          spawnProcess() {
            spawnCalls += 1;
            return fakeEditorChild();
          }
        }
      ),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.timeoutKind === "phase" &&
        error.details.runId === PROGRESS_RUN_ID &&
        error.details.phase === "verify"
    );
    assert.equal(spawnCalls, 0);
    assert.ok(reservedBudget > 0 && reservedBudget <= 60);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phase inactivity includes work before observation starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-pre-observation-inactivity-"));
  const resultPath = join(directory, "result.json");
  const child = fakeStoppableCommandChild(17341);
  let clock = 0;
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "seed",
          resultPath,
          runId: PROGRESS_RUN_ID
        },
        {
          platform: "darwin",
          phaseTimeoutMs: 1_000,
          inactivityTimeoutMs: 100,
          gracefulExitMs: 0,
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds;
          },
          spawnProcess() {
            clock = 150;
            return child;
          }
        }
      ),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.timeoutKind === "inactivity" &&
        error.details.elapsedMs === 150
    );
    assert.equal(clock, 150, "observation must not grant a fresh inactivity interval after synchronous spawn work");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phases reject results first observed after the hard deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-post-deadline-result-"));
  const resultPath = join(directory, "result.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "seed",
    resultPath,
    runId: PROGRESS_RUN_ID
  };
  const runAt = async (spawnCompletedAt, pid) => {
    let clock = 0;
    const child = fakeStoppableCommandChild(pid);
    const running = runEditorAcceptancePhase(input, {
      platform: "darwin",
      phaseTimeoutMs: 1_000,
      inactivityTimeoutMs: 2_000,
      gracefulExitMs: 0,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      spawnProcess(_executable, _arguments, options) {
        clock = spawnCompletedAt;
        writeFileSync(resultPath, acceptanceResult(options.env, { ok: true }), "utf8");
        return child;
      }
    });
    return { running, clock: () => clock };
  };

  try {
    const beforeDeadline = await runAt(999, 17342);
    await beforeDeadline.running;
    assert.equal(beforeDeadline.clock(), 999, "a result observed before the hard deadline must remain valid");

    const afterDeadline = await runAt(1_001, 17343);
    await assert.rejects(
      afterDeadline.running,
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.timeoutKind === "phase" &&
        error.details.elapsedMs === 1_001
    );
    assert.equal(afterDeadline.clock(), 1_001);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phases reject results first observed after inactivity unless a new checkpoint resets it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-post-inactivity-result-"));
  const resultPath = join(directory, "result.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "seed",
    resultPath,
    runId: PROGRESS_RUN_ID
  };
  const runAt = async (spawnCompletedAt, pid, checkpoint) => {
    let clock = 0;
    const child = fakeStoppableCommandChild(pid);
    const running = runEditorAcceptancePhase(input, {
      platform: "darwin",
      phaseTimeoutMs: 1_000,
      inactivityTimeoutMs: 100,
      gracefulExitMs: 0,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      spawnProcess(_executable, _arguments, options) {
        clock = spawnCompletedAt;
        if (checkpoint) {
          writeAcceptanceProgress(options.env.OPEN_WRANGLER_TEST_PROGRESS, progressEnvelope("seed", checkpoint));
        }
        writeFileSync(resultPath, acceptanceResult(options.env, { ok: true }), "utf8");
        return child;
      }
    });
    return { running, clock: () => clock };
  };

  try {
    const beforeInactivity = await runAt(99, 17344);
    await beforeInactivity.running;
    assert.equal(beforeInactivity.clock(), 99, "a completed result inside the inactivity budget must remain valid");

    const afterInactivity = await runAt(101, 17345);
    await assert.rejects(
      afterInactivity.running,
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.timeoutKind === "inactivity" &&
        error.details.elapsedMs === 101
    );
    assert.equal(afterInactivity.clock(), 101);

    const afterNewCheckpoint = await runAt(101, 17346, "seed:harness-start");
    await afterNewCheckpoint.running;
    assert.equal(
      afterNewCheckpoint.clock(),
      101,
      "a genuinely changed checkpoint observed after preparation must reset inactivity"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired phase deadlines override non-deadline debugging-port errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-late-port-error-"));
  const resultPath = join(directory, "result.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "verify",
    resultPath,
    runId: PROGRESS_RUN_ID
  };
  const cases = [
    { expectedKind: "phase", phaseTimeoutMs: 100, inactivityTimeoutMs: 1_000 },
    { expectedKind: "inactivity", phaseTimeoutMs: 1_000, inactivityTimeoutMs: 100 }
  ];

  try {
    for (const { expectedKind, phaseTimeoutMs, inactivityTimeoutMs } of cases) {
      let clock = 0;
      let spawnCalls = 0;
      const latePortError = new Error(`late ${expectedKind} port failure`);
      await assert.rejects(
        runEditorAcceptancePhase(input, {
          platform: "darwin",
          phaseTimeoutMs,
          inactivityTimeoutMs,
          now: () => clock,
          reserveDebugPort() {
            clock = 101;
            throw latePortError;
          },
          spawnProcess() {
            spawnCalls += 1;
            return fakeEditorChild();
          }
        }),
        (error) =>
          error instanceof EditorAcceptanceFailure &&
          error.kind === "outer-timeout" &&
          error.details.timeoutKind === expectedKind &&
          error.details.elapsedMs === 101 &&
          error.cause === latePortError
      );
      assert.equal(spawnCalls, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired phase deadlines override synchronous spawn errors and retain unverified-tree context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-late-spawn-error-"));
  const resultPath = join(directory, "result.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "seed",
    resultPath,
    runId: PROGRESS_RUN_ID
  };
  const cases = [
    { expectedKind: "phase", phaseTimeoutMs: 100, inactivityTimeoutMs: 1_000 },
    { expectedKind: "inactivity", phaseTimeoutMs: 1_000, inactivityTimeoutMs: 100 }
  ];

  try {
    for (const { expectedKind, phaseTimeoutMs, inactivityTimeoutMs } of cases) {
      let clock = 0;
      const lateSpawnError = new Error(`late ${expectedKind} spawn failure`);
      lateSpawnError.details = { treeVerifiedStopped: false };
      await assert.rejects(
        runEditorAcceptancePhase(input, {
          platform: "darwin",
          phaseTimeoutMs,
          inactivityTimeoutMs,
          now: () => clock,
          spawnProcess() {
            clock = 101;
            throw lateSpawnError;
          }
        }),
        (error) =>
          error instanceof EditorAcceptanceFailure &&
          error.kind === "outer-timeout" &&
          error.details.timeoutKind === expectedKind &&
          error.details.elapsedMs === 101 &&
          error.details.treeVerifiedStopped === false &&
          error.details.progress === null &&
          error.cause === lateSpawnError
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phases pass only runner-owned test values through the environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-phase-environment-"));
  const resultPath = join(directory, "result.json");
  const expectedModule = join(directory, "acceptance.js");
  const expectedPython = join(directory, "python");
  let launchedEnvironment;
  let launchedArguments;
  try {
    await runEditorAcceptancePhase(
      {
        editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
        workspace: directory,
        userData: join(directory, "user-data"),
        extensions: join(directory, "extensions"),
        developmentPaths: [directory],
        testModule: expectedModule,
        python: expectedPython,
        phase: "seed",
        resultPath
      },
      {
        platform: "darwin",
        environment: {
          PATH: "/safe/bin",
          HOME: "/private/home",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/editor-bus",
          OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS: join(directory, "screenshots"),
          OPEN_WRANGLER_TEST_MODULE: "/attacker/module.cjs",
          OPEN_WRANGLER_TEST_PYTHON: "/attacker/python",
          GITHUB_PAT: "github-secret",
          KUBECONFIG: "/attacker/kubeconfig",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.fsmonitor",
          GIT_CONFIG_VALUE_0: "/attacker/hook",
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: "--require=/attacker/hook.cjs",
          PYTHONPATH: "/attacker/python-hook",
          LD_PRELOAD: "/attacker/preload.so",
          SSH_AUTH_SOCK: "/attacker/agent.sock",
          HTTPS_PROXY: "https://user:password@example.invalid"
        },
        spawnProcess(_executable, arguments_, options) {
          launchedArguments = arguments_;
          launchedEnvironment = options.env;
          return fakeEditorChild({ code: 0, resultPath, result: acceptanceResult(options.env, { ok: true }) });
        }
      }
    );

    assert.match(launchedEnvironment.OPEN_WRANGLER_EDITOR_CDP_PORT, /^(?:[1-9][0-9]{0,4})$/u);
    for (const argument of [
      "--force-disable-user-env",
      "--disable-updates",
      "--disable-crash-reporter",
      "--disable-telemetry",
      "--use-inmemory-secretstorage",
      "--password-store=basic",
      "--skip-add-to-recently-opened"
    ]) {
      assert.equal(launchedArguments.includes(argument), true);
    }
    assert.equal(launchedArguments.includes("--no-sandbox"), false);
    delete launchedEnvironment.OPEN_WRANGLER_EDITOR_CDP_PORT;
    assert.deepEqual(launchedEnvironment, {
      PATH: "/safe/bin",
      HOME: "/private/home",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/editor-bus",
      OPEN_WRANGLER_EXTENSION_TESTS: "1",
      OPEN_WRANGLER_TEST_PHASE: "seed",
      OPEN_WRANGLER_TEST_EDITOR: "vscode",
      OPEN_WRANGLER_TEST_PYTHON: expectedPython,
      OPEN_WRANGLER_TEST_MODULE: expectedModule,
      OPEN_WRANGLER_TEST_RESULT: resultPath,
      OPEN_WRANGLER_TEST_PROGRESS: editorAcceptanceProgressPath(
        resultPath,
        launchedEnvironment.OPEN_WRANGLER_TEST_RUN_ID,
        "seed"
      ),
      OPEN_WRANGLER_TEST_RUN_ID: launchedEnvironment.OPEN_WRANGLER_TEST_RUN_ID,
      OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS: join(directory, "screenshots")
    });
    assert.match(launchedEnvironment.OPEN_WRANGLER_TEST_RUN_ID, /^[0-9a-f-]{36}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phases retain a bounded slow-editor allowance and report their last checkpoint", async () => {
  assert.equal(EDITOR_ACCEPTANCE_PHASE_TIMEOUT_MS, 300_000);
  assert.equal(EDITOR_ACCEPTANCE_INACTIVITY_TIMEOUT_MS, 180_000);
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-progress-"));
  const progressPath = join(directory, "result.progress");
  try {
    assert.equal(acceptanceProgressDetail(progressPath), "No acceptance checkpoint was recorded.");
    writeAcceptanceProgress(progressPath, progressEnvelope("verify", "verify:notebook-flows"));
    assert.equal(acceptanceProgressDetail(progressPath), "Last acceptance checkpoint: verify:notebook-flows.");
    assert.deepEqual(
      JSON.parse(await readFile(progressPath, "utf8")),
      progressEnvelope("verify", "verify:notebook-flows")
    );
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [
        "result.progress",
        editorAcceptanceProgressSignalPath(progressPath, PROGRESS_RUN_ID, "verify").slice(directory.length + 1)
      ].sort()
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acceptance checkpoint writes are bounded and ignore a predictable symlink trap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-progress-write-"));
  const progressPath = join(directory, "result.progress");
  const victimPath = join(directory, "victim.txt");
  const predictableTemporary = `${progressPath}.${process.pid}.tmp`;
  try {
    await writeFile(victimPath, "untouched\n");
    await symlink(victimPath, predictableTemporary);
    writeAcceptanceProgress(progressPath, progressEnvelope("verify", "verify:step"));
    assert.equal(await readFile(victimPath, "utf8"), "untouched\n");
    assert.deepEqual(JSON.parse(await readFile(progressPath, "utf8")), progressEnvelope("verify", "verify:step"));
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [
        "result.progress",
        editorAcceptanceProgressSignalPath(progressPath, PROGRESS_RUN_ID, "verify").slice(directory.length + 1),
        `result.progress.${process.pid}.tmp`,
        "victim.txt"
      ].sort()
    );

    assert.throws(
      () => writeAcceptanceProgress(progressPath, progressEnvelope("verify", "verify:first\nverify:second")),
      /non-empty single-line string/u
    );
    assert.throws(
      () => writeAcceptanceProgress(progressPath, progressEnvelope("verify", "x".repeat(1_024))),
      /at most 1024 UTF-8 bytes/u
    );
    assert.throws(
      () =>
        writeAcceptanceProgress(progressPath, {
          ...progressEnvelope("verify", "verify:extra"),
          extra: true
        }),
      /exactly protocol, runId, phase, and checkpoint/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("progress reads reject oversized, symlinked, and special files without blocking", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-progress-safety-"));
  const resultPath = join(directory, "result.json");
  const targetPath = join(directory, "target.txt");
  const progressPath = join(directory, "result.progress");
  const observe = () =>
    waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit: new Promise(() => undefined),
      isRunning: () => true
    });
  try {
    await writeFile(progressPath, "x".repeat(EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES + 1));
    await assert.rejects(observe(), /checkpoint exceeds its 1024-byte limit/u);
    assert.match(acceptanceProgressDetail(progressPath), /exceeds its 1024-byte limit/u);

    await rm(progressPath, { force: true });
    await writeFile(targetPath, "verify:unsafe-link\n");
    if (process.platform !== "win32") {
      await symlink(targetPath, progressPath);
      await assert.rejects(observe(), /regular file.*symbolic link/u);
      assert.match(acceptanceProgressDetail(progressPath), /regular file.*symbolic link/u);

      await rm(progressPath, { force: true });
      await link(targetPath, progressPath);
      await assert.rejects(observe(), /must not be hard-linked/u);
      assert.match(acceptanceProgressDetail(progressPath), /must not be hard-linked/u);

      await rm(progressPath, { force: true });
      execFileSync("mkfifo", [progressPath]);
      const startedAt = Date.now();
      await assert.rejects(observe(), /must be a regular file/u);
      assert.ok(Date.now() - startedAt < 1_000, "A FIFO checkpoint must fail without waiting for a writer.");
      assert.match(acceptanceProgressDetail(progressPath), /must be a regular file/u);
    } else {
      context.diagnostic("Symlink and FIFO progress coverage is POSIX-only.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("phase observation distinguishes inactivity, hard timeout, early exit, and result precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-observation-"));
  const resultPath = join(directory, "result.json");
  const progressPath = `${resultPath}.progress`;
  try {
    let clock = 0;
    const inactivity = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit: new Promise(() => undefined),
      isRunning: () => true,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      phaseTimeoutMs: 1_000,
      inactivityTimeoutMs: 300,
      pollIntervalMs: 100
    });
    assert.deepEqual(inactivity, { kind: "timeout", timeout: "inactivity", elapsedMs: 300 });

    clock = 0;
    let marker = 0;
    const hardTimeout = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit: new Promise(() => undefined),
      isRunning: () => true,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
        writeAcceptanceProgress(progressPath, progressEnvelope("verify", `verify:step-${marker++}`));
      },
      phaseTimeoutMs: 400,
      inactivityTimeoutMs: 250,
      pollIntervalMs: 100
    });
    assert.deepEqual(hardTimeout, { kind: "timeout", timeout: "phase", elapsedMs: 400 });

    await rm(progressPath, { force: true });
    clock = 25;
    const earlyExit = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit: Promise.resolve({ code: 17, signal: null }),
      isRunning: () => false,
      now: () => clock
    });
    assert.deepEqual(earlyExit, {
      kind: "exit",
      exitState: { code: 17, signal: null },
      elapsedMs: 0
    });

    await writeFile(resultPath, JSON.stringify({ ok: false, error: "explicit failure" }));
    const resultWinsExitRace = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit: Promise.resolve({ code: 1, signal: null }),
      isRunning: () => false,
      now: () => clock
    });
    assert.equal(resultWinsExitRace.kind, "result");
    assert.equal(resultWinsExitRace.elapsedMs, 0);
    assert.equal(resultWinsExitRace.resultSnapshot.isFile(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mis-correlated checkpoints never refresh phase inactivity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-progress-correlation-"));
  const resultPath = join(directory, "result.json");
  const progressPath = editorAcceptanceProgressPath(resultPath, PROGRESS_RUN_ID, "verify");
  const otherRunId = "de305d54-75b4-431b-adb2-eb6b9e546014";
  try {
    let clock = 0;
    let writes = 0;
    const observation = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      runId: PROGRESS_RUN_ID,
      phase: "verify",
      exit: new Promise(() => undefined),
      isRunning: () => true,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
        const envelope =
          writes++ % 2 === 0
            ? progressEnvelope("verify", `verify:wrong-run-${writes}`, otherRunId)
            : progressEnvelope("seed", `seed:wrong-phase-${writes}`);
        writeAcceptanceProgress(progressPath, envelope);
      },
      phaseTimeoutMs: 1_000,
      inactivityTimeoutMs: 300,
      pollIntervalMs: 100
    });
    assert.deepEqual(observation, { kind: "timeout", timeout: "inactivity", elapsedMs: 300 });
    assert.equal(
      acceptanceProgressDetail(progressPath, { expectedRunId: PROGRESS_RUN_ID, expectedPhase: "verify" }),
      "No acceptance checkpoint matched the launched run and phase."
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows metadata-only heartbeats ignore mis-correlated envelope writers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-windows-progress-correlation-"));
  const resultPath = join(directory, "result.json");
  const progressPath = editorAcceptanceProgressPath(resultPath, PROGRESS_RUN_ID, "seed");
  const otherRunId = "de305d54-75b4-431b-adb2-eb6b9e546014";
  const child = fakeCommandChild(27401);
  let clock = 0;
  let writes = 0;
  try {
    const running = runEditorAcceptancePhase(
      {
        editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
        workspace: directory,
        userData: join(directory, "user-data"),
        extensions: join(directory, "extensions"),
        developmentPaths: [directory],
        testModule: join(directory, "tests.js"),
        python: "python3",
        phase: "seed",
        resultPath,
        runId: PROGRESS_RUN_ID,
        progressPath
      },
      {
        platform: "win32",
        spawnProcess: () => child,
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
          const envelope =
            writes++ % 2 === 0
              ? progressEnvelope("seed", `seed:wrong-run-${writes}`, otherRunId)
              : progressEnvelope("verify", `verify:wrong-phase-${writes}`);
          writeAcceptanceProgress(progressPath, envelope);
        },
        phaseTimeoutMs: 1_000,
        inactivityTimeoutMs: 300,
        gracefulExitMs: 0,
        windowsTreeKill() {
          child.exitCode = 143;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 143, null);
          child.emit("close", 143, null);
        }
      }
    );

    await assert.rejects(
      running,
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.timeoutKind === "inactivity"
    );
    assert.equal(clock, 300);
    assert.ok(writes > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed result takes precedence over an unsafe stale checkpoint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-result-precedence-"));
  const resultPath = join(directory, "result.json");
  const progressPath = `${resultPath}.progress`;
  try {
    await writeFile(resultPath, JSON.stringify({ ok: true }));
    await writeFile(progressPath, "x".repeat(EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES + 1));
    const oversizedCheckpointResult = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit: Promise.resolve({ code: 17, signal: null }),
      isRunning: () => false
    });
    assert.equal(oversizedCheckpointResult.kind, "result");
    assert.equal(oversizedCheckpointResult.elapsedMs, 0);
    assert.equal(oversizedCheckpointResult.resultSnapshot.isFile(), true);

    if (process.platform !== "win32") {
      await rm(progressPath, { force: true });
      execFileSync("mkfifo", [progressPath]);
      const startedAt = Date.now();
      const fifoCheckpointResult = await waitForEditorAcceptanceObservation({
        resultPath,
        progressPath,
        exit: Promise.resolve({ code: 0, signal: null }),
        isRunning: () => false
      });
      assert.equal(fifoCheckpointResult.kind, "result");
      assert.equal(fifoCheckpointResult.elapsedMs, 0);
      assert.equal(fifoCheckpointResult.resultSnapshot.isFile(), true);
      assert.ok(Date.now() - startedAt < 1_000, "A completed result must not open a stale FIFO checkpoint.");
    } else {
      context.diagnostic("FIFO result precedence coverage is POSIX-only.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acceptance failures publish complete structured diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-failure-"));
  const resultPath = join(directory, "result.json");
  const progressPath = `${resultPath}.progress`;
  try {
    writeAcceptanceProgress(progressPath, progressEnvelope("verify", "verify:notebook:pandas-duplicates"));
    const failure = createEditorAcceptanceFailure("outer-timeout", "Cursor verify acceptance timed out.", {
      editor: { name: "Cursor", key: "cursor", version: "3.11.19" },
      phase: "verify",
      elapsedMs: 180_001,
      resultPath,
      progressPath,
      exitState: { code: null, signal: "SIGTERM" },
      timeoutKind: "inactivity"
    });
    assert.ok(failure instanceof EditorAcceptanceFailure);
    assert.equal(failure.kind, "outer-timeout");
    assert.deepEqual(failure.details, {
      kind: "outer-timeout",
      editor: "Cursor",
      editorKey: "cursor",
      editorVersion: "3.11.19",
      phase: "verify",
      elapsedMs: 180_001,
      exitCode: null,
      signal: "SIGTERM",
      timeoutKind: "inactivity",
      resultPath,
      progressPath,
      runId: null,
      progress: "verify:notebook:pandas-duplicates"
    });
    assert.match(failure.message, /Editor: Cursor 3\.11\.19 \(cursor\)\./u);
    assert.match(failure.message, /Elapsed: 180001 ms\./u);
    assert.match(failure.message, /Exit: code=none, signal=SIGTERM\./u);
    assert.ok(failure.message.includes(`Result: ${resultPath}.`));
    assert.match(failure.message, /Last acceptance checkpoint: verify:notebook:pandas-duplicates\./u);

    writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:runner-spawn"));
    const earlyCursorContext = {
      editor: { name: "Cursor", key: "cursor", version: "3.12.29" },
      phase: "seed",
      elapsedMs: 93_421,
      resultPath,
      progressPath,
      platform: "linux",
      displayMode: "headless",
      exitState: { code: null, signal: "SIGABRT" }
    };
    const earlyCursorFailure = createEditorAcceptanceFailure(
      "premature-exit",
      "Cursor seed acceptance exited before writing a result.",
      earlyCursorContext
    );
    assert.match(earlyCursorFailure.message, /OPEN_WRANGLER_EDITOR_DISPLAY=xvfb/u);
    assert.match(earlyCursorFailure.details.remediation, /isolated and invisible/u);
    assert.doesNotMatch(earlyCursorFailure.details.remediation, /OPEN_WRANGLER_EDITOR_DISPLAY=current/u);
    assert.equal(earlyCursorFailure.details.remediation.includes(directory), false);

    const noRemediation = (overrides) =>
      createEditorAcceptanceFailure("premature-exit", "Editor exited before writing a result.", {
        ...earlyCursorContext,
        ...overrides
      }).details.remediation;
    assert.equal(noRemediation({ editor: { name: "VS Code", key: "vscode", version: "1.129.0" } }), undefined);
    assert.equal(noRemediation({ displayMode: "xvfb" }), undefined);
    assert.equal(noRemediation({ platform: "darwin" }), undefined);
    assert.equal(noRemediation({ exitState: { code: null, signal: "SIGTERM" } }), undefined);
    assert.equal(noRemediation({ readProgress: false }), undefined);
    assert.equal(noRemediation({ treeVerifiedStopped: false }), undefined);
    writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:harness-start"));
    assert.equal(noRemediation({}), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a synchronous editor spawn failure is not reported as an early exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-spawn-"));
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "missing-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "seed",
          resultPath: join(directory, "result.json")
        },
        {
          spawnProcess() {
            throw new Error("ENOENT acceptance executable");
          },
          now: () => 731
        }
      ),
      (error) => {
        assert.ok(error instanceof EditorAcceptanceFailure);
        assert.equal(error.kind, "spawn-failure");
        assert.equal(error.details.editorVersion, "1.129.0");
        assert.equal(error.details.exitCode, null);
        assert.match(error.message, /could not start: ENOENT acceptance executable/u);
        assert.match(error.message, /Last acceptance checkpoint: seed:runner-spawn\./u);
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a late child error cannot impersonate editor-phase exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-phase-late-error-"));
  const child = fakeCommandChild(27309);
  let clock = 0;
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  let markObservationWait;
  const observationWaiting = new Promise((resolve) => {
    markObservationWait = resolve;
  });
  let releaseObservationWait;
  const observationGate = new Promise((resolve) => {
    releaseObservationWait = resolve;
  });
  try {
    const running = runEditorAcceptancePhase(
      {
        editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
        workspace: directory,
        userData: join(directory, "user-data"),
        extensions: join(directory, "extensions"),
        developmentPaths: [directory],
        testModule: join(directory, "tests.js"),
        python: "python3",
        phase: "seed",
        resultPath: join(directory, "result.json")
      },
      {
        platform: "win32",
        spawnProcess: () => {
          markSpawned();
          return child;
        },
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
          markObservationWait();
          await observationGate;
        },
        phaseTimeoutMs: 20,
        inactivityTimeoutMs: 1_000,
        gracefulExitMs: 0,
        async windowsTreeKill() {
          child.exitCode = 143;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 143, null);
          child.emit("close", 143, null);
        }
      }
    );
    const rejection = assert.rejects(
      running,
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.timeoutKind === "phase"
    );
    await spawned;
    await observationWaiting;
    child.emit("error", new Error("injected nonterminal phase error"));
    releaseObservationWait();
    await rejection;
  } finally {
    releaseObservationWait?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phase failures distinguish emitted spawn errors, early exits, malformed results, and test failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-phase-results-"));
  const resultPath = join(directory, "result.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "seed",
    resultPath
  };
  try {
    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: () => fakeEditorChild({ error: new Error("emitted ENOENT") })
      }),
      (error) => error instanceof EditorAcceptanceFailure && error.kind === "spawn-failure"
    );

    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: () => fakeEditorChild({ code: 17 })
      }),
      (error) =>
        error instanceof EditorAcceptanceFailure && error.kind === "premature-exit" && error.details.exitCode === 17
    );

    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: () => fakeEditorChild({ code: 0, resultPath, result: "not-json" })
      }),
      (error) => error instanceof EditorAcceptanceFailure && error.kind === "result-protocol-failure"
    );

    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: (_executable, _arguments, options) =>
          fakeEditorChild({
            code: 0,
            resultPath,
            result: acceptanceResult(
              { ...options.env, OPEN_WRANGLER_TEST_RUN_ID: "00000000-0000-0000-0000-000000000000" },
              { ok: true }
            )
          })
      }),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "result-protocol-failure" &&
        /run ID does not match/u.test(error.message)
    );

    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: (_executable, _arguments, options) =>
          fakeEditorChild({
            code: 0,
            resultPath,
            result: acceptanceResult(options.env, { ok: true, unexpected: "field" })
          })
      }),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "result-protocol-failure" &&
        /missing or unexpected fields/u.test(error.message)
    );

    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: (_executable, _arguments, options) =>
          fakeEditorChild({
            code: 0,
            resultPath,
            result: acceptanceResult(options.env, { ok: false, error: "assertion failed" })
          })
      }),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "explicit-test-failure" &&
        /assertion failed/u.test(error.message)
    );

    const secretToken = `ghp_${"a".repeat(24)}`;
    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess: (_executable, _arguments, options) =>
          fakeEditorChild({
            code: 0,
            resultPath,
            result: acceptanceResult(options.env, {
              ok: false,
              error: `failed in ${process.cwd()} Authorization: Bearer ${secretToken} https://example.test/a?sig=signed-value`
            })
          })
      }),
      (error) => {
        assert.ok(error instanceof EditorAcceptanceFailure);
        assert.equal(error.kind, "explicit-test-failure");
        assert.doesNotMatch(error.message, new RegExp(secretToken, "u"));
        assert.doesNotMatch(error.message, /signed-value/u);
        assert.doesNotMatch(error.message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        assert.match(error.message, /<redacted/u);
        return true;
      }
    );

    await runEditorAcceptancePhase(input, {
      spawnProcess: (_executable, _arguments, options) =>
        fakeEditorChild({ code: 0, resultPath, result: acceptanceResult(options.env, { ok: true }) })
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phase output is captured, bounded, and redacted instead of inheriting the terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-phase-output-"));
  const resultPath = join(directory, "result.json");
  const secretToken = `ghp_${"b".repeat(24)}`;
  let launchedStdio;
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "verify",
          resultPath
        },
        {
          spawnProcess(_executable, _arguments, options) {
            launchedStdio = options.stdio;
            const child = fakeEditorChild({
              code: 0,
              resultPath,
              result: acceptanceResult(options.env, { ok: false, error: "deliberate phase failure" })
            });
            child.stderr.write(
              `Authorization: Bearer ${secretToken} https://example.test/a?sig=signed-output ${"x".repeat(2_000_000)}`
            );
            return child;
          }
        }
      ),
      (error) => {
        assert.ok(error instanceof EditorAcceptanceFailure);
        assert.equal(error.kind, "explicit-test-failure");
        assert.doesNotMatch(error.message, new RegExp(secretToken, "u"));
        assert.doesNotMatch(error.message, /signed-output/u);
        assert.doesNotMatch(error.message, /Authorization:/u);
        assert.match(error.message, /complete value exceeded the fixed safety limit/u);
        assert.ok(error.message.length < 40_000);
        assert.ok(error.details.editorOutput.length < 20_000);
        return true;
      }
    );
    assert.deepEqual(launchedStdio, ["ignore", "pipe", "pipe"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phase output remains captured through close before it can be retained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-phase-output-close-"));
  const resultPath = join(directory, "result.json");
  const secret = "OW_LATE_CLOSE_SECRET_731";
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "verify",
          resultPath
        },
        {
          spawnProcess(_executable, _arguments, options) {
            const child = fakeCommandChild(undefined);
            setImmediate(() => {
              child.stderr.write(`https://user:${secret}`);
              writeFileSync(
                resultPath,
                acceptanceResult(options.env, { ok: false, error: "deliberate close-boundary failure" })
              );
              child.exitCode = 0;
              child.emit("exit", 0, null);
              setTimeout(() => {
                child.stderr.end("@example.invalid");
                child.stdout.end();
                child.emit("close", 0, null);
              }, 10);
            });
            return child;
          }
        }
      ),
      (error) => {
        assert.ok(error instanceof EditorAcceptanceFailure);
        assert.equal(error.kind, "explicit-test-failure");
        assert.doesNotMatch(error.message, new RegExp(secret, "u"));
        assert.doesNotMatch(error.message, /https:\/\/user:/u);
        assert.match(error.message, /<redacted>/u);
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor phase output is omitted within a bound when close cannot be verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-phase-output-incomplete-"));
  const resultPath = join(directory, "result.json");
  const secret = "OW_UNCLOSED_SECRET_731";
  const startedAt = Date.now();
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "verify",
          resultPath
        },
        {
          outputCloseTimeoutMs: 20,
          spawnProcess(_executable, _arguments, options) {
            const child = fakeCommandChild(undefined);
            setImmediate(() => {
              child.stderr.write(`https://user:${secret}`);
              writeFileSync(
                resultPath,
                acceptanceResult(options.env, { ok: false, error: "deliberate unclosed-output failure" })
              );
              child.exitCode = 0;
              child.emit("exit", 0, null);
            });
            return child;
          }
        }
      ),
      (error) => {
        assert.equal(editorProcessTreeMayBeLive(error), true);
        const diagnostic = sanitizeEditorAcceptanceDiagnostic(error);
        assert.doesNotMatch(diagnostic, new RegExp(secret, "u"));
        assert.doesNotMatch(diagnostic, /https:\/\/user:/u);
        assert.match(diagnostic, /complete stream closure could not be verified/u);
        assert.match(diagnostic, /result was not opened/u);
        assert.match(diagnostic, /checkpoint content was not opened/u);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 1_000, "An unclosed output pipe must fail on its explicit short deadline.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone acceptance diagnostics are bounded, cycle-safe, and credential-redacted", () => {
  const secretToken = `ghp_${"c".repeat(24)}`;
  const nested = new Error(
    `failed in ${process.cwd()} Authorization: Bearer ${secretToken} https://example.test/a?sig=signed-diagnostic`
  );
  const aggregate = new AggregateError([nested], "standalone acceptance failed");
  aggregate.errors.push(aggregate);
  const diagnostic = sanitizeEditorAcceptanceDiagnostic(aggregate);
  assert.doesNotMatch(diagnostic, new RegExp(secretToken, "u"));
  assert.doesNotMatch(diagnostic, /signed-diagnostic/u);
  assert.doesNotMatch(diagnostic, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(diagnostic, /Authorization: <redacted>/u);
  assert.ok(diagnostic.length < 20_000);
});

test("standalone diagnostics retain replacements for host homes captured before isolation", () => {
  const originalHome = resolve("/home", "ORIGINAL_HOST_USER");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = resolve("/tmp", "isolated-home");
    process.env.USERPROFILE = resolve("/tmp", "isolated-user-profile");
    const diagnostic = sanitizeEditorAcceptanceDiagnostic(
      new Error(`failed at ${resolve(originalHome, "private", "file.txt")}`),
      [originalHome]
    );
    assert.doesNotMatch(diagnostic, /ORIGINAL_HOST_USER/u);
    assert.match(diagnostic, /<host-home>/u);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});

test("standalone diagnostics replace nested private paths before repository and home prefixes", () => {
  const repositoryPrivatePath = resolve(process.cwd(), "RAW_REPOSITORY_SUFFIX", "xvfb");
  const homePrivatePath = resolve(process.env.HOME ?? tmpdir(), "RAW_HOME_SUFFIX", "python");
  const diagnostic = sanitizeEditorAcceptanceDiagnostic(
    new Error(`spawn ${repositoryPrivatePath} ENOENT\nspawn ${homePrivatePath} EACCES`),
    [repositoryPrivatePath, homePrivatePath]
  );
  assert.doesNotMatch(diagnostic, /RAW_REPOSITORY_SUFFIX|RAW_HOME_SUFFIX/u);
  assert.doesNotMatch(diagnostic, /<repository>\//u);
  assert.doesNotMatch(diagnostic, /<host-home>\//u);
});

test("standalone diagnostics tolerate hostile AggregateError children without publishing thrown sentinels", () => {
  const sentinel = "OW_HOSTILE_AGGREGATE_SENTINEL";
  const cases = [];

  const throwingGetter = new AggregateError([], "throwing errors getter");
  Object.defineProperty(throwingGetter, "errors", {
    configurable: true,
    get() {
      throw new Error(sentinel);
    }
  });
  cases.push(throwingGetter);

  const nonArrayErrors = new AggregateError([], "non-array errors");
  nonArrayErrors.errors = {
    slice() {
      throw new Error(sentinel);
    },
    [Symbol.iterator]() {
      throw new Error(sentinel);
    },
    toString() {
      return sentinel;
    }
  };
  cases.push(nonArrayErrors);

  const hostileMethods = [new Error("safe nested failure")];
  Object.defineProperties(hostileMethods, {
    slice: {
      configurable: true,
      get() {
        throw new Error(sentinel);
      }
    },
    [Symbol.iterator]: {
      configurable: true,
      get() {
        throw new Error(sentinel);
      }
    }
  });
  const hostileMethodsAggregate = new AggregateError([], "hostile collection methods");
  hostileMethodsAggregate.errors = hostileMethods;
  cases.push(hostileMethodsAggregate);

  const hostileLengthAggregate = new AggregateError([], "hostile length");
  hostileLengthAggregate.errors = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") throw new Error(sentinel);
      return Reflect.get(target, property, receiver);
    }
  });
  cases.push(hostileLengthAggregate);

  const hostileIndexAggregate = new AggregateError([], "hostile index");
  hostileIndexAggregate.errors = new Proxy([new Error("unreachable")], {
    get(target, property, receiver) {
      if (property === "0") throw new Error(sentinel);
      return Reflect.get(target, property, receiver);
    }
  });
  cases.push(hostileIndexAggregate);

  for (const hostile of cases) {
    let diagnostic;
    assert.doesNotThrow(() => {
      diagnostic = sanitizeEditorAcceptanceDiagnostic(hostile);
    });
    assert.equal(typeof diagnostic, "string");
    assert.equal(diagnostic.includes(sentinel), false);
  }
  assert.match(sanitizeEditorAcceptanceDiagnostic(hostileMethodsAggregate), /safe nested failure/u);
});

test("oversized diagnostics discard unterminated credential structures instead of retaining a prefix", () => {
  const sentinel = "OW_UNREDACTED_SENTINEL_";
  const cases = [
    `https://user:${sentinel.repeat(1_000)}@example.invalid/path`,
    `https://example.invalid/download?sig=${sentinel.repeat(1_000)}`,
    `-----BEGIN PRIVATE KEY-----\n${sentinel.repeat(1_000)}`
  ];
  for (const payload of cases) {
    const described = describeEditorAcceptanceHarnessFailure(new Error(payload));
    assert.match(described, /complete value exceeded the fixed safety limit/u);
    assert.doesNotMatch(described, new RegExp(sentinel, "u"));

    const aggregate = new AggregateError([new Error(payload)], payload);
    const diagnostic = sanitizeEditorAcceptanceDiagnostic(aggregate);
    assert.match(diagnostic, /complete value exceeded the fixed safety limit/u);
    assert.doesNotMatch(diagnostic, new RegExp(sentinel, "u"));
    assert.doesNotMatch(diagnostic, /https:\/\/user:/u);
    assert.doesNotMatch(diagnostic, /BEGIN PRIVATE KEY/u);
  }
});

test("result reads reject oversized, symlinked, and FIFO payloads as protocol failures", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-result-safety-"));
  const resultPath = join(directory, "result.json");
  const targetPath = join(directory, "target.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "verify",
    resultPath
  };
  const expectProtocolFailure = async (createResult, message) => {
    const startedAt = Date.now();
    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess() {
          createResult();
          return fakeEditorChild({ code: 0 });
        }
      }),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "result-protocol-failure" &&
        message.test(error.message)
    );
    return Date.now() - startedAt;
  };
  try {
    await expectProtocolFailure(
      () => writeFileSync(resultPath, "x".repeat(EDITOR_ACCEPTANCE_RESULT_MAX_BYTES + 1)),
      /result exceeds its 1048576-byte limit/u
    );

    if (process.platform !== "win32") {
      await writeFile(targetPath, JSON.stringify({ ok: true }));
      await expectProtocolFailure(
        () => symlinkSync(targetPath, resultPath),
        /result must be a regular file.*symbolic link/u
      );
      await expectProtocolFailure(() => linkSync(targetPath, resultPath), /result must not be hard-linked/u);
      const fifoElapsedMs = await expectProtocolFailure(
        () => execFileSync("mkfifo", [resultPath]),
        /result must be a regular file/u
      );
      assert.ok(fifoElapsedMs < 1_000, "A FIFO result must fail without waiting for a writer.");
    } else {
      context.diagnostic("Symlink and FIFO result coverage is POSIX-only.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a result replacement during editor shutdown is rejected even when its envelope is valid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-result-replacement-"));
  const resultPath = join(directory, "result.json");
  const replacementPath = join(directory, "replacement.json");
  let cleanupCalls = 0;
  let child;
  try {
    await assert.rejects(
      runEditorAcceptancePhase(
        {
          editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
          workspace: directory,
          userData: join(directory, "user-data"),
          extensions: join(directory, "extensions"),
          developmentPaths: [directory],
          testModule: join(directory, "tests.js"),
          python: "python3",
          phase: "verify",
          resultPath
        },
        {
          platform: "win32",
          gracefulExitMs: 0,
          spawnProcess(_executable, _arguments, options) {
            writeFileSync(resultPath, acceptanceResult(options.env, { ok: true }));
            child = fakeCommandChild(2810);
            return child;
          },
          async windowsTreeKill(_pid, force) {
            cleanupCalls += 1;
            assert.equal(force, false);
            writeFileSync(
              replacementPath,
              acceptanceResult(
                {
                  OPEN_WRANGLER_TEST_RUN_ID: "00000000-0000-0000-0000-000000000000",
                  OPEN_WRANGLER_TEST_PHASE: "verify"
                },
                { ok: true }
              )
            );
            renameSync(replacementPath, resultPath);
            child.exitCode = 0;
            child.stdout.end();
            child.stderr.end();
            child.emit("exit", 0, null);
            child.emit("close", 0, null);
          }
        }
      ),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "result-protocol-failure" &&
        /path changed after it was first observed/u.test(error.message)
    );
    assert.equal(cleanupCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded phase reads reject metadata-visible same-inode mutation between path snapshot and open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-result-mutation-"));
  const resultPath = join(directory, "result.json");
  const initial = '{"ok":false}';
  const replacement = '{"ok":true }';
  try {
    await writeFile(resultPath, initial);
    const initialInode = statSync(resultPath).ino;
    assert.equal(initial.length, replacement.length);
    assert.throws(
      () =>
        readBoundedAcceptanceText(resultPath, EDITOR_ACCEPTANCE_RESULT_MAX_BYTES, "acceptance result", {
          afterInitialPathSnapshot() {
            writeFileSync(resultPath, replacement);
            if (process.platform === "win32") {
              const changed = new Date(Date.now() + 2_000);
              // NTFS timestamp updates can be coalesced for an immediate
              // same-size overwrite; force the mutation to remain observable.
              utimesSync(resultPath, changed, changed);
            }
            assert.equal(statSync(resultPath).ino, initialInode);
          }
        }),
      /changed before it could be read safely/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded phase reads reject final same-inode mutation and canonical path replacement", async (context) => {
  if (process.platform === "win32") {
    context.skip(
      "Open-descriptor mutation and rename semantics differ on Windows; initial/open coverage remains portable."
    );
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-result-final-snapshot-"));
  const resultPath = join(directory, "result.json");
  const displacedPath = join(directory, "displaced.json");
  const replacementPath = join(directory, "replacement.json");
  try {
    await writeFile(resultPath, '{"ok":true }');
    const inode = statSync(resultPath).ino;
    assert.throws(
      () =>
        readBoundedAcceptanceText(resultPath, EDITOR_ACCEPTANCE_RESULT_MAX_BYTES, "acceptance result", {
          beforeFinalPathSnapshot() {
            writeFileSync(resultPath, '{"ok":false}');
            assert.equal(statSync(resultPath).ino, inode);
          }
        }),
      /path changed while it was being read/u
    );

    await writeFile(resultPath, '{"ok":true}');
    await writeFile(replacementPath, '{"ok":false}');
    assert.throws(
      () =>
        readBoundedAcceptanceText(resultPath, EDITOR_ACCEPTANCE_RESULT_MAX_BYTES, "acceptance result", {
          beforeFinalPathSnapshot() {
            renameSync(resultPath, displacedPath);
            renameSync(replacementPath, resultPath);
          }
        }),
      /path changed while it was being read/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("progress reads retry verified atomic publication races without accepting in-place mutation", async (context) => {
  if (process.platform === "win32") {
    context.skip("Open-descriptor unlink semantics for the POSIX progress reader are not portable to Windows.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-progress-publication-race-"));
  const progressPath = join(directory, "result.json.progress");
  try {
    writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:one"));
    let replacedAfterSnapshot = false;
    assert.equal(
      acceptanceProgressCheckpoint(progressPath, {
        afterInitialPathSnapshot() {
          if (replacedAfterSnapshot) return;
          replacedAfterSnapshot = true;
          writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:next"));
        }
      }),
      "seed:next"
    );

    writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:one"));
    let replacedAfterOpen = false;
    assert.equal(
      acceptanceProgressCheckpoint(progressPath, {
        afterDescriptorOpen() {
          if (replacedAfterOpen) return;
          replacedAfterOpen = true;
          writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:next"));
        }
      }),
      "seed:next"
    );

    writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:one"));
    let replacedBeforeFinalPathCheck = false;
    assert.equal(
      acceptanceProgressCheckpoint(progressPath, {
        beforeFinalPathSnapshot() {
          if (replacedBeforeFinalPathCheck) return;
          replacedBeforeFinalPathCheck = true;
          writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:next"));
        }
      }),
      "seed:next"
    );

    writeAcceptanceProgress(progressPath, progressEnvelope("seed", "seed:one"));
    assert.throws(
      () =>
        acceptanceProgressCheckpoint(progressPath, {
          beforeFinalPathSnapshot() {
            writeFileSync(progressPath, "seed:two\n");
          }
        }),
      /changed while it was being read/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("result reads reject atomic replacement immediately after descriptor open", async (context) => {
  if (process.platform === "win32") {
    context.skip("Open-descriptor unlink semantics for the POSIX result reader are not portable to Windows.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-result-open-race-"));
  const resultPath = join(directory, "result.json");
  const replacementPath = join(directory, "replacement.json");
  try {
    await writeFile(resultPath, '{"ok":true}');
    await writeFile(replacementPath, '{"ok":false}');
    assert.throws(
      () =>
        readBoundedAcceptanceText(resultPath, EDITOR_ACCEPTANCE_RESULT_MAX_BYTES, "acceptance result", {
          afterDescriptorOpen() {
            renameSync(replacementPath, resultPath);
          }
        }),
      /must not be hard-linked/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live timed-out editor phase terminates its child and removes signal hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-live-timeout-"));
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "seed",
    resultPath: join(directory, "result.json")
  };
  const signalListeners = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM")
  };
  let child;
  try {
    await assert.rejects(
      runEditorAcceptancePhase(input, {
        spawnProcess() {
          child = spawnChild(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
            detached: process.platform !== "win32",
            stdio: "ignore"
          });
          return child;
        },
        phaseTimeoutMs: 150,
        inactivityTimeoutMs: 1_000,
        gracefulExitMs: 0,
        windowsTreeKill:
          process.platform === "win32"
            ? async () => {
                child.kill();
              }
            : undefined
      }),
      (error) =>
        error instanceof EditorAcceptanceFailure &&
        error.kind === "outer-timeout" &&
        error.details.editorVersion === "1.129.0" &&
        error.details.timeoutKind === "phase"
    );
    assert.ok(child);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    assert.equal(process.listenerCount("SIGINT"), signalListeners.SIGINT);
    assert.equal(process.listenerCount("SIGTERM"), signalListeners.SIGTERM);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor shutdown failures are explicit cleanup diagnostics with their originating phase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-shutdown-diagnostic-"));
  const resultPath = join(directory, "result.json");
  const input = {
    editor: { name: "VS Code", key: "vscode", version: "1.129.0", executable: "fake-editor" },
    workspace: directory,
    userData: join(directory, "user-data"),
    extensions: join(directory, "extensions"),
    developmentPaths: [directory],
    testModule: join(directory, "tests.js"),
    python: "python3",
    phase: "verify",
    resultPath
  };
  const shutdownError = new Error("injected ownership failure");
  const run = async (result) => {
    await assert.rejects(
      runEditorAcceptancePhase(input, {
        platform: "win32",
        spawnProcess() {
          writeFileSync(resultPath, JSON.stringify(result));
          return fakeCommandChild(2731);
        },
        gracefulExitMs: 0,
        async windowsTreeKill() {
          throw shutdownError;
        }
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.equal(error.errors[0].kind, "result-protocol-failure");
        assert.match(error.errors[0].message, /result was not opened/u);
        assert.equal(error.errors[0].details.treeVerifiedStopped, false);
        assert.equal(error.errors[0].details.progress, null);
        assert.match(error.errors[0].message, /checkpoint content was not opened/u);
        assert.equal(error.errors[1].kind, "cleanup-failure");
        assert.equal(error.errors[1].details.phase, "cleanup");
        assert.equal(error.errors[1].details.cleanupOfPhase, "verify");
        assert.equal(error.errors[1].details.treeVerifiedStopped, false);
        assert.match(error.errors[1].message, /injected ownership failure/u);
        return true;
      }
    );
  };
  try {
    await run({ ok: true });
    await run({ ok: false, error: "phase failed" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the generated harness records startup before loading the acceptance module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-harness-progress-"));
  try {
    writeEditorAcceptanceHarness(directory);
    const source = await readFile(join(directory, "extension.js"), "utf8");
    const harnessMarker = source.indexOf('recordProgress(runId, phase, phase + ":harness-start")');
    const moduleLoad = source.indexOf("require(process.env.OPEN_WRANGLER_TEST_MODULE).run()");
    assert.notEqual(harnessMarker, -1);
    assert.notEqual(moduleLoad, -1);
    assert.ok(harnessMarker < moduleLoad, "The harness marker must be durable before the test module is loaded.");
    assert.match(source, /const EDITOR_HARNESS_ERROR_MAX_CHARACTERS = 16000;/u);
    assert.match(source, /const EDITOR_HARNESS_RESULT_MAX_BYTES = 131072;/u);
    assert.match(source, /serializeEditorAcceptanceHarnessOutcome/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness failures and result serialization remain within their producer-side envelope", () => {
  const description = describeEditorAcceptanceHarnessFailure(new Error("x".repeat(2_000_000)));
  assert.ok(description.length <= EDITOR_HARNESS_ERROR_MAX_CHARACTERS + 32);
  assert.match(description, /complete value exceeded the fixed safety limit\.$/u);

  const envelope = { protocol: 1, runId: "8be8c321-d21d-4de8-a890-13d18844a3c7", phase: "verify" };
  const serialized = serializeEditorAcceptanceHarnessOutcome(
    { ...envelope, ok: false, error: "x".repeat(2_000_000) },
    envelope
  );
  assert.ok(Buffer.byteLength(serialized, "utf8") <= EDITOR_HARNESS_RESULT_MAX_BYTES);
  assert.deepEqual(JSON.parse(serialized), {
    ...envelope,
    ok: false,
    error: "Acceptance result could not be serialized within its bounded envelope."
  });
  const circular = {};
  circular.self = circular;
  assert.equal(serializeEditorAcceptanceHarnessOutcome(circular, envelope), serialized);
});

test("POSIX editor process-group probes include descendants and tolerate exited or permission-mixed trees", () => {
  const probes = [];
  assert.equal(
    editorProcessGroupRunning(731, (pid, signal) => {
      probes.push([pid, signal]);
    }),
    true
  );
  assert.deepEqual(probes, [[-731, 0]]);
  assert.equal(
    editorProcessGroupRunning(731, () => {
      const error = new Error("missing process group");
      error.code = "ESRCH";
      throw error;
    }),
    false
  );
  assert.equal(
    editorProcessGroupRunning(731, () => {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    }),
    true,
    "Darwin EPERM proves the process group still has at least one member"
  );
});

test("POSIX process-group permission failures fall back to the owned leader without weakening final verification", () => {
  const child = fakeCommandChild(739);
  const directSignals = [];
  child.kill = (signal) => {
    directSignals.push(signal);
    return true;
  };
  signalPosixEditorTree(
    child,
    () => true,
    true,
    "SIGTERM",
    (pid, signal) => {
      assert.deepEqual([pid, signal], [-739, "SIGTERM"]);
      const error = new Error("permission-mixed Darwin process group");
      error.code = "EPERM";
      throw error;
    }
  );
  assert.deepEqual(directSignals, ["SIGTERM"]);

  child.kill = () => false;
  assert.throws(
    () =>
      signalPosixEditorTree(
        child,
        () => true,
        true,
        "SIGKILL",
        () => {
          const error = new Error("permission-mixed Darwin process group");
          error.code = "EPERM";
          throw error;
        }
      ),
    { code: "EPERM" },
    "an unsignalled leader must leave ownership unverified"
  );
});

test("Linux editor acceptance defaults to an isolated zero-window platform", async () => {
  const environment = {
    DISPLAY: ":desktop",
    GDK_BACKEND: "wayland",
    HOME: "/desktop/home",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_CACHE_HOME: "/desktop/cache",
    XDG_CONFIG_HOME: "/desktop/config",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/desktop/bus",
    CURSOR_IPC_HOOK_CLI: "/desktop/cursor.sock",
    XDG_DATA_HOME: "/desktop/data",
    XDG_RUNTIME_DIR: "/desktop/runtime",
    XDG_SESSION_TYPE: "wayland",
    VSCODE_IPC_HOOK_CLI: "/desktop/code.sock"
  };

  const isolation = await startIsolatedEditorDisplay({ platform: "linux", environment });
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  try {
    assert.equal(isolation.mode, "headless");
    assert.equal(isolation.isolated, true);
    assert.equal(environment.DISPLAY, undefined);
    assert.equal(environment.WAYLAND_DISPLAY, undefined);
    assert.equal(environment.GDK_BACKEND, undefined);
    assert.equal(environment.XDG_SESSION_TYPE, "tty");
    assert.deepEqual(editorDisplayLaunchArgs("linux", environment), [
      "--ozone-platform=headless",
      "--disable-gpu",
      "--force-disable-user-env",
      "--disable-updates",
      "--disable-crash-reporter",
      "--disable-telemetry",
      "--use-inmemory-secretstorage",
      "--password-store=basic",
      "--skip-add-to-recently-opened"
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    }
    assert.equal(environment.USERPROFILE, environment.HOME);
    for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      const pathWithinRuntime = relative(runtimeDirectory, environment[key]);
      assert.notEqual(pathWithinRuntime, "");
      assert.equal(pathWithinRuntime.startsWith(".."), false);
      assert.equal(isAbsolute(pathWithinRuntime), false);
      if (process.platform !== "win32") {
        assert.equal((await stat(environment[key])).mode & 0o777, 0o700);
      }
    }
    assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, "unix:path=/desktop/bus");
    assert.equal(environment.CURSOR_IPC_HOOK_CLI, undefined);
    assert.equal(environment.VSCODE_IPC_HOOK_CLI, undefined);
  } finally {
    await isolation.stop();
    await isolation.stop();
  }

  await assert.rejects(stat(runtimeDirectory), { code: "ENOENT" });
  assert.deepEqual(environment, {
    DISPLAY: ":desktop",
    GDK_BACKEND: "wayland",
    HOME: "/desktop/home",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_CACHE_HOME: "/desktop/cache",
    XDG_CONFIG_HOME: "/desktop/config",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/desktop/bus",
    CURSOR_IPC_HOOK_CLI: "/desktop/cursor.sock",
    XDG_DATA_HOME: "/desktop/data",
    XDG_RUNTIME_DIR: "/desktop/runtime",
    XDG_SESSION_TYPE: "wayland",
    VSCODE_IPC_HOOK_CLI: "/desktop/code.sock"
  });
});

test("a current-desktop debug run must be requested explicitly", async () => {
  const environment = {
    DISPLAY: ":desktop",
    OPEN_WRANGLER_EDITOR_DISPLAY: "current",
    XDG_RUNTIME_DIR: "/desktop/runtime"
  };

  const isolation = await startIsolatedEditorDisplay({ platform: "linux", environment });
  assert.equal(isolation.mode, "current");
  assert.equal(isolation.isolated, false);
  assert.deepEqual(editorDisplayLaunchArgs("linux", environment), [
    "--force-disable-user-env",
    "--disable-updates",
    "--disable-crash-reporter",
    "--disable-telemetry",
    "--use-inmemory-secretstorage",
    "--password-store=basic",
    "--skip-add-to-recently-opened"
  ]);
  assert.deepEqual(editorDisplayLaunchArgs("darwin", environment), editorDisplayLaunchArgs("win32", environment));
  assert.equal(environment.DISPLAY, ":desktop");
  assert.equal(environment.XDG_RUNTIME_DIR, "/desktop/runtime");
  await isolation.stop();
});

test("headless cleanup can retry a failed environment restore", async () => {
  let restoreAttempts = 0;
  const isolation = await startIsolatedEditorDisplay({
    platform: "linux",
    environment: {},
    isolateRuntime() {
      return {
        restore() {
          restoreAttempts += 1;
          if (restoreAttempts === 1) throw new Error("injected restore failure");
        }
      };
    }
  });

  await assert.rejects(isolation.stop(), /injected restore failure/u);
  await isolation.stop();
  await isolation.stop();
  assert.equal(restoreAttempts, 2);
});

test("headless cleanup can restore environment state without touching inherited private files", async () => {
  const restoreOptions = [];
  const isolation = await startIsolatedEditorDisplay({
    platform: "linux",
    environment: {},
    isolateRuntime() {
      return {
        restore(options) {
          restoreOptions.push(options);
        }
      };
    }
  });

  await isolation.stop({ preservePrivateFiles: true });
  assert.deepEqual(restoreOptions, [{ removePrivateFiles: false }]);
  await isolation.stop();
  await isolation.stop();
  assert.deepEqual(restoreOptions, [{ removePrivateFiles: false }, { removePrivateFiles: true }]);
});

test("Xvfb setup failure after readiness still stops the display child", async () => {
  const child = fakeDisplayChild();
  let stopAttempts = 0;
  await assert.rejects(
    startIsolatedEditorDisplay({
      platform: "linux",
      environment: { OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb" },
      spawnProcess: () => child,
      readDisplayNumber: async () => 731,
      isolateRuntime() {
        throw new Error("injected runtime setup failure");
      },
      async stopProcess(observedChild) {
        assert.equal(observedChild, child);
        stopAttempts += 1;
      }
    }),
    /could not start its private Xvfb display: injected runtime setup failure/u
  );
  assert.equal(stopAttempts, 1);
});

test("a late Xvfb child error cannot impersonate process exit", async () => {
  const child = fakeDisplayChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGTERM") {
      setImmediate(() => child.emit("error", new Error("injected nonterminal child error")));
      setTimeout(() => {
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      }, 20);
    }
    return true;
  };
  const isolation = await startIsolatedEditorDisplay({
    platform: "linux",
    environment: { OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb" },
    spawnProcess: () => child,
    readDisplayNumber: async () => 731,
    isolateRuntime() {
      return { restore() {} };
    }
  });
  await isolation.stop();
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.listenerCount("error"), 0);
});

test("Xvfb display-number reads cap output and remove temporary listeners", async () => {
  const child = fakeDisplayChild();
  const displayOutput = new PassThrough();
  child.stdio[3] = displayOutput;
  const reading = readXvfbDisplayNumber(child, new Promise(() => undefined), 1_000);
  displayOutput.write("x".repeat(65));
  await assert.rejects(reading, /display-number output exceeded 64 UTF-8 bytes/u);
  assert.equal(displayOutput.listenerCount("data"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  displayOutput.destroy();
});

test("Xvfb exit diagnostics discard stderr that has not reached EOF", async () => {
  const child = fakeDisplayChild();
  const displayOutput = new PassThrough();
  child.stdio[3] = displayOutput;
  const sentinel = "OW_XVFB_UNREDACTED_SENTINEL_";
  const exit = new Promise((resolveExit) => setImmediate(() => resolveExit({ code: 1, signal: null })));
  const reading = readXvfbDisplayNumber(child, exit, 1_000);
  child.stderr.write(`https://user:${sentinel.repeat(1_000)}@example.invalid`);
  await assert.rejects(reading, (error) => {
    assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
    assert.doesNotMatch(error.message, /https:\/\/user:/u);
    assert.match(error.message, /complete stream contents were not available/u);
    return true;
  });
  displayOutput.destroy();
  child.stderr.destroy();
});

test("Xvfb timeout diagnostics discard stderr that has not reached EOF", async () => {
  const child = fakeDisplayChild();
  const displayOutput = new PassThrough();
  child.stdio[3] = displayOutput;
  const sentinel = "OW_XVFB_TIMEOUT_UNREDACTED_SENTINEL";
  const reading = readXvfbDisplayNumber(child, new Promise(() => undefined), 10);
  child.stderr.write(`https://user:${sentinel}`);
  await assert.rejects(reading, (error) => {
    assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
    assert.doesNotMatch(error.message, /https:\/\/user:/u);
    assert.match(error.message, /complete stream contents were not available/u);
    return true;
  });
  displayOutput.destroy();
  child.stderr.destroy();
});

test("the private Xvfb helper receives the same strict environment allowlist", async () => {
  const child = fakeDisplayChild();
  let launchedEnvironment;
  let launchedArguments;
  const isolation = await startIsolatedEditorDisplay({
    platform: "linux",
    environment: {
      OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
      OPEN_WRANGLER_XVFB_EXECUTABLE: "/private/xvfb",
      PATH: "/safe/bin",
      HOME: "/private/home",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/editor-bus",
      GITHUB_PAT: "github-secret",
      KUBECONFIG: "/private/kubeconfig",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "/private/helper",
      NODE_OPTIONS: "--require=/private/node-hook.cjs",
      PYTHONPATH: "/private/python-hook",
      LD_PRELOAD: "/private/preload.so",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      HTTPS_PROXY: "https://user:password@example.invalid"
    },
    spawnProcess(_executable, arguments_, options) {
      launchedArguments = arguments_;
      launchedEnvironment = options.env;
      return child;
    },
    readDisplayNumber: async () => 731,
    isolateRuntime() {
      return { restore() {} };
    },
    async stopProcess() {}
  });
  try {
    assert.deepEqual(launchedArguments, [
      "-displayfd",
      "3",
      "-screen",
      "0",
      "1920x1080x24",
      "-dpi",
      "96",
      "-nolisten",
      "tcp",
      "-noreset",
      "-extension",
      "GLX"
    ]);
    assert.deepEqual(launchedEnvironment, {
      PATH: "/safe/bin",
      HOME: "/private/home",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/editor-bus"
    });
  } finally {
    await isolation.stop();
  }
});

test("Xvfb cleanup attempts every step, aggregates failures, and retries only incomplete work", async () => {
  const child = fakeDisplayChild();
  let restoreAttempts = 0;
  const restoreOptions = [];
  let stopAttempts = 0;
  const isolation = await startIsolatedEditorDisplay({
    platform: "linux",
    environment: { OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb" },
    spawnProcess: () => child,
    readDisplayNumber: async () => 731,
    isolateRuntime() {
      return {
        restore(options) {
          restoreOptions.push(options);
          restoreAttempts += 1;
          if (restoreAttempts === 1) throw new Error("injected restore failure");
        }
      };
    },
    async stopProcess(observedChild) {
      assert.equal(observedChild, child);
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("injected child-stop failure");
    }
  });

  await assert.rejects(isolation.stop(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, "EDITOR_PROCESS_TREE_UNVERIFIED");
    assert.equal(error.errors[0].cause.message, "injected child-stop failure");
    assert.equal(error.errors[1].message, "injected restore failure");
    return true;
  });
  assert.equal(restoreAttempts, 1);
  assert.equal(stopAttempts, 1);
  assert.deepEqual(restoreOptions, [{ removePrivateFiles: false }]);

  await isolation.stop();
  await isolation.stop();
  assert.equal(restoreAttempts, 2);
  assert.equal(stopAttempts, 2);
  assert.deepEqual(restoreOptions, [{ removePrivateFiles: false }, { removePrivateFiles: true }]);
});

test("Xvfb remains an explicit isolated compatibility fallback", async (context) => {
  if (process.platform === "win32") {
    context.skip("The executable Xvfb acceptance double uses a POSIX shebang.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-fake-xvfb-"));
  const executable = join(directory, "fake-xvfb.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeSync } from "node:fs";
const displayFd = Number(process.argv[process.argv.indexOf("-displayfd") + 1]);
writeSync(displayFd, "731\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`
  );
  await chmod(executable, 0o700);
  const environment = {
    DISPLAY: ":desktop",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: executable,
    PATH: process.env.PATH,
    XDG_RUNTIME_DIR: "/desktop/runtime"
  };

  try {
    const isolation = await startIsolatedEditorDisplay({ platform: "linux", environment });
    const runtimeDirectory = environment.XDG_RUNTIME_DIR;
    try {
      assert.equal(isolation.display, ":731");
      assert.equal(environment.DISPLAY, ":731");
      assert.equal(environment.GDK_BACKEND, "x11");
      assert.deepEqual(editorDisplayLaunchArgs("linux", environment), [
        "--ozone-platform=x11",
        "--force-disable-user-env",
        "--disable-updates",
        "--disable-crash-reporter",
        "--disable-telemetry",
        "--use-inmemory-secretstorage",
        "--password-store=basic",
        "--skip-add-to-recently-opened"
      ]);
      assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    } finally {
      await isolation.stop();
    }
    await assert.rejects(stat(runtimeDirectory), { code: "ENOENT" });
    assert.equal(environment.DISPLAY, ":desktop");
    assert.equal(environment.XDG_RUNTIME_DIR, "/desktop/runtime");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid isolation modes fail before an editor can launch", async () => {
  const sentinel = "RAW_ARBITRARY_DISPLAY_SENTINEL";
  const environment = { OPEN_WRANGLER_EDITOR_DISPLAY: sentinel };
  await assert.rejects(startIsolatedEditorDisplay({ platform: "linux", environment }), (error) => {
    assert.match(error.message, /must be "headless", "xvfb", or "current"/u);
    assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
    return true;
  });
  assert.throws(
    () => editorDisplayLaunchArgs("linux", environment),
    (error) => {
      assert.match(error.message, /must be "headless", "xvfb", or "current"/u);
      assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
      return true;
    }
  );
});

function fakeEditorChild({ code = null, signal = null, error, resultPath, result } = {}) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setImmediate(() => {
    if (resultPath && result !== undefined) writeFileSync(resultPath, result, "utf8");
    if (error) {
      child.emit("error", error);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, null);
      return;
    }
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  });
  return child;
}

function acceptanceResult(environment, outcome) {
  return JSON.stringify({
    protocol: 1,
    runId: environment.OPEN_WRANGLER_TEST_RUN_ID,
    phase: environment.OPEN_WRANGLER_TEST_PHASE,
    ...outcome
  });
}

function fakeCommandChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function fakeStoppableCommandChild(pid) {
  const child = fakeCommandChild(pid);
  child.kill = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => {
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}

function fakeDisplayChild() {
  const child = new EventEmitter();
  child.pid = 731;
  child.exitCode = null;
  child.signalCode = null;
  child.stdio = [];
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
