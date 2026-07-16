import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getSetting } from "./configuration";
import { resolvePythonExecutable } from "./pythonPath";
import { isSupportedPythonVersion } from "./pythonEnvironmentModel";

export { isSupportedPythonVersion, requiredModules } from "./pythonEnvironmentModel";

const execFileAsync = promisify(execFile);

interface PythonExtensionApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path?: string } | undefined;
    resolveEnvironment?(environment: { path?: string } | string): Promise<{
      executable?: { uri?: vscode.Uri };
      version?: { major?: number; minor?: number; micro?: number };
    } | null>;
  };
}

export interface PythonEnvironment {
  executable: string;
  version: string;
  source: "configuration" | "pythonExtension" | "system";
}

export interface DependencyProbe {
  missing: string[];
  available: string[];
}

export async function resolvePythonEnvironment(
  context: vscode.ExtensionContext,
  resource?: vscode.Uri
): Promise<PythonEnvironment> {
  const configured = getSetting("pythonPath", "", resource).trim();
  if (configured) {
    const executable = resolvePythonExecutable(
      configured,
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      context.extensionPath,
      existsSync
    );
    return probeEnvironment(executable, "configuration");
  }

  const pythonExtension = vscode.extensions.getExtension<PythonExtensionApi>("ms-python.python");
  if (pythonExtension) {
    try {
      const api = await pythonExtension.activate();
      const selected = api.environments?.getActiveEnvironmentPath(resource);
      const resolved =
        selected && api.environments?.resolveEnvironment
          ? await api.environments.resolveEnvironment(selected)
          : undefined;
      const executable = resolved?.executable?.uri?.fsPath ?? selected?.path;
      if (executable) return await probeEnvironment(executable, "pythonExtension");
    } catch {
      // Fall through to system interpreters. Diagnostics are surfaced if every candidate fails.
    }
  }

  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await probeEnvironment(candidate, "system");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`No compatible Python 3.10-3.14 interpreter was found. ${failures.join(" ")}`);
}

export async function probeDependencies(executable: string, modules: readonly string[]): Promise<DependencyProbe> {
  if (modules.length === 0) return { missing: [], available: [] };
  const program = [
    "import importlib.util,json",
    `mods=${JSON.stringify(modules)}`,
    "print(json.dumps({m: importlib.util.find_spec(m) is not None for m in mods}))"
  ].join(";");
  const { stdout } = await execFileAsync(executable, ["-c", program], { timeout: 10_000 });
  const result = JSON.parse(stdout.trim()) as Record<string, boolean>;
  return {
    missing: modules.filter((module) => !result[module]),
    available: modules.filter((module) => result[module])
  };
}

async function probeEnvironment(executable: string, source: PythonEnvironment["source"]): Promise<PythonEnvironment> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      executable,
      ["-c", "import json,sys; print(json.dumps(list(sys.version_info[:3])))"],
      { timeout: 10_000 }
    );
    stdout = result.stdout.trim();
  } catch (error) {
    throw new Error(`${executable} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [major, minor, patch] = JSON.parse(stdout) as [number, number, number];
  if (!isSupportedPythonVersion(major, minor)) {
    throw new Error(`${executable} is Python ${major}.${minor}.${patch}; Open Wrangler requires Python 3.10-3.14.`);
  }
  return { executable, version: `${major}.${minor}.${patch}`, source };
}
