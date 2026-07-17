import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Uri } from "vscode";
import {
  createNodeAtomicExportFileSystem,
  exportFileSafely,
  type AtomicExportFileSystem,
  type AtomicExportHandle
} from "../extension/files/safeFileExport";

const SOURCE_CONTENTS = "value\n1\n";
const DESTINATION_CONTENTS = "# generated\ndef clean_data(df):\n    return df\n";

describe("safe Python-script file export", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "openwrangler-safe-export-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("publishes a new sibling file and leaves its protected source untouched", async () => {
    const source = path.join(directory, "source.csv");
    const destination = path.join(directory, "clean.py");
    await writeFile(source, SOURCE_CONTENTS);

    await exportFileSafely({
      destination: fileUri(destination),
      protectedSources: [fileUri(source)],
      contents: Buffer.from(DESTINATION_CONTENTS)
    });

    expect(await readFile(destination, "utf8")).toBe(DESTINATION_CONTENTS);
    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("atomically replaces an existing regular destination only after the complete temporary file exists", async () => {
    const source = path.join(directory, "source.csv");
    const destination = path.join(directory, "clean.py");
    await writeFile(source, SOURCE_CONTENTS);
    await writeFile(destination, "old destination");
    const canonicalDestination = await realpath(destination);
    const base = actualFileSystem();
    let replaceCalls = 0;
    const fileSystem = actualFileSystem({
      replace: async (temporary, target) => {
        replaceCalls += 1;
        expect(target).toBe(canonicalDestination);
        expect(path.dirname(temporary)).toBe(path.dirname(canonicalDestination));
        expect(await readFile(destination, "utf8")).toBe("old destination");
        expect(await readFile(temporary, "utf8")).toBe(DESTINATION_CONTENTS);
        await base.replace(temporary, target);
      }
    });

    await exportFileSafely({
      destination: fileUri(destination),
      protectedSources: [fileUri(source)],
      contents: Buffer.from(DESTINATION_CONTENTS),
      fileSystem,
      createTemporaryId: () => "overwrite"
    });

    expect(replaceCalls).toBe(1);
    expect(await readFile(destination, "utf8")).toBe(DESTINATION_CONTENTS);
    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("rejects a lexically normalized source alias without creating a temporary file", async () => {
    const source = path.join(directory, "source.csv");
    const normalizedAlias = path.join(directory, "missing", "..", "source.csv");
    await writeFile(source, SOURCE_CONTENTS);

    await expect(
      exportFileSafely({
        destination: fileUri(normalizedAlias),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/never overwrites the active source/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link alias of the protected source", async () => {
    const source = path.join(directory, "source.csv");
    const alias = path.join(directory, "source-alias.py");
    await writeFile(source, SOURCE_CONTENTS);
    await symlink(source, alias, "file");

    await expect(
      exportFileSafely({
        destination: fileUri(alias),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/never overwrites the active source/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(alias, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("rejects a hard-link alias of the protected source by file identity", async () => {
    const source = path.join(directory, "source.csv");
    const alias = path.join(directory, "source-alias.py");
    await writeFile(source, SOURCE_CONTENTS);
    await link(source, alias);

    await expect(
      exportFileSafely({
        destination: fileUri(alias),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/never overwrites the active source/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(alias, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("fails before creating a temporary file when the protected source identity is all zero", async () => {
    const source = path.join(directory, "source.csv");
    const destination = path.join(directory, "clean.py");
    await writeFile(source, SOURCE_CONTENTS);
    await writeFile(destination, "old destination");
    const base = actualFileSystem();
    const fileSystem = actualFileSystem({
      stat: async (target) =>
        path.basename(target).startsWith(".openwrangler-") ? base.stat(target) : { dev: 0n, ino: 0n }
    });

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS),
        fileSystem
      })
    ).rejects.toThrow(/stable filesystem identity for the active source/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(destination, "utf8")).toBe("old destination");
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("fails before creating a temporary file when a concrete protected source disappeared", async () => {
    const source = path.join(directory, "missing-source.csv");
    const destination = path.join(directory, "clean.py");

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/stable filesystem identity for the active source/u);

    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("fails before creating a temporary file when an existing destination identity is all zero", async () => {
    const source = path.join(directory, "source.csv");
    const destination = path.join(directory, "clean.py");
    await writeFile(source, SOURCE_CONTENTS);
    await writeFile(destination, "old destination");
    const base = actualFileSystem();
    const fileSystem = actualFileSystem({
      stat: async (target) => (target === destination ? { dev: 0n, ino: 0n } : base.stat(target))
    });

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS),
        fileSystem
      })
    ).rejects.toThrow(/stable filesystem identity for the existing Python-script destination/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(destination, "utf8")).toBe("old destination");
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a source alias reached through a symbolic-link parent", async () => {
    const sourceDirectory = path.join(directory, "source-directory");
    const aliasDirectory = path.join(directory, "source-directory-alias");
    const source = path.join(sourceDirectory, "source.csv");
    await mkdir(sourceDirectory);
    await writeFile(source, SOURCE_CONTENTS);
    await symlink(sourceDirectory, aliasDirectory, "dir");

    await expect(
      exportFileSafely({
        destination: fileUri(path.join(aliasDirectory, "source.csv")),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/never overwrites the active source/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(sourceDirectory)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("rejects a case-variant alias on Windows file systems", async () => {
    const source = path.join(directory, "source.csv");
    await writeFile(source, SOURCE_CONTENTS);

    await expect(
      exportFileSafely({
        destination: fileUri(path.join(directory, "SOURCE.CSV")),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/never overwrites the active source/u);

    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
  });

  it.skipIf(process.platform === "win32")(
    "rejects an unrelated symbolic-link destination rather than replacing it",
    async () => {
      const target = path.join(directory, "unrelated.py");
      const destination = path.join(directory, "link.py");
      await writeFile(target, "unrelated destination");
      await symlink(target, destination, "file");

      await expect(
        exportFileSafely({
          destination: fileUri(destination),
          contents: Buffer.from(DESTINATION_CONTENTS)
        })
      ).rejects.toThrow(/new or regular-file destination/u);

      expect(await readFile(target, "utf8")).toBe("unrelated destination");
      expect(await readFile(destination, "utf8")).toBe("unrelated destination");
      expect(await temporaryFiles(directory)).toEqual([]);
    }
  );

  it("rejects unsupported and cross-workspace destination schemes before filesystem mutation", async () => {
    const destination = path.join(directory, "clean.py");
    const attempts = [
      {
        destination: resourceUri("memfs", destination),
        expected: /local and VS Code remote file-system destinations only/u
      },
      {
        destination: resourceUri("vscode-remote", destination, "ssh-remote+other"),
        remoteAuthority: "ssh-remote+current",
        expected: /current local host or VS Code remote authority/u
      },
      {
        destination: resourceUri("vscode-remote", destination, "ssh-remote+current"),
        expected: /current local host or VS Code remote authority/u
      },
      {
        destination: fileUri(destination),
        remoteAuthority: "ssh-remote+current",
        expected: /current local host or VS Code remote authority/u
      },
      {
        destination: resourceUri("file", ""),
        expected: /concrete file-system destination/u
      }
    ];

    for (const attempt of attempts) {
      await expect(
        exportFileSafely({
          destination: attempt.destination,
          contents: Buffer.from(DESTINATION_CONTENTS),
          remoteAuthority: attempt.remoteAuthority
        })
      ).rejects.toThrow(attempt.expected);
    }

    expect(await readdir(directory)).toEqual([]);
  });

  it("accepts a destination on the matching VS Code remote authority", async () => {
    const destination = path.join(directory, "clean.py");

    await exportFileSafely({
      destination: resourceUri("vscode-remote", destination, "ssh-remote+current"),
      remoteAuthority: "ssh-remote+current",
      contents: Buffer.from(DESTINATION_CONTENTS)
    });

    expect(await readFile(destination, "utf8")).toBe(DESTINATION_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("rejects an existing directory destination before reserving a temporary file", async () => {
    const destination = path.join(directory, "clean.py");
    await mkdir(destination);

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        contents: Buffer.from(DESTINATION_CONTENTS)
      })
    ).rejects.toThrow(/new or regular-file destination/u);

    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("publishes concurrent exports as one complete payload without torn bytes or retained temps", async () => {
    const destination = path.join(directory, "clean.py");
    const first = Buffer.from("# first\n".repeat(4_096));
    const second = Buffer.from("# second\n".repeat(4_096));

    const outcomes = await Promise.allSettled([
      exportFileSafely({ destination: fileUri(destination), contents: first }),
      exportFileSafely({ destination: fileUri(destination), contents: second })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(Error);
        expect((outcome.reason as Error).message).toMatch(/destination changed/u);
      }
    }

    const result = await readFile(destination);
    expect([result.equals(first), result.equals(second)]).toContain(true);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("retries exclusive temporary-name collisions and then publishes successfully", async () => {
    const destination = path.join(directory, "clean.py");
    const base = actualFileSystem();
    const attemptedPaths: string[] = [];
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        attemptedPaths.push(target);
        if (attemptedPaths.length <= 2) throw fileSystemError("EEXIST", "reserved collision");
        return base.openExclusive(target);
      }
    });

    await exportFileSafely({
      destination: fileUri(destination),
      contents: Buffer.from(DESTINATION_CONTENTS),
      fileSystem,
      createTemporaryId: () => "collision"
    });

    expect(attemptedPaths.map((target) => path.basename(target))).toEqual([
      ".openwrangler-collision-0.tmp",
      ".openwrangler-collision-1.tmp",
      ".openwrangler-collision-2.tmp"
    ]);
    expect(await readFile(destination, "utf8")).toBe(DESTINATION_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("fails closed after all sixteen exclusive-name collisions without removing another process's files", async () => {
    const destination = path.join(directory, "clean.py");
    const attemptedPaths: string[] = [];
    let removeCalls = 0;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        attemptedPaths.push(target);
        throw fileSystemError("EEXIST", "reserved collision");
      },
      remove: async () => {
        removeCalls += 1;
      }
    });

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        contents: Buffer.from(DESTINATION_CONTENTS),
        fileSystem,
        createTemporaryId: () => "occupied"
      })
    ).rejects.toThrow(/reserve a unique sibling temporary file/u);

    expect(attemptedPaths).toHaveLength(16);
    expect(new Set(attemptedPaths).size).toBe(16);
    expect(removeCalls).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });

  it("propagates an unexpected exclusive-open failure without removing or replacing anything", async () => {
    const fixture = await sourceAndDestination(directory);
    const openFailure = fileSystemError("EACCES", "injected exclusive-open failure");
    let removeCalls = 0;
    const fileSystem = actualFileSystem({
      openExclusive: async () => Promise.reject(openFailure),
      remove: async () => {
        removeCalls += 1;
      }
    });

    await expectExportFailure(fixture, fileSystem, openFailure);
    expect(removeCalls).toBe(0);
  });

  it("closes the newly created Node handle when its identity lookup fails", async () => {
    const temporaryPath = path.join(directory, ".openwrangler-fstat-failure.tmp");
    const identityFailure = new Error("injected handle stat failure");
    let closeCalls = 0;
    const openFile = (async (target: string, flags: string, mode: number) => {
      const handle = await open(target, flags, mode);
      return {
        stat: async () => Promise.reject(identityFailure),
        close: async () => {
          closeCalls += 1;
          await handle.close();
        }
      } as unknown as Awaited<ReturnType<typeof open>>;
    }) as typeof open;
    const fileSystem = createNodeAtomicExportFileSystem(openFile);

    await expect(fileSystem.openExclusive(temporaryPath)).rejects.toBe(identityFailure);

    expect(closeCalls).toBe(1);
    expect((await lstat(temporaryPath)).isFile()).toBe(true);
    await unlink(temporaryPath);
  });

  it("removes a partially written temporary file after a write failure", async () => {
    const fixture = await sourceAndDestination(directory);
    const writeFailure = new Error("injected write failure");
    const base = actualFileSystem();
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          write: async (contents) => {
            await handle.write(contents.subarray(0, 7));
            throw writeFailure;
          }
        };
      }
    });

    await expectExportFailure(fixture, fileSystem, writeFailure);
  });

  it("removes the complete temporary file after an injected sync failure", async () => {
    const fixture = await sourceAndDestination(directory);
    const syncFailure = new Error("injected sync failure");
    const base = actualFileSystem();
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return { ...handle, sync: async () => Promise.reject(syncFailure) };
      }
    });

    await expectExportFailure(fixture, fileSystem, syncFailure);
  });

  it("removes the temporary file when the first close reports a failure", async () => {
    const fixture = await sourceAndDestination(directory);
    const closeFailure = new Error("injected close failure");
    const base = actualFileSystem();
    let closeCalls = 0;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            closeCalls += 1;
            if (closeCalls === 1) {
              await handle.close();
              throw closeFailure;
            }
          }
        };
      }
    });

    await expectExportFailure(fixture, fileSystem, closeFailure);
    expect(closeCalls).toBe(2);
  });

  it("removes the temporary file and preserves the existing destination after replace fails", async () => {
    const fixture = await sourceAndDestination(directory);
    const replaceFailure = new Error("injected replace failure");
    const fileSystem = actualFileSystem({
      replace: async () => Promise.reject(replaceFailure)
    });

    await expectExportFailure(fixture, fileSystem, replaceFailure);
  });

  it("reports both a primary failure and a failed cleanup close while still removing the temporary file", async () => {
    const fixture = await sourceAndDestination(directory);
    const writeFailure = new Error("injected write failure");
    const closeFailure = new Error("injected cleanup close failure");
    const base = actualFileSystem();
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        let closed = false;
        return {
          ...handle,
          write: async () => {
            throw writeFailure;
          },
          close: async () => {
            if (!closed) {
              closed = true;
              await handle.close();
            }
            throw closeFailure;
          }
        };
      }
    });

    const error = await captureFailure(() => exportFixture(fixture, fileSystem));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([writeFailure, closeFailure]);
    expect((error as Error).message).toMatch(/temporary file could not be cleaned up completely/u);
    await expectFixturePreserved(fixture);
  });

  it("aggregates a remove failure with the primary error and preserves the old source and destination", async () => {
    const fixture = await sourceAndDestination(directory);
    const writeFailure = new Error("injected write failure");
    const removeFailure = new Error("injected remove failure");
    const base = actualFileSystem();
    let retainedTemporary: string | undefined;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        retainedTemporary = target;
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          write: async () => {
            throw writeFailure;
          }
        };
      },
      remove: async () => {
        throw removeFailure;
      }
    });

    const error = await captureFailure(() => exportFixture(fixture, fileSystem));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([writeFailure, removeFailure]);
    await expectFixturePreserved(fixture, { expectedTemporaryCount: 1 });
    expect(retainedTemporary).toBeDefined();
    await unlink(retainedTemporary!);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("ignores ENOENT from cleanup without hiding the original failure", async () => {
    const fixture = await sourceAndDestination(directory);
    const replaceFailure = new Error("injected replace failure");
    const base = actualFileSystem();
    const fileSystem = actualFileSystem({
      replace: async () => {
        throw replaceFailure;
      },
      remove: async (target) => {
        await base.remove(target);
        throw fileSystemError("ENOENT", "already absent");
      }
    });

    await expectExportFailure(fixture, fileSystem, replaceFailure);
  });

  it("revalidates source identity immediately before replacement and cleans the completed temporary file", async () => {
    const source = path.join(directory, "source.csv");
    const destination = path.join(directory, "clean.py");
    await writeFile(source, SOURCE_CONTENTS);
    const base = actualFileSystem();
    let replaced = false;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            await link(source, destination);
          }
        };
      },
      replace: async () => {
        replaced = true;
      }
    });

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS),
        fileSystem,
        createTemporaryId: () => "race"
      })
    ).rejects.toThrow(/destination changed/u);

    expect(replaced).toBe(false);
    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(destination, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("refuses to replace a protected source renamed onto the destination during export", async () => {
    const fixture = await sourceAndDestination(directory);
    const displacedDestination = path.join(directory, "displaced-destination");
    const base = actualFileSystem();
    let replaced = false;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            await rename(fixture.destination, displacedDestination);
            await rename(fixture.source, fixture.destination);
            await rename(displacedDestination, fixture.source);
          }
        };
      },
      replace: async () => {
        replaced = true;
      }
    });

    await expect(exportFixture(fixture, fileSystem)).rejects.toThrow(/protected source changed/u);

    expect(replaced).toBe(false);
    expect(await readFile(fixture.source, "utf8")).toBe("old destination");
    expect(await readFile(fixture.destination, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("refuses to overwrite a destination that appeared while a new script was being written", async () => {
    const source = path.join(directory, "source.csv");
    const destination = path.join(directory, "clean.py");
    await writeFile(source, SOURCE_CONTENTS);
    const base = actualFileSystem();
    let replaced = false;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            await writeFile(destination, "concurrent destination");
          }
        };
      },
      replace: async () => {
        replaced = true;
      }
    });

    await expect(
      exportFileSafely({
        destination: fileUri(destination),
        protectedSources: [fileUri(source)],
        contents: Buffer.from(DESTINATION_CONTENTS),
        fileSystem,
        createTemporaryId: () => "appeared"
      })
    ).rejects.toThrow(/destination changed/u);

    expect(replaced).toBe(false);
    expect(await readFile(source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(destination, "utf8")).toBe("concurrent destination");
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("refuses to overwrite an existing destination that was replaced during export", async () => {
    const fixture = await sourceAndDestination(directory);
    const displacedDestination = path.join(directory, "original-destination");
    const base = actualFileSystem();
    let replaced = false;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            await rename(fixture.destination, displacedDestination);
            await writeFile(fixture.destination, "concurrent replacement");
          }
        };
      },
      replace: async () => {
        replaced = true;
      }
    });

    await expect(exportFixture(fixture, fileSystem)).rejects.toThrow(/destination changed/u);

    expect(replaced).toBe(false);
    expect(await readFile(fixture.source, "utf8")).toBe(SOURCE_CONTENTS);
    expect(await readFile(fixture.destination, "utf8")).toBe("concurrent replacement");
    expect(await readFile(displacedDestination, "utf8")).toBe("old destination");
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("refuses to publish when an existing destination disappears during export", async () => {
    const fixture = await sourceAndDestination(directory);
    const displacedDestination = path.join(directory, "moved-destination");
    const base = actualFileSystem();
    let replaced = false;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            await rename(fixture.destination, displacedDestination);
          }
        };
      },
      replace: async () => {
        replaced = true;
      }
    });

    await expect(exportFixture(fixture, fileSystem)).rejects.toThrow(/destination changed/u);

    expect(replaced).toBe(false);
    expect(await readFile(fixture.source, "utf8")).toBe(SOURCE_CONTENTS);
    await expect(readFile(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(displacedDestination, "utf8")).toBe("old destination");
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("refuses to publish when the destination folder identity changes during export", async () => {
    const fixture = await sourceAndDestination(directory);
    const base = actualFileSystem();
    let temporaryClosed = false;
    let replaced = false;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            temporaryClosed = true;
          }
        };
      },
      stat: async (target) => {
        const identity = await base.stat(target);
        return temporaryClosed && target === directory ? { dev: identity.dev, ino: identity.ino + 1n } : identity;
      },
      replace: async () => {
        replaced = true;
      }
    });

    await expect(exportFixture(fixture, fileSystem)).rejects.toThrow(/destination changed/u);

    expect(replaced).toBe(false);
    await expectFixturePreserved(fixture);
  });

  it("refuses to publish or remove a temporary pathname swapped after its handle closes", async () => {
    const fixture = await sourceAndDestination(directory);
    const base = actualFileSystem();
    let temporaryPath: string | undefined;
    let displacedPath: string | undefined;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        temporaryPath = target;
        displacedPath = path.join(directory, "displaced-owned-temp");
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          close: async () => {
            await handle.close();
            await rename(target, displacedPath!);
            await writeFile(target, "foreign replacement");
          }
        };
      }
    });

    const error = await captureFailure(() => exportFixture(fixture, fileSystem));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toMatch(/could not be cleaned up completely/u);
    expect(temporaryPath).toBeDefined();
    expect(displacedPath).toBeDefined();
    expect(await readFile(temporaryPath!, "utf8")).toBe("foreign replacement");
    expect(await readFile(displacedPath!, "utf8")).toBe(DESTINATION_CONTENTS);
    await expectFixturePreserved(fixture, { expectedTemporaryCount: 1 });
  });

  it("leaves a substituted temporary pathname untouched when its identity is unusable", async () => {
    const fixture = await sourceAndDestination(directory);
    const base = actualFileSystem();
    let temporaryPath: string | undefined;
    let displacedPath: string | undefined;
    let replaceCalls = 0;
    let removeCalls = 0;
    const fileSystem = actualFileSystem({
      openExclusive: async (target) => {
        temporaryPath = target;
        displacedPath = path.join(directory, "displaced-zero-identity-temp");
        const handle = await base.openExclusive(target);
        return {
          ...handle,
          identity: { dev: 0n, ino: 0n },
          close: async () => {
            await handle.close();
            await rename(target, displacedPath!);
            await writeFile(target, "foreign replacement");
          }
        };
      },
      replace: async () => {
        replaceCalls += 1;
      },
      remove: async () => {
        removeCalls += 1;
      }
    });

    await expect(exportFixture(fixture, fileSystem)).rejects.toThrow(/did not provide a usable identity/u);

    expect(replaceCalls).toBe(0);
    expect(removeCalls).toBe(0);
    expect(temporaryPath).toBeDefined();
    expect(displacedPath).toBeDefined();
    expect(await readFile(temporaryPath!, "utf8")).toBe("foreign replacement");
    expect(await readFile(displacedPath!)).toHaveLength(0);
    await expectFixturePreserved(fixture, { expectedTemporaryCount: 1 });
  });

  it.each(["realpath", "stat", "lstat"] as const)(
    "cleans the completed temporary file when second-validation %s fails",
    async (method) => {
      const fixture = await sourceAndDestination(directory);
      const validationFailure = fileSystemError("EIO", `injected second-validation ${method} failure`);
      const base = actualFileSystem();
      let calls = 0;
      let temporaryClosed = false;
      let failed = false;
      const failingTarget = method === "lstat" ? fixture.destination : fixture.source;
      const fileSystem = actualFileSystem({
        openExclusive: async (target) => {
          const handle = await base.openExclusive(target);
          return {
            ...handle,
            close: async () => {
              await handle.close();
              temporaryClosed = true;
            }
          };
        },
        [method]: async (target: string) => {
          calls += 1;
          if (temporaryClosed && !failed && target === failingTarget) {
            failed = true;
            throw validationFailure;
          }
          return base[method](target);
        }
      });

      await expectExportFailure(fixture, fileSystem, validationFailure);
      expect(failed).toBe(true);
      expect(calls).toBeGreaterThan(0);
    }
  );
});

interface ExportFixture {
  directory: string;
  source: string;
  destination: string;
}

async function sourceAndDestination(directory: string): Promise<ExportFixture> {
  const source = path.join(directory, "source.csv");
  const destination = path.join(directory, "clean.py");
  await writeFile(source, SOURCE_CONTENTS);
  await writeFile(destination, "old destination");
  return { directory, source, destination };
}

async function exportFixture(fixture: ExportFixture, fileSystem: AtomicExportFileSystem): Promise<void> {
  await exportFileSafely({
    destination: fileUri(fixture.destination),
    protectedSources: [fileUri(fixture.source)],
    contents: Buffer.from(DESTINATION_CONTENTS),
    fileSystem,
    createTemporaryId: () => "fault"
  });
}

async function expectExportFailure(
  fixture: ExportFixture,
  fileSystem: AtomicExportFileSystem,
  expected: Error
): Promise<void> {
  const error = await captureFailure(() => exportFixture(fixture, fileSystem));
  expect(error).toBe(expected);
  await expectFixturePreserved(fixture);
}

async function expectFixturePreserved(
  fixture: ExportFixture,
  { expectedTemporaryCount = 0 }: { expectedTemporaryCount?: number } = {}
): Promise<void> {
  expect(await readFile(fixture.source, "utf8")).toBe(SOURCE_CONTENTS);
  expect(await readFile(fixture.destination, "utf8")).toBe("old destination");
  expect(await temporaryFiles(fixture.directory)).toHaveLength(expectedTemporaryCount);
}

async function captureFailure(operation: () => Promise<void>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected safe export to fail.");
}

function actualFileSystem(overrides: Partial<AtomicExportFileSystem> = {}): AtomicExportFileSystem {
  const implementation: AtomicExportFileSystem = {
    realpath,
    async stat(target) {
      const details = await stat(target, { bigint: true });
      return { dev: details.dev, ino: details.ino };
    },
    async lstat(target) {
      const details = await lstat(target);
      return { isFile: details.isFile(), isSymbolicLink: details.isSymbolicLink() };
    },
    async openExclusive(target): Promise<AtomicExportHandle> {
      const handle = await open(target, "wx", 0o600);
      const details = await handle.stat({ bigint: true });
      return {
        identity: { dev: details.dev, ino: details.ino },
        write: async (contents) => handle.writeFile(contents),
        sync: async () => handle.sync(),
        close: async () => handle.close()
      };
    },
    replace: rename,
    remove: unlink
  };
  return { ...implementation, ...overrides };
}

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.startsWith(".openwrangler-")).sort();
}

function fileUri(fsPath: string): Uri {
  return resourceUri("file", fsPath);
}

function resourceUri(scheme: string, fsPath: string, authority = ""): Uri {
  return { scheme, fsPath, authority } as Uri;
}

function fileSystemError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
