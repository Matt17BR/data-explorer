import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/architecture.md",
  "docs/feature-parity.md",
  "docs/reference.md",
  "docs/releasing.md",
  "docs/testing.md"
];

const missing = required.filter((file) => !existsSync(resolve(root, file)));
if (missing.length > 0) {
  throw new Error(`Missing required documentation: ${missing.join(", ")}`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${packageJson.version}]`)) {
  throw new Error(`CHANGELOG.md does not contain an entry for ${packageJson.version}`);
}

const runtimeVersionSource = readFileSync(resolve(root, "python/openwrangler_runtime/version.py"), "utf8");
const runtimeVersion = runtimeVersionSource.match(/^__version__ = "([^"]+)"$/m)?.[1];
const expectedRuntimeVersion = packageJson.version
  .replace(/-alpha\.(\d+)$/, "a$1")
  .replace(/-beta\.(\d+)$/, "b$1")
  .replace(/-rc\.(\d+)$/, "rc$1");
if (runtimeVersion !== expectedRuntimeVersion) {
  throw new Error(
    `Python runtime version ${runtimeVersion ?? "is missing"}; expected ${expectedRuntimeVersion} from package.json`
  );
}

const notebookOutputSource = readFileSync(resolve(root, "src/shared/notebookOutput.ts"), "utf8");
const notebookRuntimeSource = readFileSync(resolve(root, "python/openwrangler_runtime/notebook.py"), "utf8");
for (const [typescriptName, pythonName] of [
  ["rows", "MAX_SAVED_ROWS"],
  ["columns", "MAX_SAVED_COLUMNS"],
  ["cells", "MAX_SAVED_CELLS"],
  ["bytes", "MAX_SAVED_PAYLOAD_BYTES"],
  ["labelCharacters", "MAX_SAVED_LABEL_CHARACTERS"],
  ["columnCharacters", "MAX_SAVED_COLUMN_CHARACTERS"],
  ["cellCharacters", "MAX_SAVED_CELL_CHARACTERS"]
]) {
  const typescriptValue = notebookOutputSource.match(new RegExp(`\\b${typescriptName}:\\s*([\\d_]+)`))?.[1];
  const pythonValue = notebookRuntimeSource.match(new RegExp(`^${pythonName}\\s*=\\s*([\\d_]+)$`, "m"))?.[1];
  if (
    !typescriptValue ||
    !pythonValue ||
    Number(typescriptValue.replaceAll("_", "")) !== Number(pythonValue.replaceAll("_", ""))
  ) {
    throw new Error(`Notebook output limit ${typescriptName}/${pythonName} differs between TypeScript and Python.`);
  }
}
for (const limitName of ["MAX_SAVED_PAYLOAD_NODES", "MAX_SAVED_PAYLOAD_DEPTH"]) {
  const typescriptValue = notebookOutputSource.match(new RegExp(`^const ${limitName}\\s*=\\s*([\\d_]+)`, "m"))?.[1];
  const pythonValue = notebookRuntimeSource.match(new RegExp(`^${limitName}\\s*=\\s*([\\d_]+)$`, "m"))?.[1];
  if (
    !typescriptValue ||
    !pythonValue ||
    Number(typescriptValue.replaceAll("_", "")) !== Number(pythonValue.replaceAll("_", ""))
  ) {
    throw new Error(`Notebook output structural limit ${limitName} differs between TypeScript and Python.`);
  }
}

const agentGuide = readFileSync(resolve(root, "AGENTS.md"), "utf8");
for (const file of required.filter((file) => file.startsWith("docs/"))) {
  if (!agentGuide.includes(file)) {
    throw new Error(`AGENTS.md must route agents to ${file}`);
  }
}
