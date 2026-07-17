import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import {
  downloadEditorWithRetry,
  runEditorAcceptancePhase,
  writeEditorAcceptanceHarness,
  writeEditorSettings,
  writeFakeJupyterExtension
} from "./editor-acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vsix = resolve(root, process.argv[2] ?? "openwrangler.vsix");
if (!existsSync(vsix)) throw new Error(`Packaged extension not found: ${vsix}`);
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const expectedExtension = `${packageJson.publisher}.${packageJson.name}@${packageJson.version}`.toLowerCase();

const requested = process.env.OPEN_WRANGLER_PACKAGED_EDITORS?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const supportedEditorKeys = new Set(["vscode", "cursor"]);
const unknownRequested = requested?.filter((key) => !supportedEditorKeys.has(key)) ?? [];
if (unknownRequested.length) {
  throw new Error(`Unsupported packaged editor key(s): ${unknownRequested.join(", ")}.`);
}
const candidates = [
  {
    name: "VS Code",
    key: "vscode",
    executable: process.env.OPEN_WRANGLER_VSCODE_EXECUTABLE ?? "/usr/share/code/code",
    cli: process.env.OPEN_WRANGLER_VSCODE_CLI ?? "/usr/share/code/bin/code",
    sharedDataDir: true
  },
  {
    name: "Cursor",
    key: "cursor",
    executable: process.env.OPEN_WRANGLER_CURSOR_EXECUTABLE ?? "/usr/share/cursor/cursor",
    cli: process.env.OPEN_WRANGLER_CURSOR_CLI ?? "/usr/share/cursor/bin/cursor",
    sharedDataDir: false
  }
].filter(
  (editor) =>
    existsSync(editor.executable) && existsSync(editor.cli) && (!requested?.length || requested.includes(editor.key))
);
if (!candidates.some((editor) => editor.key === "vscode") && (!requested?.length || requested.includes("vscode"))) {
  const executable = await downloadEditorWithRetry(downloadAndUnzipVSCode, process.env.VSCODE_TEST_VERSION ?? "stable");
  const downloadedCli = process.platform === "linux" ? resolve(dirname(executable), "bin", "code") : executable;
  candidates.unshift({
    name: "VS Code",
    key: "vscode",
    executable,
    cli: existsSync(downloadedCli) ? downloadedCli : executable,
    sharedDataDir: true
  });
}
if (!candidates.length) throw new Error("No supported VS Code or Cursor desktop executable was found.");
const missingRequested = requested?.filter((key) => !candidates.some((editor) => editor.key === key)) ?? [];
if (missingRequested.length) {
  throw new Error(
    `Requested packaged editor(s) were not found: ${missingRequested.join(", ")}. Configure the corresponding OPEN_WRANGLER_*_EXECUTABLE and OPEN_WRANGLER_*_CLI paths.`
  );
}

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

for (const editor of candidates) {
  const profile = mkdtempSync(join(tmpdir(), `openwrangler-packaged-${editor.key}-`));
  const userData = resolve(profile, "user-data");
  const extensions = resolve(profile, "extensions");
  const workspace = resolve(profile, "Open Wrangler Demo");
  try {
    mkdirSync(workspace, { recursive: true });
    cpSync(resolve(root, "fixtures"), resolve(workspace, "fixtures"), { recursive: true });
    writeEditorAcceptanceHarness(profile);
    writeEditorSettings(userData, { "window.dialogStyle": "custom", "files.simpleDialog.enable": true });
    const fakeJupyter = resolve(profile, "fake-jupyter");
    writeFakeJupyterExtension(fakeJupyter);
    const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
    execFileSync(
      editor.cli,
      [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        vsix,
        "--force",
        ...sandboxArgs
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 60_000 }
    );
    const installed = execFileSync(
      editor.cli,
      [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      { encoding: "utf8", timeout: 60_000 }
    );
    if (!installed.toLowerCase().includes(expectedExtension)) {
      throw new Error(`${editor.name} did not report the installed Open Wrangler package. Output: ${installed}`);
    }

    const testModule = resolve(root, "dist-test", "test", "extensionHost", "index.js");
    const resultPath = resolve(profile, "result.json");
    for (const phase of ["seed", "verify"]) {
      await runEditorAcceptancePhase({
        editor,
        workspace,
        userData,
        extensions,
        developmentPaths: [profile, fakeJupyter],
        testModule,
        python: process.env.OPEN_WRANGLER_TEST_PYTHON,
        phase,
        resultPath
      });
    }
    console.log(`${editor.name} packaged acceptance passed for ${basename(vsix)}.`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
