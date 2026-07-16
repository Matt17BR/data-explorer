# Open Wrangler agent guide

This repository builds the open-source Open Wrangler extension and its bundled Python runtime. Read this file before changing code. The product is a clean-room implementation: use public documentation and black-box behavior as references, but never copy Microsoft Data Wrangler code or assets.

## Architecture map

- `src/extension/` owns VS Code APIs, runtime lifecycle, sessions, commands, custom editors, and notebook integration.
- `src/shared/` owns the versioned messages and behavior shared by extension and webviews.
- `src/webviews/` owns the React UI. It must remain themeable, keyboard accessible, and independent of Node APIs.
- `python/openwrangler_runtime/` owns dataframe engines, queries, transformations, profiling, code generation, and exports.
- `docs/architecture.md` records boundaries and invariants.
- `docs/feature-parity.md` is the release gate for user-visible parity.
- `docs/reference.md` is generated from public interface registries; never edit it by hand.
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
10. File readers expose a shared zero-based Excel sheet index. Failed eager or lazy opens must produce `EngineError` and must not retain a session; nested and scalar values must remain strict-JSON-safe.
11. Every operation change needs matching Pandas/Polars runtime and executable generated-code tests. Generated categorical columns may not collide, and engine-specific null/Unicode/aggregate defaults must be normalized explicitly.
12. Standalone runtime startup is single-flight. Restart must invalidate any pending start, and closing the final session must stop the Python process; packaged seed/verify acceptance guards these lifecycle rules.
13. Cleaning-plan shortcuts must be state-scoped, mirrored inside the webview, documented in the generated reference, and tested without intercepting editable-field undo.
14. Saved notebook-output queries use the pure `src/webviews/snapshotModel.ts` model. Null/NaN predicates and per-sort null placement must match live runtime semantics and remain directly unit-tested.
15. Visual baselines and axe acceptance use the lockfile-pinned Playwright Chromium plus deterministic Liberation Sans/Mono harness tokens. Install Chromium with `npx playwright-core install chromium`; do not silently fall back to a moving system browser or distribution font. CI must retain actual/diff artifacts on failure.

## Required checks

Run the narrowest relevant tests while iterating, then run all of these before a milestone PR:

```bash
npm run check
npm test
npm run test:extension-host
npm run test:webview-acceptance
npm run test:coverage
npm run license:check
npm run benchmark:runtime # required for performance/runtime changes and release candidates
npm run test:packaged-editors -- openwrangler.vsix # after packaging
npx playwright-core install chromium # before local visual capture/verification
npm run clean
npm run build
npm run capture:screenshots # for visible changes
npm run package -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
```

For editor-facing changes, also complete the relevant scenarios in `docs/testing.md` in both VS Code and Cursor using isolated profiles.

## Documentation update matrix

- Protocol, session, runtime, or engine boundary changes: update `docs/architecture.md` and protocol tests.
- New or changed operation, filter, export, or entry point: update `docs/feature-parity.md` and its acceptance evidence.
- New or changed command, setting, operation, MIME type, or protocol message: run `npm run generate:reference` and commit `docs/reference.md`.
- Test commands, fixtures, or release gates: update `docs/testing.md`.
- Package contents, versioning, CI, publishing, or credentials: update `docs/releasing.md` and `CHANGELOG.md`.
- User-visible setup or behavior: update `README.md` and `CHANGELOG.md`.
- New third-party runtime or bundled asset: update `THIRD_PARTY_NOTICES.md` and verify its license.

CI runs `npm run reference:check` and `npm run docs:check`; do not bypass them or hand-edit `docs/reference.md`.
