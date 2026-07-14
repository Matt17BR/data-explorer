import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

for (const directory of ["dist", "media"]) {
  rmSync(resolve(root, directory), { force: true, recursive: true });
}
