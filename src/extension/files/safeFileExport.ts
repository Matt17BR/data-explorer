import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

const supportedSchemes = new Set(["file", "vscode-remote"]);
const TEMPORARY_FILE_ATTEMPTS = 16;

type FileIdentity = { dev: bigint; ino: bigint };

interface ProtectedSourceAnchor {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

interface DestinationAnchor {
  path: string;
  canonicalPath: string;
  identity?: FileIdentity;
  parentPath: string;
  canonicalParentPath: string;
  parentIdentity: FileIdentity;
}

export interface AtomicExportHandle {
  readonly identity: FileIdentity;
  write(contents: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicExportFileSystem {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<FileIdentity>;
  lstat(target: string): Promise<{ isFile: boolean; isSymbolicLink: boolean }>;
  openExclusive(target: string): Promise<AtomicExportHandle>;
  replace(source: string, destination: string): Promise<void>;
  remove(target: string): Promise<void>;
}

export interface SafeFileExportOptions {
  destination: vscode.Uri;
  protectedSources?: readonly vscode.Uri[];
  contents: Uint8Array;
  remoteAuthority?: string;
  fileSystem?: AtomicExportFileSystem;
  createTemporaryId?: () => string;
}

export function createNodeAtomicExportFileSystem(openFile: typeof open = open): AtomicExportFileSystem {
  return {
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
      const handle = await openFile(target, "wx", 0o600);
      try {
        const details = await handle.stat({ bigint: true });
        return nodeHandle(handle, { dev: details.dev, ino: details.ino });
      } catch (error) {
        try {
          await handle.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "Open Wrangler could not inspect or close its newly created temporary export file."
          );
        }
        throw error;
      }
    },
    replace: rename,
    remove: unlink
  };
}

const nodeFileSystem = createNodeAtomicExportFileSystem();

export async function exportFileSafely({
  destination,
  protectedSources = [],
  contents,
  remoteAuthority,
  fileSystem = nodeFileSystem,
  createTemporaryId = randomUUID
}: SafeFileExportOptions): Promise<void> {
  if (!supportedSchemes.has(destination.scheme)) {
    throw new Error("Python-script export supports local and VS Code remote file-system destinations only.");
  }
  if (
    (destination.scheme === "vscode-remote" && (!remoteAuthority || destination.authority !== remoteAuthority)) ||
    (destination.scheme === "file" && remoteAuthority)
  ) {
    throw new Error("Choose a Python-script destination on the current local host or VS Code remote authority.");
  }
  if (!destination.fsPath) throw new Error("Choose a concrete file-system destination for the Python script.");

  const protectedSourceAnchors = await captureProtectedSourceAnchors(fileSystem, protectedSources);
  const destinationAnchor = await captureDestinationAnchor(fileSystem, destination.fsPath, protectedSourceAnchors);
  await assertProtectedSourcesUnchanged(fileSystem, protectedSourceAnchors);
  await assertDestinationUnchanged(fileSystem, destinationAnchor);
  const resolvedDestination = destinationAnchor.canonicalPath;

  let temporaryPath: string | undefined;
  let temporaryIdentity: AtomicExportHandle["identity"] | undefined;
  let handle: AtomicExportHandle | undefined;
  try {
    for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
      const candidate = path.join(
        path.dirname(resolvedDestination),
        `.openwrangler-${createTemporaryId()}-${attempt}.tmp`
      );
      try {
        handle = await fileSystem.openExclusive(candidate);
        if (!isUsableIdentity(handle.identity)) {
          throw new Error(
            "The filesystem did not provide a usable identity for Open Wrangler's temporary export file; it was not published or removed."
          );
        }
        temporaryPath = candidate;
        temporaryIdentity = handle.identity;
        break;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
      }
    }
    if (!handle || !temporaryPath || !temporaryIdentity) {
      throw new Error("Could not reserve a unique sibling temporary file for the Python script.");
    }

    await handle.write(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertKnownTemporary(fileSystem, temporaryPath, temporaryIdentity);
    await assertProtectedSourcesUnchanged(fileSystem, protectedSourceAnchors);
    await assertDestinationUnchanged(fileSystem, destinationAnchor);
    await assertKnownTemporary(fileSystem, temporaryPath, temporaryIdentity);
    await fileSystem.replace(temporaryPath, resolvedDestination);
    temporaryPath = undefined;
    temporaryIdentity = undefined;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (temporaryPath) {
      try {
        if (!temporaryIdentity) {
          throw new Error("Open Wrangler could not verify ownership of its temporary export file.");
        }
        await assertKnownTemporary(fileSystem, temporaryPath, temporaryIdentity);
        await fileSystem.remove(temporaryPath);
      } catch (cleanupError) {
        if (!isFileSystemError(cleanupError, "ENOENT")) cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Python-script export failed and its temporary file could not be cleaned up completely."
      );
    }
    throw error;
  }
}

async function captureProtectedSourceAnchors(
  fileSystem: AtomicExportFileSystem,
  protectedSources: readonly vscode.Uri[]
): Promise<ProtectedSourceAnchor[]> {
  const anchors: ProtectedSourceAnchor[] = [];
  for (const source of protectedSources) {
    if (!supportedSchemes.has(source.scheme) || !source.fsPath) continue;
    const identity = await optionalStat(fileSystem, source.fsPath);
    if (!identity || !isUsableIdentity(identity)) {
      throw new Error(
        "Open Wrangler could not establish a stable filesystem identity for the active source; nothing was exported."
      );
    }
    anchors.push({
      path: source.fsPath,
      canonicalPath: await canonicalPath(fileSystem, source.fsPath),
      identity
    });
  }
  return anchors;
}

async function assertProtectedSourcesUnchanged(
  fileSystem: AtomicExportFileSystem,
  anchors: readonly ProtectedSourceAnchor[]
): Promise<void> {
  for (const anchor of anchors) {
    const canonicalSource = await canonicalPath(fileSystem, anchor.path);
    const identity = await optionalStat(fileSystem, anchor.path);
    if (
      comparablePath(canonicalSource) !== comparablePath(anchor.canonicalPath) ||
      !identity ||
      !isUsableIdentity(identity) ||
      !sameIdentity(identity, anchor.identity)
    ) {
      throw new Error("A protected source changed while the Python script was being exported; nothing was published.");
    }
  }
}

async function captureDestinationAnchor(
  fileSystem: AtomicExportFileSystem,
  destination: string,
  protectedSources: readonly ProtectedSourceAnchor[]
): Promise<DestinationAnchor> {
  const entry = await optionalLstat(fileSystem, destination);
  const identity = await optionalStat(fileSystem, destination);
  if (Boolean(entry) !== Boolean(identity)) {
    throw destinationChangedError();
  }
  if (identity && !isUsableIdentity(identity)) {
    throw new Error(
      "Open Wrangler could not establish a stable filesystem identity for the existing Python-script destination."
    );
  }

  const parentPath = path.dirname(path.resolve(destination));
  const parentIdentity = await optionalStat(fileSystem, parentPath);
  if (!parentIdentity || !isUsableIdentity(parentIdentity)) {
    throw new Error(
      "Open Wrangler could not establish a stable filesystem identity for the Python-script destination folder."
    );
  }
  const anchor: DestinationAnchor = {
    path: destination,
    canonicalPath: await canonicalPath(fileSystem, destination),
    identity,
    parentPath,
    canonicalParentPath: await canonicalPath(fileSystem, parentPath),
    parentIdentity
  };

  assertDestinationDiffersFromSources(anchor, protectedSources);
  if (entry && (!entry.isFile || entry.isSymbolicLink)) {
    throw new Error("Choose a new or regular-file destination for the exported Python script.");
  }
  return anchor;
}

async function assertDestinationUnchanged(
  fileSystem: AtomicExportFileSystem,
  anchor: DestinationAnchor
): Promise<void> {
  const parentIdentity = await optionalStat(fileSystem, anchor.parentPath);
  const canonicalParentPath = await canonicalPath(fileSystem, anchor.parentPath);
  if (
    !parentIdentity ||
    !isUsableIdentity(parentIdentity) ||
    !sameIdentity(parentIdentity, anchor.parentIdentity) ||
    comparablePath(canonicalParentPath) !== comparablePath(anchor.canonicalParentPath)
  ) {
    throw destinationChangedError();
  }

  const entry = await optionalLstat(fileSystem, anchor.path);
  const identity = await optionalStat(fileSystem, anchor.path);
  if (
    (entry && (!entry.isFile || entry.isSymbolicLink)) ||
    Boolean(entry) !== Boolean(anchor.identity) ||
    Boolean(identity) !== Boolean(anchor.identity) ||
    (identity && (!isUsableIdentity(identity) || !sameIdentity(identity, anchor.identity!))) ||
    comparablePath(await canonicalPath(fileSystem, anchor.path)) !== comparablePath(anchor.canonicalPath)
  ) {
    throw destinationChangedError();
  }
}

function assertDestinationDiffersFromSources(
  destination: DestinationAnchor,
  protectedSources: readonly ProtectedSourceAnchor[]
): void {
  for (const source of protectedSources) {
    if (
      comparablePath(source.path) === comparablePath(destination.path) ||
      comparablePath(source.canonicalPath) === comparablePath(destination.canonicalPath) ||
      (destination.identity && sameIdentity(source.identity, destination.identity))
    ) {
      throw sourceCollisionError();
    }
  }
}

async function assertKnownTemporary(
  fileSystem: AtomicExportFileSystem,
  temporaryPath: string,
  expectedIdentity: { dev: bigint; ino: bigint }
): Promise<void> {
  if (!isUsableIdentity(expectedIdentity)) {
    throw new Error("Open Wrangler could not verify ownership of its temporary export file.");
  }
  const entry = await optionalLstat(fileSystem, temporaryPath);
  const identity = await optionalStat(fileSystem, temporaryPath);
  if (
    !entry ||
    !entry.isFile ||
    entry.isSymbolicLink ||
    !identity ||
    identity.dev !== expectedIdentity.dev ||
    identity.ino !== expectedIdentity.ino
  ) {
    throw new Error("Open Wrangler's temporary export file changed unexpectedly; it was not published or removed.");
  }
}

async function canonicalPath(fileSystem: AtomicExportFileSystem, target: string): Promise<string> {
  let current = path.resolve(target);
  const missingParts: string[] = [];
  while (true) {
    try {
      return path.join(await fileSystem.realpath(current), ...missingParts);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missingParts.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function optionalStat(fileSystem: AtomicExportFileSystem, target: string): Promise<FileIdentity | undefined> {
  try {
    return await fileSystem.stat(target);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isUsableIdentity(identity: FileIdentity): boolean {
  return identity.dev !== 0n || identity.ino !== 0n;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function optionalLstat(
  fileSystem: AtomicExportFileSystem,
  target: string
): Promise<{ isFile: boolean; isSymbolicLink: boolean } | undefined> {
  try {
    return await fileSystem.lstat(target);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function comparablePath(target: string): string {
  const normalized = path.resolve(target);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sourceCollisionError(): Error {
  return new Error("Choose a separate Python-script destination; Open Wrangler never overwrites the active source.");
}

function destinationChangedError(): Error {
  return new Error("The selected Python-script destination changed before it could be replaced safely.");
}

function nodeHandle(handle: FileHandle, identity: AtomicExportHandle["identity"]): AtomicExportHandle {
  return {
    identity,
    write: async (contents) => handle.writeFile(contents),
    sync: async () => handle.sync(),
    close: async () => handle.close()
  };
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
