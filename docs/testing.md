# Testing

## Automated layers

- `npm run typecheck` checks the extension and webview projects independently.
- `npm run lint` and `npm run lint:python` enforce TypeScript/JavaScript and Python quality.
- `npm run test:ts` covers shared models, extension helpers, reducers, and React behavior.
- `npm run test:python` covers Pandas/Polars engines, transformations, code generation, exports, and runtime dispatch.
- `npm run test:extension-host` launches the real custom editor in an isolated VS Code profile and validates activation, commands, native contributions, and fixture opening.
- `npm run test:packaged-editors -- data-explorer.vsix` installs the release artifact into isolated VS Code/Cursor profiles and runs the same session-backed acceptance from a separate harness extension so checkout code cannot shadow the package.
- `npm run test:webview-acceptance` renders the production bundles in Chrome, compares every screenshot with its checked-in baseline, and runs WCAG 2.0/2.1/2.2 axe rules through Playwright.
- `npm run reference:check` regenerates command, setting, operation, protocol, and MIME reference content in memory and fails on drift.
- `npm run docs:check` enforces required documentation and release/version alignment.
- `npm run verify:vsix -- <file>` rejects development, user, secret, test, and source-map content from a package.

Protocol fixtures and engine-operation cases must run through both TypeScript and Python decoders. Polars tests monkeypatch `DataFrame.to_pandas` to fail. Cross-engine operation tests compare normalized semantic output and separately validate engine-native generated code.

File-source tests must cover quoted/delimited and headerless CSV, a non-UTF-8 Pandas CSV, TSV, JSONL, Parquet, and Excel by sheet name and zero-based sheet index in both engines. They must reject missing and malformed inputs as structured engine errors, prove failed opens retain no session, and assert Polars CSV/TSV/JSONL/Parquet sources remain lazy. Typed-cell fixtures cover NumPy/Pandas nullable scalars and strict JSON, while nested Polars fixtures cover unsigned large integers, decimals, time zones, lists, structs, binary, categoricals, durations, null/NaN/infinity, and long Unicode text without a Pandas conversion. Both engines must remain page-safe with zero visible columns.

Persistence tests must assert that only serializable replay state is stored, malformed operation kinds are rejected, import options participate in source identity, and runtime/public session identifiers never enter workspace state. Packaged release acceptance must still apply a plan, reload the editor, and verify the restored grid in both VS Code and Cursor.

Notebook compatibility tests must exercise complete MIME v2 snapshots, saved MIME v1 normalization, malformed versions, Pandas/Polars formatter registration after kernel permission, source notebook URI retention, and insertion of the edited generated function. The real-kernel suite must render both engines, use protocol v2, restart, recover, and always terminate its kernel. Lifecycle tests must cover permission/acquisition denial, cancellation, timeout, one retry, and repeated failure. Browser baselines include current v2 output and `notebook-v1-compat-dark-1280.png`; release acceptance must repeat both in packaged VS Code and Cursor.

Export tests must cover both engines and both supported formats. They must prove committed-plan output, exclusion of view filters, pending-draft rejection, source-path rejection, atomic replacement, failed-write cleanup, and the Polars-to-Pandas prohibition. Code export acceptance must verify the edited CodeMirror buffer, not only the original generated string.

Identity tests must prove stable row tokens through filtering, sorting, projections, and value changes; deterministic new generations for group/custom results; column lineage through renames, reorders, drops, latest-step edits, and duplicate labels; and identity exclusion from schema, summaries, duplicate counts, custom code, generated code, and exports.

By-example tests must exercise every candidate family, deterministic tie ordering, ambiguity warnings, failure diagnostics, persisted-program revalidation, native execution, and generated-code equivalence in both engines. A synthesized step is not accepted without draft/diff confirmation and apply/discard coverage.

## Visual and accessibility coverage

`npm run build && npm run capture:screenshots` updates the browser baselines from real Polars protocol responses and the production webview bundle. `npm run test:webview-acceptance` writes separate actual images under `tmp/`, fails above a 1% anti-aliasing-tolerant pixel delta, and never overwrites the baselines. Coverage includes light, dark, high contrast dark/light, 800/1280/1920px widths, and 80/100/150/200% zoom. The wide fixture contains 1,000 rows by 40 columns and supplies five independent 200-row blocks.

The browser acceptance records keyboard cell navigation and resizing, far-column focus restoration, bounded row/column DOM counts, responsive drawer layout, advanced predicate interaction, the complete operation catalog, draft/diff presentation, by-example input/warning states, and editable CodeMirror code preview. Dedicated baselines cover long/Unicode values plus empty, loading, malformed-file error, and runtime-recovery states. Playwright injects axe into all 23 generated editor, notebook, and Code Preview harnesses and fails on every non-minor WCAG violation.

## VS Code and Cursor release checklist

Use isolated `--user-data-dir` and `--extensions-dir` directories. Never install a development VSIX into the user's normal profile during automated checks.

1. Install the packaged VSIX and confirm the gallery and Activity Bar icons.
2. Open every supported fixture through Explorer, editor title, command palette, and custom-editor selection.
3. Exercise column navigation, resizing, keyboard grid navigation, insights, filters, and multi-sort.
4. Apply one operation from every operation group; preview, discard, apply, edit, undo, and inspect generated code.
5. Export code to clipboard, script, and notebook; export data to CSV and Parquet; verify the source is unchanged.
6. Open live Pandas and Polars notebook variables, inline output, and expanded output; restart the kernel and recover.
7. Test missing Python, missing engine packages, denied kernel permission, untrusted workspace, malformed files, runtime crash, reload, multiple panels, and disposal.
8. Repeat core flows in light, dark, and high-contrast themes and at 200% zoom.

Record the editor versions and evidence link in `docs/feature-parity.md` before a release.

The packaged harness auto-detects local VS Code and Cursor installations; set `DATA_EXPLORER_PACKAGED_EDITORS=vscode` in Linux CI. It verifies the publisher/gallery icon, Activity Bar icon, both notebook MIME registrations, all public commands, the walkthrough, an actual Polars custom-editor session, source reopening, and notebook cell insertion. Editor directories are temporary and removed in `finally`.

CI runs the extension-host suite on the minimum declared VS Code 1.105.0 and current stable release under Xvfb. Local packaged-install checks use dedicated `--user-data-dir` and `--extensions-dir` paths for both VS Code and Cursor.

## Performance fixtures

`npm run benchmark:runtime` creates deterministic 100k×50 CSV and 1M×20 Parquet fixtures under ignored `tmp/performance`, measures the complete native Polars `openSession` response, samples cached and distributed block fetches, asserts session disposal, and writes a JSON report. Exact release limits are 3s and 5s for the first usable CSV/Parquet grids, 100ms cached p95, and 500ms uncached p95. The scheduled `Performance gates` workflow repeats the strict benchmark and uploads its report.

The Playwright wide-grid acceptance independently measures rendered scrolling against the same 100ms cached and 500ms uncached p95 limits. Repeated extension-host and installed-package runs verify process/session cleanup; a benchmark is not accepted if `SessionManager.sessions` retains an entry after close.
