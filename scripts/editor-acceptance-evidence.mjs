import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const MAX_LOG_FILES = 24;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_TOTAL_LOG_BYTES = 8 * 1024 * 1024;
// Failure collection is synchronous and happens after the editor phase deadline. Count every candidate,
// including missing or rejected files, and charge every opened regular file before scanning it so a hostile
// profile cannot turn redaction into an unbounded post-failure read loop.
const MAX_EVIDENCE_SOURCE_CANDIDATES = 64;
const MAX_TOTAL_EVIDENCE_SCAN_BYTES = 64 * 1024 * 1024;
// A single source is scanned completely for private-key markers before its bounded tail can be retained.
// Rejecting larger files before that scan keeps failure collection deterministic under hostile profiles.
const MAX_EVIDENCE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 4_000;
const MAX_FAILURE_BYTES = 128 * 1024;
const MAX_FAILURE_DEPTH = 8;
const MAX_FAILURE_ENTRIES = 256;
const MAX_FAILURE_STRING_BYTES = 8 * 1024;
const OVERSIZED_DIAGNOSTIC_MARKER = "<diagnostic-omitted-size-budget>";
// Converting an arbitrary BigInt to decimal allocates the complete digit string before a text cap can run.
// Preserve ordinary diagnostic values while replacing anything beyond this fixed comparison-only bound.
const MAX_FAILURE_BIGINT_DIGITS = 1_024;
const MAX_FAILURE_BIGINT_ABSOLUTE = 10n ** BigInt(MAX_FAILURE_BIGINT_DIGITS);
const MAX_FAILURE_LIST_ENTRIES = 256;
const MAX_PATH_METADATA_BYTES = 1_024;
// Security escapes are normalized at most this deeply. A still-decodable escape after the final pass is
// rejected instead of retained. Every admitted source is already capped at 16 MiB, so evidence is decoded,
// normalized, and redacted as one bounded value before its retained tail is selected. This avoids heuristic
// cross-chunk state that nested escape encodings could otherwise defeat.
const MAX_SECURITY_NORMALIZATION_PASSES = 16;
const SECRET_HEADER = /((?:authorization|cookie)\s*[:=]\s*)[^\r\n]*/giu;
const JSON_SECRET_FIELD =
  /("(?:[^"\\]|\\.)*(?:authorization|auth|cookie|password|passwd|secret|credential|api(?:[_-]|[^\S\r\n]{1,8})?key|account(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|refresh(?:[_-]|[^\S\r\n]{1,8})?token|signing(?:[_-]|[^\S\r\n]{1,8})?key|token)(?:[^"\\]|\\.)*"\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\r\n]*)/giu;
const SINGLE_QUOTED_SECRET_FIELD =
  /('(?:[^'\\]|\\.)*(?:authorization|auth|cookie|password|passwd|secret|credential|api(?:[_-]|[^\S\r\n]{1,8})?key|account(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|refresh(?:[_-]|[^\S\r\n]{1,8})?token|signing(?:[_-]|[^\S\r\n]{1,8})?key|token)(?:[^'\\]|\\.)*'\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\r\n]*)/giu;
const SECRET_ASSIGNMENT =
  /(\b[a-z0-9_.-]*(?:authorization|auth|cookie|password|passwd|secret|credential|api(?:[_-]|[^\S\r\n]{1,8})?key|account(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|refresh(?:[_-]|[^\S\r\n]{1,8})?token|signing(?:[_-]|[^\S\r\n]{1,8})?key|token)[a-z0-9_.-]*\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/giu;
const SECRET_WHITESPACE_ASSIGNMENT =
  /(\b[a-z0-9_.-]*(?:authorization|auth|cookie|password|passwd|secret|credential|api(?:[_-]|[^\S\r\n]{1,8})?key|account(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|refresh(?:[_-]|[^\S\r\n]{1,8})?token|signing(?:[_-]|[^\S\r\n]{1,8})?key|token)[a-z0-9_.-]*(?:[^\S\r\n]+|\\[bfnrtv])+)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/giu;
const SECRET_MULTILINE_ASSIGNMENT =
  /(^[^\S\r\n]*(?!-)[a-z0-9_.-]*(?:authorization|auth|cookie|password|passwd|secret|credential|api(?:[_-]|[^\S\r\n]{1,8})?key|account(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|refresh(?:[_-]|[^\S\r\n]{1,8})?token|signing(?:[_-]|[^\S\r\n]{1,8})?key|token)[a-z0-9_.-]*(?:[^\S\r\n]*(?:\r?\n|\r))+[^\S\r\n]*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gimu;
const PAT_SECRET_FIELD =
  /("(?:pat|[a-z0-9][a-z0-9_.-]*[_.-]pat)"\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\r\n]*)/giu;
const SINGLE_QUOTED_PAT_SECRET_FIELD =
  /('(?:pat|[a-z0-9][a-z0-9_.-]*[_.-]pat)'\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\r\n]*)/giu;
const PAT_SECRET_ASSIGNMENT =
  /(\b(?:pat|[a-z0-9][a-z0-9_.-]*[_.-]pat)\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/giu;
const PAT_SECRET_WHITESPACE_ASSIGNMENT =
  /(\b(?:pat|[a-z0-9][a-z0-9_.-]*[_.-]pat)(?:\s+|\\[bfnrtv])+)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/giu;
const CLI_SECRET_OPTION =
  /((?:^|[\s,;])--?(?:authorization|auth|cookie|password|passwd|secret|credential|api(?:[_-]|[^\S\r\n]{1,8})?key|account(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|refresh(?:[_-]|[^\S\r\n]{1,8})?token|signing(?:[_-]|[^\S\r\n]{1,8})?key|token|pat|[a-z0-9][a-z0-9_.-]*[_.-]pat)(?:\s+|\\[bfnrtv]|=)+)(?:(?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*')|[^\s,;]+)/gimu;
const TOKEN_VALUE =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}|ya29\.[A-Za-z0-9_-]{10,}|sq0(?:atp|csp)-[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|A3T)[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const BASIC_VALUE = /\bBasic\s+[A-Za-z0-9._~+/-]{2,}={0,2}/giu;
const URL_USER_INFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]+@/giu;
const SIGNED_QUERY_PARAMETER =
  /([?&](?:x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential|security-token)|signature|sig|credential|aws(?:[_-]|[^\S\r\n]{1,8})?access(?:[_-]|[^\S\r\n]{1,8})?key(?:[_-]|[^\S\r\n]{1,8})?id|access(?:[_-]|[^\S\r\n]{1,8})?(?:token|key(?:(?:[_-]|[^\S\r\n]{1,8})?id)?)|auth(?:orization)?|api(?:[_-]|[^\S\r\n]{1,8})?key|private(?:[_-]|[^\S\r\n]{1,8})?key|key|token|code|client(?:[_-]|[^\S\r\n]{1,8})?secret|password|passwd)=)[^&#\s]*/giu;
const UNIX_DBUS_ADDRESS = /\bunix:(?=[^\s\r\n]*(?:path|abstract)=)[^\s\r\n]*/giu;
const HUMAN_SECRET_SEPARATOR = String.raw`(?:[._-]|[^\S\r\n]+)?`;
const SECRET_KEY_SOURCE = String.raw`(?:authorization|auth|cookie|password|passwd|pwd|(?:ssh${HUMAN_SECRET_SEPARATOR})?passphrase|connection${HUMAN_SECRET_SEPARATOR}string|api${HUMAN_SECRET_SEPARATOR}key|account${HUMAN_SECRET_SEPARATOR}key|private${HUMAN_SECRET_SEPARATOR}key|(?:aws${HUMAN_SECRET_SEPARATOR})?access${HUMAN_SECRET_SEPARATOR}(?:token|key(?:${HUMAN_SECRET_SEPARATOR}id)?)|refresh${HUMAN_SECRET_SEPARATOR}token|signing${HUMAN_SECRET_SEPARATOR}key|session${HUMAN_SECRET_SEPARATOR}key|encryption${HUMAN_SECRET_SEPARATOR}key|shared${HUMAN_SECRET_SEPARATOR}access${HUMAN_SECRET_SEPARATOR}(?:signature|key)|sas${HUMAN_SECRET_SEPARATOR}token|secret${HUMAN_SECRET_SEPARATOR}key|(?:client${HUMAN_SECRET_SEPARATOR})?secret|credential|token)`;
const SECRET_KEY = new RegExp(SECRET_KEY_SOURCE, "iu");
const HUMAN_SECRET_KEY = new RegExp(String.raw`(?:${SECRET_KEY_SOURCE}s?|pat)`, "giu");
const STRUCTURED_SECRET_KEY = new RegExp(String.raw`^(?:(?:${SECRET_KEY_SOURCE})s?|pat)$`, "iu");
const PAT_SECRET_KEY = /^(?:pat|[a-z0-9][a-z0-9_.-]*[_.-]pat)$/iu;
const CLIENT_KEY_DATA_NAME = /^client(?:[._-]|[^\S\r\n]+)?key(?:[._-]|[^\S\r\n]+)?data$/iu;
const CLIENT_KEY_DATA_FIELD =
  /(?:^|[^a-z0-9])(?:["'])?client(?:[._-]|[^\S\r\n]+)?key(?:[._-]|[^\S\r\n]+)?data(?:["'])?[^\S\r\n]*[:=]/iu;
const PEM_PRIVATE_KEY = /-----BEGIN [^\r\n]*PRIVATE KEY(?: [A-Z0-9_-]+)*-----/iu;
const SSH2_PRIVATE_KEY = /-{4,5}\s*BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY\s*-{4,5}/iu;
const PUTTY_PRIVATE_KEY_HEADER = /PuTTY-User-Key-File-\d+:/iu;
const PUTTY_PRIVATE_KEY_LINES = /Private-Lines:\s*[1-9][0-9]*/iu;
const SIGNIFY_PRIVATE_KEY_HEADER =
  /^[^\S\r\n]*untrusted comment:[^\S\r\n]*(?:minisign[^\S\r\n]+encrypted|signify)[^\S\r\n]+secret[^\S\r\n]+key[^\S\r\n]*\r?$/imu;
const EXTENDED_PRIVATE_KEY = /(?:^|[^A-Za-z0-9])(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{100,115}(?![A-Za-z0-9])/u;
const AGE_PRIVATE_KEY = /\bAGE-SECRET-KEY-1[0-9A-Z]{40,100}\b/iu;
const PASERK_PRIVATE_KEY = /(?:^|[^A-Za-z0-9_])k[1-4]\.secret\.[A-Za-z0-9_-]{40,256}(?![A-Za-z0-9_-])/u;
const UNICODE_FORMAT_CONTROL = /\p{Cf}/u;
const UNSAFE_HTML_FORMAT_ENTITY =
  /&(?:shy|zwnj|zwj|lrm|rlm|NoBreak|ApplyFunction|af|InvisibleTimes|it|InvisibleComma|ic|Negative(?:Medium|Thick|Thin|VeryThin)Space);/iu;

export function clearEditorAcceptanceEvidence(evidenceRoot) {
  if (typeof evidenceRoot !== "string" || evidenceRoot.length === 0) {
    throw new Error("Editor acceptance evidence root must be a non-empty path.");
  }
  const retainedRoot = resolve(evidenceRoot);
  if (retainedRoot === parse(retainedRoot).root) {
    throw new Error("Refusing to clear a filesystem root as editor acceptance evidence.");
  }
  rmSync(retainedRoot, { recursive: true, force: true });
}

export function retainEditorAcceptanceEvidence({
  evidenceRoot,
  temporaryRoot,
  profile,
  editor,
  phase,
  attempt = 1,
  error,
  hostHome,
  hostHomes = [],
  resultPath,
  resultPaths = { [phase]: resultPath },
  evidenceMode = "full",
  evidenceReason
}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Editor acceptance evidence attempt must be a positive safe integer.");
  }
  if (evidenceMode !== "full" && evidenceMode !== "metadata-only") {
    throw new Error('Editor acceptance evidence mode must be either "full" or "metadata-only".');
  }
  if (evidenceMode === "metadata-only" && (typeof evidenceReason !== "string" || evidenceReason.trim().length === 0)) {
    throw new Error("Metadata-only editor acceptance evidence requires a non-empty reason.");
  }
  const isolatedRoot = resolve(temporaryRoot);
  const isolatedProfile = resolve(profile);
  const retainedRoot = resolve(evidenceRoot);
  if (!Array.isArray(hostHomes)) {
    throw new Error("Editor acceptance host homes must be an array of absolute paths.");
  }
  const allHostHomes = [...(hostHome === undefined ? [] : [hostHome]), ...hostHomes];
  if (allHostHomes.some((value) => typeof value !== "string" || value.length === 0 || !isAbsolute(value))) {
    throw new Error("Every editor acceptance host home must be an absolute path when provided.");
  }
  requireContainedPath(isolatedRoot, isolatedProfile, "acceptance profile");
  if (retainedRoot === isolatedRoot || isContainedPath(isolatedRoot, retainedRoot)) {
    throw new Error("Editor acceptance evidence must live outside the disposable editor root.");
  }

  if (typeof resultPath !== "string") {
    throw new Error("Editor acceptance result path must be provided.");
  }
  requireContainedPath(isolatedProfile, resolve(resultPath), "acceptance result");
  for (const [resultPhase, phaseResultPath] of Object.entries(resultPaths)) {
    if (typeof phaseResultPath !== "string") {
      throw new Error(`Editor acceptance result path for ${resultPhase} must be provided.`);
    }
    requireContainedPath(isolatedProfile, resolve(phaseResultPath), `acceptance result for ${resultPhase}`);
  }

  const lexicalReplacements = createFailureReplacements({
    isolatedProfile,
    isolatedRoot,
    allHostHomes
  });
  if (evidenceMode === "metadata-only") {
    const { target, editorKey } = prepareEvidenceTarget({
      retainedRoot,
      editor,
      phase,
      attempt,
      replacements: lexicalReplacements
    });
    writeFailureMetadata({
      target,
      isolatedProfile,
      editor,
      editorKey,
      phase,
      attempt,
      error,
      resultPath,
      replacements: lexicalReplacements,
      evidenceMode,
      evidenceReason,
      copiedFiles: [],
      skippedFiles: []
    });
    return target;
  }

  const canonicalIsolatedRoot = canonicalizePath(isolatedRoot);
  const canonicalIsolatedProfile = canonicalizePath(isolatedProfile);
  const canonicalRetainedRoot = canonicalizePath(retainedRoot);
  requireContainedPath(canonicalIsolatedRoot, canonicalIsolatedProfile, "acceptance profile");
  if (
    canonicalRetainedRoot === canonicalIsolatedRoot ||
    isContainedPath(canonicalIsolatedRoot, canonicalRetainedRoot)
  ) {
    throw new Error("Editor acceptance evidence must live outside the disposable editor root.");
  }
  requireContainedPath(canonicalIsolatedProfile, canonicalizePath(resultPath), "acceptance result");
  for (const [resultPhase, phaseResultPath] of Object.entries(resultPaths)) {
    requireContainedPath(
      canonicalIsolatedProfile,
      canonicalizePath(phaseResultPath),
      `acceptance result for ${resultPhase}`
    );
  }

  const replacements = createFailureReplacements({
    isolatedProfile,
    canonicalIsolatedProfile,
    isolatedRoot,
    canonicalIsolatedRoot,
    allHostHomes
  });
  const { target, editorKey } = prepareEvidenceTarget({
    retainedRoot,
    editor,
    phase,
    attempt,
    replacements
  });

  const copiedFiles = [];
  const skippedFiles = [];
  const evidenceByProfilePath = new Map();
  const sourceBudget = createEvidenceSourceBudget();
  const copyText = (source, destination, byteLimit = MAX_LOG_BYTES) => {
    const sourceProfilePath = profileRelativePath(isolatedProfile, source);
    let retained;
    try {
      sourceBudget.beginCandidate();
      retained = readEvidenceUtf8Tail(source, canonicalIsolatedProfile, byteLimit, sourceBudget);
    } catch (error) {
      if (error instanceof EvidenceFileError && error.reason === "missing") return false;
      recordSkippedEvidence(
        sourceProfilePath,
        error instanceof EvidenceFileError ? error.reason : "unreadable",
        skippedFiles,
        evidenceByProfilePath,
        replacements
      );
      return false;
    }
    const redacted = redactEditorAcceptanceText(retained.text, replacements);
    if (redacted === undefined) {
      recordSkippedEvidence(sourceProfilePath, "redaction-rejected", skippedFiles, evidenceByProfilePath, replacements);
      return false;
    }
    const boundedRedacted = boundedUtf8Tail(redacted, byteLimit);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, boundedRedacted, { encoding: "utf8", mode: 0o600 });
    const targetPath = redactPathMetadata(relative(target, destination).replaceAll(sep, "/"), replacements);
    const retainedBytes = statSync(destination).size;
    copiedFiles.push(targetPath);
    evidenceByProfilePath.set(sourceProfilePath, {
      status: "retained",
      target: targetPath,
      sourceBytes: retained.sourceBytes,
      retainedBytes,
      truncated: retained.truncated || retainedBytes < Buffer.byteLength(redacted)
    });
    return true;
  };

  for (const [resultPhase, phaseResultPath] of Object.entries(resultPaths)) {
    const phaseDirectory = resolve(target, "phases", safeSegment(redactFailureText(resultPhase, replacements, 128)));
    copyText(phaseResultPath, resolve(phaseDirectory, "result.json"));
    copyText(`${phaseResultPath}.progress`, resolve(phaseDirectory, "progress.txt"));
  }

  const logRoot = resolve(isolatedProfile, "user-data", "logs");
  let retainedLogBytes = 0;
  let retainedLogFiles = 0;
  let logEvidenceOrdinal = 0;
  for (const source of listProfileEntries(logRoot, canonicalIsolatedProfile)) {
    const logRelativePath = relative(logRoot, source.path).replaceAll(sep, "/");
    if (!isAllowlistedEditorLog(logRelativePath)) continue;
    if (source.type !== "file") {
      recordSkippedEvidence(
        profileRelativePath(isolatedProfile, source.path),
        "not-regular",
        skippedFiles,
        evidenceByProfilePath,
        replacements
      );
      continue;
    }
    if (retainedLogFiles >= MAX_LOG_FILES || retainedLogBytes >= MAX_TOTAL_LOG_BYTES) {
      recordSkippedEvidence(
        profileRelativePath(isolatedProfile, source.path),
        "bundle-budget",
        skippedFiles,
        evidenceByProfilePath,
        replacements
      );
      continue;
    }
    const availableBytes = Math.min(MAX_LOG_BYTES, MAX_TOTAL_LOG_BYTES - retainedLogBytes);
    logEvidenceOrdinal += 1;
    const destination = resolve(
      target,
      "logs",
      `${String(logEvidenceOrdinal).padStart(3, "0")}-${editorLogKind(logRelativePath)}.log`
    );
    if (copyText(source.path, destination, availableBytes)) {
      retainedLogFiles += 1;
      retainedLogBytes += statSync(destination).size;
    }
  }

  const manifest = listProfileEntries(isolatedProfile, canonicalIsolatedProfile, MAX_MANIFEST_ENTRIES).map((entry) => {
    const rawPath = relative(isolatedProfile, entry.path).replaceAll(sep, "/") || ".";
    return {
      path: redactPathMetadata(rawPath, replacements),
      type: entry.type,
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(evidenceByProfilePath.has(rawPath) ? { evidence: evidenceByProfilePath.get(rawPath) } : {})
    };
  });
  writeFileSync(resolve(target, "profile-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  copiedFiles.push("profile-manifest.json");

  writeFailureMetadata({
    target,
    isolatedProfile,
    editor,
    editorKey,
    phase,
    attempt,
    error,
    resultPath,
    replacements,
    evidenceMode,
    evidenceReason,
    copiedFiles,
    skippedFiles
  });
  return target;
}

function createFailureReplacements({
  isolatedProfile,
  canonicalIsolatedProfile,
  isolatedRoot,
  canonicalIsolatedRoot,
  allHostHomes
}) {
  return [
    [isolatedProfile, "<profile>"],
    ...(canonicalIsolatedProfile === undefined ? [] : [[canonicalIsolatedProfile, "<profile>"]]),
    [isolatedRoot, "<editor-temp>"],
    ...(canonicalIsolatedRoot === undefined ? [] : [[canonicalIsolatedRoot, "<editor-temp>"]]),
    [resolve(process.cwd()), "<repository>"],
    ...allHostHomes.map((value) => [resolve(value), "<host-home>"])
  ]
    .filter(([source], index, all) => all.findIndex(([candidate]) => candidate === source) === index)
    .sort((left, right) => right[0].length - left[0].length);
}

function prepareEvidenceTarget({ retainedRoot, editor, phase, attempt, replacements }) {
  const editorKey = safeSegment(redactFailureText(editor.key ?? editor.name, replacements, 128));
  const version = safeSegment(redactFailureText(editor.version ?? "unknown", replacements, 128));
  const target = resolve(
    retainedRoot,
    `${editorKey}-${version}-${safeSegment(redactFailureText(phase, replacements, 128))}-attempt-${attempt}`
  );
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  return { target, editorKey };
}

function writeFailureMetadata({
  target,
  isolatedProfile,
  editor,
  editorKey,
  phase,
  attempt,
  error,
  resultPath,
  replacements,
  evidenceMode,
  evidenceReason,
  copiedFiles,
  skippedFiles
}) {
  const details = redactStructuredValue(error?.details ?? {}, replacements);
  const failure = {
    schemaVersion: 1,
    evidenceMode,
    evidenceReason: evidenceReason === undefined ? null : redactFailureText(evidenceReason, replacements),
    editor: {
      key: redactFailureText(editor.key ?? editorKey, replacements),
      name: redactFailureText(editor.name ?? editorKey, replacements),
      version: redactFailureText(editor.version ?? "unknown", replacements)
    },
    attempt,
    phase: redactFailureText(phase, replacements),
    classification: redactFailureText(error?.kind ?? "unclassified", replacements),
    elapsedMs: typeof error?.details?.elapsedMs === "number" ? error.details.elapsedMs : null,
    exitCode: redactFailureScalar(error?.details?.exitCode, replacements),
    signal: redactFailureScalar(error?.details?.signal, replacements),
    timeoutKind: redactFailureScalar(error?.details?.timeoutKind, replacements),
    resultPath: `<profile>/${redactPathMetadata(relative(isolatedProfile, resultPath).replaceAll(sep, "/"), replacements)}`,
    lastProgress:
      typeof error?.details?.progress === "string" ? redactFailureText(error.details.progress, replacements) : null,
    message: redactFailureText(error instanceof Error ? error.message : String(error), replacements),
    details,
    copiedFiles: [...copiedFiles].sort(),
    skippedFiles
  };
  writeFileSync(resolve(target, "failure.json"), serializeBoundedFailure(failure), {
    encoding: "utf8",
    mode: 0o600
  });
}

export function redactEditorAcceptanceText(text, replacements = []) {
  try {
    let redacted = String(text);
    if (containsBinaryControl(redacted) || containsEncodedBinaryControl(redacted)) return undefined;
    if (containsPrivateKeyContainer(redacted) || containsStructuredSecretContainer(redacted)) return undefined;
    // Protect literal paths before security-escape normalization. A valid Windows
    // component such as `\x64` is syntactically indistinguishable from an encoded
    // character, so normalization can intentionally change it before a later match.
    for (const [source, replacement] of replacements) {
      if (source) redacted = replaceKnownPath(redacted, source, replacement);
    }
    // Redact complete raw credential values before decoding reserved delimiters.
    // Otherwise `%26` inside a signed query or `%2F` inside URI userinfo can become
    // a boundary that leaves the remainder of the original secret visible.
    redacted = redactCredentialSyntax(redacted, false);
    if (redacted === undefined) return undefined;
    redacted = normalizeSecurityEscapes(redacted);
    if (redacted === undefined) return undefined;
    if (containsBinaryControl(redacted) || containsEncodedBinaryControl(redacted)) return undefined;
    if (containsPrivateKeyContainer(redacted) || containsStructuredSecretContainer(redacted)) return undefined;
    // A second pass catches encoded/escaped representations revealed above.
    for (const [source, replacement] of replacements) {
      if (source) redacted = replaceKnownPath(redacted, source, replacement);
    }
    return redactCredentialSyntax(redacted, true);
  } catch {
    // Evidence is diagnostic-only. Any regex/decoder/runtime limit must omit the
    // candidate instead of aborting the failure bundle or retaining raw text.
    return undefined;
  }
}

function redactCredentialSyntax(text, includeHumanLines) {
  if (redactHumanSecretLines(text) === undefined) return undefined;
  const precise = text
    .replace(JSON_SECRET_FIELD, '$1"<redacted>"')
    .replace(SINGLE_QUOTED_SECRET_FIELD, "$1'<redacted>'")
    .replace(PAT_SECRET_FIELD, '$1"<redacted>"')
    .replace(SINGLE_QUOTED_PAT_SECRET_FIELD, "$1'<redacted>'")
    .replace(SECRET_HEADER, "$1<redacted>")
    .replace(CLI_SECRET_OPTION, "$1<redacted>")
    .replace(PAT_SECRET_ASSIGNMENT, "$1<redacted>")
    .replace(PAT_SECRET_WHITESPACE_ASSIGNMENT, "$1<redacted>")
    .replace(SECRET_ASSIGNMENT, "$1<redacted>")
    .replace(SECRET_WHITESPACE_ASSIGNMENT, "$1<redacted>")
    .replace(SECRET_MULTILINE_ASSIGNMENT, "$1<redacted>")
    .replace(TOKEN_VALUE, "<redacted>")
    .replace(BEARER_VALUE, "Bearer <redacted>")
    .replace(BASIC_VALUE, "Basic <redacted>")
    .replace(URL_USER_INFO, "$1<redacted>@")
    .replace(SIGNED_QUERY_PARAMETER, "$1<redacted>")
    .replace(UNIX_DBUS_ADDRESS, "unix:<redacted>");
  return includeHumanLines ? redactHumanSecretLines(precise) : precise;
}

function redactHumanSecretLines(text) {
  const output = [];
  let cursor = 0;
  while (cursor < text.length) {
    let lineEnd = cursor;
    while (lineEnd < text.length && text[lineEnd] !== "\r" && text[lineEnd] !== "\n") lineEnd += 1;
    const line = text.slice(cursor, lineEnd);
    let separatorEnd = lineEnd;
    if (text[separatorEnd] === "\r") separatorEnd += 1;
    if (text[separatorEnd] === "\n") separatorEnd += 1;
    const redacted = redactHumanSecretLine(line);
    if (redacted.reject || redacted.redactNextValueLine) return undefined;
    output.push(redacted.text);
    output.push(text.slice(lineEnd, separatorEnd));
    cursor = separatorEnd;
  }
  if (text.length === 0) return text;
  return output.join("");
}

function redactHumanSecretLine(line) {
  HUMAN_SECRET_KEY.lastIndex = 0;
  let match;
  while ((match = HUMAN_SECRET_KEY.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isHumanSecretIdentifierCharacter(line[start - 1]) || isHumanSecretIdentifierCharacter(line[end])) continue;

    const quotedLabel = quotedSpanContaining(line, start, end);
    let valueStart = quotedLabel?.end ?? end;
    if (quotedLabel) {
      const afterQuotedLabel = consumeHorizontalWhitespace(line, valueStart);
      if (!/^(?::|=|=>|->|\bis\b|\bvalue\b)/iu.test(line.slice(afterQuotedLabel))) continue;
    }
    valueStart = consumeHorizontalWhitespace(line, valueStart);

    let sawConnector = false;
    for (let connectorCount = 0; connectorCount < 2; connectorCount += 1) {
      const connector = /^(?:is|value)(?=$|[^a-z0-9])/iu.exec(line.slice(valueStart));
      if (!connector) break;
      sawConnector = true;
      valueStart += connector[0].length;
      valueStart = consumeHorizontalWhitespace(line, valueStart);
    }
    const punctuationStart = valueStart;
    while (valueStart < line.length && /[:=\->]/u.test(line[valueStart])) valueStart += 1;
    if (valueStart > punctuationStart) sawConnector = true;
    valueStart = consumeHorizontalWhitespace(line, valueStart);

    if (valueStart >= line.length) {
      const prefixBeforeLabel = line.slice(0, start).trim();
      const keyOnlyPrefix = /^[-'"[{(]*[a-z0-9_.-]*$/iu.test(prefixBeforeLabel);
      return {
        text: line,
        redactNextValueLine: sawConnector || keyOnlyPrefix
      };
    }

    if (line[valueStart] === "|" || line[valueStart] === ">" || line[valueStart] === "[" || line[valueStart] === "{") {
      return { text: line, redactNextValueLine: false, reject: true };
    }

    let valueQuote;
    if (line[valueStart] === '"' || line[valueStart] === "'") {
      valueQuote = line[valueStart];
      valueStart += 1;
      if (!hasClosingQuote(line, valueStart, valueQuote)) {
        return { text: line, redactNextValueLine: false, reject: true };
      }
    }
    return {
      text: `${line.slice(0, valueStart)}<redacted>${valueQuote ?? ""}`,
      redactNextValueLine: false
    };
  }
  return { text: line, redactNextValueLine: false };
}

function quotedSpanContaining(text, start, end) {
  let quote;
  let quoteStart = -1;
  let escaped = false;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === undefined) {
      if (character === '"' || character === "'") {
        quote = character;
        quoteStart = cursor;
      }
      continue;
    }
    if (character !== quote) continue;
    if (quoteStart < start && cursor >= end) return { start: quoteStart, end: cursor + 1 };
    quote = undefined;
    quoteStart = -1;
  }
  return undefined;
}

function hasClosingQuote(text, start, quote) {
  let escaped = false;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (text[cursor] === "\\") {
      escaped = true;
      continue;
    }
    if (text[cursor] === quote) return true;
  }
  return false;
}

function consumeHorizontalWhitespace(text, start) {
  let cursor = start;
  while (cursor < text.length && /[^\S\r\n]/u.test(text[cursor])) cursor += 1;
  return cursor;
}

function isHumanSecretIdentifierCharacter(character) {
  return typeof character === "string" && /^[a-z0-9]$/iu.test(character);
}

function replaceKnownPath(text, sourceValue, replacement) {
  const source = String(sourceValue);
  const windowsPath = /^[a-z]:[\\/]/iu.test(source) || /^\\\\[^\\]/u.test(source);
  const variants = new Map();
  const addVariant = (
    value,
    insensitivePrefixLength = windowsPath ? Number.POSITIVE_INFINITY : 0,
    boundary = false
  ) => {
    if (!value) return;
    const previous = variants.get(value) ?? { insensitivePrefixLength: 0, boundary: false };
    variants.set(value, {
      insensitivePrefixLength: Math.max(previous.insensitivePrefixLength, insensitivePrefixLength),
      boundary: previous.boundary || boundary
    });
  };
  addVariant(source);
  const forward = source.replaceAll("\\", "/");
  addVariant(forward);
  if (windowsPath) addVariant(forward.replaceAll("/", "\\"));

  const uriPaths = [forward];
  const extendedUnc = /^\/\/\?\/UNC\/([^/]+)\/(.+)$/iu.exec(forward);
  if (extendedUnc) {
    const normalizedUnc = `//${extendedUnc[1]}/${extendedUnc[2]}`;
    addVariant(normalizedUnc, Number.POSITIVE_INFINITY, true);
    addVariant(normalizedUnc.replaceAll("/", "\\"), Number.POSITIVE_INFINITY, true);
    uriPaths.push(normalizedUnc);
  }
  const ordinaryUnc = /^\/\/(?!\?\/UNC\/)([^/]+)\/(.+)$/iu.exec(forward);
  if (ordinaryUnc) {
    const diagnosticUnc = `//?/UNC/${ordinaryUnc[1]}/${ordinaryUnc[2]}`;
    addVariant(diagnosticUnc);
    addVariant(diagnosticUnc.replaceAll("/", "\\"));
  }
  for (const uriPath of uriPaths) {
    for (const fileUri of fileUriVariants(uriPath, windowsPath)) {
      addVariant(fileUri.value, windowsPath ? Number.POSITIVE_INFINITY : fileUri.insensitivePrefixLength, true);
    }
    // VS Code notebook-cell and remote URIs have dynamic scheme/authority portions.
    // Redact the exact encoded source path wherever it appears instead of attempting
    // to enumerate remote authorities or notebook-cell fragments.
    for (const encodedPath of encodedUriPathVariants(uriPath, windowsPath)) {
      if (encodedPath !== uriPath) {
        addVariant(encodedPath, windowsPath ? Number.POSITIVE_INFINITY : 0, true);
      }
    }
  }
  for (const [variant, options] of [...variants]) {
    addVariant(variant.replaceAll("\\", "\\\\"), options.insensitivePrefixLength, options.boundary);
    addVariant(variant.replaceAll("/", "\\/"), options.insensitivePrefixLength, options.boundary);
  }

  let result = text;
  for (const [variant, options] of [...variants].sort((left, right) => right[0].length - left[0].length)) {
    const pattern = pathVariantPattern(variant, options.insensitivePrefixLength, options.boundary);
    result = result.replace(new RegExp(pattern, windowsPath ? "giu" : "gu"), () => replacement);
  }
  return result;
}

function encodedUriPathVariants(forwardPath, windowsPath) {
  if (!windowsPath) {
    return forwardPath.startsWith("/") ? [`/${encodePathSegments(forwardPath.slice(1))}`] : [];
  }
  const driveMatch = /^([a-z]):(?:\/(.*))?$/iu.exec(forwardPath);
  if (driveMatch) {
    const drive = driveMatch[1];
    const suffix = encodePathSegments(driveMatch[2] ?? "");
    return [`/${drive}:/${suffix}`, `/${drive}%3A/${suffix}`];
  }
  const uncMatch = /^\/\/([^/]+)(?:\/(.*))?$/u.exec(forwardPath);
  if (!uncMatch) return [];
  return [`//${uncMatch[1]}/${encodePathSegments(uncMatch[2] ?? "")}`];
}

function fileUriVariants(forwardPath, windowsPath) {
  const variants = [];
  if (windowsPath) {
    const driveMatch = /^([a-z]):(?:\/(.*))?$/iu.exec(forwardPath);
    if (driveMatch) {
      const drive = driveMatch[1];
      const suffix = driveMatch[2] ?? "";
      const encodedSuffix = encodePathSegments(suffix);
      variants.push(
        { value: `file:///${drive}:/${suffix}`, insensitivePrefixLength: 8 },
        { value: `file:///${drive}:/${encodedSuffix}`, insensitivePrefixLength: 8 },
        { value: `file:///${drive}%3A/${encodedSuffix}`, insensitivePrefixLength: 8 },
        { value: `file://localhost/${drive}:/${suffix}`, insensitivePrefixLength: "file://localhost".length },
        {
          value: `file://localhost/${drive}:/${encodedSuffix}`,
          insensitivePrefixLength: "file://localhost".length
        },
        {
          value: `file://localhost/${drive}%3A/${encodedSuffix}`,
          insensitivePrefixLength: "file://localhost".length
        },
        {
          value: `vscode-file://vscode-app/${drive}:/${encodedSuffix}`,
          insensitivePrefixLength: "vscode-file://vscode-app".length
        },
        {
          value: `vscode-file://vscode-app/${drive}%3A/${encodedSuffix}`,
          insensitivePrefixLength: "vscode-file://vscode-app".length
        },
        {
          value: `vscode-userdata:/${drive}:/${encodedSuffix}`,
          insensitivePrefixLength: "vscode-userdata:".length
        },
        {
          value: `vscode-userdata:/${drive}%3A/${encodedSuffix}`,
          insensitivePrefixLength: "vscode-userdata:".length
        }
      );
      return variants;
    }
    const uncMatch = /^\/\/([^/]+)(?:\/(.*))?$/u.exec(forwardPath);
    if (uncMatch) {
      const host = uncMatch[1];
      const suffix = uncMatch[2] ?? "";
      const prefixLength = `file://${host}`.length;
      variants.push(
        { value: `file://${host}/${suffix}`, insensitivePrefixLength: prefixLength },
        { value: `file://${host}/${encodePathSegments(suffix)}`, insensitivePrefixLength: prefixLength }
      );
    }
    return variants;
  }
  if (forwardPath.startsWith("/")) {
    variants.push(
      { value: `file://${forwardPath}`, insensitivePrefixLength: "file://".length },
      { value: `file:///${encodePathSegments(forwardPath.slice(1))}`, insensitivePrefixLength: "file://".length },
      {
        value: `file://localhost${forwardPath}`,
        insensitivePrefixLength: "file://localhost".length
      },
      {
        value: `file://localhost/${encodePathSegments(forwardPath.slice(1))}`,
        insensitivePrefixLength: "file://localhost".length
      },
      {
        value: `vscode-file://vscode-app/${encodePathSegments(forwardPath.slice(1))}`,
        insensitivePrefixLength: "vscode-file://vscode-app".length
      },
      {
        value: `vscode-userdata:/${encodePathSegments(forwardPath.slice(1))}`,
        insensitivePrefixLength: "vscode-userdata:".length
      }
    );
  }
  return variants;
}

function encodePathSegments(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function pathVariantPattern(value, insensitivePrefixLength, boundary) {
  let pattern = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "%" && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      pattern += `%${caseInsensitiveHexDigit(value[index + 1])}${caseInsensitiveHexDigit(value[index + 2])}`;
      index += 2;
      continue;
    }
    if (index < insensitivePrefixLength && /^[a-z]$/iu.test(character)) {
      pattern += `[${character.toLowerCase()}${character.toUpperCase()}]`;
      continue;
    }
    pattern += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return boundary ? `${pattern}(?=$|[\\/?#:\\s"'(),;}\\]])` : pattern;
}

function caseInsensitiveHexDigit(character) {
  return /^[a-f]$/iu.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]` : character;
}

function normalizeSecurityEscapes(text) {
  let normalized = text;
  for (let pass = 0; pass < MAX_SECURITY_NORMALIZATION_PASSES; pass += 1) {
    const result = normalizeSecurityEscapesOnce(normalized);
    if (!result.changed) return normalized;
    normalized = result.text;
  }
  // Deeper encodings are not useful diagnostics. Fail closed instead of retaining
  // content whose security-relevant syntax has not reached a fixed point.
  return undefined;
}

function normalizeSecurityEscapesOnce(text) {
  const backslash = normalizeBackslashSecurityEscapesOnce(text);
  const percent = normalizePercentSecurityEscapesOnce(backslash.text);
  const html = normalizeHtmlSecurityEntitiesOnce(percent.text);
  return { text: html.text, changed: backslash.changed || percent.changed || html.changed };
}

function normalizeBackslashSecurityEscapesOnce(text) {
  const parts = [];
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const slashStart = text.indexOf("\\", searchFrom);
    if (slashStart < 0) break;
    let marker = slashStart;
    while (marker < text.length && text.charCodeAt(marker) === 0x5c) marker += 1;
    const escape = parseSecurityEscape(text, marker);
    if (!escape) {
      searchFrom = marker;
      continue;
    }
    parts.push(text.slice(cursor, slashStart), escape.character);
    cursor = escape.end;
    searchFrom = escape.end;
  }
  if (parts.length === 0) return { text, changed: false };
  parts.push(text.slice(cursor));
  return { text: parts.join(""), changed: true };
}

function normalizePercentSecurityEscapesOnce(text) {
  const parts = [];
  let cursor = 0;
  for (let index = 0; index + 2 < text.length; index += 1) {
    if (text[index] !== "%" || !isHex(text.slice(index + 1, index + 3), 2, 2)) continue;
    const character = String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 3), 16));
    if (!isSecuritySyntaxCharacter(character)) continue;
    parts.push(text.slice(cursor, index), character);
    cursor = index + 3;
    index += 2;
  }
  if (parts.length === 0) return { text, changed: false };
  parts.push(text.slice(cursor));
  return { text: parts.join(""), changed: true };
}

function normalizeHtmlSecurityEntitiesOnce(text) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["colon", ":"],
    ["commat", "@"],
    ["equals", "="],
    ["gt", ">"],
    ["lt", "<"],
    ["newline", "\n"],
    ["num", "#"],
    ["percnt", "%"],
    ["quest", "?"],
    ["quot", '"'],
    ["sol", "/"],
    ["tab", "\t"]
  ]);
  let changed = false;
  const normalized = text.replace(/&(?:#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|[a-z]+);/giu, (entity) => {
    const body = entity.slice(1, -1).toLowerCase();
    let character;
    if (body.startsWith("#x")) character = String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    else if (body.startsWith("#")) character = String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    else character = named.get(body);
    if (character === undefined || !isSecuritySyntaxCharacter(character)) return entity;
    changed = true;
    return character;
  });
  return { text: normalized, changed };
}

function containsPrivateKeyContainer(text) {
  return (
    PEM_PRIVATE_KEY.test(text) ||
    SSH2_PRIVATE_KEY.test(text) ||
    (PUTTY_PRIVATE_KEY_HEADER.test(text) && PUTTY_PRIVATE_KEY_LINES.test(text)) ||
    SIGNIFY_PRIVATE_KEY_HEADER.test(text) ||
    CLIENT_KEY_DATA_FIELD.test(text) ||
    EXTENDED_PRIVATE_KEY.test(text) ||
    AGE_PRIVATE_KEY.test(text) ||
    PASERK_PRIVATE_KEY.test(text) ||
    containsPrivateJsonKeyContainer(text) ||
    Boolean(scanXmlStructuredContainers(text) & XML_PRIVATE_KEY_CONTAINER)
  );
}

function containsStructuredSecretContainer(text) {
  return Boolean(scanXmlStructuredContainers(text) & XML_SECRET_VALUE_CONTAINER);
}

const JSON_KEY_TYPE = 1;
const JSON_PRIVATE_D = 2;
const JSON_RSA_MODULUS = 4;
const JSON_RSA_EXPONENT = 8;
const JSON_RSA_PRIVATE_COMPONENT = 16;
const JSON_DSA_P = 32;
const JSON_DSA_Q = 64;
const JSON_DSA_G = 128;
const JSON_DSA_Y = 256;
const JSON_DSA_X = 512;
const JSON_EC_CURVE = 1_024;
const MAX_STRUCTURED_OBJECT_DEPTH = 64;

function containsPrivateJsonKeyContainer(text) {
  const objectMasks = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const quoted = readQuotedStructuredToken(text, cursor, character);
      cursor = quoted.end - 1;
      if (!quoted.closed || objectMasks.length === 0) continue;
      let separator = quoted.end;
      while (separator < text.length && /[^\S\r\n]/u.test(text[separator])) separator += 1;
      if (text[separator] !== ":") continue;
      const normalizedKey = normalizeSecurityEscapes(quoted.value);
      if (normalizedKey === undefined) return true;
      const bit = privateJsonKeyBit(normalizedKey.trim().toLowerCase());
      if (bit === 0) continue;
      const index = objectMasks.length - 1;
      objectMasks[index] |= bit;
      const mask = objectMasks[index];
      if (
        (mask & JSON_KEY_TYPE && mask & JSON_PRIVATE_D) ||
        (mask & JSON_RSA_MODULUS && mask & JSON_RSA_EXPONENT && mask & JSON_RSA_PRIVATE_COMPONENT) ||
        (mask & JSON_DSA_P && mask & JSON_DSA_Q && mask & JSON_DSA_G && mask & JSON_DSA_Y && mask & JSON_DSA_X) ||
        (mask & JSON_EC_CURVE && mask & JSON_DSA_Q && mask & JSON_PRIVATE_D)
      ) {
        return true;
      }
      continue;
    }
    if (character === "{") {
      if (objectMasks.length >= MAX_STRUCTURED_OBJECT_DEPTH) return true;
      objectMasks.push(0);
    } else if (character === "}" && objectMasks.length > 0) {
      objectMasks.pop();
    }
  }
  return false;
}

function privateJsonKeyBit(key) {
  if (key === "kty") return JSON_KEY_TYPE;
  if (key === "d") return JSON_PRIVATE_D | JSON_RSA_PRIVATE_COMPONENT;
  if (key === "modulus") return JSON_RSA_MODULUS;
  if (key === "exponent") return JSON_RSA_EXPONENT;
  if (key === "p") return JSON_RSA_PRIVATE_COMPONENT | JSON_DSA_P;
  if (key === "q") return JSON_RSA_PRIVATE_COMPONENT | JSON_DSA_Q;
  if (key === "g") return JSON_DSA_G;
  if (key === "y") return JSON_DSA_Y;
  if (key === "x") return JSON_DSA_X;
  if (key === "curve") return JSON_EC_CURVE;
  if (key === "dp" || key === "dq" || key === "inverseq") return JSON_RSA_PRIVATE_COMPONENT;
  return 0;
}

function readQuotedStructuredToken(text, start, quote) {
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (text[cursor] === "\\") {
      escaped = true;
      continue;
    }
    if (text[cursor] === quote) {
      return { value: text.slice(start + 1, cursor), end: cursor + 1, closed: true };
    }
  }
  return { value: "", end: text.length, closed: false };
}

const XML_PRIVATE_KEY_CONTAINER = 1;
const XML_SECRET_VALUE_CONTAINER = 2;
const XML_SECRET_VALUE_TAGS = new Set(["data", "string", "value"]);
const XML_RSA_PRIVATE_COMPONENTS = new Set(["d", "p", "q", "dp", "dq", "inverseq"]);
const MAX_STRUCTURED_SECRET_NAME_CHARACTERS = 512;

function scanXmlStructuredContainers(text) {
  let result = 0;
  let cursor = 0;
  let rsaDepth = 0;
  let dsaDepth = 0;
  let keyContentStart;
  let pendingPlistSecret = false;

  while (cursor < text.length) {
    const tagStart = text.indexOf("<", cursor);
    if (tagStart < 0) break;
    if (pendingPlistSecret && text.slice(cursor, tagStart).trim().length > 0) pendingPlistSecret = false;
    const tag = readXmlStructuredTag(text, tagStart);
    if (!tag) {
      cursor = tagStart + 1;
      continue;
    }
    cursor = tag.end;
    if (tag.special) continue;

    if (pendingPlistSecret) {
      if (!tag.closing && XML_SECRET_VALUE_TAGS.has(tag.localName)) {
        result |= XML_SECRET_VALUE_CONTAINER;
      }
      pendingPlistSecret = false;
    }

    if (tag.closing) {
      if (tag.localName === "key" && keyContentStart !== undefined) {
        const rawName = text.slice(keyContentStart, tagStart);
        pendingPlistSecret = isStructuredSecretName(rawName);
        keyContentStart = undefined;
      }
      if (tag.localName === "rsakeyvalue" && rsaDepth > 0) rsaDepth -= 1;
      if (tag.localName === "dsakeyvalue" && dsaDepth > 0) dsaDepth -= 1;
      continue;
    }

    if (rsaDepth > 0 && XML_RSA_PRIVATE_COMPONENTS.has(tag.localName)) {
      result |= XML_PRIVATE_KEY_CONTAINER;
    }
    if (dsaDepth > 0 && tag.localName === "x") result |= XML_PRIVATE_KEY_CONTAINER;
    if (tag.localName === "rsakeyvalue" && !tag.selfClosing) rsaDepth += 1;
    if (tag.localName === "dsakeyvalue" && !tag.selfClosing) dsaDepth += 1;

    if (keyContentStart !== undefined && tag.localName !== "key") keyContentStart = undefined;
    if (tag.localName === "key" && !tag.selfClosing) keyContentStart = tag.end;

    if (
      (tag.localName === "property" || tag.localName === "entry" || tag.localName === "setting") &&
      hasStructuredSecretAttribute(text.slice(tag.nameEnd, tag.end - 1))
    ) {
      result |= XML_SECRET_VALUE_CONTAINER;
    }

    if (result === (XML_PRIVATE_KEY_CONTAINER | XML_SECRET_VALUE_CONTAINER)) break;
  }
  return result;
}

function readXmlStructuredTag(text, start) {
  if (text.startsWith("<!--", start)) {
    const close = text.indexOf("-->", start + 4);
    return { end: close < 0 ? text.length : close + 3, special: true };
  }
  if (text.startsWith("<![CDATA[", start)) {
    const close = text.indexOf("]]>", start + 9);
    return { end: close < 0 ? text.length : close + 3, special: true };
  }
  if (text.startsWith("<?", start)) {
    const close = text.indexOf("?>", start + 2);
    return { end: close < 0 ? text.length : close + 2, special: true };
  }

  let nameStart = start + 1;
  while (nameStart < text.length && /[^\S\r\n]/u.test(text[nameStart])) nameStart += 1;
  let closing = false;
  if (text[nameStart] === "/") {
    closing = true;
    nameStart += 1;
    while (nameStart < text.length && /[^\S\r\n]/u.test(text[nameStart])) nameStart += 1;
  }
  if (text[nameStart] === "!") {
    const end = findXmlStructuredTagEnd(text, nameStart + 1);
    return { end, special: true };
  }
  let nameEnd = nameStart;
  while (nameEnd < text.length && /[a-z0-9_.:-]/iu.test(text[nameEnd])) nameEnd += 1;
  if (nameEnd === nameStart) return undefined;
  const end = findXmlStructuredTagEnd(text, nameEnd);
  if (end <= nameEnd) return undefined;
  let last = end - 2;
  while (last > nameEnd && /[^\S\r\n]/u.test(text[last])) last -= 1;
  const qualifiedName = text.slice(nameStart, nameEnd).toLowerCase();
  return {
    end,
    nameEnd,
    localName: qualifiedName.slice(qualifiedName.lastIndexOf(":") + 1),
    closing,
    selfClosing: !closing && text[last] === "/",
    special: false
  };
}

function findXmlStructuredTagEnd(text, start) {
  let quote;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return cursor + 1;
  }
  return text.length;
}

function hasStructuredSecretAttribute(attributes) {
  const expression = /\b(?:name|key)[^\S\r\n]*=[^\S\r\n]*(?:"([^"]*)"|'([^']*)')/giu;
  let match;
  while ((match = expression.exec(attributes)) !== null) {
    if (isStructuredSecretName(match[1] ?? match[2])) return true;
  }
  return false;
}

function isStructuredSecretName(value) {
  if (typeof value !== "string" || value.length > MAX_STRUCTURED_SECRET_NAME_CHARACTERS) return false;
  const normalized = normalizeSecurityEscapes(value);
  if (normalized === undefined) return true;
  const name = normalized.trim();
  return STRUCTURED_SECRET_KEY.test(name) || PAT_SECRET_KEY.test(name) || CLIENT_KEY_DATA_NAME.test(name);
}

function isSecretKey(value) {
  return SECRET_KEY.test(value) || PAT_SECRET_KEY.test(value);
}

function parseSecurityEscape(text, marker) {
  if (text[marker] === "/" || text[marker] === '"' || text[marker] === "'") {
    return { character: text[marker], end: marker + 1 };
  }
  let hexadecimal;
  let end;
  if (text.slice(marker, marker + 3).toLowerCase() === "u00" && isHex(text.slice(marker + 3, marker + 5), 2, 2)) {
    hexadecimal = text.slice(marker + 3, marker + 5);
    end = marker + 5;
  } else if (text[marker]?.toLowerCase() === "x" && isHex(text.slice(marker + 1, marker + 3), 2, 2)) {
    hexadecimal = text.slice(marker + 1, marker + 3);
    end = marker + 3;
  } else if (text.slice(marker, marker + 2).toLowerCase() === "u{") {
    const close = text.indexOf("}", marker + 2);
    if (close < 0 || !isHex(text.slice(marker + 2, close), 1, 6)) return undefined;
    hexadecimal = text.slice(marker + 2, close);
    end = close + 1;
  } else {
    return undefined;
  }
  const value = Number.parseInt(hexadecimal, 16);
  if (!Number.isSafeInteger(value) || value > 0x10ffff) return undefined;
  const character = String.fromCodePoint(value);
  return isSecuritySyntaxCharacter(character) ? { character, end } : undefined;
}

function isHex(value, minimum, maximum) {
  if (value.length < minimum || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66))) {
      return false;
    }
  }
  return true;
}

function isSecuritySyntaxCharacter(character) {
  return /^[a-z0-9_./:?&=@+%<>\\ '"{}[\],;\t\r\n-]$/iu.test(character);
}

function redactStructuredValue(value, replacements) {
  const state = { remainingEntries: MAX_FAILURE_ENTRIES, seen: new WeakSet() };
  const visit = (item, depth) => {
    if (typeof item === "string") return redactFailureText(item, replacements);
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "bigint") return redactFailureBigInt(item, replacements);
    if (typeof item === "boolean" || item === null) return item;
    if (item === undefined) return "<undefined>";
    if (typeof item !== "object") return `<unsupported-${typeof item}>`;
    if (depth >= MAX_FAILURE_DEPTH) return "<truncated-depth>";
    if (state.seen.has(item)) return "<circular>";
    state.seen.add(item);
    try {
      if (Array.isArray(item)) {
        const result = [];
        for (const child of item) {
          if (state.remainingEntries <= 0) {
            result.push("<truncated-entry-budget>");
            break;
          }
          state.remainingEntries -= 1;
          result.push(visit(child, depth + 1));
        }
        return result;
      }

      const result = Object.create(null);
      try {
        for (const rawKey in item) {
          if (!Object.hasOwn(item, rawKey)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(item, rawKey);
          if (!descriptor?.enumerable) continue;
          if (state.remainingEntries <= 0) {
            result[uniqueStructuredKey(result, "<truncated-entry-budget>")] = true;
            break;
          }
          state.remainingEntries -= 1;
          const redactedKey = isSecretKey(rawKey) ? "<redacted-key>" : redactFailureText(rawKey, replacements, 256);
          const key = uniqueStructuredKey(result, redactedKey);
          if (isSecretKey(rawKey)) result[key] = "<redacted>";
          else if (!("value" in descriptor)) result[key] = "<accessor-omitted>";
          else result[key] = visit(descriptor.value, depth + 1);
        }
      } catch {
        result[uniqueStructuredKey(result, "<unreadable-object>")] = true;
      }
      return result;
    } finally {
      state.seen.delete(item);
    }
  };
  return visit(value, 0);
}

function uniqueStructuredKey(target, desired) {
  if (!Object.hasOwn(target, desired)) return desired;
  let suffix = 2;
  while (Object.hasOwn(target, `${desired}-${suffix}`)) suffix += 1;
  return `${desired}-${suffix}`;
}

function redactFailureScalar(value, replacements) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return redactFailureBigInt(value, replacements);
  if (typeof value === "boolean") return value;
  return redactFailureText(value, replacements);
}

function redactFailureBigInt(value, replacements) {
  if (value >= MAX_FAILURE_BIGINT_ABSOLUTE || value <= -MAX_FAILURE_BIGINT_ABSOLUTE) {
    return `<bigint-truncated-${MAX_FAILURE_BIGINT_DIGITS}-digits>`;
  }
  return redactFailureText(value.toString(), replacements);
}

function redactFailureText(value, replacements, byteLimit = MAX_FAILURE_STRING_BYTES) {
  const raw = String(value);
  // Never truncate an unredacted diagnostic. Doing so can remove the trailing
  // `@`, query delimiter, or private-key label terminator that makes the secret
  // recognizable to the redactor. Oversized values retain no source content.
  if (raw.length > byteLimit || Buffer.byteLength(raw, "utf8") > byteLimit) {
    return boundedUtf8Head(OVERSIZED_DIAGNOSTIC_MARKER, byteLimit);
  }
  const redacted = redactEditorAcceptanceText(raw, replacements) ?? "<redacted-private-key>";
  return boundedUtf8Head(redacted, byteLimit);
}

function redactPathMetadata(path, replacements) {
  const raw = String(path);
  // Credential syntax may span path separators (`token=/secret`) or be percent/
  // backslash encoded. Inspect the complete bounded path before doing any shaping;
  // truncating or segment-wise redaction could remove the delimiter that proves it
  // contains a secret.
  if (raw.length > MAX_PATH_METADATA_BYTES || Buffer.byteLength(raw, "utf8") > MAX_PATH_METADATA_BYTES) {
    return OVERSIZED_DIAGNOSTIC_MARKER;
  }
  const redacted = redactEditorAcceptanceText(raw, replacements) ?? "<redacted-private-key>";
  if (redacted.length > MAX_PATH_METADATA_BYTES || Buffer.byteLength(redacted, "utf8") > MAX_PATH_METADATA_BYTES) {
    return OVERSIZED_DIAGNOSTIC_MARKER;
  }
  return redacted;
}

function serializeBoundedFailure(failure) {
  let candidate = failure;
  let serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FAILURE_BYTES) {
    candidate = {
      ...failure,
      message: boundedUtf8Head(failure.message, 2_048),
      lastProgress: typeof failure.lastProgress === "string" ? boundedUtf8Head(failure.lastProgress, 2_048) : null,
      details: { truncated: "failure-size-budget" },
      copiedFiles: failure.copiedFiles.slice(0, 64),
      skippedFiles: failure.skippedFiles.slice(0, 64)
    };
    serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  }
  if (Buffer.byteLength(serialized) > MAX_FAILURE_BYTES) {
    candidate = {
      schemaVersion: failure.schemaVersion,
      evidenceMode: failure.evidenceMode,
      evidenceReason: failure.evidenceReason,
      editor: failure.editor,
      attempt: failure.attempt,
      phase: failure.phase,
      classification: failure.classification,
      elapsedMs: failure.elapsedMs,
      exitCode: failure.exitCode,
      signal: failure.signal,
      timeoutKind: failure.timeoutKind,
      resultPath: failure.resultPath,
      lastProgress: null,
      message: boundedUtf8Head(failure.message, 1_024),
      details: { truncated: "failure-size-budget" },
      copiedFiles: [],
      skippedFiles: []
    };
    serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  }
  if (Buffer.byteLength(serialized) > MAX_FAILURE_BYTES) {
    throw new Error("Bounded editor acceptance failure metadata exceeded its hard byte limit.");
  }
  return serialized;
}

function readEvidenceUtf8Source(descriptor, size, byteLimit) {
  const bytes = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const count = readSync(descriptor, bytes, position, size - position, null);
    if (count === 0) throw new EvidenceFileError("unreadable");
    position += count;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvidenceFileError("not-utf8");
  }
  if (containsBinaryControl(text)) throw new EvidenceFileError("binary");
  const normalized = normalizeSecurityEscapes(text);
  if (normalized === undefined || containsPrivateKeyContainer(normalized)) throw new EvidenceFileError("private-key");
  return { text, sourceBytes: size, truncated: size > byteLimit };
}

function readEvidenceUtf8Tail(path, canonicalProfile, byteLimit, sourceBudget) {
  let initial;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new EvidenceFileError(error?.code === "ENOENT" ? "missing" : "unreadable");
  }
  if (!initial.isFile() || initial.isSymbolicLink()) throw new EvidenceFileError("not-regular");
  if (initial.nlink > 1n) throw new EvidenceFileError("multiple-links");
  assertCanonicalEvidenceContainment(path, canonicalProfile);

  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") throw new EvidenceFileError("missing");
    if (error?.code === "ELOOP") throw new EvidenceFileError("not-regular");
    throw new EvidenceFileError("unreadable");
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink > 1n) {
      throw new EvidenceFileError(opened.nlink > 1n ? "multiple-links" : "not-regular");
    }
    if (!sameFileIdentity(initial, opened)) throw new EvidenceFileError("path-race");
    if (!sameImmutableFileSnapshot(initial, opened)) throw new EvidenceFileError("file-changed");
    assertOpenEvidencePath(path, canonicalProfile, descriptor, opened);
    if (opened.size < 0n || opened.size > BigInt(MAX_EVIDENCE_SOURCE_BYTES)) {
      throw new EvidenceFileError("source-too-large");
    }
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size)) throw new EvidenceFileError("unreadable");
    sourceBudget.reserveScan(size);
    const retained = readEvidenceUtf8Source(descriptor, size, byteLimit);
    assertOpenEvidencePath(path, canonicalProfile, descriptor, opened);
    return retained;
  } finally {
    closeSync(descriptor);
  }
}

function createEvidenceSourceBudget() {
  let candidates = 0;
  let scannedBytes = 0;
  return {
    beginCandidate() {
      if (candidates >= MAX_EVIDENCE_SOURCE_CANDIDATES) {
        throw new EvidenceFileError("source-candidate-budget");
      }
      candidates += 1;
    },
    reserveScan(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new EvidenceFileError("unreadable");
      if (scannedBytes + bytes > MAX_TOTAL_EVIDENCE_SCAN_BYTES) {
        throw new EvidenceFileError("source-scan-budget");
      }
      scannedBytes += bytes;
    }
  };
}

function assertCanonicalEvidenceContainment(path, canonicalProfile) {
  let canonicalPath;
  try {
    canonicalPath = realpathSync(path);
  } catch {
    throw new EvidenceFileError("path-race");
  }
  if (!isContainedPath(canonicalProfile, canonicalPath)) throw new EvidenceFileError("outside-profile");
}

function assertOpenEvidencePath(path, canonicalProfile, descriptor, opened) {
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch {
    throw new EvidenceFileError("path-race");
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, opened)) {
    throw new EvidenceFileError("path-race");
  }
  if (!sameImmutableFileSnapshot(current, opened)) throw new EvidenceFileError("file-changed");
  assertCanonicalEvidenceContainment(path, canonicalProfile);
  const stillOpened = fstatSync(descriptor, { bigint: true });
  if (!sameFileIdentity(stillOpened, opened)) throw new EvidenceFileError("path-race");
  if (!sameImmutableFileSnapshot(stillOpened, opened)) throw new EvidenceFileError("file-changed");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameImmutableFileSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function listProfileEntries(root, canonicalProfile, limit = MAX_MANIFEST_ENTRIES) {
  if (!existsSync(root)) return [];
  const entries = [];
  const pending = [resolve(root)];
  while (pending.length > 0 && entries.length < limit) {
    const path = pending.pop();
    const metadata = containedProfileEntry(path, canonicalProfile);
    if (!metadata) continue;
    if (metadata.snapshot.isSymbolicLink()) {
      entries.push({ path, type: "symlink" });
      continue;
    }
    if (metadata.snapshot.isDirectory()) {
      entries.push({ path, type: "directory" });
      const remainingSlots = Math.max(0, limit - entries.length - pending.length);
      const children = readBoundedDirectoryChildren(path, canonicalProfile, metadata.snapshot, remainingSlots);
      pending.push(...children);
      continue;
    }
    entries.push({
      path,
      type: metadata.snapshot.isFile() ? "file" : "special",
      size: safeMetadataSize(metadata.snapshot.size)
    });
  }
  return entries;
}

function readBoundedDirectoryChildren(path, canonicalProfile, expected, limit) {
  if (limit <= 0) return [];
  let descriptor;
  let directory;
  try {
    if (process.platform === "win32") {
      directory = opendirSync(path, { bufferSize: Math.min(32, limit) });
      const current = containedProfileEntry(path, canonicalProfile);
      if (!current || !sameImmutableFileSnapshot(current.snapshot, expected)) {
        directory.closeSync();
        return [];
      }
    } else {
      descriptor = openSync(
        path,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      );
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameImmutableFileSnapshot(opened, expected)) {
        closeSync(descriptor);
        descriptor = undefined;
        return [];
      }
      const descriptorPath = directoryDescriptorPath(descriptor, path);
      directory = opendirSync(descriptorPath, { bufferSize: Math.min(32, limit) });
    }
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    return [];
  }
  const children = [];
  try {
    let inspected = 0;
    while (inspected < limit) {
      const entry = directory.readSync();
      if (entry === null) break;
      inspected += 1;
      const childPath = join(path, entry.name);
      if (containedProfileEntry(childPath, canonicalProfile)) children.push(childPath);
    }
  } finally {
    try {
      directory.closeSync();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  const current = containedProfileEntry(path, canonicalProfile);
  if (!current || !sameImmutableFileSnapshot(current.snapshot, expected)) return [];
  children.sort((left, right) => basename(right).localeCompare(basename(left)));
  return children;
}

function containedProfileEntry(path, canonicalProfile) {
  let initial;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
  const containmentPath = initial.isSymbolicLink() ? dirname(path) : path;
  let canonicalPath;
  try {
    canonicalPath = realpathSync(containmentPath);
  } catch {
    return undefined;
  }
  if (!isPathAtOrInside(canonicalProfile, canonicalPath)) return undefined;
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
  if (!sameImmutableFileSnapshot(initial, current)) return undefined;
  return { snapshot: current };
}

function directoryDescriptorPath(descriptor, fallbackPath) {
  if (process.platform === "linux") return `/proc/self/fd/${descriptor}`;
  if (process.platform === "darwin") return `/dev/fd/${descriptor}`;
  return fallbackPath;
}

function safeMetadataSize(size) {
  if (size < 0n) return 0;
  return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
}

function isAllowlistedEditorLog(path) {
  return (
    /^[^/]+\/(?:main|sharedprocess)\.log$/u.test(path) ||
    /^[^/]+\/window[0-9]+\/(?:renderer|notebook\.rendering)\.log$/u.test(path) ||
    /^[^/]+\/window[0-9]+\/exthost\/exthost\.log$/u.test(path) ||
    /^[^/]+\/window[0-9]+\/exthost\/output_logging_[^/]+\/[^/]*Open Wrangler[^/]*\.log$/iu.test(path)
  );
}

function editorLogKind(path) {
  if (path.endsWith("/main.log")) return "main";
  if (path.endsWith("/sharedprocess.log")) return "sharedprocess";
  if (path.endsWith("/notebook.rendering.log")) return "notebook-rendering";
  if (path.endsWith("/renderer.log")) return "renderer";
  if (path.endsWith("/exthost.log")) return "extension-host";
  return "open-wrangler-output";
}

function profileRelativePath(profile, path) {
  const result = relative(profile, resolve(path)).replaceAll(sep, "/");
  return result.startsWith("../") ? basename(path) : result;
}

function requireContainedPath(parent, child, description) {
  if (!isContainedPath(parent, child)) throw new Error(`${description} must be inside its private temporary root.`);
}

function isContainedPath(parent, child) {
  const nested = relative(resolve(parent), resolve(child));
  return nested !== "" && !nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested);
}

function isPathAtOrInside(parent, child) {
  return resolve(parent) === resolve(child) || isContainedPath(parent, child);
}

function canonicalizePath(path) {
  const resolvedPath = resolve(path);
  const suffix = [];
  let existingPath = resolvedPath;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    suffix.unshift(basename(existingPath));
    existingPath = parent;
  }
  return resolve(realpathSync(existingPath), ...suffix);
}

function discardLeadingUtf8ContinuationBytes(buffer) {
  let index = 0;
  while (index < buffer.length && (buffer[index] & 0xc0) === 0x80) index += 1;
  return buffer.subarray(index);
}

function boundedUtf8Tail(text, byteLimit) {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= byteLimit) return text;
  const aligned = discardLeadingUtf8ContinuationBytes(encoded.subarray(encoded.length - byteLimit));
  return new TextDecoder("utf-8", { fatal: true }).decode(aligned);
}

function boundedUtf8Head(text, byteLimit) {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= byteLimit) return text;
  for (let end = byteLimit; end >= Math.max(0, byteLimit - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
    } catch {
      // A byte limit may split the final UTF-8 code point by at most three bytes.
    }
  }
  return "";
}

function containsBinaryControl(text) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (isBinaryControlCodePoint(codePoint)) return true;
  }
  return false;
}

function containsEncodedBinaryControl(text) {
  if (/\\(?:e|0*33)\[/iu.test(text)) return true;
  if (UNSAFE_HTML_FORMAT_ENTITY.test(text)) return true;
  const surrogatePairs = /\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/giu;
  let surrogateMatch;
  while ((surrogateMatch = surrogatePairs.exec(text)) !== null) {
    const high = Number.parseInt(surrogateMatch[1], 16);
    const low = Number.parseInt(surrogateMatch[2], 16);
    const codePoint = (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    if (isBinaryControlCodePoint(codePoint)) return true;
  }
  const patterns = [
    { expression: /%([0-9a-f]{2})/giu, radix: 16 },
    { expression: /\\x([0-9a-f]{2})/giu, radix: 16 },
    { expression: /\\u([0-9a-f]{4})/giu, radix: 16 },
    { expression: /\\u\{([0-9a-f]{1,6})\}/giu, radix: 16 },
    { expression: /&#x([0-9a-f]{1,6});/giu, radix: 16 },
    { expression: /&#([0-9]{1,7});/gu, radix: 10 }
  ];
  for (const { expression, radix } of patterns) {
    let match;
    while ((match = expression.exec(text)) !== null) {
      const codePoint = Number.parseInt(match[1], radix);
      if (Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff && isBinaryControlCodePoint(codePoint)) {
        return true;
      }
    }
  }
  const percentRuns = /(?:%[0-9a-f]{2})+/giu;
  let percentMatch;
  while ((percentMatch = percentRuns.exec(text)) !== null) {
    const encoded = percentMatch[0];
    const bytes = new Uint8Array(encoded.length / 3);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(encoded.slice(index * 3 + 1, index * 3 + 3), 16);
    }
    try {
      if (containsBinaryControl(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) return true;
    } catch {
      if (bytes.some((value) => value >= 0x80)) return true;
    }
  }
  return false;
}

function isBinaryControlCodePoint(codePoint) {
  return (
    codePoint <= 0x08 ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    UNICODE_FORMAT_CONTROL.test(String.fromCodePoint(codePoint)) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function recordSkippedEvidence(path, reason, skippedFiles, evidenceByProfilePath, replacements) {
  if (evidenceByProfilePath.has(path)) return;
  if (skippedFiles.length < MAX_FAILURE_LIST_ENTRIES) {
    skippedFiles.push({ path: redactPathMetadata(path, replacements), reason });
  }
  evidenceByProfilePath.set(path, { status: "skipped", reason });
}

class EvidenceFileError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function safeSegment(value) {
  const normalized = String(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return normalized || "unknown";
}
