import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileFromFile } from "json-schema-to-typescript";

const root = resolve(import.meta.dirname, "..");
const schemaPath = resolve(root, "protocol", "openwrangler.v2.schema.json");
const outputPath = resolve(root, "src", "shared", "protocol.generated.ts");
const generated = await compileFromFile(schemaPath, {
  bannerComment: "/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */",
  style: {
    bracketSpacing: true,
    printWidth: 120,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "none",
    useTabs: false
  },
  unreachableDefinitions: true
});

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    throw new Error("Generated protocol types are stale. Run npm run generate:protocol.");
  }
} else {
  await writeFile(outputPath, generated, "utf8");
}
