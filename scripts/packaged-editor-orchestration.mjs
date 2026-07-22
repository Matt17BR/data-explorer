import { rmSync } from "node:fs";
import { clearEditorAcceptanceEvidence } from "./editor-acceptance-evidence.mjs";

export async function runPackagedEditorOrchestration(
  { evidenceRoot, run, retainFailure, cleanup, failureMessage = "Packaged editor acceptance failed." },
  { clearEvidence = clearEditorAcceptanceEvidence } = {}
) {
  return runWithRetainedFailure({
    run: async () => {
      clearEvidence(evidenceRoot);
      return run();
    },
    retainFailure,
    cleanup,
    failureMessage
  });
}

export async function runWithRetainedFailure({ run, retainFailure, cleanup, failureMessage }) {
  let value;
  let primaryError;
  let hasPrimaryError = false;
  const retentionErrors = [];
  let cleanupError;
  let hasCleanupError = false;

  try {
    value = await run();
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    try {
      await retainFailure(error, { stage: "run" });
    } catch (errorDuringRetention) {
      retentionErrors.push(errorDuringRetention);
    }
  }

  try {
    await cleanup();
  } catch (errorDuringCleanup) {
    cleanupError = errorDuringCleanup;
    hasCleanupError = true;
  }

  if (!hasPrimaryError && hasCleanupError) {
    try {
      await retainFailure(cleanupError, { stage: "cleanup" });
    } catch (errorDuringRetention) {
      retentionErrors.push(errorDuringRetention);
    }
    if (retentionErrors.length > 0) {
      throw new AggregateError(
        [cleanupError, ...retentionErrors],
        failureMessage ?? "Packaged editor acceptance cleanup failed and its evidence could not be retained."
      );
    }
    throw cleanupError;
  }

  if (hasPrimaryError) {
    if (hasCleanupError) {
      try {
        await retainFailure(cleanupError, { stage: "cleanup" });
      } catch (errorDuringRetention) {
        retentionErrors.push(errorDuringRetention);
      }
    }
    const secondaryErrors = [...retentionErrors, ...(hasCleanupError ? [cleanupError] : [])];
    if (secondaryErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...secondaryErrors],
        failureMessage ?? "Packaged editor acceptance failed during evidence retention or cleanup."
      );
    }
    throw primaryError;
  }
  return value;
}

export function packagedEditorFailureLeaves(error, seen = new Set()) {
  if (seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    const leaves = error.errors.flatMap((nested) => packagedEditorFailureLeaves(nested, seen));
    // Empty and self-cyclic aggregates are still real failures. Retain the bounded
    // aggregate itself when traversal cannot produce a unique diagnostic leaf.
    return leaves.length > 0 ? leaves : [error];
  }
  return [error];
}

export function removeEditorAcceptancePrivateRoot(path, { processTreeVerifiedStopped = true, remove = rmSync } = {}) {
  if (!processTreeVerifiedStopped) {
    const error = new Error(
      "Private editor files were intentionally left untouched because the owning process tree could not be verified as stopped."
    );
    error.code = "EDITOR_PRIVATE_ROOT_CLEANUP_WITHHELD";
    error.details = {
      phase: "cleanup",
      treeVerifiedStopped: false,
      privateRootCleanup: "withheld"
    };
    throw error;
  }
  remove(path, { recursive: true, force: true });
}
