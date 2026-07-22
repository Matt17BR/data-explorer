import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync as readFileDescriptorSync,
  renameSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSealedEditorAcceptanceArtifact,
  assertEditorAcceptanceEvidenceStagingRoot,
  captureEditorAcceptanceEvidenceReceipt,
  createEditorAcceptanceArtifactParent,
  createEditorAcceptanceEvidenceStagingRoot,
  removeEditorAcceptanceArtifactParent,
  sealEditorAcceptanceEvidence,
  sealEditorAcceptanceEvidenceForTest
} from "./editor-acceptance-artifact.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("prelaunch staging receipts reject planted entries and root replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-staging-receipt-"));
  try {
    const receipt = createEditorAcceptanceEvidenceStagingRoot(join(directory, "staging-parent"));
    assert.equal(assertEditorAcceptanceEvidenceStagingRoot(receipt, { requireEmpty: true }), receipt.root);
    await writeFile(join(receipt.root, "planted-profile.db"), "RAW_USER_DATA", { mode: 0o600 });
    assert.throws(
      () => assertEditorAcceptanceEvidenceStagingRoot(receipt, { requireEmpty: true }),
      /modified by the editor process/u
    );
    await rm(receipt.root, { recursive: true, force: true });
    await mkdir(receipt.root, { mode: 0o700 });
    assert.throws(
      () => assertEditorAcceptanceEvidenceStagingRoot(receipt),
      /no longer matches its prelaunch identity/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sealed editor evidence contains only receipt-bound, re-redacted text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-evidence-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    await mkdir(join(target, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(target, "failure.json"),
      '{"message":"Authorization: Bearer top-secret --token\\\\tartifact-tab-secret"}\n',
      { mode: 0o600 }
    );
    await writeFile(join(target, "logs", "001-renderer.log"), "https://user:password@example.invalid\n", {
      mode: 0o600
    });
    await writeFile(join(target, "logs", "002-ansi.log"), "password\u001b[31m=artifact-ansi-secret\n", {
      mode: 0o600
    });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactReceipt = sealEditorAcceptanceEvidence({ evidenceRoot, artifactParent, receipts: [receipt] });
    const artifact = assertSealedEditorAcceptanceArtifact(artifactReceipt);
    assert.equal(Object.isFrozen(artifactReceipt), true);
    assert.equal(Object.isFrozen(artifactReceipt.parent), true);
    assert.equal(Object.isFrozen(artifactReceipt.snapshot), true);
    const bundle = JSON.parse(await readFile(artifact, "utf8"));
    assert.equal(bundle.schemaVersion, 1);
    assert.deepEqual(
      bundle.entries.map((entry) => entry.path),
      ["evidence-001/failure.json", "evidence-001/logs/001-renderer.log", "evidence-001/logs/002-ansi.log"]
    );
    const serialized = JSON.stringify(bundle);
    assert.doesNotMatch(serialized, /top-secret|user:password|artifact-tab-secret|artifact-ansi-secret/u);
    assert.match(serialized, /<redacted>/u);
    assert.match(serialized, /<sealed-source-omitted-sensitive-content>/u);
    assert.equal(
      createHash("sha256")
        .update(await readFile(artifact))
        .digest("hex"),
      artifactReceipt.sha256
    );
    assert.equal(BigInt((await stat(artifact)).size), artifactReceipt.snapshot.size);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh artifact parents are unique private directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-artifact-parent-"));
  try {
    const first = createEditorAcceptanceArtifactParent(join(directory, "base"));
    const second = createEditorAcceptanceArtifactParent(join(directory, "base"));
    assert.notEqual(first.path, second.path);
    if (process.platform !== "win32") {
      assert.equal((await stat(first.path)).mode & 0o777, 0o700);
      assert.equal((await stat(second.path)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact receipts remain valid below a symlinked ancestor", async (context) => {
  if (process.platform === "win32") {
    context.skip("Creating directory symlinks is not available to unprivileged Windows test users.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-artifact-ancestor-"));
  try {
    const realRoot = join(directory, "real-root");
    const aliasRoot = join(directory, "alias-root");
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    await mkdir(realRoot, { mode: 0o700 });
    await symlink(realRoot, aliasRoot, "dir");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(aliasRoot, "artifact-base"));
    const artifactReceipt = sealEditorAcceptanceEvidence({ evidenceRoot, artifactParent, receipts: [receipt] });
    assert.equal(assertSealedEditorAcceptanceArtifact(artifactReceipt), artifactReceipt.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sealing rejects files or links planted after the in-memory receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-evidence-race-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "cursor-1.0-verify-attempt-1");
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });

    await writeFile(join(target, "raw-profile.db"), "RAW_USER_DATA", { mode: 0o600 });
    assert.throws(
      () => sealEditorAcceptanceEvidence({ evidenceRoot, artifactParent, receipts: [receipt] }),
      /changed after collection/u
    );
    await rm(join(target, "raw-profile.db"));
    await symlink(join(target, "failure.json"), join(target, "planted.log"));
    assert.throws(
      () => sealEditorAcceptanceEvidence({ evidenceRoot, artifactParent, receipts: [receipt] }),
      /only real directories|changed after collection/u
    );
    assert.deepEqual(await readdir(artifactParent.path), []);
    removeEditorAcceptanceArtifactParent(artifactParent);
    await assert.rejects(stat(artifactParent.path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sealing rejects replacement of the pinned artifact parent before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-parent-race-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    const artifactParentReceipt = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    const artifactParent = artifactParentReceipt.path;
    const parkedParent = join(directory, "artifacts-parked");
    const outside = join(directory, "outside");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const receipts = [receipt];
    Object.defineProperty(receipts, "0", {
      configurable: true,
      get() {
        renameSync(artifactParent, parkedParent);
        symlinkSync(outside, artifactParent, process.platform === "win32" ? "junction" : "dir");
        return receipt;
      }
    });

    assert.throws(
      () => sealEditorAcceptanceEvidence({ evidenceRoot, artifactParent: artifactParentReceipt, receipts }),
      /artifact parent no longer matches its pinned identity/u
    );
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(parkedParent), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sealed artifact receipts reject parent replacement before handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-handoff-race-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    const artifactParentPath = artifactParent.path;
    const parkedParent = join(directory, "artifact-parent-parked");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactReceipt = sealEditorAcceptanceEvidence({
      evidenceRoot,
      artifactParent,
      receipts: [receipt]
    });
    renameSync(artifactParentPath, parkedParent);
    await mkdir(artifactParentPath, { mode: 0o700 });
    await writeFile(join(artifactParentPath, basename(artifactReceipt.path)), "RAW_REBOUND_UPLOAD\n", { mode: 0o600 });
    assert.throws(
      () => assertSealedEditorAcceptanceArtifact(artifactReceipt),
      /artifact parent no longer matches its pinned identity/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a post-write parent rename attempt leaves no diagnostic bytes behind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-parent-write-race-"));
  const evidenceRoot = join(directory, "staging");
  const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
  const parkedParent = join(directory, "artifacts-parked");
  try {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe-diagnostic-line\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    let renamed = false;
    assert.throws(
      () =>
        sealEditorAcceptanceEvidenceForTest(
          { evidenceRoot, artifactParent, receipts: [receipt] },
          {
            afterWrite() {
              renameSync(artifactParent.path, parkedParent);
              renamed = true;
            }
          }
        ),
      /artifact parent no longer matches its pinned identity|EPERM|EACCES/u
    );
    if (renamed) {
      const parkedArtifacts = (await readdir(parkedParent)).filter((entry) => entry.startsWith("a-"));
      assert.equal(parkedArtifacts.length, 1);
      assert.equal((await stat(join(parkedParent, parkedArtifacts[0]))).size, 0);
      assert.equal(await readFile(join(parkedParent, parkedArtifacts[0]), "utf8"), "");
    } else {
      assert.deepEqual(await readdir(artifactParent.path), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-write hard-link interference scrubs every link to the created inode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-hardlink-failure-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    const observedLink = join(directory, "observed-artifact.json");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe-diagnostic-line\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    assert.throws(
      () =>
        sealEditorAcceptanceEvidenceForTest(
          { evidenceRoot, artifactParent, receipts: [receipt] },
          {
            afterWrite() {
              const artifactName = readdirSync(artifactParent.path).find((entry) => entry.startsWith("a-"));
              assert.ok(artifactName);
              linkSync(join(artifactParent.path, artifactName), observedLink);
            }
          }
        ),
      /changed before it was committed/u
    );
    assert.equal((await stat(observedLink)).size, 0);
    assert.equal(await readFile(observedLink, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-write unlink interference scrubs the unlinked created inode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-unlink-failure-"));
  let observer;
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe-diagnostic-line\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    assert.throws(() =>
      sealEditorAcceptanceEvidenceForTest(
        { evidenceRoot, artifactParent, receipts: [receipt] },
        {
          afterWrite() {
            const artifactName = readdirSync(artifactParent.path).find((entry) => entry.startsWith("a-"));
            assert.ok(artifactName);
            const artifactPath = join(artifactParent.path, artifactName);
            observer = openSync(artifactPath, constants.O_RDONLY);
            unlinkSync(artifactPath);
          }
        }
      )
    );
    assert.ok(observer !== undefined);
    assert.equal(fstatSync(observer).size, 0);
    assert.equal(readFileDescriptorSync(observer).length, 0);
    assert.deepEqual(await readdir(artifactParent.path), []);
  } finally {
    if (observer !== undefined) closeSync(observer);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a close failure while the descriptor remains open scrubs before a bounded retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-open-close-failure-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe-diagnostic-line\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    let closeCalls = 0;
    assert.throws(
      () =>
        sealEditorAcceptanceEvidenceForTest(
          { evidenceRoot, artifactParent, receipts: [receipt] },
          {
            closeDescriptor(descriptor) {
              closeCalls += 1;
              if (closeCalls === 1) throw new Error("injected close before descriptor release");
              closeSync(descriptor);
            }
          }
        ),
      /injected close before descriptor release/u
    );
    assert.equal(closeCalls, 2);
    assert.deepEqual(await readdir(artifactParent.path), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reported close failure removes the pinned artifact after the descriptor is already closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-close-failure-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-1.0-verify-attempt-1");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), "safe-diagnostic-line\n", { mode: 0o600 });
    const receipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    let closeCalls = 0;
    assert.throws(
      () =>
        sealEditorAcceptanceEvidenceForTest(
          { evidenceRoot, artifactParent, receipts: [receipt] },
          {
            closeDescriptor(descriptor) {
              closeCalls += 1;
              closeSync(descriptor);
              if (closeCalls === 1) throw new Error("injected close reporting failure");
            }
          }
        ),
      /injected close reporting failure/u
    );
    assert.equal(closeCalls, 1);
    assert.deepEqual(await readdir(artifactParent.path), []);
    removeEditorAcceptanceArtifactParent(artifactParent);
    await assert.rejects(stat(artifactParent.path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged preflight artifacts never echo untrusted CLI or enum inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-preflight-artifact-"));
  const runnerTemp = join(directory, "runner-temp");
  const missingPathSentinel = "RAW_ARBITRARY_PATH_SENTINEL.vsix";
  const editorSentinel = "RAW_ARBITRARY_EDITOR_SENTINEL";
  const scenarios = [
    {
      name: "missing package path",
      args: [join(directory, missingPathSentinel)],
      environment: { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode" },
      forbidden: [missingPathSentinel, join(directory, missingPathSentinel)]
    },
    {
      name: "unsupported editor selection",
      args: ["package.json"],
      environment: { OPEN_WRANGLER_PACKAGED_EDITORS: editorSentinel },
      forbidden: [editorSentinel]
    }
  ];
  const artifacts = [];
  try {
    for (const scenario of scenarios) {
      const outputPath = join(directory, `${scenario.name.replaceAll(" ", "-")}.output`);
      const environment = { ...process.env };
      delete environment.GITHUB_OUTPUT;
      delete environment.OPEN_WRANGLER_PACKAGED_EDITORS;
      delete environment.OPEN_WRANGLER_EDITOR_DISPLAY;
      Object.assign(environment, scenario.environment, {
        GITHUB_ACTIONS: "true",
        GITHUB_OUTPUT: outputPath,
        RUNNER_TEMP: runnerTemp
      });
      const result = await runChild(
        process.execPath,
        [join(repositoryRoot, "scripts", "run-packaged-editor-tests.mjs"), ...scenario.args],
        {
          cwd: repositoryRoot,
          env: environment
        }
      );
      assert.equal(result.code, 1, scenario.name);
      assert.match(result.stderr, /A sealed sanitized diagnostic artifact is ready/u);
      const workflowOutput = await readFile(outputPath, "utf8");
      assert.match(workflowOutput, /^evidence_ready=true$/mu);
      const artifactOutputPath = /^evidence_path=(.+)$/mu.exec(workflowOutput)?.[1];
      assert.ok(artifactOutputPath, scenario.name);
      const artifactPath = resolve(repositoryRoot, artifactOutputPath);
      artifacts.push(artifactPath);
      const artifact = await readFile(artifactPath, "utf8");
      const expectedDigest = /^evidence_sha256=([0-9a-f]{64})$/mu.exec(workflowOutput)?.[1];
      const expectedSize = /^evidence_size=([0-9]+)$/mu.exec(workflowOutput)?.[1];
      assert.equal(createHash("sha256").update(artifact).digest("hex"), expectedDigest);
      assert.equal(String(Buffer.byteLength(artifact, "utf8")), expectedSize);
      assert.ok(artifactPath.startsWith(`${resolve(runnerTemp)}${sep}`));
      if (process.platform !== "win32") assert.equal((await stat(dirname(artifactPath))).mode & 0o777, 0o700);
      for (const forbidden of scenario.forbidden) {
        assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(forbidden), "u"));
        assert.doesNotMatch(artifact, new RegExp(escapeRegExp(forbidden), "u"));
      }
    }
  } finally {
    await Promise.all(artifacts.map((artifact) => rm(artifact, { force: true })));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local packaged preflight reports one removable relative artifact path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-local-preflight-artifact-"));
  let artifactParent;
  try {
    const environment = { ...process.env, OPEN_WRANGLER_PACKAGED_EDITORS: "vscode" };
    delete environment.GITHUB_ACTIONS;
    delete environment.GITHUB_OUTPUT;
    delete environment.RUNNER_TEMP;
    delete environment.OPEN_WRANGLER_EDITOR_DISPLAY;
    const result = await runChild(
      process.execPath,
      [join(repositoryRoot, "scripts", "run-packaged-editor-tests.mjs"), join(directory, "missing.vsix")],
      { cwd: repositoryRoot, env: environment }
    );
    assert.equal(result.code, 1);
    const relativeArtifact = /ready at (tmp\/editor-acceptance-artifacts\/p-[^/\s]+\/a-[a-f0-9-]+\.json)\./u.exec(
      result.stderr
    )?.[1];
    assert.ok(relativeArtifact);
    const artifactPath = resolve(repositoryRoot, relativeArtifact);
    artifactParent = dirname(artifactPath);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    assert.equal(artifact.schemaVersion, 1);
    assert.ok(artifact.entries.length > 0);
    await rm(artifactPath, { force: true });
    await rm(artifactParent, { recursive: true, force: true });
    artifactParent = undefined;
  } finally {
    if (artifactParent) await rm(artifactParent, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("CI hands the exact emitted artifact path directly to the upload action", async () => {
  const workflows = new Map([
    ["ci.yml", "b7c566a772e6b6bfb58ed0dc250532a479d7789f"],
    ["release.yml", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"]
  ]);
  for (const [workflowName, uploadArtifactRevision] of workflows) {
    const source = await readFile(join(repositoryRoot, ".github", "workflows", workflowName), "utf8");
    const steps = topLevelWorkflowSteps(source);
    const producers = steps.filter((step) => /\bid:\s*packaged_editor\s*$/mu.test(step));
    assert.ok(producers.length > 0, `${workflowName} must run packaged editor acceptance`);
    for (const producer of producers) {
      const producerIndex = steps.indexOf(producer);
      const upload = steps[producerIndex + 1];
      assert.ok(upload, `${workflowName} must upload immediately after packaged editor acceptance`);
      assert.match(upload, /name:\s*Upload packaged-editor failure diagnostics/u);
      assert.match(upload, new RegExp(`uses:\\s*actions/upload-artifact@${uploadArtifactRevision}\\b`, "u"));
      assert.match(upload, /path:\s*\$\{\{\s*steps\.packaged_editor\.outputs\.evidence_path\s*\}\}\s*$/mu);
      assert.match(upload, /steps\.packaged_editor\.outputs\.evidence_ready\s*==\s*'true'/u);
      assert.match(upload, /retention-days:\s*7\s*$/mu);
      assert.doesNotMatch(upload, /\n\s*path:\s*\|/u);
    }
  }
});

function topLevelWorkflowSteps(source) {
  const lines = source.split(/\r?\n/u);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s{6}- (?:id:|name:|uses:|run:|if:)/u.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n"));
}

function runChild(executable, args, options) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal, stdout, stderr }));
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
