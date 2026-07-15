# Testing

## Automated layers

- `npm run typecheck` checks the extension and webview projects independently.
- `npm run lint` and `npm run lint:python` enforce TypeScript/JavaScript and Python quality.
- `npm run test:ts` covers shared models, extension helpers, reducers, and React behavior.
- `npm run test:python` covers Pandas/Polars engines, transformations, code generation, exports, and runtime dispatch.
- `npm run test:extension-host` launches the real custom editor in an isolated VS Code profile and validates activation, commands, native contributions, and fixture opening.
- `npm run reference:check` regenerates command, setting, operation, protocol, and MIME reference content in memory and fails on drift.
- `npm run docs:check` enforces required documentation and release/version alignment.
- `npm run verify:vsix -- <file>` rejects development, user, secret, test, and source-map content from a package.

Protocol fixtures and engine-operation cases must run through both TypeScript and Python decoders. Polars tests monkeypatch `DataFrame.to_pandas` to fail. Cross-engine operation tests compare normalized semantic output and separately validate engine-native generated code.

Persistence tests must assert that only serializable replay state is stored, malformed operation kinds are rejected, import options participate in source identity, and runtime/public session identifiers never enter workspace state. Packaged release acceptance must still apply a plan, reload the editor, and verify the restored grid in both VS Code and Cursor.

Notebook compatibility tests must exercise complete MIME v2 snapshots, saved MIME v1 normalization, malformed versions, Pandas/Polars formatter registration after kernel permission, source notebook URI retention, and insertion of the edited generated function. The real-kernel suite must render both engines, use protocol v2, restart, recover, and always terminate its kernel. Lifecycle tests must cover permission/acquisition denial, cancellation, timeout, one retry, and repeated failure. Browser baselines include current v2 output and `notebook-v1-compat-dark-1280.png`; release acceptance must repeat both in packaged VS Code and Cursor.

Export tests must cover both engines and both supported formats. They must prove committed-plan output, exclusion of view filters, pending-draft rejection, source-path rejection, atomic replacement, failed-write cleanup, and the Polars-to-Pandas prohibition. Code export acceptance must verify the edited CodeMirror buffer, not only the original generated string.

Identity tests must prove stable row tokens through filtering, sorting, projections, and value changes; deterministic new generations for group/custom results; column lineage through renames, reorders, drops, latest-step edits, and duplicate labels; and identity exclusion from schema, summaries, duplicate counts, custom code, generated code, and exports.

By-example tests must exercise every candidate family, deterministic tie ordering, ambiguity warnings, failure diagnostics, persisted-program revalidation, native execution, and generated-code equivalence in both engines. A synthesized step is not accepted without draft/diff confirmation and apply/discard coverage.

## Visual and accessibility coverage

`npm run build && npm run capture:screenshots` generates the browser harness from real Polars protocol responses and the production webview bundle. Checked-in baselines currently cover light, dark, and high contrast at 800, 1280, and 1920 pixels, plus 80%, 100%, 150%, and 200% zoom. The wide fixture contains 1,000 rows by 40 columns and supplies five independent 200-row blocks.

The current browser acceptance records keyboard cell navigation, far-column focus restoration, bounded row/column DOM counts, responsive drawer layout, advanced predicate interaction, the complete operation catalog, draft/diff presentation, by-example input/warning states, and editable CodeMirror code preview. Checked-in editing baselines include `operation-dialog-dark-1280.png`, `draft-preview-dark-1280.png`, `by-example-dialog-dark-1280.png`, `by-example-preview-dark-1280.png`, and `code-preview-dark-1280.png`. High-contrast light, automated axe scanning and image diffs, long/Unicode content, and explicit empty/loading/error/recovery states remain release gates; do not mark those matrix rows Done until the harness implements them.

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

CI runs the extension-host suite on the minimum declared VS Code 1.105.0 and current stable release under Xvfb. Local packaged-install checks use dedicated `--user-data-dir` and `--extensions-dir` paths for both VS Code and Cursor.

## Performance fixtures

Release benchmarks include a 100k by 50 CSV and 1M by 20 Parquet. On the reference Linux workstation with warm dependencies, first usable Polars grids must appear within 3 and 5 seconds respectively, cached scroll work within 100ms, and uncached block fetches within 500ms at p95. Repeated open/close cycles must leave no runtime process or retained session.
