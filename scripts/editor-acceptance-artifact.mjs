import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactEditorAcceptanceText } from "./editor-acceptance-evidence.mjs";

const MAX_RECEIPTS = 64;
const MAX_RECEIPT_ENTRIES = 512;
const MAX_SEALED_ENTRIES = 2_048;
const MAX_SEALED_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SEALED_ARTIFACT_BYTES = 40 * 1024 * 1024;
const OMITTED_SENSITIVE_SOURCE = "<sealed-source-omitted-sensitive-content>";
const defaultArtifactOperations = Object.freeze({
  afterWrite() {},
  closeDescriptor: closeSync
});

export function createEditorAcceptanceArtifactParent(base) {
  const resolvedBase = resolve(base);
  mkdirSync(resolvedBase, { recursive: true, mode: 0o700 });
  const baseMetadata = safeEvidenceMetadata(resolvedBase);
  if (!baseMetadata.isDirectory() || baseMetadata.isSymbolicLink()) {
    throw new Error("The sealed editor evidence base must be a real directory.");
  }
  const canonicalBase = realpathSync(resolvedBase);
  const parent = mkdtempSync(resolve(resolvedBase, "p-"));
  chmodSync(parent, 0o700);
  const metadata = safeEvidenceMetadata(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The sealed editor evidence parent must be a real directory.");
  }
  const canonicalParent = realpathSync(parent);
  requireContainedPath(canonicalBase, canonicalParent, "sealed editor evidence parent");
  return artifactParentReceipt(parent, canonicalParent, metadata);
}

export function removeEditorAcceptanceArtifactParent(receipt) {
  validateArtifactParentReceipt(receipt);
  assertArtifactParentReceipt(receipt);
  const directory = opendirSync(receipt.path);
  try {
    if (directory.readSync() !== null) {
      throw new Error("The sealed editor evidence parent is not empty.");
    }
  } finally {
    directory.closeSync();
  }
  assertArtifactParentReceipt(receipt);
  rmdirSync(receipt.path);
}

export function createEditorAcceptanceEvidenceStagingRoot(parent) {
  const resolvedParent = resolve(parent);
  mkdirSync(resolvedParent, { recursive: true, mode: 0o700 });
  const parentMetadata = safeEvidenceMetadata(resolvedParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("The editor evidence staging parent must be a real directory.");
  }
  const canonicalParent = realpathSync(resolvedParent);
  const root = mkdtempSync(resolve(resolvedParent, "s-"));
  const metadata = safeEvidenceMetadata(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The editor evidence staging root must be a real directory.");
  }
  const canonicalRoot = realpathSync(root);
  requireContainedPath(canonicalParent, canonicalRoot, "editor evidence staging root");
  return Object.freeze({
    root,
    canonicalRoot,
    snapshot: Object.freeze({ dev: metadata.dev, ino: metadata.ino, mode: metadata.mode })
  });
}

export function assertEditorAcceptanceEvidenceStagingRoot(receipt, { requireEmpty = false } = {}) {
  if (!receipt || typeof receipt !== "object" || typeof receipt.root !== "string") {
    throw new Error("The editor evidence staging receipt is invalid.");
  }
  const metadata = safeEvidenceMetadata(receipt.root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== receipt.snapshot?.dev ||
    metadata.ino !== receipt.snapshot?.ino ||
    metadata.mode !== receipt.snapshot?.mode ||
    realpathSync(receipt.root) !== receipt.canonicalRoot
  ) {
    throw new Error("The editor evidence staging root no longer matches its prelaunch identity.");
  }
  if (requireEmpty) {
    const directory = opendirSync(receipt.root);
    try {
      if (directory.readSync() !== null) {
        throw new Error("The prelaunch editor evidence staging root was modified by the editor process.");
      }
    } finally {
      directory.closeSync();
    }
  }
  return receipt.root;
}

export function captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target }) {
  const root = resolve(evidenceRoot);
  const resolvedTarget = resolve(target);
  requireContainedPath(root, resolvedTarget, "retained evidence target");
  const canonicalRoot = realpathDirectory(root, "retained evidence root");
  const canonicalTarget = realpathDirectory(resolvedTarget, "retained evidence target");
  requireContainedPath(canonicalRoot, canonicalTarget, "canonical retained evidence target");
  const targetName = relative(root, resolvedTarget);
  if (!isSafeRelativePath(targetName) || targetName.includes(sep)) {
    throw new Error("A retained evidence target must be one safe direct child of its root.");
  }
  return Object.freeze({
    root,
    target: resolvedTarget,
    targetName,
    entries: Object.freeze(captureStableInventory(resolvedTarget).map((entry) => Object.freeze(entry)))
  });
}

export function sealEditorAcceptanceEvidence(options) {
  return sealEditorAcceptanceEvidenceWithOperations(options, defaultArtifactOperations);
}

export function sealEditorAcceptanceEvidenceForTest(options, operations) {
  return sealEditorAcceptanceEvidenceWithOperations(options, validateArtifactOperations(operations));
}

function sealEditorAcceptanceEvidenceWithOperations({ evidenceRoot, artifactParent, receipts }, operations) {
  const root = resolve(evidenceRoot);
  validateArtifactParentReceipt(artifactParent);
  assertArtifactParentReceipt(artifactParent);
  const parentReceipt = artifactParent;
  const parent = parentReceipt.path;
  if (!Array.isArray(receipts) || receipts.length === 0 || receipts.length > MAX_RECEIPTS) {
    throw new Error(`Sealed editor evidence requires between 1 and ${MAX_RECEIPTS} in-memory receipts.`);
  }
  const canonicalParent = parentReceipt.canonicalPath;
  const canonicalRoot = realpathDirectory(root, "retained evidence root");
  if (canonicalParent === canonicalRoot || isContainedPath(canonicalRoot, canonicalParent)) {
    throw new Error("Sealed editor evidence must live outside its untrusted staging root.");
  }

  const entries = [];
  let sourceBytes = 0;
  for (let receiptIndex = 0; receiptIndex < receipts.length; receiptIndex += 1) {
    const receipt = receipts[receiptIndex];
    validateReceipt(receipt, root);
    const current = captureStableInventory(receipt.target);
    requireMatchingInventory(receipt.entries, current);
    for (const entry of receipt.entries) {
      if (entry.type !== "file") continue;
      if (entries.length >= MAX_SEALED_ENTRIES) {
        throw new Error(`Sealed editor evidence exceeds its ${MAX_SEALED_ENTRIES}-file inventory limit.`);
      }
      if (!isSafeRelativePath(entry.path)) throw new Error("A retained evidence file has an unsafe relative path.");
      const sourcePath = resolve(receipt.target, entry.path);
      requireContainedPath(receipt.target, sourcePath, "retained evidence file");
      const bytes = readReceiptFile(sourcePath, entry.snapshot);
      sourceBytes += bytes.length;
      if (sourceBytes > MAX_SEALED_SOURCE_BYTES) {
        throw new Error(`Sealed editor evidence exceeds its ${MAX_SEALED_SOURCE_BYTES}-byte source budget.`);
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("A retained evidence file is not strict UTF-8 text.");
      }
      const redacted = redactEditorAcceptanceText(text);
      entries.push({
        path: `evidence-${String(receiptIndex + 1).padStart(3, "0")}/${entry.path}`,
        text: redacted ?? OMITTED_SENSITIVE_SOURCE
      });
    }
  }

  const serialized = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SEALED_ARTIFACT_BYTES) {
    throw new Error(`Sealed editor evidence exceeds its ${MAX_SEALED_ARTIFACT_BYTES}-byte artifact limit.`);
  }
  const artifactPath = resolve(parent, `a-${randomUUID()}.json`);
  requireContainedPath(parent, artifactPath, "sealed evidence artifact");
  const receipt = writeExclusiveArtifact(artifactPath, serialized, parentReceipt, operations);
  assertSealedEditorAcceptanceArtifact(receipt);
  return receipt;
}

export function assertSealedEditorAcceptanceArtifact(receipt) {
  validateSealedArtifactReceipt(receipt);
  assertArtifactParentReceipt(receipt.parent);
  requireContainedPath(receipt.parent.path, receipt.path, "sealed evidence artifact");
  let descriptor;
  try {
    descriptor = openSync(receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("The sealed evidence artifact could not be opened without following links.");
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const openedPath = lstatSync(receipt.path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameEvidenceSnapshot(receipt.snapshot, evidenceSnapshot(opened)) ||
      !sameEvidenceSnapshot(receipt.snapshot, evidenceSnapshot(openedPath))
    ) {
      throw new Error("The sealed evidence artifact no longer matches its pinned identity.");
    }
    if (
      opened.size < 0n ||
      opened.size > BigInt(MAX_SEALED_ARTIFACT_BYTES) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("The sealed evidence artifact exceeds its handoff limit.");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const finalPath = lstatSync(receipt.path, { bigint: true });
    if (
      bytes.length !== Number(opened.size) ||
      !sameEvidenceSnapshot(receipt.snapshot, evidenceSnapshot(after)) ||
      !sameEvidenceSnapshot(receipt.snapshot, evidenceSnapshot(finalPath)) ||
      createHash("sha256").update(bytes).digest("hex") !== receipt.sha256
    ) {
      throw new Error("The sealed evidence artifact changed during handoff validation.");
    }
    assertArtifactParentReceipt(receipt.parent);
    return receipt.path;
  } finally {
    closeSync(descriptor);
  }
}

function validateReceipt(receipt, evidenceRoot) {
  if (!receipt || typeof receipt !== "object" || receipt.root !== evidenceRoot) {
    throw new Error("A sealed evidence receipt does not belong to the requested staging root.");
  }
  requireContainedPath(evidenceRoot, receipt.target, "receipt target");
  if (!Array.isArray(receipt.entries) || receipt.entries.length === 0 || receipt.entries.length > MAX_RECEIPT_ENTRIES) {
    throw new Error("A sealed evidence receipt has an invalid inventory.");
  }
}

function captureStableInventory(target) {
  const entries = [];
  const visit = (path, relativePath) => {
    if (entries.length >= MAX_RECEIPT_ENTRIES) {
      throw new Error(`A retained evidence target exceeds its ${MAX_RECEIPT_ENTRIES}-entry limit.`);
    }
    const before = safeEvidenceMetadata(path);
    const type = before.isDirectory() ? "directory" : before.isFile() ? "file" : undefined;
    if (!type || before.isSymbolicLink() || (type === "file" && before.nlink !== 1n)) {
      throw new Error("Retained evidence may contain only real directories and singly linked regular files.");
    }
    const entry = { path: relativePath, type, snapshot: evidenceSnapshot(before) };
    entries.push(entry);
    if (type === "directory") {
      const directory = opendirSync(path);
      const names = [];
      try {
        let child;
        while ((child = directory.readSync()) !== null) names.push(child.name);
      } finally {
        directory.closeSync();
      }
      names.sort();
      for (const name of names) {
        if (!isSafePathSegment(name)) throw new Error("A retained evidence entry has an unsafe name.");
        visit(resolve(path, name), relativePath === "." ? name : `${relativePath}/${name}`);
      }
    }
    const after = safeEvidenceMetadata(path);
    if (!sameEvidenceSnapshot(entry.snapshot, evidenceSnapshot(after))) {
      throw new Error("A retained evidence entry changed while its inventory was captured.");
    }
  };
  visit(target, ".");
  return entries;
}

function requireMatchingInventory(expected, current) {
  if (expected.length !== current.length) throw new Error("Retained evidence changed after collection.");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = current[index];
    if (left.path !== right.path || left.type !== right.type || !sameEvidenceSnapshot(left.snapshot, right.snapshot)) {
      throw new Error("Retained evidence changed after collection.");
    }
  }
}

function readReceiptFile(path, expected) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("A retained evidence file could not be opened without following links.");
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameEvidenceSnapshot(expected, evidenceSnapshot(opened))) {
      throw new Error("A retained evidence file no longer matches its collector receipt.");
    }
    if (
      opened.size < 0n ||
      opened.size > BigInt(MAX_SEALED_SOURCE_BYTES) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("A retained evidence file exceeds the sealed-source limit.");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const currentPath = safeEvidenceMetadata(path);
    if (
      bytes.length !== Number(opened.size) ||
      !sameEvidenceSnapshot(expected, evidenceSnapshot(after)) ||
      !sameEvidenceSnapshot(expected, evidenceSnapshot(currentPath))
    ) {
      throw new Error("A retained evidence file changed while it was sealed.");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveArtifact(path, contents, parentReceipt, operations) {
  let descriptor;
  let opened;
  let failure;
  let contentsScrubbed = false;
  const cleanupFailures = [];
  try {
    assertArtifactParentReceipt(parentReceipt);
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw new Error("The sealed evidence target is not a regular file.");
    const openedPath = lstatSync(path, { bigint: true });
    if (!openedPath.isFile() || openedPath.nlink !== 1n || !sameFileIdentity(opened, openedPath)) {
      throw new Error("The sealed evidence artifact path does not identify the file that was opened.");
    }
    assertArtifactParentReceipt(parentReceipt);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, completed) || completed.nlink !== 1n) {
      throw new Error("The sealed evidence artifact changed while it was written.");
    }
    operations.afterWrite();
    assertArtifactParentReceipt(parentReceipt);
    const finalMetadata = lstatSync(path, { bigint: true });
    if (!sameEvidenceSnapshot(evidenceSnapshot(completed), evidenceSnapshot(finalMetadata))) {
      throw new Error("The sealed evidence artifact changed before it was committed.");
    }
    assertArtifactParentReceipt(parentReceipt);
  } catch (error) {
    failure = error;
  }
  if (failure && descriptor !== undefined && opened) {
    try {
      contentsScrubbed = scrubOwnedArtifactIfOpen(descriptor, opened);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (descriptor !== undefined) {
    try {
      operations.closeDescriptor(descriptor);
    } catch (error) {
      if (!failure) failure = error;
      else cleanupFailures.push(error);
      try {
        const scrubbedAfterCloseError = opened && scrubOwnedArtifactIfOpen(descriptor, opened);
        contentsScrubbed ||= scrubbedAfterCloseError;
        if (scrubbedAfterCloseError) {
          try {
            operations.closeDescriptor(descriptor);
          } catch (retryError) {
            cleanupFailures.push(retryError);
            try {
              contentsScrubbed ||= scrubOwnedArtifactIfOpen(descriptor, opened);
            } catch (scrubError) {
              cleanupFailures.push(scrubError);
            }
          }
        }
      } catch (scrubError) {
        cleanupFailures.push(scrubError);
      }
    }
  }
  let receipt;
  if (!failure) {
    try {
      receipt = captureSealedArtifactReceipt(path, contents, opened, parentReceipt);
    } catch (error) {
      failure = error;
    }
  }
  if (failure) {
    if (opened) {
      try {
        removeOwnedArtifactPath(path, opened, parentReceipt, { requireSinglyLinked: !contentsScrubbed });
      } catch (error) {
        if (!contentsScrubbed) cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupFailures],
        "The sealed evidence artifact failed and its owned contents could not be scrubbed cleanly."
      );
    }
    throw failure;
  }
  return receipt;
}

function scrubOwnedArtifactIfOpen(descriptor, opened) {
  let before;
  try {
    before = fstatSync(descriptor, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EBADF") return false;
    throw error;
  }
  if (!before.isFile() || !sameFileIdentity(opened, before)) {
    throw new Error("The failed sealed evidence descriptor no longer owns its original file.");
  }
  ftruncateSync(descriptor, 0);
  fsyncSync(descriptor);
  const after = fstatSync(descriptor, { bigint: true });
  if (!after.isFile() || !sameFileIdentity(opened, after) || after.size !== 0n) {
    throw new Error("The failed sealed evidence artifact could not be scrubbed through its owned descriptor.");
  }
  return true;
}

function captureSealedArtifactReceipt(path, contents, openedWriter, parentReceipt) {
  assertArtifactParentReceipt(parentReceipt);
  const expectedSize = Buffer.byteLength(contents, "utf8");
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("The sealed evidence artifact could not be reopened after its writer closed.");
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const openedPath = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameFileIdentity(openedWriter, opened) ||
      !sameEvidenceSnapshot(evidenceSnapshot(opened), evidenceSnapshot(openedPath))
    ) {
      throw new Error("The sealed evidence artifact changed after its writer closed.");
    }
    if (
      opened.size < 0n ||
      opened.size > BigInt(MAX_SEALED_ARTIFACT_BYTES) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      opened.size !== BigInt(expectedSize)
    ) {
      throw new Error("The sealed evidence artifact exceeds its receipt limit.");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const finalPath = lstatSync(path, { bigint: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.length !== Number(opened.size) ||
      bytes.length !== expectedSize ||
      sha256 !== createHash("sha256").update(contents, "utf8").digest("hex") ||
      !sameEvidenceSnapshot(evidenceSnapshot(opened), evidenceSnapshot(after)) ||
      !sameEvidenceSnapshot(evidenceSnapshot(opened), evidenceSnapshot(finalPath))
    ) {
      throw new Error("The sealed evidence artifact changed while its receipt was captured.");
    }
    assertArtifactParentReceipt(parentReceipt);
    return Object.freeze({
      path,
      parent: parentReceipt,
      snapshot: Object.freeze(evidenceSnapshot(after)),
      sha256
    });
  } finally {
    closeSync(descriptor);
  }
}

function removeOwnedArtifactPath(path, opened, parentReceipt, { requireSinglyLinked }) {
  assertArtifactParentReceipt(parentReceipt);
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("The failed sealed evidence artifact disappeared before pinned-path cleanup.");
    }
    throw error;
  }
  if (
    !opened ||
    !current.isFile() ||
    !sameFileIdentity(opened, current) ||
    (requireSinglyLinked && current.nlink !== 1n)
  ) {
    throw new Error("The failed sealed evidence path no longer identifies its created file.");
  }
  assertArtifactParentReceipt(parentReceipt);
  rmSync(path, { force: true });
}

function validateArtifactOperations(operations) {
  if (!operations || typeof operations !== "object") {
    throw new Error("Artifact test operations are required.");
  }
  const resolved = {
    afterWrite: operations.afterWrite ?? defaultArtifactOperations.afterWrite,
    closeDescriptor: operations.closeDescriptor ?? defaultArtifactOperations.closeDescriptor
  };
  if (typeof resolved.afterWrite !== "function" || typeof resolved.closeDescriptor !== "function") {
    throw new Error("Artifact test operations must be functions.");
  }
  return Object.freeze(resolved);
}

function validateSealedArtifactReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.path !== "string" ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256) ||
    !receipt.parent ||
    !receipt.snapshot
  ) {
    throw new Error("The sealed evidence artifact receipt is invalid.");
  }
}

function artifactParentReceipt(path, canonicalPath, metadata) {
  return Object.freeze({
    path: resolve(path),
    canonicalPath,
    snapshot: Object.freeze({ dev: metadata.dev, ino: metadata.ino, mode: metadata.mode })
  });
}

function validateArtifactParentReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.path !== "string" ||
    typeof receipt.canonicalPath !== "string" ||
    !receipt.snapshot ||
    typeof receipt.snapshot !== "object"
  ) {
    throw new Error("The sealed editor evidence parent receipt is invalid.");
  }
}

function assertArtifactParentReceipt(receipt) {
  validateArtifactParentReceipt(receipt);
  let metadata;
  let canonicalPath;
  try {
    metadata = lstatSync(receipt.path, { bigint: true });
    canonicalPath = realpathSync(receipt.path);
  } catch {
    throw new Error("The sealed evidence artifact parent no longer matches its pinned identity.");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== receipt.snapshot.dev ||
    metadata.ino !== receipt.snapshot.ino ||
    metadata.mode !== receipt.snapshot.mode ||
    canonicalPath !== receipt.canonicalPath
  ) {
    throw new Error("The sealed evidence artifact parent no longer matches its pinned identity.");
  }
}

function safeEvidenceMetadata(path) {
  let metadata;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch {
    throw new Error("A retained evidence entry disappeared during verification.");
  }
  return metadata;
}

function evidenceSnapshot(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  };
}

function sameEvidenceSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function realpathDirectory(path, description) {
  const metadata = safeEvidenceMetadata(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`The ${description} must be a real directory.`);
  return realpathSync(path);
}

function isSafeRelativePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path !== "." &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path.split("/").every(isSafePathSegment)
  );
}

function isSafePathSegment(segment) {
  return typeof segment === "string" && /^[A-Za-z0-9._-]+$/u.test(segment) && segment !== "." && segment !== "..";
}

function requireContainedPath(parent, child, description) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (!isContainedPath(resolvedParent, resolvedChild)) throw new Error(`The ${description} is outside its owner.`);
}

function isContainedPath(parent, child) {
  const relation = relative(parent, child);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}
