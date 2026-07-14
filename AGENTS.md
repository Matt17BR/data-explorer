# Data Explorer agent guide

This repository builds the open-source Data Explorer extension and its bundled Python runtime. Read this file before changing code. The product is a clean-room implementation: use public documentation and black-box behavior as references, but never copy Microsoft Data Wrangler code or assets.

## Architecture map

- `src/extension/` owns VS Code APIs, runtime lifecycle, sessions, commands, custom editors, and notebook integration.
- `src/shared/` owns the versioned messages and behavior shared by extension and webviews.
- `src/webviews/` owns the React UI. It must remain themeable, keyboard accessible, and independent of Node APIs.
- `python/data_wrangler_runtime/` owns dataframe engines, queries, transformations, profiling, code generation, and exports.
- `docs/architecture.md` records boundaries and invariants.
- `docs/feature-parity.md` is the release gate for user-visible parity.
- `docs/testing.md` defines required checks and manual editor scenarios.
- `docs/releasing.md` defines packaging and release rules.

## Non-negotiable invariants

1. Pandas and Polars paths remain engine-native. Polars code must never call `to_pandas()`.
2. Viewing filters/sorts are separate from committed cleaning steps and never alter the source.
3. User data is not overwritten. Exports use a new destination and atomic replacement.
4. Python execution, dependency installation, custom code, and exports require a trusted workspace.
5. Every runtime request is versioned, validated, correlated, cancellable where possible, and safe to ignore when stale.
6. Disposing a panel closes its runtime session. A runtime crash rejects pending work and offers replay/recovery.
7. Webviews use VS Code theme tokens, a restrictive CSP, validated messages, accessible labels, and keyboard navigation.
8. `scratch.txt` and all other untracked user files are user-owned. Never edit, delete, stage, or package them.
9. Do not describe the project as feature-parity complete until every in-scope row in `docs/feature-parity.md` is green.

## Required checks

Run the narrowest relevant tests while iterating, then run all of these before a milestone PR:

```bash
npm run check
npm test
npm run clean
npm run build
npm run package -- --out data-explorer.vsix
npm run verify:vsix -- data-explorer.vsix
```

For editor-facing changes, also complete the relevant scenarios in `docs/testing.md` in both VS Code and Cursor using isolated profiles.

## Documentation update matrix

- Protocol, session, runtime, or engine boundary changes: update `docs/architecture.md` and protocol tests.
- New or changed operation, filter, export, or entry point: update `docs/feature-parity.md` and its acceptance evidence.
- Test commands, fixtures, or release gates: update `docs/testing.md`.
- Package contents, versioning, CI, publishing, or credentials: update `docs/releasing.md` and `CHANGELOG.md`.
- User-visible setup or behavior: update `README.md` and `CHANGELOG.md`.
- New third-party runtime or bundled asset: update `THIRD_PARTY_NOTICES.md` and verify its license.

CI runs `npm run docs:check`; do not bypass it or hand-edit generated reference sections once generation markers are introduced.
