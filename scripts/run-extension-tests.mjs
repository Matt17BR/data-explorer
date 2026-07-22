import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureEditorAcceptanceTempRoot,
  collectEditorAcceptancePrivateDiagnosticPaths,
  createEditorAcceptanceEnvironment,
  downloadEditorWithRetry,
  editorDisplayLaunchArgs,
  editorProcessTreeMayBeLive,
  resolveDownloadedEditorCliPath,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase,
  sanitizeEditorAcceptanceDiagnostic,
  startIsolatedEditorDisplay,
  validateEditorAcceptancePrivatePathOverrides,
  writeEditorAcceptanceHarness,
  writeEditorSettings,
  writeFakeJupyterExtension
} from "./editor-acceptance.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateDiagnosticPaths = collectEditorAcceptancePrivateDiagnosticPaths();
let temporaryRoot;
let temporaryRootReceipt;
let profile;
let fakeJupyter;
let editorDisplay;
let runError;

try {
  validateEditorAcceptancePrivatePathOverrides();
  const hostedPython = process.env.pythonLocation
    ? process.platform === "win32"
      ? resolve(process.env.pythonLocation, "python.exe")
      : resolve(process.env.pythonLocation, "bin", "python")
    : undefined;
  const localPython =
    process.platform === "win32"
      ? resolve(root, ".venv", "Scripts", "python.exe")
      : resolve(root, ".venv", "bin", "python");
  process.env.OPEN_WRANGLER_TEST_PYTHON ??=
    hostedPython && existsSync(hostedPython)
      ? hostedPython
      : existsSync(localPython)
        ? localPython
        : process.platform === "win32"
          ? "python"
          : "python3";
  process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
  const temporaryParent = resolve(root, "tmp", "ow");
  mkdirSync(temporaryParent, { recursive: true, mode: 0o700 });
  temporaryRoot = mkdtempSync(join(temporaryParent, "x-"));
  temporaryRootReceipt = createEditorAcceptancePrivateRootReceipt(temporaryRoot, {
    containedBy: temporaryParent
  });
  configureEditorAcceptanceTempRoot(temporaryRoot);
  profile = mkdtempSync(join(temporaryRoot, "host-"));
  fakeJupyter = resolve(profile, "fake-jupyter");
  const requestedVersion = process.env.VSCODE_TEST_VERSION;
  const installedExecutable = "/usr/share/code/code";
  const vscodeExecutablePath = requestedVersion
    ? await downloadEditorWithRetry(requestedVersion)
    : existsSync(installedExecutable)
      ? installedExecutable
      : await downloadEditorWithRetry("stable");
  writeFakeJupyterExtension(fakeJupyter);
  editorDisplay = await startIsolatedEditorDisplay();
  const editorEnvironment = createEditorAcceptanceEnvironment();
  const vscodeCliPath = resolveDownloadedEditorCliPath(vscodeExecutablePath);
  const editorLaunch = {
    name: "VS Code",
    key: "vscode",
    executable: vscodeExecutablePath,
    cli: vscodeCliPath
  };
  const editorVersion = await readEditorVersion(editorLaunch, editorEnvironment);
  const harness = resolve(profile, "harness");
  const singleUserData = resolve(profile, "single-user-data");
  const singleExtensions = resolve(profile, "single-extensions");
  const userData = resolve(profile, "reload-user-data");
  const extensions = resolve(profile, "reload-extensions");
  const testModule = resolve(root, "dist-test", "test", "extensionHost", "index.js");
  writeEditorAcceptanceHarness(harness);
  const workbenchSettings = {
    "window.dialogStyle": "custom",
    "window.menuStyle": "custom",
    "files.simpleDialog.enable": true
  };
  writeEditorSettings(singleUserData, workbenchSettings);
  writeEditorSettings(userData, workbenchSettings);
  const editor = {
    name: "VS Code",
    key: "vscode",
    version: editorVersion,
    executable: vscodeExecutablePath,
    cli: vscodeCliPath,
    sharedDataDir: true
  };

  await runEditorAcceptancePhase({
    editor,
    workspace: root,
    userData: singleUserData,
    extensions: singleExtensions,
    developmentPaths: [root, harness, fakeJupyter],
    testModule,
    python: process.env.OPEN_WRANGLER_TEST_PYTHON,
    phase: "single",
    resultPath: resolve(profile, "single-result.json")
  });

  for (const phase of ["seed", "verify"]) {
    await runEditorAcceptancePhase({
      editor,
      workspace: root,
      userData,
      extensions,
      developmentPaths: [root, harness, fakeJupyter],
      testModule,
      python: process.env.OPEN_WRANGLER_TEST_PYTHON,
      phase,
      resultPath: resolve(profile, `${phase}-result.json`)
    });
  }
  console.log("VS Code extension-host acceptance passed.");
} catch (error) {
  runError = error;
}

const cleanupErrors = [];
let processTreeMayBeLive = editorProcessTreeMayBeLive(runError);
try {
  await editorDisplay?.stop({ preservePrivateFiles: processTreeMayBeLive });
} catch (error) {
  cleanupErrors.push(error);
  processTreeMayBeLive ||= editorProcessTreeMayBeLive(error);
}
try {
  if (temporaryRootReceipt) {
    removeEditorAcceptancePrivateRoot(temporaryRootReceipt, {
      processTreeVerifiedStopped: !processTreeMayBeLive
    });
  }
} catch (error) {
  cleanupErrors.push(error);
}
let finalError;
if (runError && cleanupErrors.length > 0) {
  finalError = new AggregateError(
    [runError, ...cleanupErrors],
    "Extension-host acceptance failed and its isolated environment did not clean up completely."
  );
} else if (runError) {
  finalError = runError;
} else if (cleanupErrors.length === 1) {
  finalError = cleanupErrors[0];
} else if (cleanupErrors.length > 1) {
  finalError = new AggregateError(cleanupErrors, "Extension-host acceptance cleanup failed.");
}
if (finalError) {
  console.error(sanitizeEditorAcceptanceDiagnostic(finalError, privateDiagnosticPaths));
  process.exitCode = 1;
}

async function readEditorVersion(editor, environment) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor,
      args: ["--version", ...editorDisplayLaunchArgs()],
      environment,
      label: "VS Code version probe"
    },
    {
      timeoutMs: 30_000
    }
  );
  const version = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(line));
  if (!version) throw new Error("VS Code did not report a numeric major.minor.patch version from its executable.");
  return version;
}
