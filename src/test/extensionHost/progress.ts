import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { isAbsolute } from "node:path";

export const ACCEPTANCE_PROGRESS_MAX_BYTES = 1024;

interface AcceptanceProgressWriteOptions {
  randomId?: () => string;
}

export function writeAcceptanceProgressCheckpoint(
  progressPath: string,
  checkpoint: string,
  { randomId = randomUUID }: AcceptanceProgressWriteOptions = {}
): void {
  if (
    typeof progressPath !== "string" ||
    progressPath.length === 0 ||
    progressPath.length > 16_384 ||
    !isAbsolute(progressPath) ||
    /[\0\r\n]/u.test(progressPath)
  ) {
    throw new Error("An editor acceptance progress path must be a bounded absolute filesystem path.");
  }
  if (
    typeof checkpoint !== "string" ||
    checkpoint.length === 0 ||
    checkpoint.includes("\n") ||
    checkpoint.includes("\r") ||
    Buffer.byteLength(checkpoint, "utf8") + 1 > ACCEPTANCE_PROGRESS_MAX_BYTES
  ) {
    throw new Error(
      "An editor acceptance checkpoint must be a non-empty, single-line UTF-8 string whose file is at most 1024 bytes including its newline."
    );
  }

  const suffix = randomId();
  if (!/^[0-9A-Za-z-]{1,64}$/u.test(suffix)) {
    throw new Error("An editor acceptance checkpoint temporary suffix must be a bounded safe identifier.");
  }
  const temporaryPath = `${progressPath}.${process.pid}.${suffix}.tmp`;
  let descriptor: number | undefined;
  let ownedIdentity: BigIntStats | undefined;
  let renamed = false;
  let operationError: unknown;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    ownedIdentity = fstatSync(descriptor, { bigint: true });
    if (!ownedIdentity.isFile() || ownedIdentity.nlink !== 1n) {
      throw new Error("The acceptance checkpoint temporary must be one exclusively owned regular file.");
    }
    writeFileSync(descriptor, `${checkpoint}\n`, { encoding: "utf8" });
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !completed.isFile() ||
      completed.nlink !== 1n ||
      completed.dev !== ownedIdentity.dev ||
      completed.ino !== ownedIdentity.ino
    ) {
      throw new Error("The acceptance checkpoint temporary changed while it was written.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    const pathIdentity = lstatSync(temporaryPath, { bigint: true });
    if (
      !pathIdentity.isFile() ||
      pathIdentity.isSymbolicLink() ||
      pathIdentity.nlink !== 1n ||
      pathIdentity.dev !== completed.dev ||
      pathIdentity.ino !== completed.ino
    ) {
      throw new Error("The acceptance checkpoint temporary path changed before publication.");
    }
    renameSync(temporaryPath, progressPath);
    renamed = true;
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!renamed && ownedIdentity) {
    try {
      const current = lstatSync(temporaryPath, { bigint: true });
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.nlink === 1n &&
        current.dev === ownedIdentity.dev &&
        current.ino === ownedIdentity.ino
      ) {
        rmSync(temporaryPath, { force: true });
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        cleanupErrors.push(error);
      }
    }
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Acceptance checkpoint publication and temporary cleanup both failed."
    );
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Acceptance checkpoint temporary cleanup failed.");
  }
}
