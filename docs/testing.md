# Testing

## Automated layers

- `npm run typecheck` checks the extension and webview projects independently.
- `npm run lint` and `npm run lint:python` enforce TypeScript/JavaScript and Python quality.
- `npm run test:ts` covers shared models, extension helpers, reducers, and React behavior.
- `npm run test:python` covers Pandas/Polars engines, transformations, code generation, exports, and runtime dispatch.
- `npm run docs:check` enforces required documentation and release/version alignment.
- `npm run verify:vsix -- <file>` rejects development, user, secret, test, and source-map content from a package.

Protocol fixtures and engine-operation cases must run through both TypeScript and Python decoders. Polars tests monkeypatch `DataFrame.to_pandas` to fail. Cross-engine operation tests compare normalized semantic output and separately validate engine-native generated code.

## Visual and accessibility coverage

The browser harness captures the built webviews in light, dark, high contrast, and high-contrast light themes at 800, 1280, and 1920 pixels. It covers 80%, 100%, 150%, and 200% zoom; empty, loading, error, recovery, preview, and diff states; long and Unicode values; wide and tall datasets; and keyboard-only interaction. Playwright runs axe checks and screenshot comparisons.

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

## Performance fixtures

Release benchmarks include a 100k by 50 CSV and 1M by 20 Parquet. On the reference Linux workstation with warm dependencies, first usable Polars grids must appear within 3 and 5 seconds respectively, cached scroll work within 100ms, and uncached block fetches within 500ms at p95. Repeated open/close cycles must leave no runtime process or retained session.
