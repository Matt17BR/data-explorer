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

const agentGuide = readFileSync(resolve(root, "AGENTS.md"), "utf8");
for (const file of required.filter((file) => file.startsWith("docs/"))) {
  if (!agentGuide.includes(file)) {
    throw new Error(`AGENTS.md must route agents to ${file}`);
  }
}
