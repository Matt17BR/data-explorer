import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const pythonCandidates = [
  process.env.OPEN_WRANGLER_PYTHON,
  join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts" : "bin", "python"),
  "python3",
  "python"
].filter(Boolean);

function resolveCommand(command) {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : undefined;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const executable of [command, `${command}.exe`]) {
      const candidate = join(directory, executable);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const python = pythonCandidates.map(resolveCommand).find(Boolean);
if (!python) {
  throw new Error("Python was not found. Set OPEN_WRANGLER_PYTHON or create .venv.");
}

const pyright = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pyright.cmd" : "pyright");
const result = spawnSync(pyright, ["--pythonpath", python, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
