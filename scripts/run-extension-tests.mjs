import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import {
  downloadEditorWithRetry,
  runEditorAcceptancePhase,
  writeEditorAcceptanceHarness,
  writeEditorSettings,
  writeFakeJupyterExtension
} from "./editor-acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const profile = mkdtempSync(join(tmpdir(), "openwrangler-extension-host-"));
const requestedVersion = process.env.VSCODE_TEST_VERSION;
const installedExecutable = "/usr/share/code/code";
const vscodeExecutablePath = requestedVersion
  ? await downloadEditorWithRetry(downloadAndUnzipVSCode, requestedVersion)
  : existsSync(installedExecutable)
    ? installedExecutable
    : await downloadEditorWithRetry(downloadAndUnzipVSCode, "stable");
const fakeJupyter = resolve(profile, "fake-jupyter");
writeFakeJupyterExtension(fakeJupyter);

try {
  process.env.OPEN_WRANGLER_TEST_PHASE = "single";
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: [root, fakeJupyter],
    extensionTestsPath: resolve(root, "dist-test", "test", "extensionHost", "index.js"),
    launchArgs: [
      root,
      "--user-data-dir",
      resolve(profile, "runner-user-data"),
      "--extensions-dir",
      resolve(profile, "runner-extensions"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      ...(process.platform === "linux" ? ["--no-sandbox"] : [])
    ]
  });

  const harness = resolve(profile, "harness");
  const userData = resolve(profile, "reload-user-data");
  const extensions = resolve(profile, "reload-extensions");
  const resultPath = resolve(profile, "reload-result.json");
  const testModule = resolve(root, "dist-test", "test", "extensionHost", "index.js");
  writeEditorAcceptanceHarness(harness);
  writeEditorSettings(userData, { "window.dialogStyle": "custom", "files.simpleDialog.enable": true });
  const editor = { name: "VS Code", key: "vscode", executable: vscodeExecutablePath, sharedDataDir: true };
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
      resultPath
    });
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
