import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { redactEditorAcceptanceText } from "./editor-acceptance-evidence.mjs";

const RESULT_PROTOCOL = 1;
const MAX_VERSION_CHARACTERS = 128;
const MAX_ERROR_BYTES = 16_000;
const MAX_RESULT_BYTES = 32 * 1024;
const OVERSIZED_DIAGNOSTIC_MARKER = "<diagnostic-omitted-size-budget>";
const silentReporter = {
  report() {},
  error() {}
};

const version = process.argv[2];
let result;
try {
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > MAX_VERSION_CHARACTERS ||
    /[\0\r\n]/u.test(version)
  ) {
    throw new Error("The isolated editor downloader received an invalid version.");
  }
  const executablePath = await downloadAndUnzipVSCode({ version, reporter: silentReporter });
  result = { protocol: RESULT_PROTOCOL, ok: true, executablePath };
} catch (error) {
  result = { protocol: RESULT_PROTOCOL, ok: false, error: describeBoundedError(error) };
}

process.stdout.write(`${serializeBoundedResult(result)}\n`);

function describeBoundedError(error) {
  let description;
  try {
    description = error instanceof Error ? error.stack || error.message : String(error);
  } catch {
    description = "The isolated editor downloader failed with an unreadable value.";
  }
  // The complete stack must remain intact until redaction. A prefix could end
  // before a URL userinfo `@`, signed-query delimiter, or private-key terminator.
  if (description.length > MAX_ERROR_BYTES || Buffer.byteLength(description, "utf8") > MAX_ERROR_BYTES) {
    return OVERSIZED_DIAGNOSTIC_MARKER;
  }
  const redacted = redactEditorAcceptanceText(description);
  if (redacted === undefined) return "<sensitive-download-diagnostic-suppressed>";
  return boundedUtf8Head(redacted, MAX_ERROR_BYTES);
}

function boundedUtf8Head(text, byteLimit) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= byteLimit) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, byteLimit));
}

function serializeBoundedResult(outcome) {
  try {
    const serialized = JSON.stringify(outcome);
    if (Buffer.byteLength(serialized, "utf8") <= MAX_RESULT_BYTES) return serialized;
  } catch {
    // Use the fixed envelope below.
  }
  return JSON.stringify({
    protocol: RESULT_PROTOCOL,
    ok: false,
    error: "The isolated editor downloader result exceeded its bounded envelope."
  });
}
