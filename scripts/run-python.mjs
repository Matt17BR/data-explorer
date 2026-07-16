import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const candidates = [
  process.env.OPEN_WRANGLER_PYTHON,
  process.platform === "win32"
    ? resolve(root, ".venv", "Scripts", "python.exe")
    : resolve(root, ".venv", "bin", "python"),
  "python3",
  "python"
].filter(Boolean);

const executable =
  candidates.find((candidate) => {
    if (!candidate) {
      return false;
    }
    const isPath = candidate.includes("/") || candidate.includes("\\") || candidate.includes(delimiter);
    return !isPath || existsSync(candidate);
  }) ?? "python3";
const result = spawnSync(executable, process.argv.slice(2), {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
