import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveCliPathFromVSCodeExecutablePath } from "@vscode/test-electron";
import { redactEditorAcceptanceText } from "./editor-acceptance-evidence.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";

const DISPLAY_MODE_ENV = "OPEN_WRANGLER_EDITOR_DISPLAY";
const XVFB_EXECUTABLE_ENV = "OPEN_WRANGLER_XVFB_EXECUTABLE";
const TEMP_ROOT_ENV = "OPEN_WRANGLER_EDITOR_TEMP_ROOT";
const XVFB_START_TIMEOUT_MS = 10_000;
const XVFB_STOP_TIMEOUT_MS = 5_000;
export const EDITOR_ACCEPTANCE_PHASE_TIMEOUT_MS = 300_000;
export const EDITOR_ACCEPTANCE_INACTIVITY_TIMEOUT_MS = 180_000;
export const EDITOR_ACCEPTANCE_RESULT_MAX_BYTES = 1024 * 1024;
export const EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES = 1024;
export const EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL = 1;
export const EDITOR_COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;
export const EDITOR_HARNESS_ERROR_MAX_CHARACTERS = 16_000;
export const EDITOR_HARNESS_RESULT_MAX_BYTES = 128 * 1024;
export const EDITOR_DOWNLOAD_ATTEMPT_TIMEOUT_MS = 300_000;
export const EDITOR_DOWNLOAD_RESULT_MAX_BYTES = 32 * 1024;
const EDITOR_ACCEPTANCE_POLL_INTERVAL_MS = 100;
const EDITOR_COMMAND_TERMINATION_GRACE_MS = 2_000;
const EDITOR_COMMAND_KILL_GRACE_MS = 5_000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 5_000;
const EDITOR_DOWNLOAD_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024;
const EDITOR_COMMAND_RESOURCE_FAILURE_CODE = "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED";
const EDITOR_DOWNLOAD_HELPER_PATH = fileURLToPath(new URL("./download-editor.mjs", import.meta.url));
const WINDOWS_JOB_SUPERVISOR_PATH = fileURLToPath(new URL("./windows-job-supervisor.ps1", import.meta.url));
const WINDOWS_JOB_OWNERSHIP = Symbol("openWranglerWindowsJobOwnership");
const WINDOWS_JOB_CAPTURE_STDERR = Symbol("openWranglerWindowsJobCaptureStderr");
const EDITOR_PROCESS_TREE_UNVERIFIED_CODE = "EDITOR_PROCESS_TREE_UNVERIFIED";
const ACCEPTANCE_FILE_REPLACED_DURING_READ_CODE = "ACCEPTANCE_FILE_REPLACED_DURING_READ";
const WINDOWS_JOB_LAUNCH_FRAME_MAX_BYTES = 256 * 1024;
const WINDOWS_JOB_ATTESTATION_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:";
const WINDOWS_JOB_BUILD_TIMEOUT_MS = 300_000;
const WINDOWS_JOB_BUILD_OUTPUT_MAX_BYTES = 16 * 1024;
const WINDOWS_JOB_EXECUTABLE_MAX_BYTES = 4 * 1024 * 1024;
const XVFB_DISPLAY_OUTPUT_MAX_BYTES = 64;
const XVFB_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
const EDITOR_OUTPUT_CLOSE_TIMEOUT_MS = 5_000;
const EDITOR_DEBUG_PORT_RELEASE_GRACE_MS = 100;
const OVERSIZED_EDITOR_DIAGNOSTIC =
  "Diagnostic text was suppressed because its complete value exceeded the fixed safety limit.";
const INCOMPLETE_EDITOR_OUTPUT_DIAGNOSTIC =
  "Editor output was suppressed because complete stream closure could not be verified.";
const ACCEPTANCE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCEPTANCE_PHASE = /^[a-z][a-z0-9-]{0,63}$/u;
const PRIVATE_DIAGNOSTIC_PATH_ENV_KEYS = [
  "OPEN_WRANGLER_XVFB_EXECUTABLE",
  "OPEN_WRANGLER_VSCODE_EXECUTABLE",
  "OPEN_WRANGLER_VSCODE_CLI",
  "OPEN_WRANGLER_CURSOR_EXECUTABLE",
  "OPEN_WRANGLER_CURSOR_CLI",
  "OPEN_WRANGLER_TEST_PYTHON",
  "OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS"
];

export function validateEditorAcceptancePrivatePathOverrides() {
  for (const key of [...PRIVATE_DIAGNOSTIC_PATH_ENV_KEYS, "pythonLocation"]) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0 && !isAbsolute(value)) {
      throw new Error("Editor acceptance path overrides must be absolute paths.");
    }
  }
}

export function collectEditorAcceptancePrivateDiagnosticPaths(additionalPaths = []) {
  if (!Array.isArray(additionalPaths)) {
    throw new TypeError("Additional editor acceptance private paths must be an array.");
  }
  const paths = new Set();
  const add = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    const absolute = resolve(value);
    paths.add(absolute);
    if (!existsSync(absolute)) return;
    try {
      paths.add(realpathSync(absolute));
    } catch {
      // The lexical path still remains private if canonicalization races or fails.
    }
  };
  add(process.env.HOME);
  add(process.env.USERPROFILE);
  for (const key of PRIVATE_DIAGNOSTIC_PATH_ENV_KEYS) add(process.env[key]);
  const hostedPythonRoot = process.env.pythonLocation;
  add(hostedPythonRoot);
  if (hostedPythonRoot) {
    add(
      process.platform === "win32"
        ? resolve(hostedPythonRoot, "python.exe")
        : resolve(hostedPythonRoot, "bin", "python")
    );
  }
  const busPath = /^unix:(?:[^,]*,)*path=([^,;]+)(?:[,;]|$)/u.exec(process.env.DBUS_SESSION_BUS_ADDRESS ?? "")?.[1];
  if (busPath) {
    add(busPath);
    try {
      const decodedBusPath = decodeURIComponent(busPath);
      // A Unix D-Bus address can be present while the coordinator itself runs
      // on Windows (for example, in a cross-platform diagnostic test). Keep the
      // literal transport path as well as the host-normalized path so neither
      // spelling can escape redaction.
      paths.add(decodedBusPath);
      add(decodedBusPath);
    } catch {
      // Malformed encoded transports remain covered by whole-address redaction.
    }
  }
  for (const value of additionalPaths) add(value);
  return [...paths].sort((left, right) => right.length - left.length);
}
const INCOMPLETE_XVFB_DIAGNOSTIC =
  "Xvfb stderr was suppressed because its complete stream contents were not available.";
const UNREADABLE_EDITOR_DIAGNOSTIC = "Unreadable acceptance failure";
const UNREADABLE_AGGREGATE_DIAGNOSTIC = "Nested acceptance failures were omitted because the aggregate was unreadable.";
const CURSOR_HEADLESS_XVFB_REMEDIATION =
  "Cursor aborted before the acceptance harness started on Linux's zero-window headless Ozone platform. This can be an editor-platform incompatibility; install Xvfb and rerun explicitly with OPEN_WRANGLER_EDITOR_DISPLAY=xvfb (and set OPEN_WRANGLER_XVFB_EXECUTABLE if the binary is not on PATH). The compatibility run remains isolated and invisible.";
const EDITOR_DOWNLOAD_VERSION = /^(?:stable|insiders|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const ISOLATED_EDITOR_ARGS = [
  "--force-disable-user-env",
  "--disable-updates",
  "--disable-crash-reporter",
  "--disable-telemetry",
  "--use-inmemory-secretstorage",
  "--password-store=basic",
  "--skip-add-to-recently-opened"
];
// Keep this list explicit: the extension host and its Python children inherit
// the editor environment, so an exclusion list would turn every new loader,
// credential, or tool-specific variable into an unreviewed injection path.
const INHERITED_EDITOR_ENVIRONMENT_KEYS = new Set([
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "GDK_BACKEND",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ADDRESS",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_STATE_HOME"
]);
// These values are never copied implicitly. The runner must deliberately pass
// each one from its phase inputs or explicit capture configuration.
const CONTROLLED_EDITOR_ENVIRONMENT_KEYS = new Set([
  "OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS",
  "OPEN_WRANGLER_EDITOR_CDP_PORT",
  "OPEN_WRANGLER_EXTENSION_TESTS",
  "OPEN_WRANGLER_TEST_EDITOR",
  "OPEN_WRANGLER_TEST_MODULE",
  "OPEN_WRANGLER_TEST_PHASE",
  "OPEN_WRANGLER_TEST_PROGRESS",
  "OPEN_WRANGLER_TEST_PYTHON",
  "OPEN_WRANGLER_TEST_RUN_ID",
  "OPEN_WRANGLER_TEST_RESULT"
]);
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
export function configureEditorAcceptanceTempRoot(path, environment = process.env) {
  const root = resolve(path);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const privateDirectories = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state")
  };
  for (const directory of new Set(Object.values(privateDirectories))) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  Object.assign(environment, privateDirectories);
  environment[TEMP_ROOT_ENV] = root;
  // Electron and editor subprocesses create additional temporary files outside
  // the profile itself. Keep those on the same disposable, quota-independent
  // filesystem on every desktop platform.
  environment.TMPDIR = root;
  environment.TMP = root;
  environment.TEMP = root;
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === "HOMEDRIVE" || key.toUpperCase() === "HOMEPATH") delete environment[key];
  }
  return root;
}

export function createEditorAcceptanceEnvironment(environment = process.env, overrides = {}) {
  return createEditorAcceptanceEnvironmentForPlatform(environment, overrides, process.platform);
}

export function createEditorAcceptanceEnvironmentForPlatform(
  environment = process.env,
  overrides = {},
  platform = process.platform
) {
  const isolated = {};
  for (const [key, value] of platformEnvironmentEntries(environment, platform, "inherited")) {
    if (value === undefined) continue;
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    if (!INHERITED_EDITOR_ENVIRONMENT_KEYS.has(normalizedKey)) continue;
    if (normalizedKey !== "DBUS_SESSION_BUS_ADDRESS" && isSensitiveEditorEnvironmentValue(value)) continue;
    validateEditorEnvironmentValue(normalizedKey, value);
    isolated[normalizedKey] = value;
  }
  for (const [key, value] of platformEnvironmentEntries(overrides, platform, "override")) {
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    if (
      !INHERITED_EDITOR_ENVIRONMENT_KEYS.has(normalizedKey) &&
      !CONTROLLED_EDITOR_ENVIRONMENT_KEYS.has(normalizedKey)
    ) {
      throw new Error(`Editor acceptance does not allow the ${JSON.stringify(key)} environment override.`);
    }
    if (value === undefined) {
      delete isolated[normalizedKey];
      continue;
    }
    if (normalizedKey !== "DBUS_SESSION_BUS_ADDRESS" && isSensitiveEditorEnvironmentValue(value)) {
      throw new Error(`Editor acceptance rejected a credential-bearing value for ${JSON.stringify(key)}.`);
    }
    validateEditorEnvironmentValue(normalizedKey, value);
    isolated[normalizedKey] = value;
  }
  return isolated;
}

function platformEnvironmentEntries(environment, platform, description) {
  const entries = Object.entries(environment);
  if (platform !== "win32") return entries;
  const seen = new Map();
  for (const [key] of entries) {
    const normalizedKey = key.toUpperCase();
    if (seen.has(normalizedKey)) {
      throw new Error(
        `Editor acceptance rejected colliding Windows ${description} environment keys ${JSON.stringify(seen.get(normalizedKey))} and ${JSON.stringify(key)}.`
      );
    }
    seen.set(normalizedKey, key);
  }
  return entries;
}

function validateEditorEnvironmentValue(key, value) {
  if (key === "DBUS_SESSION_BUS_ADDRESS" && !isSafeLocalDbusAddress(value)) {
    throw new Error(
      "Editor acceptance requires DBUS_SESSION_BUS_ADDRESS to name one local unix:path or unix:abstract transport."
    );
  }
}

function isSafeLocalDbusAddress(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes(";") || /[\0\r\n]/u.test(value)) return false;
  const match = /^unix:(.+)$/u.exec(value);
  if (!match) return false;
  const parameters = new Map();
  for (const part of match[1].split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return false;
    const key = part.slice(0, separator);
    const rawValue = part.slice(separator + 1);
    if (parameters.has(key) || !/^(?:path|abstract|guid)$/u.test(key)) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      return false;
    }
    if (!decoded || /[\0\r\n]/u.test(decoded)) return false;
    parameters.set(key, decoded);
  }
  const path = parameters.get("path");
  const abstract = parameters.get("abstract");
  if (Boolean(path) === Boolean(abstract)) return false;
  if (path && !path.startsWith("/")) return false;
  const guid = parameters.get("guid");
  if (guid && !/^[0-9a-f]{32}$/iu.test(guid)) return false;
  return parameters.size === (guid ? 2 : 1);
}

function isSensitiveEditorEnvironmentValue(value) {
  if (typeof value !== "string") return true;
  const redacted = redactEditorAcceptanceText(value);
  // Evidence normalization also decodes security-looking backslash escapes.
  // A legitimate Windows path such as C:\tool\x64 therefore changes even
  // though it contains no credential. Every actual credential substitution
  // uses the redaction marker below; private-key material fails with undefined.
  return redacted === undefined || redacted.includes("<redacted");
}

export function describeEditorAcceptanceHarnessFailure(error) {
  let description;
  try {
    description = error instanceof Error ? error.stack || error.message : String(error);
  } catch {
    description = "Acceptance failed with an unreadable thrown value.";
  }
  if (description.length <= EDITOR_HARNESS_ERROR_MAX_CHARACTERS) return description;
  return OVERSIZED_EDITOR_DIAGNOSTIC;
}

export function serializeEditorAcceptanceHarnessOutcome(outcome, fallbackEnvelope = {}) {
  try {
    const serialized = JSON.stringify(outcome);
    if (Buffer.byteLength(serialized, "utf8") <= EDITOR_HARNESS_RESULT_MAX_BYTES) return serialized;
  } catch {
    // The fixed fallback below remains valid and bounded.
  }
  return JSON.stringify({
    protocol: fallbackEnvelope.protocol,
    runId: fallbackEnvelope.runId,
    phase: fallbackEnvelope.phase,
    ok: false,
    error: "Acceptance result could not be serialized within its bounded envelope."
  });
}

export async function startIsolatedEditorDisplay({
  platform = process.platform,
  environment = process.env,
  spawnProcess = spawn,
  startupTimeoutMs = XVFB_START_TIMEOUT_MS,
  isolateRuntime = isolateLinuxEditorEnvironment,
  readDisplayNumber = readXvfbDisplayNumber,
  stopProcess = stopChild
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
    const runtime = isolateRuntime(environment, mode);
    console.log(
      "Editor acceptance is using Chromium's zero-window headless platform; it cannot open or focus a desktop window."
    );
    const stop = createRuntimeCleanup(runtime);
    return {
      display: undefined,
      isolated: true,
      mode,
      stop
    };
  }

  const executable = environment[XVFB_EXECUTABLE_ENV] || "Xvfb";
  const child = spawnProcess(
    executable,
    [
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
    ],
    {
      env: createEditorAcceptanceEnvironmentForPlatform(environment, {}, platform),
      stdio: ["ignore", "ignore", "pipe", "pipe"]
    }
  );
  const exit = childExit(child);
  let displayNumber;
  let runtime;
  try {
    displayNumber = await readDisplayNumber(child, exit, startupTimeoutMs);
    runtime = isolateRuntime(environment, mode, `:${displayNumber}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const startupError = new Error(
      `Linux editor acceptance could not start its private Xvfb display: ${detail} Install Xvfb (for example, \`sudo apt-get install xvfb\` on Ubuntu/Debian), configure ${XVFB_EXECUTABLE_ENV}, or set ${DISPLAY_MODE_ENV}=current only when a visible, focus-stealing debug run is intentional.`,
      { cause: error }
    );
    try {
      await stopPrivateDisplayProcess(stopProcess, child, exit);
    } catch (stopError) {
      throw new AggregateError(
        [startupError, stopError],
        "The private Xvfb display failed during setup and its child process did not shut down cleanly."
      );
    }
    throw startupError;
  }

  const display = `:${displayNumber}`;
  console.log(`Editor acceptance is isolated on private Xvfb display ${display}; it cannot take desktop focus.`);

  const stopDisplay = retryableCleanup(
    [{ run: () => stopPrivateDisplayProcess(stopProcess, child, exit), complete: false }],
    "The private Xvfb process did not shut down cleanly."
  );
  const restoreRuntime = createRuntimeCleanup(runtime);
  const stop = async ({ preservePrivateFiles = false } = {}) => {
    let displayError;
    try {
      await stopDisplay();
    } catch (error) {
      displayError = error;
    }
    let runtimeError;
    try {
      await restoreRuntime({
        preservePrivateFiles: preservePrivateFiles || editorProcessTreeMayBeLive(displayError)
      });
    } catch (error) {
      runtimeError = error;
    }
    if (displayError && runtimeError) {
      throw new AggregateError(
        [displayError, runtimeError],
        "The private Xvfb editor environment did not shut down cleanly."
      );
    }
    if (displayError) throw displayError;
    if (runtimeError) throw runtimeError;
  };
  return {
    display,
    isolated: true,
    mode,
    stop
  };
}

function retryableCleanup(steps, message) {
  let activeAttempt;
  return async function stop() {
    if (steps.every((step) => step.complete)) return;
    if (activeAttempt) return activeAttempt;
    activeAttempt = (async () => {
      const errors = [];
      for (const step of steps) {
        if (step.complete) continue;
        try {
          await step.run();
          step.complete = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, message);
    })();
    try {
      await activeAttempt;
    } finally {
      activeAttempt = undefined;
    }
  };
}

function createRuntimeCleanup(runtime) {
  let fullyRemoved = false;
  let activeAttempt;
  return async function cleanupRuntime({ preservePrivateFiles = false } = {}) {
    if (fullyRemoved) return;
    if (activeAttempt) return activeAttempt;
    const removePrivateFiles = !preservePrivateFiles;
    activeAttempt = Promise.resolve()
      .then(() => runtime.restore({ removePrivateFiles }))
      .then(() => {
        if (removePrivateFiles) fullyRemoved = true;
      });
    try {
      await activeAttempt;
    } finally {
      activeAttempt = undefined;
    }
  };
}

export function editorDisplayLaunchArgs(platform = process.platform, environment = process.env) {
  if (platform !== "linux") return [...ISOLATED_EDITOR_ARGS];
  const mode = editorDisplayMode(environment);
  if (mode === "headless") return ["--ozone-platform=headless", "--disable-gpu", ...ISOLATED_EDITOR_ARGS];
  if (mode === "xvfb") return ["--ozone-platform=x11", ...ISOLATED_EDITOR_ARGS];
  return [...ISOLATED_EDITOR_ARGS];
}

function editorDisplayMode(environment) {
  const mode = environment[DISPLAY_MODE_ENV] ?? "headless";
  if (mode !== "headless" && mode !== "xvfb" && mode !== "current") {
    throw new Error(`${DISPLAY_MODE_ENV} must be "headless", "xvfb", or "current".`);
  }
  return mode;
}

function isolateLinuxEditorEnvironment(environment, mode, display) {
  const temporaryRoot = environment[TEMP_ROOT_ENV] ? resolve(environment[TEMP_ROOT_ENV]) : tmpdir();
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  // VS Code places a Unix-domain socket below XDG_RUNTIME_DIR. Keep the
  // generated component deliberately short so ordinary workspace paths stay
  // below Linux's 107-byte sockaddr_un limit.
  const runtimeDirectory = mkdtempSync(join(temporaryRoot, "r-"));
  chmodSync(runtimeDirectory, 0o700);
  const homeDirectory = join(runtimeDirectory, "home");
  const configDirectory = join(runtimeDirectory, "config");
  const cacheDirectory = join(runtimeDirectory, "cache");
  const dataDirectory = join(runtimeDirectory, "data");
  const stateDirectory = join(runtimeDirectory, "state");
  for (const directory of [homeDirectory, configDirectory, cacheDirectory, dataDirectory, stateDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const changedEnvironment = new Map();
  setEnvironmentValue(environment, changedEnvironment, "HOME", homeDirectory);
  setEnvironmentValue(environment, changedEnvironment, "USERPROFILE", homeDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_RUNTIME_DIR", runtimeDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_CONFIG_HOME", configDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_CACHE_HOME", cacheDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_DATA_HOME", dataDirectory);
  setEnvironmentValue(environment, changedEnvironment, "XDG_STATE_HOME", stateDirectory);
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
  let environmentRestored = false;
  let privateFilesRemoved = false;
  return {
    restore({ removePrivateFiles = true } = {}) {
      if (!environmentRestored) {
        restoreEnvironment(environment, changedEnvironment);
        environmentRestored = true;
      }
      if (removePrivateFiles && !privateFilesRemoved) {
        rmSync(runtimeDirectory, { recursive: true, force: true });
        privateFilesRemoved = true;
      }
    }
  };
}

export async function readXvfbDisplayNumber(child, exit, timeoutMs) {
  const displayOutput = child.stdio?.[3];
  if (!displayOutput || typeof displayOutput.on !== "function") {
    throw new Error("Xvfb did not expose its display-number pipe.");
  }
  const stderrChunks = [];
  let stderrBytes = 0;
  let stderrExceeded = false;
  let stderrComplete = child.stderr?.readableEnded === true;
  const onStderr = (chunk) => {
    if (stderrExceeded) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stderrBytes + buffer.length > XVFB_DIAGNOSTIC_MAX_BYTES) {
      stderrChunks.length = 0;
      stderrBytes = 0;
      stderrExceeded = true;
      return;
    }
    stderrChunks.push(Buffer.from(buffer));
    stderrBytes += buffer.length;
  };
  child.stderr?.on("data", onStderr);
  const onStderrEnd = () => {
    stderrComplete = true;
  };
  child.stderr?.once("end", onStderrEnd);

  const stderrSuffix = () => {
    if (child.stderr && !stderrComplete) return ` ${INCOMPLETE_XVFB_DIAGNOSTIC}`;
    if (stderrExceeded) return ` ${OVERSIZED_EDITOR_DIAGNOSTIC}`;
    const complete = Buffer.concat(stderrChunks, stderrBytes).toString("utf8").trim();
    if (!complete) return "";
    return ` ${sanitizeHarnessFailure(complete)}`;
  };

  let timer;
  let output = "";
  let outputBytes = 0;
  let onDisplayData;
  let onChildError;
  try {
    return await Promise.race([
      new Promise((resolveDisplay, rejectDisplay) => {
        onDisplayData = (chunk) => {
          const text = String(chunk);
          outputBytes += Buffer.byteLength(text, "utf8");
          if (outputBytes > XVFB_DISPLAY_OUTPUT_MAX_BYTES) {
            rejectDisplay(
              new Error(`Xvfb display-number output exceeded ${XVFB_DISPLAY_OUTPUT_MAX_BYTES} UTF-8 bytes.`)
            );
            return;
          }
          output += text;
          const lineEnd = output.indexOf("\n");
          if (lineEnd < 0) return;
          const value = output.slice(0, lineEnd).trim();
          if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) {
            rejectDisplay(new Error("Xvfb returned an invalid display number."));
            return;
          }
          resolveDisplay(Number(value));
        };
        onChildError = rejectDisplay;
        displayOutput.on("data", onDisplayData);
        child.once("error", onChildError);
      }),
      exit.then(({ code, signal }) => {
        throw new Error(`Xvfb exited before it became ready (code ${code}, signal ${signal}).${stderrSuffix()}`);
      }),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          rejectTimeout(new Error(`Xvfb did not become ready within ${timeoutMs}ms.${stderrSuffix()}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onDisplayData) displayOutput.off("data", onDisplayData);
    if (onChildError) child.off("error", onChildError);
    child.stderr?.off("data", onStderr);
    child.stderr?.off("end", onStderrEnd);
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
    let settled = false;
    const settle = (state) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("exit", onExit);
      resolveExit(state);
    };
    const onError = (error) => {
      // A late stream/process error is not proof that an already-started child exited.
      // Only a spawn failure (no pid) may settle this lifecycle without an exit event.
      if (child.pid === undefined) settle({ error });
    };
    const onExit = (code, signal) => settle({ code, signal });
    child.on("error", onError);
    child.once("exit", onExit);
  });
}

function childClose(child) {
  return new Promise((resolveClose) => {
    let settled = false;
    let spawnError;
    const settle = (state) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("close", onClose);
      resolveClose(state);
    };
    const onError = (error) => {
      // Neither a spawn failure nor a late process/stream error proves that
      // every inherited output handle has closed. Preserve a spawn failure for
      // classification, but require the ChildProcess close event itself.
      if (child.pid === undefined) spawnError ??= error;
    };
    const onClose = (code, signal) => settle(spawnError ? { error: spawnError, code, signal } : { code, signal });
    child.on("error", onError);
    child.once("close", onClose);
  });
}

async function stopChild(child, exit) {
  try {
    return await stopChildWithVerifiedExit(child, exit);
  } catch (error) {
    if (editorProcessTreeMayBeLive(error)) throw error;
    throw unverifiedEditorProcessTreeError("The private Xvfb process could not be verified as stopped.", error);
  }
}

async function stopPrivateDisplayProcess(stopProcess, child, exit) {
  try {
    await stopProcess(child, exit);
  } catch (error) {
    if (editorProcessTreeMayBeLive(error)) throw error;
    throw unverifiedEditorProcessTreeError("The private Xvfb process could not be verified as stopped.", error);
  }
}

async function stopChildWithVerifiedExit(child, exit) {
  const isRunning = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  if (!isRunning()) return;
  child.kill("SIGTERM");
  await waitForChildExit(exit, XVFB_STOP_TIMEOUT_MS);
  if (!isRunning()) return;
  if (isRunning()) child.kill("SIGKILL");
  await waitForChildExit(exit, XVFB_STOP_TIMEOUT_MS);
  if (!isRunning()) return;
  throw unverifiedEditorProcessTreeError("The private Xvfb process remained after forced termination.");
}

export async function downloadEditorWithRetry(
  version,
  attempts = 3,
  {
    attemptTimeoutMs = EDITOR_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
    retryWait = delay,
    runCommand = runBoundedEditorCommand,
    helperPath = EDITOR_DOWNLOAD_HELPER_PATH,
    environment = createEditorAcceptanceEnvironment()
  } = {}
) {
  if (
    typeof version !== "string" ||
    version.length > 128 ||
    /[\0\r\n\u2028\u2029]/u.test(version) ||
    !EDITOR_DOWNLOAD_VERSION.test(version) ||
    isSensitiveEditorEnvironmentValue(version)
  ) {
    throw new Error('An editor download version must be "stable", "insiders", or a numeric major.minor.patch version.');
  }
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("An editor download attempt count must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new Error("An editor download attempt timeout must be a positive safe integer.");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await runCommand(
        {
          executable: process.execPath,
          args: [helperPath, version],
          environment,
          label: `Editor download attempt ${attempt}/${attempts}`
        },
        {
          timeoutMs: attemptTimeoutMs,
          maxOutputBytes: EDITOR_DOWNLOAD_COMMAND_OUTPUT_MAX_BYTES,
          terminationGraceMs: 0
        }
      );
      return parseEditorDownloadResult(stdout, version);
    } catch (error) {
      lastError = error;
      if (error?.code === EDITOR_COMMAND_RESOURCE_FAILURE_CODE || attempt === attempts) break;
      const waitMs = attempt * 2_000;
      // Downloader failures can contain signed CDN URLs. Final details are retained
      // only through the sanitized acceptance-evidence path.
      console.warn(`Editor download failed on attempt ${attempt}/${attempts}; retrying in ${waitMs}ms.`);
      await retryWait(waitMs);
    }
  }
  throw sanitizeEditorDownloadFailure(lastError, version, attempts);
}

function sanitizeEditorDownloadFailure(error, version, attempts) {
  let rawDetail;
  try {
    rawDetail = error instanceof Error ? error.message : String(error);
  } catch {
    rawDetail = "The isolated downloader failed with an unreadable value.";
  }
  const replacements = [...new Set([process.env.HOME, process.env.USERPROFILE].filter(Boolean))].map((value) => [
    value,
    "<host-home>"
  ]);
  const redacted = redactEditorAcceptanceText(rawDetail, replacements);
  const detail = redacted === undefined ? "Sensitive helper details were suppressed." : redacted.slice(0, 16_000);
  const failure = new Error(
    `Editor download failed after ${attempts} bounded attempt${attempts === 1 ? "" : "s"}: ${detail}`
  );
  if (error?.code === EDITOR_COMMAND_RESOURCE_FAILURE_CODE) failure.code = EDITOR_COMMAND_RESOURCE_FAILURE_CODE;
  if (editorProcessTreeMayBeLive(error)) {
    failure.details = { treeVerifiedStopped: false };
  }
  return failure;
}

function parseEditorDownloadResult(stdout, version) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > EDITOR_DOWNLOAD_RESULT_MAX_BYTES) {
    throw new Error(`Editor download ${version} returned an oversized or non-text result.`);
  }
  const lines = stdout.endsWith("\n") ? stdout.slice(0, -1).split("\n") : stdout.split("\n");
  if (lines.length !== 1 || lines[0].length === 0 || lines[0].includes("\r")) {
    throw new Error(`Editor download ${version} returned a malformed result envelope.`);
  }
  let result;
  try {
    result = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Editor download ${version} returned invalid JSON.`, { cause: error });
  }
  if (!result || typeof result !== "object" || result.protocol !== 1 || typeof result.ok !== "boolean") {
    throw new Error(`Editor download ${version} returned an unsupported result envelope.`);
  }
  if (!result.ok) {
    const detail =
      typeof result.error === "string" && result.error.length > 0 && result.error.length <= 16_000
        ? result.error
        : "The isolated downloader did not provide a bounded error.";
    throw new Error(`Editor download ${version} failed: ${detail}`);
  }
  if (
    typeof result.executablePath !== "string" ||
    result.executablePath.length === 0 ||
    result.executablePath.length > 16_384 ||
    /[\0\r\n]/u.test(result.executablePath) ||
    !isAbsolute(result.executablePath)
  ) {
    throw new Error(`Editor download ${version} returned an invalid executable path.`);
  }
  return result.executablePath;
}

export function resolveDownloadedEditorCliPath(executablePath, platform = process.platform) {
  if (platform === "win32") {
    const executableName = win32.basename(executablePath).toLowerCase();
    if (executableName !== "code.exe" && executableName !== "code - insiders.exe") {
      throw new Error("A downloaded Windows VS Code executable has an unsupported product filename.");
    }
    return win32.resolve(
      win32.dirname(executablePath),
      "bin",
      executableName === "code - insiders.exe" ? "code-insiders.cmd" : "code.cmd"
    );
  }
  if (platform === "darwin") {
    return posix.resolve(posix.dirname(executablePath), "../Resources/app/bin/code");
  }
  return resolveCliPathFromVSCodeExecutablePath(executablePath, platform);
}

function isContainedWindowsPath(parent, candidate) {
  const child = win32.relative(parent, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${win32.sep}`) && !win32.isAbsolute(child);
}

function validateWindowsEditorCliPath(path, description) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 16_384 ||
    /[\0\r\n]/u.test(path) ||
    !win32.isAbsolute(path)
  ) {
    throw new Error(`The Windows editor ${description} must be one absolute, bounded path.`);
  }
  return win32.resolve(path);
}

function readBoundedWindowsEditorInstallationEntries(root) {
  const directory = opendirSync(root);
  const entries = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) return entries;
      if (entries.length >= 4_096) {
        throw new Error("The Windows editor installation root contains too many entries for bounded discovery.");
      }
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
}

/**
 * Resolve the direct equivalent of VS Code's Windows `bin/code.cmd` launcher.
 * The wrapper itself is deliberately never executed: setup remains shell-free,
 * while Electron runs the installation's own CLI entry point in Node mode.
 */
export function resolveEditorCliLaunch(
  editor,
  environment = createEditorAcceptanceEnvironment(),
  {
    platform = process.platform,
    lstatPath = lstatSync,
    realpathPath = realpathSync,
    readInstallationEntries = readBoundedWindowsEditorInstallationEntries
  } = {}
) {
  if (!editor || typeof editor !== "object") throw new Error("An editor CLI launch requires editor metadata.");
  if (platform !== "win32") {
    if (typeof editor.cli !== "string" || editor.cli.length === 0) {
      throw new Error("An editor CLI launch requires a CLI executable.");
    }
    return { executable: editor.cli, argsPrefix: [], environment };
  }

  const executable = validateWindowsEditorCliPath(editor.executable, "executable");
  const wrapper = validateWindowsEditorCliPath(editor.cli, "CLI wrapper");
  const installationRoot = win32.dirname(executable);
  const wrapperDirectory = win32.resolve(installationRoot, "bin");
  if (
    win32.dirname(wrapper).toLowerCase() !== wrapperDirectory.toLowerCase() ||
    win32.extname(wrapper).toLowerCase() !== ".cmd"
  ) {
    throw new Error("The Windows editor CLI wrapper must be a direct child of its installation's bin directory.");
  }
  let canonicalRoot;
  let canonicalExecutable;
  let canonicalWrapper;
  let canonicalEntryPoint;
  let cliEntryPoint;
  try {
    const rootSnapshot = lstatPath(installationRoot);
    const executableSnapshot = lstatPath(executable);
    const wrapperSnapshot = lstatPath(wrapper);
    if (
      rootSnapshot.isSymbolicLink() ||
      !rootSnapshot.isDirectory() ||
      executableSnapshot.isSymbolicLink() ||
      !executableSnapshot.isFile() ||
      wrapperSnapshot.isSymbolicLink() ||
      !wrapperSnapshot.isFile()
    ) {
      throw new Error("invalid editor installation file type");
    }

    const entryPointCandidates = [win32.resolve(installationRoot, "resources", "app", "out", "cli.js")];
    const entries = readInstallationEntries(installationRoot);
    if (!Array.isArray(entries) || entries.length > 4_096) throw new Error("invalid bounded directory result");
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string" || entry.name.length > 255) {
        throw new Error("invalid editor installation directory entry");
      }
      if (!/^[0-9a-f]{10}$/iu.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("invalid versioned editor directory");
      const versionRoot = win32.resolve(installationRoot, entry.name);
      const versionSnapshot = lstatPath(versionRoot);
      if (versionSnapshot.isSymbolicLink() || !versionSnapshot.isDirectory()) {
        throw new Error("invalid versioned editor directory type");
      }
      entryPointCandidates.push(win32.resolve(versionRoot, "resources", "app", "out", "cli.js"));
    }

    const verifiedEntryPoints = [];
    for (const candidate of entryPointCandidates) {
      let candidateSnapshot;
      try {
        candidateSnapshot = lstatPath(candidate);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
        throw error;
      }
      if (candidateSnapshot.isSymbolicLink() || !candidateSnapshot.isFile()) {
        throw new Error("invalid editor CLI entry point type");
      }
      verifiedEntryPoints.push(candidate);
    }
    if (verifiedEntryPoints.length !== 1) throw new Error("ambiguous editor CLI entry point layout");
    [cliEntryPoint] = verifiedEntryPoints;

    canonicalRoot = realpathPath(installationRoot);
    canonicalExecutable = realpathPath(executable);
    canonicalWrapper = realpathPath(wrapper);
    canonicalEntryPoint = realpathPath(cliEntryPoint);
  } catch {
    throw new Error("The Windows editor CLI launch requires a complete regular installation layout.");
  }
  if (
    !isContainedWindowsPath(canonicalRoot, canonicalExecutable) ||
    !isContainedWindowsPath(canonicalRoot, canonicalWrapper) ||
    !isContainedWindowsPath(canonicalRoot, canonicalEntryPoint)
  ) {
    throw new Error("The Windows editor CLI launch escaped its verified installation root.");
  }

  return {
    executable,
    argsPrefix: [cliEntryPoint],
    environment: {
      ...createEditorAcceptanceEnvironmentForPlatform(environment, {}, "win32"),
      ELECTRON_RUN_AS_NODE: "1"
    }
  };
}

const windowsJobSupervisorBuilds = new Map();
const unsafeWindowsJobSupervisorRoots = new Set();
let windowsJobSupervisorFallbackRoot;
let windowsJobSupervisorFallbackReceipt;
let removeWindowsJobSupervisorFallbackRoot = false;

export async function prepareWindowsEditorProcessSupervisor(
  environment = process.env,
  { platform = process.platform, spawnProcess = spawn, buildTimeoutMs = WINDOWS_JOB_BUILD_TIMEOUT_MS } = {}
) {
  if (platform !== "win32") return undefined;
  if (!Number.isSafeInteger(buildTimeoutMs) || buildTimeoutMs <= 0 || buildTimeoutMs > WINDOWS_JOB_BUILD_TIMEOUT_MS) {
    throw new Error(
      `The Windows editor Job Object supervisor build timeout must be a positive safe integer no larger than ${WINDOWS_JOB_BUILD_TIMEOUT_MS}.`
    );
  }
  // Editor subprocess environments intentionally omit this host-only routing
  // value. Setup commands still belong to the process-owned acceptance root,
  // so recover it from the coordinator environment before using a fallback.
  const configuredRoot = environment[TEMP_ROOT_ENV] ?? process.env[TEMP_ROOT_ENV];
  let buildRoot;
  if (typeof configuredRoot === "string" && configuredRoot.length > 0) {
    if (!isAbsolute(configuredRoot)) {
      throw new Error("The Windows editor Job Object supervisor requires an absolute private temporary root.");
    }
    buildRoot = resolve(configuredRoot);
  } else {
    if (!windowsJobSupervisorFallbackRoot) {
      const parent = resolve(tmpdir(), "ow");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      windowsJobSupervisorFallbackRoot = mkdtempSync(join(parent, "job-"));
      windowsJobSupervisorFallbackReceipt = createEditorAcceptancePrivateRootReceipt(windowsJobSupervisorFallbackRoot, {
        containedBy: parent
      });
      if (!removeWindowsJobSupervisorFallbackRoot) {
        removeWindowsJobSupervisorFallbackRoot = true;
        process.once("exit", () => {
          if (unsafeWindowsJobSupervisorRoots.has(windowsJobSupervisorFallbackRoot)) return;
          try {
            removeEditorAcceptancePrivateRoot(windowsJobSupervisorFallbackReceipt);
          } catch {
            // Process exit cannot safely surface cleanup diagnostics. Normal
            // packaged runs always place the helper under their owned root.
          }
        });
      }
    }
    buildRoot = windowsJobSupervisorFallbackRoot;
  }

  if (unsafeWindowsJobSupervisorRoots.has(buildRoot)) {
    throw unverifiedEditorProcessTreeError(
      "The Windows editor Job Object supervisor root was previously involved in an unverified process tree and cannot be reused."
    );
  }

  let build = windowsJobSupervisorBuilds.get(buildRoot);
  if (!build) {
    build = compileWindowsEditorProcessSupervisor(buildRoot, environment, spawnProcess, buildTimeoutMs);
    windowsJobSupervisorBuilds.set(buildRoot, build);
    build.catch(() => windowsJobSupervisorBuilds.delete(buildRoot));
  }
  return build;
}

async function compileWindowsEditorProcessSupervisor(buildRoot, environment, spawnProcess, buildTimeoutMs) {
  mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  const outputDirectory = mkdtempSync(join(buildRoot, "job-supervisor-"));
  const executable = join(outputDirectory, "openwrangler-windows-job-supervisor.exe");
  const systemRoot =
    environment.SYSTEMROOT ??
    environment.SystemRoot ??
    environment.WINDIR ??
    process.env.SYSTEMROOT ??
    process.env.SystemRoot ??
    process.env.WINDIR ??
    "C:\\Windows";
  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const compilerEnvironment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(buildRoot, compilerEnvironment);
  const child = spawnProcess(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_JOB_SUPERVISOR_PATH,
      "-CompileTo",
      executable
    ],
    {
      detached: false,
      env: compilerEnvironment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const output = createBoundedCommandOutput(WINDOWS_JOB_BUILD_OUTPUT_MAX_BYTES);
  child.stdout?.on("data", (chunk) => output.append("stdout", chunk));
  child.stderr?.on("data", (chunk) => output.append("stderr", chunk));
  let state;
  try {
    state = await promiseWithDeadline(
      childClose(child),
      buildTimeoutMs,
      `Windows editor Job Object supervisor compilation exceeded ${buildTimeoutMs} ms.`
    );
  } catch (error) {
    unsafeWindowsJobSupervisorRoots.add(buildRoot);
    try {
      child.kill("SIGKILL");
    } catch {
      // The fixed failure below still prevents an unowned editor launch.
    }
    throw unverifiedEditorProcessTreeError(
      "The Windows editor Job Object supervisor could not be prepared within its bounded bootstrap.",
      error
    );
  } finally {
    destroyCapturedCommandStdio(child);
  }
  if (state.error || state.code !== 0 || output.exceeded()) {
    throw new Error("The Windows editor Job Object supervisor could not be compiled in its private root.");
  }
  const snapshot = lstatSync(executable, { bigint: true });
  if (
    !snapshot.isFile() ||
    snapshot.nlink !== 1n ||
    snapshot.size <= 0n ||
    snapshot.size > BigInt(WINDOWS_JOB_EXECUTABLE_MAX_BYTES)
  ) {
    throw new Error("The compiled Windows editor Job Object supervisor is not a private regular file.");
  }
  const rootSnapshot = lstatSync(buildRoot, { bigint: true });
  const parentSnapshot = lstatSync(outputDirectory, { bigint: true });
  if (
    !rootSnapshot.isDirectory() ||
    rootSnapshot.isSymbolicLink() ||
    !parentSnapshot.isDirectory() ||
    parentSnapshot.isSymbolicLink() ||
    relative(buildRoot, outputDirectory).startsWith("..")
  ) {
    throw new Error("The compiled Windows editor Job Object supervisor escaped its private root.");
  }
  return Object.freeze({
    executable,
    canonicalExecutable: realpathSync(executable),
    buildRoot,
    canonicalBuildRoot: realpathSync(buildRoot),
    outputDirectory,
    rootSnapshot,
    parentSnapshot,
    executableSnapshot: snapshot,
    executableSha256: windowsJobSupervisorDigest(executable, snapshot)
  });
}

function assertWindowsEditorProcessSupervisorReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("The Windows editor Job Object supervisor has no immutable preparation receipt.");
  }
  const currentRoot = lstatSync(receipt.buildRoot, { bigint: true });
  const currentParent = lstatSync(receipt.outputDirectory, { bigint: true });
  const currentExecutable = lstatSync(receipt.executable, { bigint: true });
  if (
    !sameDirectoryPathIdentity(currentRoot, receipt.rootSnapshot) ||
    !sameImmutablePathSnapshot(currentParent, receipt.parentSnapshot) ||
    !sameImmutablePathSnapshot(currentExecutable, receipt.executableSnapshot) ||
    !currentRoot.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    !currentParent.isDirectory() ||
    currentParent.isSymbolicLink() ||
    !currentExecutable.isFile() ||
    currentExecutable.isSymbolicLink() ||
    currentExecutable.nlink !== 1n ||
    realpathSync(receipt.buildRoot) !== receipt.canonicalBuildRoot ||
    realpathSync(receipt.executable) !== receipt.canonicalExecutable ||
    relative(receipt.buildRoot, receipt.outputDirectory).startsWith("..") ||
    windowsJobSupervisorDigest(receipt.executable, receipt.executableSnapshot) !== receipt.executableSha256
  ) {
    throw new Error("The prepared Windows editor Job Object supervisor changed before launch.");
  }
  return receipt.executable;
}

function windowsJobSupervisorDigest(path, expectedSnapshot) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = openSync(path, flags);
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new Error("The compiled Windows editor Job Object supervisor may not be a symbolic link.", {
        cause: error
      });
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const pathSnapshot = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size <= 0n ||
      opened.size > BigInt(WINDOWS_JOB_EXECUTABLE_MAX_BYTES) ||
      pathSnapshot.isSymbolicLink() ||
      !sameImmutablePathSnapshot(opened, pathSnapshot) ||
      !sameImmutablePathSnapshot(opened, expectedSnapshot)
    ) {
      throw new Error("The compiled Windows editor Job Object supervisor changed before it could be read.");
    }

    const content = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) {
        throw new Error("The compiled Windows editor Job Object supervisor ended before its attested size.");
      }
      offset += count;
    }

    const completed = fstatSync(descriptor, { bigint: true });
    const finalPathSnapshot = lstatSync(path, { bigint: true });
    if (
      !sameImmutablePathSnapshot(completed, opened) ||
      finalPathSnapshot.isSymbolicLink() ||
      !sameImmutablePathSnapshot(finalPathSnapshot, opened)
    ) {
      throw new Error("The compiled Windows editor Job Object supervisor changed while it was read.");
    }
    return createHash("sha256").update(content).digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function sameDirectoryPathIdentity(current, expected) {
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.mode === expected.mode &&
    current.birthtimeNs === expected.birthtimeNs
  );
}

function sameImmutablePathSnapshot(current, expected) {
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.mode === expected.mode &&
    current.nlink === expected.nlink &&
    current.size === expected.size &&
    current.mtimeNs === expected.mtimeNs &&
    current.ctimeNs === expected.ctimeNs &&
    current.birthtimeNs === expected.birthtimeNs
  );
}

export function spawnOwnedEditorProcess(
  executable,
  args,
  options,
  { platform = process.platform, spawnProcess = spawn, supervisorPath, supervisorReceipt } = {}
) {
  if (platform !== "win32") return spawnProcess(executable, args, options);

  const attestationToken = randomUUID();
  const environment = Object.fromEntries(
    Object.entries(options.env ?? {}).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(`Windows editor job environment value ${JSON.stringify(key)} must be a string.`);
      }
      return [key, value];
    })
  );
  const launchFrame = `${JSON.stringify({
    protocol: 1,
    command: "launch",
    executable,
    args,
    cwd: options.cwd ?? process.cwd(),
    environment,
    attestationToken
  })}\n`;
  if (Buffer.byteLength(launchFrame, "utf8") > WINDOWS_JOB_LAUNCH_FRAME_MAX_BYTES) {
    throw new Error(`Windows editor job launch metadata exceeds ${WINDOWS_JOB_LAUNCH_FRAME_MAX_BYTES} bytes.`);
  }

  let supervisor;
  let supervisorArgs;
  if (supervisorReceipt) {
    supervisor = assertWindowsEditorProcessSupervisorReceipt(supervisorReceipt);
    supervisorArgs = [];
  } else if (supervisorPath) {
    const systemRoot = environment.SYSTEMROOT ?? environment.SystemRoot ?? environment.WINDIR ?? "C:\\Windows";
    supervisor = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    supervisorArgs = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      supervisorPath
    ];
  } else {
    throw new Error("The Windows editor Job Object supervisor was not prepared before launch.");
  }
  const child = spawnProcess(supervisor, supervisorArgs, {
    ...options,
    detached: false,
    windowsHide: true,
    stdio: windowsSupervisorStdio(options.stdio)
  });
  if (!child.stdin || typeof child.stdin.write !== "function") {
    throw abandonUnverifiedWindowsSupervisor(
      child,
      "The Windows editor job supervisor did not expose its private control pipe."
    );
  }

  let controlError;
  let terminationRequest;
  if (!child.stderr || typeof child.stderr.pipe !== "function") {
    throw abandonUnverifiedWindowsSupervisor(
      child,
      "The Windows editor job supervisor did not expose its private stderr protocol pipe."
    );
  }
  const stderrProtocol = createWindowsJobStderrProtocol(child.stderr, attestationToken);
  const attestation = stderrProtocol.attestation;
  Object.defineProperty(child, WINDOWS_JOB_CAPTURE_STDERR, {
    value: stderrProtocol.output
  });
  child.stdin.on("error", (error) => {
    controlError ??= error;
  });
  child.stdin.write(launchFrame, "utf8", (error) => {
    controlError ??= error;
  });
  const ownership = {
    verificationLost: false,
    async verifyEmpty(timeoutMs) {
      if (ownership.verificationLost) return false;
      let observed;
      try {
        observed = await promiseWithDeadline(
          attestation,
          timeoutMs,
          `Windows editor Job Object attestation exceeded ${timeoutMs} ms.`
        );
      } catch (error) {
        ownership.verificationLost = true;
        throw error;
      }
      if (!observed || ownership.verificationLost) {
        ownership.verificationLost = true;
        return false;
      }
      return true;
    },
    terminate(force) {
      if (force) {
        ownership.verificationLost = true;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return Promise.resolve();
      }
      if (terminationRequest) return terminationRequest;
      terminationRequest = new Promise((resolveTermination, rejectTermination) => {
        if (controlError) {
          rejectTermination(controlError);
          return;
        }
        if (!child.stdin.writable) {
          rejectTermination(new Error("The Windows editor job supervisor control pipe closed before termination."));
          return;
        }
        child.stdin.write('{"protocol":1,"command":"terminate"}\n', "utf8", (error) => {
          if (error) rejectTermination(error);
          else resolveTermination();
        });
      });
      return terminationRequest;
    }
  };
  Object.defineProperty(child, WINDOWS_JOB_OWNERSHIP, {
    value: ownership
  });
  return child;
}

function windowsSupervisorStdio(stdio) {
  if (stdio === undefined || stdio === "pipe") return ["pipe", "pipe", "pipe"];
  if (!Array.isArray(stdio)) {
    throw new Error("Windows-owned editor processes require a piped stderr protocol channel.");
  }
  if ((stdio[2] ?? "pipe") !== "pipe") {
    throw new Error("Windows-owned editor processes require piped stderr; inherit and ignore are unsafe.");
  }
  return ["pipe", stdio[1] ?? "pipe", "pipe"];
}

function createWindowsJobStderrProtocol(stream, token) {
  const marker = Buffer.from(`${WINDOWS_JOB_ATTESTATION_PREFIX}${token}\n`, "ascii");
  let pending = Buffer.alloc(0);
  let markerCount = 0;
  let settled = false;
  let resolveAttestation;
  const attestation = new Promise((resolve) => {
    resolveAttestation = resolve;
  });
  const settle = (value) => {
    if (settled) return;
    settled = true;
    resolveAttestation(value);
  };
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const combined = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
        let offset = 0;
        while (true) {
          const match = combined.indexOf(marker, offset);
          if (match < 0) break;
          if (match > offset) this.push(combined.subarray(offset, match));
          markerCount += 1;
          offset = match + marker.length;
        }
        const remaining = combined.subarray(offset);
        const publishLength = Math.max(0, remaining.length - (marker.length - 1));
        if (publishLength > 0) this.push(remaining.subarray(0, publishLength));
        pending = Buffer.from(remaining.subarray(publishLength));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      if (pending.length > 0) this.push(pending);
      pending = Buffer.alloc(0);
      settle(markerCount === 1);
      callback();
    }
  });
  output.once("error", () => settle(false));
  output.once("close", () => settle(false));
  stream.once("error", (error) => {
    settle(false);
    output.destroy(error);
  });
  stream.once("close", () => {
    if (!output.writableEnded && !output.destroyed) {
      settle(false);
      output.destroy();
    }
  });
  stream.pipe(output);
  return { attestation, output };
}

function capturedEditorStderr(child) {
  return child[WINDOWS_JOB_CAPTURE_STDERR] ?? child.stderr;
}

function abandonUnverifiedWindowsSupervisor(child, message) {
  for (const stream of new Set([child.stdin, child.stdout, child.stderr])) {
    try {
      stream?.destroy?.();
    } catch {
      // Ownership remains explicitly unverified below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Ownership remains explicitly unverified below.
  }
  return unverifiedEditorProcessTreeError(message);
}

export async function runBoundedEditorCommand(
  { executable, args = [], environment = createEditorAcceptanceEnvironment(), label = "Editor command" },
  {
    platform = process.platform,
    spawnProcess,
    timeoutMs = 60_000,
    maxOutputBytes = EDITOR_COMMAND_OUTPUT_MAX_BYTES,
    terminationGraceMs = EDITOR_COMMAND_TERMINATION_GRACE_MS,
    killGraceMs = EDITOR_COMMAND_KILL_GRACE_MS,
    windowsTreeKill,
    windowsTreeKillTimeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS,
    signalSource = process,
    now = () => performance.now()
  } = {}
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("An editor command timeout must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > EDITOR_COMMAND_OUTPUT_MAX_BYTES
  ) {
    throw new Error(
      `An editor command output limit must be a positive safe integer no larger than ${EDITOR_COMMAND_OUTPUT_MAX_BYTES}.`
    );
  }

  const startedAt = now();
  let supervisorReceipt;
  try {
    supervisorReceipt =
      platform === "win32" && !spawnProcess
        ? await prepareWindowsEditorProcessSupervisor(environment, {
            platform,
            buildTimeoutMs: Math.min(timeoutMs, WINDOWS_JOB_BUILD_TIMEOUT_MS)
          })
        : undefined;
  } catch (error) {
    throw editorCommandError(
      label,
      "could not prepare its owned Windows Job Object supervisor",
      startedAt,
      "",
      "",
      error
    );
  }
  const preparationElapsedMs = Math.max(0, now() - startedAt);
  const remainingTimeoutMs = Math.max(0, timeoutMs - preparationElapsedMs);
  if (remainingTimeoutMs <= 0) {
    throw editorCommandError(
      label,
      `timed out after ${timeoutMs} ms during owned-process preparation`,
      startedAt,
      "",
      ""
    );
  }
  let child;
  try {
    const launchProcess = spawnProcess ?? spawnOwnedEditorProcess;
    child = launchProcess(
      executable,
      args,
      {
        detached: platform !== "win32",
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      },
      { platform, supervisorReceipt }
    );
  } catch (error) {
    if (supervisorReceipt && editorProcessTreeMayBeLive(error)) {
      unsafeWindowsJobSupervisorRoots.add(supervisorReceipt.buildRoot);
    }
    throw editorCommandError(label, "could not start", startedAt, "", "", error);
  }

  const remainingObservationTimeoutMs = Math.max(0, timeoutMs - Math.max(0, now() - startedAt));

  const output = createBoundedCommandOutput(maxOutputBytes);
  let resolveOverflow;
  const overflow = new Promise((resolveOverflowObservation) => {
    resolveOverflow = resolveOverflowObservation;
  });
  const onStdout = (chunk) => {
    if (!output.append("stdout", chunk)) resolveOverflow({ kind: "output-limit" });
  };
  const onStderr = (chunk) => {
    if (!output.append("stderr", chunk)) resolveOverflow({ kind: "output-limit" });
  };
  const capturedStderr = capturedEditorStderr(child);
  child.stdout?.on("data", onStdout);
  capturedStderr?.on("data", onStderr);

  let exitState;
  const exit = childExit(child).then((state) => (exitState ??= state));
  const close = childClose(child).then((state) => (exitState ??= state));
  let interruptedSignal;
  let resolveInterruption;
  const interruption = new Promise((resolveInterrupted) => {
    resolveInterruption = resolveInterrupted;
  });
  const recordInterruption = (signal) => {
    if (interruptedSignal) {
      void signalEditorTree(
        child,
        () => child.exitCode === null && child.signalCode === null && child.pid !== undefined,
        platform !== "win32",
        "SIGKILL",
        platform,
        windowsTreeKill,
        windowsTreeKillTimeoutMs
      ).catch(() => undefined);
      return;
    }
    interruptedSignal = signal;
    resolveInterruption({ kind: "interrupted", signal });
  };
  const onSigint = () => recordInterruption("SIGINT");
  const onSigterm = () => recordInterruption("SIGTERM");
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  let timeout;
  let observation;
  try {
    observation =
      remainingObservationTimeoutMs <= 0
        ? { kind: "timeout" }
        : await Promise.race([
            close.then((state) => ({ kind: "exit", state })),
            overflow,
            interruption,
            new Promise((resolveTimeout) => {
              timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), remainingObservationTimeoutMs);
            })
          ]);
  } finally {
    clearTimeout(timeout);
  }

  const isRunning = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  let terminationError;
  let stdioError;
  try {
    await terminateEditorChild(child, exit, isRunning, platform !== "win32", 0, {
      platform,
      windowsTreeKill,
      windowsTreeKillTimeoutMs,
      terminationGraceMs,
      killGraceMs
    });
  } catch (error) {
    terminationError = error;
  } finally {
    signalSource.off("SIGINT", onSigint);
    signalSource.off("SIGTERM", onSigterm);
    child.stdout?.off("data", onStdout);
    capturedStderr?.off("data", onStderr);
    try {
      destroyCapturedCommandStdio(child);
    } catch (error) {
      stdioError = error;
    }
  }

  const outputExceeded = output.exceeded();
  const stdout = outputExceeded ? "" : output.text("stdout");
  const stderr = outputExceeded ? "" : output.text("stderr");
  let commandFailure;
  if (observation.kind === "exit" && outputExceeded) {
    commandFailure = editorCommandError(
      label,
      `exceeded its ${maxOutputBytes}-byte combined output limit`,
      startedAt,
      stdout,
      stderr
    );
  } else if (observation.kind === "timeout") {
    commandFailure = editorCommandError(label, `timed out after ${timeoutMs} ms`, startedAt, stdout, stderr);
  } else if (observation.kind === "output-limit") {
    commandFailure = editorCommandError(
      label,
      `exceeded its ${maxOutputBytes}-byte combined output limit`,
      startedAt,
      stdout,
      stderr
    );
  } else if (observation.kind === "interrupted") {
    commandFailure = editorCommandError(label, `was interrupted by ${observation.signal}`, startedAt, stdout, stderr);
  } else if (observation.state?.error) {
    commandFailure = editorCommandError(
      label,
      "failed while starting",
      startedAt,
      stdout,
      stderr,
      observation.state.error
    );
  } else if (observation.state?.code !== 0) {
    commandFailure = editorCommandError(
      label,
      `exited with code ${String(observation.state?.code)} and signal ${String(observation.state?.signal ?? "none")}`,
      startedAt,
      stdout,
      stderr
    );
  }

  const resourceFailures = [terminationError, stdioError].filter(Boolean);
  if (resourceFailures.length > 0) {
    if (supervisorReceipt && resourceFailures.some((error) => editorProcessTreeMayBeLive(error))) {
      unsafeWindowsJobSupervisorRoots.add(supervisorReceipt.buildRoot);
    }
    const failure = new AggregateError(
      [commandFailure, ...resourceFailures].filter(Boolean),
      `${label} failed or did not release all owned process resources.`
    );
    failure.code = EDITOR_COMMAND_RESOURCE_FAILURE_CODE;
    throw failure;
  }
  if (commandFailure) throw commandFailure;
  return { stdout, stderr };
}

export async function runBoundedEditorCliCommand(
  { editor, args = [], environment = createEditorAcceptanceEnvironment(), label = "Editor CLI command" },
  {
    platform = process.platform,
    lstatPath = lstatSync,
    realpathPath = realpathSync,
    readInstallationEntries = readBoundedWindowsEditorInstallationEntries,
    ...commandOptions
  } = {}
) {
  const launch = resolveEditorCliLaunch(editor, environment, {
    platform,
    lstatPath,
    realpathPath,
    readInstallationEntries
  });
  return runBoundedEditorCommand(
    {
      executable: launch.executable,
      args: [...launch.argsPrefix, ...args],
      environment: launch.environment,
      label
    },
    { ...commandOptions, platform }
  );
}

function destroyCapturedCommandStdio(child) {
  const errors = [];
  for (const stream of new Set([child.stdin, child.stdout, child.stderr, capturedEditorStderr(child)])) {
    if (!stream || typeof stream.destroy !== "function") continue;
    try {
      stream.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Captured editor command pipes could not be destroyed.");
}

function createBoundedCommandOutput(maximumBytes) {
  const buffers = {
    stdout: Buffer.allocUnsafe(maximumBytes),
    stderr: Buffer.allocUnsafe(maximumBytes)
  };
  const lengths = { stdout: 0, stderr: 0 };
  let retainedBytes = 0;
  let exceeded = false;
  return {
    append(stream, chunk) {
      if (exceeded) return false;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximumBytes - retainedBytes;
      const retained = Math.min(buffer.length, remaining);
      if (retained > 0) {
        buffer.copy(buffers[stream], lengths[stream], 0, retained);
        lengths[stream] += retained;
        retainedBytes += retained;
      }
      if (buffer.length > remaining) {
        exceeded = true;
        return false;
      }
      return true;
    },
    text(stream) {
      if (exceeded) return "";
      return buffers[stream].subarray(0, lengths[stream]).toString("utf8");
    },
    exceeded() {
      return exceeded;
    }
  };
}

function editorCommandError(label, detail, startedAt, stdout, stderr, cause) {
  const output = [stdout.trim() ? `stdout:\n${stdout.trim()}` : "", stderr.trim() ? `stderr:\n${stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n");
  const message = `${label} ${detail} after ${Math.max(0, Math.round(performance.now() - startedAt))} ms.${output ? `\n${output}` : ""}`;
  return new Error(message, cause ? { cause } : undefined);
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
	const crypto = require("node:crypto");
	const vscode = require("vscode");

	function publishProgressFile(targetPath, contents) {
	  const temporaryPath = targetPath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
	  try {
	    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
	    const temporary = fs.lstatSync(temporaryPath, { bigint: true });
	    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1n) {
	      throw new Error("The editor acceptance progress temporary is not exclusively owned.");
	    }
	    fs.renameSync(temporaryPath, targetPath);
	  } finally {
	    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
	  }
	}

	function recordProgress(runId, phase, checkpoint) {
	  const progressPath = process.env.OPEN_WRANGLER_TEST_PROGRESS;
	  if (!progressPath) return;
	  const serialized = JSON.stringify({ protocol: ${EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL}, runId, phase, checkpoint }) + "\\n";
	  if (Buffer.byteLength(serialized, "utf8") > ${EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES}) {
	    throw new Error("The editor acceptance progress envelope exceeded its fixed byte limit.");
	  }
	  publishProgressFile(progressPath, serialized);
	  const signalPath = progressPath + "." + runId.replaceAll("-", "") + "." + phase + ".heartbeat";
	  publishProgressFile(signalPath, "");
	}

const EDITOR_HARNESS_ERROR_MAX_CHARACTERS = ${EDITOR_HARNESS_ERROR_MAX_CHARACTERS};
const EDITOR_HARNESS_RESULT_MAX_BYTES = ${EDITOR_HARNESS_RESULT_MAX_BYTES};
const OVERSIZED_EDITOR_DIAGNOSTIC = ${JSON.stringify(OVERSIZED_EDITOR_DIAGNOSTIC)};
const describeFailure = ${describeEditorAcceptanceHarnessFailure.toString()};
const serializeOutcome = ${serializeEditorAcceptanceHarnessOutcome.toString()};

exports.activate = async function (context) {
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE || "unknown";
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID || "missing-run-id";
  const envelope = { protocol: 1, runId, phase };
  recordProgress(runId, phase, phase + ":harness-start");
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
    outcome = { ...envelope, ok: true };
  } catch (error) {
    const description = describeFailure(error);
    outcome = { ...envelope, ok: false, error: description };
  }
  const resultPath = process.env.OPEN_WRANGLER_TEST_RESULT;
  const temporaryResultPath = resultPath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporaryResultPath, serializeOutcome(outcome, envelope), { encoding: "utf8", flag: "wx" });
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

export function createAcceptanceProgressEnvelope(runId, phase, checkpoint) {
  const envelope = {
    protocol: EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL,
    runId,
    phase,
    checkpoint
  };
  validateAcceptanceProgressEnvelope(envelope);
  return envelope;
}

export function editorAcceptanceProgressPath(resultPath, runId, phase) {
  createAcceptanceProgressEnvelope(runId, phase, "path-reservation");
  if (typeof resultPath !== "string" || resultPath.length === 0 || /[\0\r\n]/u.test(resultPath)) {
    throw new Error("An editor acceptance result path must be a non-empty single-line filesystem path.");
  }
  return `${resultPath}.${runId}.${phase}.progress`;
}

export function editorAcceptanceProgressSignalPath(progressPath, runId, phase) {
  createAcceptanceProgressEnvelope(runId, phase, "signal-path-reservation");
  if (typeof progressPath !== "string" || progressPath.length === 0 || /[\0\r\n]/u.test(progressPath)) {
    throw new Error("An editor acceptance progress path must be a non-empty single-line filesystem path.");
  }
  return `${progressPath}.${runId.replaceAll("-", "")}.${phase}.heartbeat`;
}

export async function runEditorAcceptancePhase(
  {
    editor,
    workspace,
    userData,
    extensions,
    developmentPaths,
    testModule,
    python,
    phase,
    resultPath,
    runId = randomUUID(),
    progressPath = editorAcceptanceProgressPath(resultPath, runId, phase)
  },
  {
    spawnProcess,
    environment = process.env,
    now = () => performance.now(),
    wait = delay,
    phaseTimeoutMs = EDITOR_ACCEPTANCE_PHASE_TIMEOUT_MS,
    inactivityTimeoutMs = EDITOR_ACCEPTANCE_INACTIVITY_TIMEOUT_MS,
    gracefulExitMs = 3_500,
    outputCloseTimeoutMs = EDITOR_OUTPUT_CLOSE_TIMEOUT_MS,
    platform = process.platform,
    windowsTreeKill,
    windowsTreeKillTimeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS,
    reserveDebugPort = reserveEditorDebugPort
  } = {}
) {
  const expectedProgressPath = editorAcceptanceProgressPath(resultPath, runId, phase);
  if (progressPath !== expectedProgressPath) {
    throw new Error("An editor acceptance progress path must be the unique path derived for its run and phase.");
  }
  const startedAt = now();
  rmSync(resultPath, { force: true });
  rmSync(progressPath, { force: true });
  const progressCorrelation = { runId, phase };
  const displayMode = platform === "linux" ? editorDisplayMode(environment) : undefined;
  const progressReader = platform === "win32" ? acceptanceProgressFileSnapshot : acceptanceProgressCheckpoint;
  const progressReadOptions = { expectedRunId: runId, expectedPhase: phase };
  writeAcceptanceProgress(
    progressPath,
    createAcceptanceProgressEnvelope(progressCorrelation.runId, progressCorrelation.phase, `${phase}:runner-spawn`)
  );
  const initialProgressCheckpoint = progressReader(progressPath, progressReadOptions);
  const initialProgressAt = now();
  const deadlineState = () => {
    const currentTime = now();
    const phaseElapsedMs = Math.max(0, currentTime - startedAt);
    const inactivityElapsedMs = Math.max(0, currentTime - initialProgressAt);
    if (phaseElapsedMs >= phaseTimeoutMs) {
      return { expired: true, kind: "phase", phaseElapsedMs, inactivityElapsedMs, remainingMs: 0 };
    }
    if (inactivityElapsedMs >= inactivityTimeoutMs) {
      return { expired: true, kind: "inactivity", phaseElapsedMs, inactivityElapsedMs, remainingMs: 0 };
    }
    const remainingPhaseMs = phaseTimeoutMs - phaseElapsedMs;
    const remainingInactivityMs = inactivityTimeoutMs - inactivityElapsedMs;
    return {
      expired: false,
      kind: remainingPhaseMs <= remainingInactivityMs ? "phase" : "inactivity",
      phaseElapsedMs,
      inactivityElapsedMs,
      remainingMs: Math.min(remainingPhaseMs, remainingInactivityMs)
    };
  };
  const deadlineDescription = (kind) =>
    kind === "inactivity" ? `${inactivityTimeoutMs} ms without a new checkpoint` : `${phaseTimeoutMs} ms phase limit`;
  let supervisorReceipt;
  const supervisorDeadline = deadlineState();
  if (supervisorDeadline.expired) {
    throw createEditorAcceptanceFailure(
      "outer-timeout",
      `${editor.name} ${phase} acceptance timed out after ${deadlineDescription(supervisorDeadline.kind)} during owned-process preparation.`,
      {
        editor,
        phase,
        elapsedMs: supervisorDeadline.phaseElapsedMs,
        resultPath,
        progressPath,
        platform,
        displayMode,
        runId,
        timeoutKind: supervisorDeadline.kind
      }
    );
  }
  try {
    supervisorReceipt =
      platform === "win32" && !spawnProcess
        ? await prepareWindowsEditorProcessSupervisor(environment, {
            platform,
            buildTimeoutMs: Math.max(
              1,
              Math.min(Math.ceil(supervisorDeadline.remainingMs), WINDOWS_JOB_BUILD_TIMEOUT_MS)
            )
          })
        : undefined;
  } catch (error) {
    const deadline = deadlineState();
    const timedOut = deadline.expired;
    throw createEditorAcceptanceFailure(
      timedOut ? "outer-timeout" : "spawn-failure",
      timedOut
        ? `${editor.name} ${phase} acceptance timed out after ${deadlineDescription(deadline.kind)} during owned-process preparation.`
        : `${editor.name} ${phase} acceptance could not prepare its owned Windows Job Object supervisor: ${error instanceof Error ? error.message : String(error)}`,
      {
        editor,
        phase,
        elapsedMs: deadline.phaseElapsedMs,
        resultPath,
        progressPath,
        platform,
        displayMode,
        runId,
        ...(timedOut ? { timeoutKind: deadline.kind } : {}),
        exitState: { error },
        ...(editorProcessTreeMayBeLive(error) ? { treeVerifiedStopped: false, readProgress: false } : {})
      },
      error
    );
  }
  let cdpPort;
  if (phase === "verify" || environment.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
    const portDeadline = deadlineState();
    if (portDeadline.expired) {
      throw createEditorAcceptanceFailure(
        "outer-timeout",
        `${editor.name} ${phase} acceptance timed out after ${deadlineDescription(portDeadline.kind)} during debugging-port reservation.`,
        {
          editor,
          phase,
          elapsedMs: portDeadline.phaseElapsedMs,
          resultPath,
          progressPath,
          platform,
          displayMode,
          runId,
          timeoutKind: portDeadline.kind
        }
      );
    }
    try {
      cdpPort = await reserveDebugPort(Math.max(1, Math.floor(portDeadline.remainingMs)));
    } catch (error) {
      const completedDeadline = deadlineState();
      const timedOut =
        completedDeadline.expired ||
        (error && typeof error === "object" && error.code === "EDITOR_ACCEPTANCE_DEADLINE");
      const timeoutKind = completedDeadline.expired ? completedDeadline.kind : portDeadline.kind;
      throw createEditorAcceptanceFailure(
        timedOut ? "outer-timeout" : "spawn-failure",
        timedOut
          ? `${editor.name} ${phase} acceptance timed out after ${deadlineDescription(timeoutKind)} during debugging-port reservation.`
          : `${editor.name} ${phase} acceptance could not reserve its private debugging port: ${error instanceof Error ? error.message : String(error)}`,
        {
          editor,
          phase,
          elapsedMs: completedDeadline.phaseElapsedMs,
          resultPath,
          progressPath,
          platform,
          displayMode,
          runId,
          ...(timedOut ? { timeoutKind } : {}),
          exitState: { error }
        },
        error
      );
    }
  }
  const sandboxArgs = [
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    ...editorDisplayLaunchArgs(platform, environment)
  ];
  const sharedDataArgs = editor.sharedDataDir ? ["--shared-data-dir", resolve(userData, "shared-data")] : [];
  const beforeSpawnDeadline = deadlineState();
  if (beforeSpawnDeadline.expired) {
    throw createEditorAcceptanceFailure(
      "outer-timeout",
      `${editor.name} ${phase} acceptance timed out after ${deadlineDescription(beforeSpawnDeadline.kind)} during owned-process preparation.`,
      {
        editor,
        phase,
        elapsedMs: beforeSpawnDeadline.phaseElapsedMs,
        resultPath,
        progressPath,
        platform,
        displayMode,
        runId,
        timeoutKind: beforeSpawnDeadline.kind
      }
    );
  }
  let child;
  try {
    const launchProcess = spawnProcess ?? spawnOwnedEditorProcess;
    child = launchProcess(
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
        detached: platform !== "win32",
        env: createEditorAcceptanceEnvironmentForPlatform(
          environment,
          {
            OPEN_WRANGLER_EXTENSION_TESTS: "1",
            OPEN_WRANGLER_TEST_PHASE: phase,
            OPEN_WRANGLER_TEST_EDITOR: editor.key ?? editor.name.toLowerCase().replaceAll(" ", "-"),
            ...(cdpPort ? { OPEN_WRANGLER_EDITOR_CDP_PORT: String(cdpPort) } : {}),
            OPEN_WRANGLER_TEST_PYTHON: python,
            OPEN_WRANGLER_TEST_MODULE: testModule,
            OPEN_WRANGLER_TEST_RESULT: resultPath,
            OPEN_WRANGLER_TEST_PROGRESS: progressPath,
            OPEN_WRANGLER_TEST_RUN_ID: runId,
            OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS: environment.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
          },
          platform
        ),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      },
      { platform, supervisorReceipt }
    );
  } catch (error) {
    const completedDeadline = deadlineState();
    const timedOut = completedDeadline.expired;
    const treeMayBeLive = editorProcessTreeMayBeLive(error);
    if (supervisorReceipt && treeMayBeLive) {
      unsafeWindowsJobSupervisorRoots.add(supervisorReceipt.buildRoot);
    }
    throw createEditorAcceptanceFailure(
      timedOut ? "outer-timeout" : "spawn-failure",
      timedOut
        ? `${editor.name} ${phase} acceptance timed out after ${deadlineDescription(completedDeadline.kind)} during owned-process launch.`
        : `${editor.name} ${phase} acceptance could not start: ${error instanceof Error ? error.message : String(error)}`,
      {
        editor,
        phase,
        elapsedMs: completedDeadline.phaseElapsedMs,
        resultPath,
        progressPath,
        platform,
        displayMode,
        runId,
        ...(timedOut ? { timeoutKind: completedDeadline.kind } : {}),
        exitState: { error },
        ...(treeMayBeLive ? { treeVerifiedStopped: false, readProgress: false } : {})
      },
      error
    );
  }

  const editorOutput = createBoundedCommandOutput(EDITOR_COMMAND_OUTPUT_MAX_BYTES);
  const onEditorStdout = (chunk) => editorOutput.append("stdout", chunk);
  const onEditorStderr = (chunk) => editorOutput.append("stderr", chunk);
  const capturedEditorError = capturedEditorStderr(child);
  child.stdout?.on("data", onEditorStdout);
  capturedEditorError?.on("data", onEditorStderr);

  let exitState;
  const exit = childExit(child).then((state) => (exitState ??= state));
  const close = childClose(child);
  const isRunning = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  const ownsProcessGroup = platform !== "win32";
  let interruptedSignal;
  const recordInterruption = (signal) => {
    if (interruptedSignal) {
      void signalEditorTree(
        child,
        isRunning,
        ownsProcessGroup,
        "SIGKILL",
        platform,
        windowsTreeKill,
        windowsTreeKillTimeoutMs
      ).catch(() => undefined);
      return;
    }
    interruptedSignal = signal;
  };
  const onSigint = () => recordInterruption("SIGINT");
  const onSigterm = () => recordInterruption("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const observationStartedAfterMs = Math.max(0, now() - startedAt);
  const remainingPhaseTimeoutMs = Math.max(0, phaseTimeoutMs - observationStartedAfterMs);
  let outcome;
  let failure;
  let resultContext;
  try {
    const observation = await waitForEditorAcceptanceObservation({
      resultPath,
      progressPath,
      exit,
      isRunning,
      isInterrupted: () => interruptedSignal,
      now,
      wait,
      phaseTimeoutMs: remainingPhaseTimeoutMs,
      inactivityTimeoutMs,
      runId,
      phase,
      progressReader,
      initialProgressCheckpoint,
      progressStartedAt: initialProgressAt
    });
    const context = {
      editor,
      phase,
      elapsedMs: observationStartedAfterMs + observation.elapsedMs,
      resultPath,
      progressPath,
      platform,
      displayMode,
      runId,
      exitState: observation.exitState,
      resultSnapshot: observation.resultSnapshot
    };
    if (observation.kind === "interrupted") {
      failure = {
        kind: "interrupted",
        summary: `${editor.name} ${phase} acceptance was interrupted by ${observation.signal}.`,
        context
      };
    } else if (observation.kind === "timeout") {
      const timeoutDescription =
        observation.timeout === "inactivity"
          ? `${inactivityTimeoutMs} ms without a new checkpoint`
          : `${phaseTimeoutMs} ms phase limit`;
      failure = {
        kind: "outer-timeout",
        summary: `${editor.name} ${phase} acceptance timed out after ${timeoutDescription}.`,
        context: { ...context, timeoutKind: observation.timeout }
      };
    } else if (observation.kind === "exit") {
      const spawnError = observation.exitState?.error;
      failure = {
        kind: spawnError ? "spawn-failure" : "premature-exit",
        summary: spawnError
          ? `${editor.name} ${phase} acceptance could not start: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
          : `${editor.name} ${phase} acceptance exited before writing a result.`,
        context,
        cause: spawnError
      };
    } else resultContext = context;
  } catch (error) {
    failure = {
      kind: "runner-failure",
      summary: `${editor.name} ${phase} acceptance runner failed: ${error instanceof Error ? error.message : String(error)}`,
      context: {
        editor,
        phase,
        elapsedMs: Math.max(0, now() - startedAt),
        resultPath,
        progressPath,
        platform,
        displayMode,
        runId,
        exitState
      },
      cause: error
    };
  }

  let shutdownError;
  let outputCloseError;
  let outputCleanupError;
  try {
    await terminateEditorChild(child, exit, isRunning, ownsProcessGroup, interruptedSignal ? 0 : gracefulExitMs, {
      platform,
      windowsTreeKill,
      windowsTreeKillTimeoutMs
    });
  } catch (error) {
    shutdownError = error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (!shutdownError) {
      try {
        await promiseWithDeadline(
          close,
          outputCloseTimeoutMs,
          `Captured editor output did not close within ${outputCloseTimeoutMs} ms.`
        );
      } catch (error) {
        outputCloseError = unverifiedEditorProcessTreeError(
          "The spawned editor's captured output streams did not reach a verified close.",
          error
        );
      }
    }
    child.stdout?.off("data", onEditorStdout);
    capturedEditorError?.off("data", onEditorStderr);
    try {
      destroyCapturedCommandStdio(child);
    } catch (error) {
      outputCleanupError = error;
    }
  }
  const cleanupErrors = [shutdownError, outputCloseError, outputCleanupError].filter(Boolean);
  const cleanupError =
    cleanupErrors.length > 1
      ? new AggregateError(cleanupErrors, "Editor tree or captured output cleanup failed.")
      : cleanupErrors[0];
  const retainedEditorOutput =
    shutdownError || outputCloseError ? INCOMPLETE_EDITOR_OUTPUT_DIAGNOSTIC : sanitizeEditorPhaseOutput(editorOutput);
  const processResourcesUnverified = editorProcessTreeMayBeLive(cleanupError);
  if (supervisorReceipt && processResourcesUnverified) {
    unsafeWindowsJobSupervisorRoots.add(supervisorReceipt.buildRoot);
  }

  if (resultContext && !failure) {
    if (shutdownError || outputCloseError) {
      failure = {
        kind: "result-protocol-failure",
        summary: `${editor.name} ${phase} acceptance result was not opened because its editor process resources did not close cleanly.`,
        context: {
          ...resultContext,
          ...(processResourcesUnverified ? { readProgress: false, treeVerifiedStopped: false } : {}),
          ...(retainedEditorOutput ? { editorOutput: retainedEditorOutput } : {})
        }
      };
    } else {
      try {
        outcome = JSON.parse(
          readBoundedAcceptanceText(resultPath, EDITOR_ACCEPTANCE_RESULT_MAX_BYTES, "acceptance result", {
            expectedPathSnapshot: resultContext.resultSnapshot
          })
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failure = {
          kind: "result-protocol-failure",
          summary: `${editor.name} ${phase} acceptance wrote an unreadable result: ${detail}`,
          context: resultContext,
          cause: error
        };
      }
      if (!failure && (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean")) {
        failure = {
          kind: "result-protocol-failure",
          summary: `${editor.name} ${phase} acceptance wrote a malformed result payload.`,
          context: resultContext
        };
      }
      if (!failure) {
        const protocolError = validateEditorAcceptanceOutcome(outcome, runId, phase);
        if (protocolError) {
          failure = {
            kind: "result-protocol-failure",
            summary: `${editor.name} ${phase} acceptance wrote a malformed or mis-correlated result: ${protocolError}`,
            context: resultContext
          };
        }
      }
      if (!failure && !outcome.ok) {
        failure = {
          kind: "explicit-test-failure",
          summary: `${editor.name} ${phase} acceptance reported a test failure:\n${sanitizeHarnessFailure(outcome.error)}`,
          context: resultContext
        };
      }
    }
  }

  const cleanupFailure = cleanupError
    ? createEditorAcceptanceCleanupFailure(cleanupError, {
        editor,
        phase,
        elapsedMs: Math.max(0, now() - startedAt),
        resultPath,
        progressPath,
        platform,
        displayMode,
        runId,
        exitState,
        ...(retainedEditorOutput ? { editorOutput: retainedEditorOutput } : {})
      })
    : undefined;

  if (failure) {
    failure.context.exitState ??= exitState;
    if (retainedEditorOutput) failure.context.editorOutput ??= retainedEditorOutput;
    if (processResourcesUnverified) {
      failure.context.readProgress = false;
      failure.context.treeVerifiedStopped = false;
    }
    const acceptanceError = createEditorAcceptanceFailure(
      failure.kind,
      failure.summary,
      failure.context,
      failure.cause
    );
    if (cleanupFailure) {
      throw new AggregateError(
        [acceptanceError, cleanupFailure],
        `${editor.name} ${phase} acceptance failed and its editor process did not shut down cleanly.`
      );
    }
    throw acceptanceError;
  }

  if (cleanupFailure) throw cleanupFailure;
}

export async function waitForEditorAcceptanceObservation({
  resultPath,
  progressPath,
  exit,
  isRunning,
  isInterrupted = () => undefined,
  now = () => performance.now(),
  wait = delay,
  phaseTimeoutMs = EDITOR_ACCEPTANCE_PHASE_TIMEOUT_MS,
  inactivityTimeoutMs = EDITOR_ACCEPTANCE_INACTIVITY_TIMEOUT_MS,
  pollIntervalMs = EDITOR_ACCEPTANCE_POLL_INTERVAL_MS,
  runId,
  phase,
  progressReader = acceptanceProgressCheckpoint,
  initialProgressCheckpoint,
  progressStartedAt
}) {
  const progressReadOptions = {
    ...(runId === undefined ? {} : { expectedRunId: runId }),
    ...(phase === undefined ? {} : { expectedPhase: phase })
  };
  const startedAt = now();
  let checkpoint = initialProgressCheckpoint;
  let checkpointInitialized = initialProgressCheckpoint !== undefined;
  let lastProgressAt = progressStartedAt ?? startedAt;
  const refreshCheckpoint = () => {
    const nextCheckpoint = progressReader(progressPath, progressReadOptions);
    if (!checkpointInitialized) {
      checkpoint = nextCheckpoint;
      checkpointInitialized = true;
    } else if (nextCheckpoint !== undefined && nextCheckpoint !== checkpoint) {
      checkpoint = nextCheckpoint;
      lastProgressAt = now();
    }
  };
  const authoritativeDeadline = () => {
    let currentTime = now();
    let elapsedMs = Math.max(0, currentTime - startedAt);
    if (elapsedMs >= phaseTimeoutMs) return { kind: "timeout", timeout: "phase", elapsedMs };
    if (Math.max(0, currentTime - lastProgressAt) < inactivityTimeoutMs) return undefined;
    try {
      refreshCheckpoint();
    } catch {
      currentTime = now();
      elapsedMs = Math.max(0, currentTime - startedAt);
      if (elapsedMs >= phaseTimeoutMs) return { kind: "timeout", timeout: "phase", elapsedMs };
      return { kind: "timeout", timeout: "inactivity", elapsedMs };
    }
    currentTime = now();
    elapsedMs = Math.max(0, currentTime - startedAt);
    if (elapsedMs >= phaseTimeoutMs) return { kind: "timeout", timeout: "phase", elapsedMs };
    if (Math.max(0, currentTime - lastProgressAt) >= inactivityTimeoutMs) {
      return { kind: "timeout", timeout: "inactivity", elapsedMs };
    }
    return undefined;
  };
  const observeResult = (initialObservation = false) => {
    let deadline = authoritativeDeadline();
    if (deadline) return deadline;
    const resultSnapshot = acceptanceFileSnapshotIfExists(resultPath);
    deadline = authoritativeDeadline();
    if (deadline) return deadline;
    const elapsedMs = Math.max(0, now() - startedAt);
    return resultSnapshot
      ? { kind: "result", elapsedMs: initialObservation ? 0 : elapsedMs, resultSnapshot }
      : { kind: "pending", elapsedMs };
  };
  let resultObservation = observeResult(true);
  if (resultObservation.kind !== "pending") return resultObservation;
  try {
    refreshCheckpoint();
  } catch (error) {
    resultObservation = observeResult();
    if (resultObservation.kind !== "pending") return resultObservation;
    throw error;
  }
  while (true) {
    resultObservation = observeResult();
    if (resultObservation.kind !== "pending") return resultObservation;
    const elapsedMs = resultObservation.elapsedMs;
    const signal = isInterrupted();
    if (signal) return { kind: "interrupted", signal, elapsedMs };
    if (!isRunning()) {
      const observedExit = await exit;
      resultObservation = observeResult();
      if (resultObservation.kind !== "pending") return resultObservation;
      return { kind: "exit", exitState: observedExit, elapsedMs: resultObservation.elapsedMs };
    }

    try {
      refreshCheckpoint();
    } catch (error) {
      resultObservation = observeResult();
      if (resultObservation.kind !== "pending") return resultObservation;
      throw error;
    }
    const currentTime = now();
    const currentElapsedMs = Math.max(0, currentTime - startedAt);
    if (currentElapsedMs >= phaseTimeoutMs) {
      return { kind: "timeout", timeout: "phase", elapsedMs: currentElapsedMs };
    }
    if (Math.max(0, currentTime - lastProgressAt) >= inactivityTimeoutMs) {
      return { kind: "timeout", timeout: "inactivity", elapsedMs: currentElapsedMs };
    }
    await wait(pollIntervalMs);
  }
}

export class EditorAcceptanceFailure extends Error {
  constructor(kind, message, details, options) {
    super(message, options);
    this.name = "EditorAcceptanceFailure";
    this.kind = kind;
    this.details = details;
  }
}

export function editorProcessTreeMayBeLive(error, seen = new Set()) {
  if (seen.size >= 256) return true;
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  try {
    if (error.code === EDITOR_PROCESS_TREE_UNVERIFIED_CODE || error.details?.treeVerifiedStopped === false) {
      return true;
    }
    if (error instanceof AggregateError) {
      for (const nested of error.errors.slice(0, 256)) {
        if (editorProcessTreeMayBeLive(nested, seen)) return true;
      }
      if (error.errors.length > 256) return true;
    }
    if ("cause" in error && editorProcessTreeMayBeLive(error.cause, seen)) return true;
  } catch {
    return true;
  }
  return false;
}

function sanitizeHarnessFailure(value, additionalPrivatePaths = []) {
  let raw;
  try {
    raw = typeof value === "string" ? value : String(value ?? "Unknown error");
  } catch {
    raw = "The acceptance harness failed with an unreadable value.";
  }
  if (raw.length > EDITOR_HARNESS_ERROR_MAX_CHARACTERS) return OVERSIZED_EDITOR_DIAGNOSTIC;
  const repository = process.cwd();
  const replacements = [
    [repository, "<repository>"],
    ...[process.env.HOME, process.env.USERPROFILE].filter(Boolean).map((path) => [path, "<host-home>"]),
    ...additionalPrivatePaths
      .filter((path) => typeof path === "string" && isAbsolute(path))
      .slice(0, 32)
      .map((path) => [path, "<host-home>"])
  ]
    .filter(([source], index, all) => all.findIndex(([candidate]) => candidate === source) === index)
    .sort((left, right) => right[0].length - left[0].length);
  const redacted = redactEditorAcceptanceText(raw, replacements);
  if (redacted === undefined) return "Sensitive harness details were suppressed.";
  return redacted.length > EDITOR_HARNESS_ERROR_MAX_CHARACTERS ? OVERSIZED_EDITOR_DIAGNOSTIC : redacted;
}

function sanitizeEditorPhaseOutput(output) {
  if (output.exceeded()) return OVERSIZED_EDITOR_DIAGNOSTIC;
  const stdout = output.text("stdout").trim();
  const stderr = output.text("stderr").trim();
  const combined = [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n");
  return combined ? sanitizeHarnessFailure(combined) : undefined;
}

function validateEditorAcceptanceOutcome(outcome, runId, phase) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return "the envelope is not an object";
  if (outcome.protocol !== 1) return "the protocol version is not 1";
  if (outcome.runId !== runId) return "the run ID does not match the launched phase";
  if (outcome.phase !== phase) return "the phase does not match the launched phase";
  if (typeof outcome.ok !== "boolean") return "the outcome flag is not boolean";
  const expectedKeys = outcome.ok
    ? ["ok", "phase", "protocol", "runId"]
    : ["error", "ok", "phase", "protocol", "runId"];
  const actualKeys = Object.keys(outcome).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return "the envelope contains missing or unexpected fields";
  }
  if (
    !outcome.ok &&
    (typeof outcome.error !== "string" ||
      outcome.error.length === 0 ||
      outcome.error.length > EDITOR_HARNESS_ERROR_MAX_CHARACTERS + 64)
  ) {
    return "the failure detail is absent, non-text, or oversized";
  }
  return undefined;
}

export function sanitizeEditorAcceptanceDiagnostic(error, additionalPrivatePaths = []) {
  try {
    const summaries = [];
    const pending = [{ value: error, depth: 0 }];
    const seen = new Set();
    let cursor = 0;
    let omitted = false;
    while (cursor < pending.length && summaries.length < 32) {
      const { value, depth, fixedSummary } = pending[cursor];
      cursor += 1;
      if ((typeof value === "object" || typeof value === "function") && value !== null) {
        if (seen.has(value)) continue;
        seen.add(value);
      }
      const summary = fixedSummary ?? boundedEditorDiagnosticSummary(value);
      summaries.push(`${"  ".repeat(Math.min(depth, 8))}${summary}`);
      if (fixedSummary !== undefined || depth >= 8 || !isAggregateError(value)) continue;

      const remainingCapacity = Math.max(0, 32 - summaries.length - (pending.length - cursor));
      const children = boundedAggregateChildren(value, remainingCapacity);
      omitted ||= children.omitted;
      for (const child of children.values) pending.push({ ...child, depth: depth + 1 });
    }
    if (cursor < pending.length || omitted) summaries.push("<additional acceptance failures omitted>");
    return sanitizeHarnessFailure(summaries.join("\n"), additionalPrivatePaths);
  } catch {
    // Diagnostics must never replace the original failure with another exception.
    return UNREADABLE_EDITOR_DIAGNOSTIC;
  }
}

function boundedEditorDiagnosticSummary(value) {
  try {
    if (value instanceof Error) {
      const name = value.name;
      const message = value.message;
      if (typeof name !== "string" || typeof message !== "string") return UNREADABLE_EDITOR_DIAGNOSTIC;
      return name.length + message.length + 2 > EDITOR_HARNESS_ERROR_MAX_CHARACTERS
        ? OVERSIZED_EDITOR_DIAGNOSTIC
        : `${name}: ${message}`;
    }
    const rendered = String(value);
    return rendered.length > EDITOR_HARNESS_ERROR_MAX_CHARACTERS ? OVERSIZED_EDITOR_DIAGNOSTIC : rendered;
  } catch {
    return UNREADABLE_EDITOR_DIAGNOSTIC;
  }
}

function isAggregateError(value) {
  try {
    return value instanceof AggregateError;
  } catch {
    return false;
  }
}

function boundedAggregateChildren(value, capacity) {
  try {
    const errors = value.errors;
    if (!Array.isArray(errors)) {
      return { values: [{ fixedSummary: UNREADABLE_AGGREGATE_DIAGNOSTIC }], omitted: false };
    }
    const length = errors.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      return { values: [{ fixedSummary: UNREADABLE_AGGREGATE_DIAGNOSTIC }], omitted: false };
    }
    const retainedLength = Math.min(length, capacity);
    const values = [];
    for (let index = 0; index < retainedLength; index += 1) {
      try {
        values.push({ value: errors[index] });
      } catch {
        values.push({ fixedSummary: UNREADABLE_EDITOR_DIAGNOSTIC });
      }
    }
    return { values, omitted: length > retainedLength };
  } catch {
    return { values: [{ fixedSummary: UNREADABLE_AGGREGATE_DIAGNOSTIC }], omitted: false };
  }
}

export function createEditorAcceptanceFailure(kind, summary, context, cause) {
  const exitState = context.exitState;
  const exitDetail = exitState?.error
    ? `spawn error: ${exitState.error instanceof Error ? exitState.error.message : String(exitState.error)}`
    : exitState
      ? `code=${String(exitState.code ?? "none")}, signal=${String(exitState.signal ?? "none")}`
      : "not observed";
  const editorKey = context.editor.key ?? context.editor.name.toLowerCase().replaceAll(" ", "-");
  const editorVersion = context.editor.version ?? "unknown";
  const readProgress = context.readProgress !== false;
  let progress = null;
  if (readProgress) {
    try {
      progress =
        acceptanceProgressCheckpoint(context.progressPath, {
          expectedRunId: context.runId,
          expectedPhase: context.phase === "cleanup" ? context.cleanupOfPhase : context.phase
        }) ?? null;
    } catch {
      // The user-facing detail below reports malformed or unsafe checkpoint files.
    }
  }
  const remediation = editorAcceptanceRemediation(kind, context, editorKey, progress, readProgress);
  const details = {
    kind,
    editor: context.editor.name,
    editorKey,
    editorVersion,
    phase: context.phase,
    elapsedMs: context.elapsedMs,
    exitCode: exitState && !exitState.error ? (exitState.code ?? null) : null,
    signal: exitState && !exitState.error ? (exitState.signal ?? null) : null,
    timeoutKind: context.timeoutKind ?? null,
    resultPath: context.resultPath,
    progressPath: context.progressPath,
    runId: context.runId ?? null,
    progress,
    ...(remediation ? { remediation } : {}),
    ...(context.treeVerifiedStopped === false ? { treeVerifiedStopped: false } : {}),
    ...(typeof context.editorOutput === "string" ? { editorOutput: context.editorOutput } : {})
  };
  const message = [
    summary,
    `Editor: ${context.editor.name} ${editorVersion} (${editorKey}).`,
    `Phase: ${context.phase}.`,
    `Elapsed: ${context.elapsedMs} ms.`,
    `Exit: ${exitDetail}.`,
    `Result: ${context.resultPath}.`,
    readProgress
      ? acceptanceProgressDetail(context.progressPath, {
          expectedRunId: context.runId,
          expectedPhase: context.phase === "cleanup" ? context.cleanupOfPhase : context.phase
        })
      : "Acceptance checkpoint content was not opened because editor-tree shutdown is unverified.",
    remediation ? `Remediation: ${remediation}` : "",
    typeof context.editorOutput === "string" ? `Sanitized editor output:\n${context.editorOutput}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return new EditorAcceptanceFailure(kind, message, details, cause ? { cause } : undefined);
}

function editorAcceptanceRemediation(kind, context, editorKey, progress, readProgress) {
  if (
    kind === "premature-exit" &&
    context.platform === "linux" &&
    context.displayMode === "headless" &&
    editorKey === "cursor" &&
    context.exitState?.error === undefined &&
    context.exitState?.signal === "SIGABRT" &&
    readProgress &&
    context.treeVerifiedStopped !== false &&
    progress === `${context.phase}:runner-spawn`
  ) {
    return CURSOR_HEADLESS_XVFB_REMEDIATION;
  }
  return undefined;
}

function createEditorAcceptanceCleanupFailure(error, context) {
  const treeMayBeLive = editorProcessTreeMayBeLive(error);
  const cleanupFailure = createEditorAcceptanceFailure(
    "cleanup-failure",
    `${context.editor.name} ${context.phase} acceptance completed, but its editor process tree did not shut down cleanly: ${error instanceof Error ? error.message : String(error)}`,
    {
      ...context,
      phase: "cleanup",
      cleanupOfPhase: context.phase,
      readProgress: !treeMayBeLive,
      ...(treeMayBeLive ? { treeVerifiedStopped: false } : {})
    },
    error
  );
  cleanupFailure.details.cleanupOfPhase = context.phase;
  return cleanupFailure;
}

function validateAcceptanceProgressEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("An editor acceptance checkpoint must be an object envelope.");
  }
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 4 || keys.join(",") !== "checkpoint,phase,protocol,runId") {
    throw new Error("An editor acceptance checkpoint must contain exactly protocol, runId, phase, and checkpoint.");
  }
  if (envelope.protocol !== EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL) {
    throw new Error(`An editor acceptance checkpoint must use protocol ${EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL}.`);
  }
  if (typeof envelope.runId !== "string" || !ACCEPTANCE_RUN_ID.test(envelope.runId)) {
    throw new Error("An editor acceptance checkpoint run ID must be a canonical UUID.");
  }
  if (typeof envelope.phase !== "string" || !ACCEPTANCE_PHASE.test(envelope.phase)) {
    throw new Error("An editor acceptance checkpoint phase must be a bounded safe identifier.");
  }
  if (
    typeof envelope.checkpoint !== "string" ||
    envelope.checkpoint.length === 0 ||
    /[\0\r\n]/u.test(envelope.checkpoint)
  ) {
    throw new Error("An editor acceptance checkpoint must be a non-empty single-line string.");
  }
}

export function writeAcceptanceProgress(progressPath, envelope) {
  validateAcceptanceProgressEnvelope(envelope);
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES) {
    throw new Error("An editor acceptance checkpoint envelope must be at most 1024 UTF-8 bytes including its newline.");
  }
  publishAcceptanceProgressFile(progressPath, serialized, "checkpoint");
  publishAcceptanceProgressFile(
    editorAcceptanceProgressSignalPath(progressPath, envelope.runId, envelope.phase),
    "",
    "heartbeat"
  );
}

function publishAcceptanceProgressFile(targetPath, content, description) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let ownedIdentity;
  let renamed = false;
  let operationError;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    ownedIdentity = fstatSync(descriptor, { bigint: true });
    if (!ownedIdentity.isFile() || ownedIdentity.nlink !== 1n) {
      throw new Error(`The acceptance ${description} temporary must be one exclusively owned regular file.`);
    }
    writeFileSync(descriptor, content, { encoding: "utf8" });
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !completed.isFile() ||
      completed.nlink !== 1n ||
      completed.dev !== ownedIdentity.dev ||
      completed.ino !== ownedIdentity.ino
    ) {
      throw new Error(`The acceptance ${description} temporary changed while it was written.`);
    }
    closeSync(descriptor);
    descriptor = undefined;
    const pathIdentity = lstatSync(temporaryPath, { bigint: true });
    if (
      !pathIdentity.isFile() ||
      pathIdentity.isSymbolicLink() ||
      pathIdentity.nlink !== 1n ||
      pathIdentity.dev !== completed.dev ||
      pathIdentity.ino !== completed.ino
    ) {
      throw new Error(`The acceptance ${description} temporary path changed before publication.`);
    }
    renameSync(temporaryPath, targetPath);
    renamed = true;
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!renamed && ownedIdentity) {
    try {
      const current = lstatSync(temporaryPath, { bigint: true });
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === ownedIdentity.dev &&
        current.ino === ownedIdentity.ino
      ) {
        rmSync(temporaryPath, { force: true });
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") cleanupErrors.push(error);
    }
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      `Acceptance ${description} publication and temporary cleanup both failed.`
    );
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `Acceptance ${description} temporary cleanup failed.`);
  }
}

export function acceptanceProgressCheckpoint(progressPath, { expectedRunId, expectedPhase, ...readOptions } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const text = readBoundedAcceptanceText(
        progressPath,
        EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES,
        "acceptance checkpoint",
        {
          ...readOptions,
          allowAtomicPathReplacement: true
        }
      );
      if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
        throw new Error("The acceptance checkpoint envelope must contain exactly one newline-terminated line.");
      }
      let envelope;
      try {
        envelope = JSON.parse(text.slice(0, -1));
      } catch {
        throw new Error("The acceptance checkpoint envelope must be valid JSON.");
      }
      validateAcceptanceProgressEnvelope(envelope);
      if (expectedRunId !== undefined && envelope.runId !== expectedRunId) return undefined;
      if (expectedPhase !== undefined && envelope.phase !== expectedPhase) return undefined;
      return envelope.checkpoint;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
      if (error && typeof error === "object" && error.code === ACCEPTANCE_FILE_REPLACED_DURING_READ_CODE) {
        if (attempt < 2) continue;
        return undefined;
      }
      throw error;
    }
  }
  return undefined;
}

function acceptanceProgressFileSnapshot(progressPath, { expectedRunId, expectedPhase } = {}) {
  if (expectedRunId === undefined || expectedPhase === undefined) {
    throw new Error("Windows editor acceptance heartbeat polling requires the exact launched run and phase.");
  }
  const signalPath = editorAcceptanceProgressSignalPath(progressPath, expectedRunId, expectedPhase);
  let metadata;
  try {
    metadata = lstatSync(signalPath, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("The acceptance heartbeat must be one non-linked regular file.");
  }
  if (metadata.size !== 0n) {
    throw new Error("The acceptance heartbeat must be an empty metadata-only file.");
  }
  // Windows libuv exposes neither O_NOFOLLOW nor nonblocking file opens. While
  // the editor Job Object is live, observe only the exact run/phase-scoped
  // heartbeat's lstat metadata. Envelope content remains unopened until the
  // complete owned process tree has stopped.
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs].join(
    ":"
  );
}

export function acceptanceProgressDetail(progressPath, correlation = {}) {
  try {
    if (!acceptancePathExists(progressPath)) return "No acceptance checkpoint was recorded.";
    const checkpoint = acceptanceProgressCheckpoint(progressPath, correlation);
    return checkpoint
      ? `Last acceptance checkpoint: ${checkpoint}.`
      : "No acceptance checkpoint matched the launched run and phase.";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "No acceptance checkpoint was recorded.";
    }
    return `The acceptance checkpoint could not be read: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

function acceptancePathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function acceptanceFileSnapshotIfExists(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function readBoundedAcceptanceText(
  path,
  maximumBytes,
  description,
  {
    afterInitialPathSnapshot,
    afterDescriptorOpen,
    beforeFinalPathSnapshot,
    expectedPathSnapshot,
    allowAtomicPathReplacement = false
  } = {}
) {
  const maximumSize = BigInt(maximumBytes);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = openSync(path, flags);
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new Error(`The ${description} must be a regular file and may not be a symbolic link.`, {
        cause: error
      });
    }
    throw error;
  }
  try {
    afterDescriptorOpen?.();
    const openedMetadata = fstatSync(descriptor, { bigint: true });
    if (!openedMetadata.isFile()) {
      throw new Error(`The ${description} must be a regular file while it is read.`);
    }
    if (openedMetadata.size > maximumSize) {
      throw new Error(`The ${description} exceeds its ${maximumBytes}-byte limit.`);
    }
    // An atomic checkpoint publisher may replace the path after open() but
    // before the descriptor's first fstat(). POSIX then reports the securely
    // opened old inode with zero links. Discard it and retry the path; never
    // accept bytes from an unlinked descriptor.
    if (allowAtomicPathReplacement && openedMetadata.nlink === 0n) {
      throw acceptanceFileReplacedDuringRead(description);
    }
    if (openedMetadata.nlink !== 1n) {
      throw new Error(`The ${description} must not be hard-linked.`);
    }
    if (expectedPathSnapshot && !sameAcceptanceFileSnapshot(openedMetadata, expectedPathSnapshot)) {
      throw new Error(`The ${description} path changed after it was first observed.`);
    }

    const pathMetadata = lstatSync(path, { bigint: true });
    if (expectedPathSnapshot && !sameAcceptanceFileSnapshot(pathMetadata, expectedPathSnapshot)) {
      throw new Error(`The ${description} path changed after it was first observed.`);
    }
    if (
      acceptancePathSnapshotShowsAtomicPublication(
        pathMetadata,
        openedMetadata,
        maximumSize,
        allowAtomicPathReplacement
      )
    ) {
      throw acceptanceFileReplacedDuringRead(description);
    }
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new Error(`The ${description} must be a regular file and may not be a symbolic link.`);
    }
    if (pathMetadata.nlink !== 1n) {
      throw new Error(`The ${description} must not be hard-linked.`);
    }
    if (pathMetadata.size > maximumSize) {
      throw new Error(`The ${description} exceeds its ${maximumBytes}-byte limit.`);
    }
    if (!sameAcceptanceFileSnapshot(openedMetadata, pathMetadata)) {
      throw new Error(`The ${description} changed before it could be read safely.`);
    }
    afterInitialPathSnapshot?.();

    const readyMetadata = fstatSync(descriptor, { bigint: true });
    if (!sameAcceptanceFileSnapshot(readyMetadata, openedMetadata)) {
      if (
        allowAtomicPathReplacement &&
        (sameAcceptanceDescriptorAfterUnlink(readyMetadata, openedMetadata) ||
          sameAcceptanceFileSnapshotExceptCtime(readyMetadata, openedMetadata))
      ) {
        throw acceptanceFileReplacedDuringRead(description);
      }
      throw new Error(`The ${description} changed before it could be read safely.`);
    }
    const readyPathMetadata = lstatSync(path, { bigint: true });
    if (
      acceptancePathSnapshotShowsAtomicPublication(
        readyPathMetadata,
        readyMetadata,
        maximumSize,
        allowAtomicPathReplacement
      )
    ) {
      throw acceptanceFileReplacedDuringRead(description);
    }
    if (
      !readyPathMetadata.isFile() ||
      readyPathMetadata.isSymbolicLink() ||
      readyPathMetadata.nlink !== 1n ||
      !sameAcceptanceFileSnapshot(readyPathMetadata, readyMetadata)
    ) {
      const descriptorAfterPathChange = fstatSync(descriptor, { bigint: true });
      if (
        allowAtomicPathReplacement &&
        readyPathMetadata.isFile() &&
        !readyPathMetadata.isSymbolicLink() &&
        readyPathMetadata.nlink === 1n &&
        readyPathMetadata.size <= maximumSize &&
        (sameAcceptanceDescriptorAfterUnlink(descriptorAfterPathChange, readyMetadata) ||
          sameAcceptanceFileSnapshotExceptCtime(descriptorAfterPathChange, readyMetadata))
      ) {
        throw acceptanceFileReplacedDuringRead(description);
      }
      throw new Error(`The ${description} changed before it could be read safely.`);
    }

    const buffer = Buffer.alloc(Number(readyMetadata.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error(`The ${description} ended before its declared size.`);
      offset += count;
    }
    const completedMetadata = fstatSync(descriptor, { bigint: true });
    if (!sameAcceptanceFileSnapshot(completedMetadata, readyMetadata)) {
      if (
        allowAtomicPathReplacement &&
        (sameAcceptanceDescriptorAfterUnlink(completedMetadata, readyMetadata) ||
          sameAcceptanceFileSnapshotExceptCtime(completedMetadata, readyMetadata))
      ) {
        throw acceptanceFileReplacedDuringRead(description);
      }
      throw new Error(`The ${description} changed while it was being read.`);
    }
    beforeFinalPathSnapshot?.();
    const finalPathMetadata = lstatSync(path, { bigint: true });
    if (
      acceptancePathSnapshotShowsAtomicPublication(
        finalPathMetadata,
        completedMetadata,
        maximumSize,
        allowAtomicPathReplacement
      )
    ) {
      throw acceptanceFileReplacedDuringRead(description);
    }
    if (
      !finalPathMetadata.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      finalPathMetadata.nlink !== 1n ||
      !sameAcceptanceFileSnapshot(finalPathMetadata, completedMetadata)
    ) {
      const descriptorAfterPathChange = fstatSync(descriptor, { bigint: true });
      if (
        allowAtomicPathReplacement &&
        finalPathMetadata.isFile() &&
        !finalPathMetadata.isSymbolicLink() &&
        finalPathMetadata.nlink === 1n &&
        finalPathMetadata.size <= maximumSize &&
        (sameAcceptanceDescriptorAfterUnlink(descriptorAfterPathChange, completedMetadata) ||
          sameAcceptanceFileSnapshotExceptCtime(descriptorAfterPathChange, completedMetadata))
      ) {
        throw acceptanceFileReplacedDuringRead(description);
      }
      throw new Error(`The ${description} path changed while it was being read.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      throw new Error(`The ${description} is not valid UTF-8.`, { cause: error });
    }
  } finally {
    closeSync(descriptor);
  }
}

export function acceptancePathSnapshotShowsAtomicPublication(
  pathMetadata,
  openedMetadata,
  maximumSize,
  allowAtomicPathReplacement
) {
  if (
    !allowAtomicPathReplacement ||
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size > maximumSize
  ) {
    return false;
  }
  if (pathMetadata.nlink === 0n) return true;
  if (pathMetadata.nlink !== 1n || openedMetadata.nlink !== 1n) return false;
  if (pathMetadata.dev !== openedMetadata.dev || pathMetadata.ino !== openedMetadata.ino) return true;
  return sameAcceptanceFileSnapshotExceptCtime(pathMetadata, openedMetadata);
}

function acceptanceFileReplacedDuringRead(description) {
  const error = new Error(`The ${description} was atomically replaced while it was being read.`);
  error.code = ACCEPTANCE_FILE_REPLACED_DURING_READ_CODE;
  return error;
}

function sameAcceptanceDescriptorAfterUnlink(current, opened) {
  return (
    current.isFile() &&
    current.dev === opened.dev &&
    current.ino === opened.ino &&
    current.mode === opened.mode &&
    current.size === opened.size &&
    current.mtimeNs === opened.mtimeNs &&
    opened.nlink === 1n &&
    current.nlink === 0n
  );
}

function sameAcceptanceFileSnapshotExceptCtime(left, right) {
  return (
    left.ctimeNs !== right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameAcceptanceFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function terminateEditorChild(child, exit, isRunning, ownsProcessGroup, gracefulExitMs, options) {
  try {
    return await terminateEditorChildWithOptions(child, exit, isRunning, ownsProcessGroup, gracefulExitMs, options);
  } catch (error) {
    if (editorProcessTreeMayBeLive(error)) throw error;
    const failure = new AggregateError([error], "The spawned editor process tree could not be verified as stopped.");
    failure.code = EDITOR_PROCESS_TREE_UNVERIFIED_CODE;
    throw failure;
  }
}

async function terminateEditorChildWithOptions(
  child,
  exit,
  isRunning,
  ownsProcessGroup,
  gracefulExitMs,
  {
    platform = process.platform,
    windowsTreeKill,
    windowsTreeKillTimeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS,
    terminationGraceMs = 10_000,
    killGraceMs = 10_000
  } = {}
) {
  const exitedWithinGrace = await waitForEditorTreeExit(child, exit, isRunning, ownsProcessGroup, gracefulExitMs);
  const windowsOwnership = platform === "win32" ? child[WINDOWS_JOB_OWNERSHIP] : undefined;
  if ((platform !== "win32" || windowsOwnership) && exitedWithinGrace) {
    await requireWindowsJobEmptyAttestation(windowsOwnership, windowsTreeKillTimeoutMs);
    return;
  }

  let gracefulError;
  try {
    await signalEditorTree(
      child,
      isRunning,
      ownsProcessGroup,
      "SIGTERM",
      platform,
      windowsTreeKill,
      windowsTreeKillTimeoutMs
    );
  } catch (error) {
    gracefulError = error;
  }
  if (!gracefulError) {
    if (platform === "win32" && exitedWithinGrace) return;
    if (await waitForEditorTreeExit(child, exit, isRunning, ownsProcessGroup, terminationGraceMs)) {
      await requireWindowsJobEmptyAttestation(windowsOwnership, windowsTreeKillTimeoutMs);
      return;
    }
  }

  let forcedError;
  try {
    await signalEditorTree(
      child,
      isRunning,
      ownsProcessGroup,
      "SIGKILL",
      platform,
      windowsTreeKill,
      windowsTreeKillTimeoutMs
    );
  } catch (error) {
    forcedError = error;
  }
  if (!forcedError && (await waitForEditorTreeExit(child, exit, isRunning, ownsProcessGroup, killGraceMs))) {
    await requireWindowsJobEmptyAttestation(windowsOwnership, windowsTreeKillTimeoutMs);
    return;
  }

  const errors = [gracefulError, forcedError].filter(Boolean);
  if (!forcedError) {
    errors.push(new Error(`The spawned editor process tree ${child.pid ?? "(unknown pid)"} remained after SIGKILL.`));
  }
  const details = errors
    .map((error, index) => `${index === 0 && gracefulError ? "graceful" : "forced"}: ${boundedErrorMessage(error)}`)
    .join("; ");
  const failure = new AggregateError(
    errors,
    `The spawned editor process tree could not be verified as stopped (${details}).`
  );
  failure.code = EDITOR_PROCESS_TREE_UNVERIFIED_CODE;
  throw failure;
}

function unverifiedEditorProcessTreeError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = EDITOR_PROCESS_TREE_UNVERIFIED_CODE;
  error.details = { treeVerifiedStopped: false };
  return error;
}

async function requireWindowsJobEmptyAttestation(ownership, timeoutMs) {
  if (!ownership) return;
  if (ownership.verificationLost) {
    throw unverifiedEditorProcessTreeError(
      "The Windows editor Job Object supervisor exited after its completion attestation was lost."
    );
  }
  let verified;
  try {
    verified = await ownership.verifyEmpty(timeoutMs);
  } catch (error) {
    throw unverifiedEditorProcessTreeError(
      "The Windows editor Job Object supervisor did not provide a bounded completion attestation.",
      error
    );
  }
  if (!verified) {
    throw unverifiedEditorProcessTreeError(
      "The Windows editor Job Object supervisor exited without exactly one valid job-empty attestation."
    );
  }
}

async function waitForEditorTreeExit(child, exit, isRunning, ownsProcessGroup, timeoutMs) {
  if (!ownsProcessGroup || child.pid === undefined) return waitForChildExit(exit, timeoutMs);
  const deadline = performance.now() + timeoutMs;
  do {
    if (!editorProcessGroupRunning(child.pid) && !isRunning()) return true;
    await delay(50);
  } while (performance.now() < deadline);
  return !editorProcessGroupRunning(child.pid) && !isRunning();
}

async function signalEditorTree(
  child,
  isRunning,
  ownsProcessGroup,
  signal,
  platform = process.platform,
  windowsTreeKill,
  windowsTreeKillTimeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS
) {
  if (platform === "win32" && child.pid !== undefined) {
    const ownership = child[WINDOWS_JOB_OWNERSHIP];
    if (ownership) {
      await promiseWithDeadline(
        Promise.resolve().then(() => ownership.terminate(signal === "SIGKILL")),
        windowsTreeKillTimeoutMs,
        `Windows editor Job Object cleanup exceeded ${windowsTreeKillTimeoutMs} ms.`
      );
      return;
    }
    if (typeof windowsTreeKill !== "function") {
      throw new Error("The Windows editor process was not launched inside an owned Job Object.");
    }
    await promiseWithDeadline(
      Promise.resolve().then(() => windowsTreeKill(child.pid, signal === "SIGKILL")),
      windowsTreeKillTimeoutMs,
      `Windows editor process-tree cleanup exceeded ${windowsTreeKillTimeoutMs} ms.`
    );
    return;
  }
  signalPosixEditorTree(child, isRunning, ownsProcessGroup, signal);
}

export function signalPosixEditorTree(child, isRunning, ownsProcessGroup, signal, signalProcess = process.kill) {
  let groupPermissionError;
  if (ownsProcessGroup && child.pid !== undefined) {
    try {
      signalProcess(-child.pid, signal);
      return;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EPERM") groupPermissionError = error;
      else if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
    }
  }
  if (isRunning()) {
    const signaled = child.kill(signal);
    if (signaled || !groupPermissionError) return;
  }
  if (groupPermissionError) throw groupPermissionError;
}

function boundedErrorMessage(error) {
  let message;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "unreadable cleanup error";
  }
  return message.length <= 2_048 ? message : OVERSIZED_EDITOR_DIAGNOSTIC;
}

async function promiseWithDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = "EDITOR_ACCEPTANCE_DEADLINE";
          rejectTimeout(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function editorProcessGroupRunning(pid, signalProcess = process.kill) {
  try {
    signalProcess(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    // Darwin reports EPERM when any member of a process group cannot be
    // signalled. The group still exists, so keep treating it as live and let
    // termination fall back to the owned group leader before re-probing.
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    throw error;
  }
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

export async function reserveEditorDebugPort(
  timeoutMs,
  { createServerFactory = createServer, schedule = setTimeout, cancelSchedule = clearTimeout } = {}
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("An editor debugging-port reservation timeout must be a positive safe integer.");
  }
  const server = createServerFactory();
  const controller = new AbortController();
  server.unref?.();
  return await new Promise((resolvePort, rejectPort) => {
    let settled = false;
    let closeRequested = false;
    let pendingError;
    let reservationTimer;
    let hardDeadlineTimer;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      cancelSchedule(reservationTimer);
      cancelSchedule(hardDeadlineTimer);
      if (error) rejectPort(error);
      else resolvePort(port);
    };
    const closeServer = (error) => {
      pendingError ??= error;
      controller.abort();
      if (closeRequested) return;
      if (!server.listening) {
        finish(pendingError);
        return;
      }
      closeRequested = true;
      try {
        server.close((closeError) => finish(pendingError ?? closeError));
      } catch (closeError) {
        finish(pendingError ?? closeError);
      }
    };
    const deadlineError = () => {
      const error = new Error(`Editor debugging-port reservation exceeded ${timeoutMs} ms.`);
      error.code = "EDITOR_ACCEPTANCE_DEADLINE";
      return error;
    };
    const releaseGraceMs = Math.min(EDITOR_DEBUG_PORT_RELEASE_GRACE_MS, Math.max(1, Math.floor(timeoutMs / 4)));
    reservationTimer = schedule(() => closeServer(deadlineError()), Math.max(1, timeoutMs - releaseGraceMs));
    hardDeadlineTimer = schedule(() => {
      controller.abort();
      try {
        if (!closeRequested && server.listening) {
          closeRequested = true;
          server.close();
        }
      } catch {
        // The server was never listening or is already closing; it is unref'ed above.
      }
      finish(deadlineError());
    }, timeoutMs);
    server.once("error", (error) => closeServer(pendingError ?? error));
    try {
      server.listen({ port: 0, host: "127.0.0.1", exclusive: true, signal: controller.signal }, () => {
        let port;
        try {
          const address = server.address();
          port = typeof address === "object" && address ? address.port : undefined;
        } catch (error) {
          closeServer(error);
          return;
        }
        try {
          closeRequested = true;
          server.close((error) => {
            const finalError = pendingError ?? error;
            if (finalError) finish(finalError);
            else if (!port) finish(new Error("Could not reserve an editor debugging port."));
            else finish(undefined, port);
          });
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      closeServer(error);
    }
  });
}
