import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_PROGRESS_MAX_BYTES, writeAcceptanceProgressCheckpoint } from "./extensionHost/progress";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("extension-host acceptance progress", () => {
  it("publishes one bounded checkpoint through an exclusive randomized sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-host-progress-"));
    temporaryDirectories.push(directory);
    const progressPath = join(directory, "progress.txt");

    writeAcceptanceProgressCheckpoint(progressPath, "verify:first", { randomId: () => "first" });
    expect(await readFile(progressPath, "utf8")).toBe("verify:first\n");
    writeAcceptanceProgressCheckpoint(progressPath, "verify:second", { randomId: () => "second" });
    expect(await readFile(progressPath, "utf8")).toBe("verify:second\n");
    expect(await readdir(directory)).toEqual(["progress.txt"]);
  });

  it("rejects multiline and oversized checkpoints before touching the destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-host-progress-"));
    temporaryDirectories.push(directory);
    const progressPath = join(directory, "progress.txt");

    for (const checkpoint of ["", "verify:first\nverify:second", "x".repeat(ACCEPTANCE_PROGRESS_MAX_BYTES)]) {
      assert.throws(
        () => writeAcceptanceProgressCheckpoint(progressPath, checkpoint),
        /non-empty, single-line UTF-8 string/u
      );
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("never truncates or removes a pre-existing temporary hard-link trap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-host-progress-"));
    temporaryDirectories.push(directory);
    const progressPath = join(directory, "progress.txt");
    const victimPath = join(directory, "victim.txt");
    const trapPath = `${progressPath}.${process.pid}.trapped.tmp`;
    await writeFile(victimPath, "keep me", "utf8");
    await link(victimPath, trapPath);

    assert.throws(
      () => writeAcceptanceProgressCheckpoint(progressPath, "verify:checkpoint", { randomId: () => "trapped" }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST")
    );
    expect(await readFile(victimPath, "utf8")).toBe("keep me");
    expect(await readFile(trapPath, "utf8")).toBe("keep me");
    expect((await stat(victimPath)).nlink).toBe(2);
  });
});
