import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const pythonCandidates = [
  process.env.DATA_EXPLORER_PYTHON,
  join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts" : "bin", "python"),
  "python3",
  "python"
].filter(Boolean);

function commandExists(command) {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => existsSync(join(directory, command)) || existsSync(join(directory, `${command}.exe`)));
}

const python = pythonCandidates.find(commandExists);
if (!python) {
  throw new Error("Python was not found. Set DATA_EXPLORER_PYTHON or create .venv.");
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
