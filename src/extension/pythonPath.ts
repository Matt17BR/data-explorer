import * as path from "path";

export type Exists = (candidate: string) => boolean;

export function resolvePythonExecutable(
  configuredPath: string,
  workspaceFolders: readonly string[],
  extensionPath: string,
  exists: Exists
): string {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  for (const workspaceFolder of workspaceFolders) {
    const candidate = path.join(workspaceFolder, configuredPath);
    if (exists(candidate)) {
      return candidate;
    }
  }

  const extensionCandidate = path.join(extensionPath, configuredPath);
  if (exists(extensionCandidate)) {
    return extensionCandidate;
  }

  return configuredPath;
}
