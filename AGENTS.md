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

1. Pandas, Polars, and DuckDB paths remain engine-native. Polars code must never call `to_pandas()`; DuckDB code must never convert through Pandas, Polars, or Arrow.
2. Viewing filters/sorts are separate from committed cleaning steps and never alter the source.
3. User data is not overwritten. Exports use a new destination and atomic replacement.
4. Python execution, dependency installation, custom code, and exports require a trusted workspace.
5. Every runtime request is versioned, validated, correlated, cancellable where possible, and safe to ignore when stale.
6. Disposing a panel closes its runtime session. A runtime crash rejects pending work and offers replay/recovery.
7. Webviews use VS Code theme tokens, a restrictive CSP, same-origin validated messages, accessible labels, and keyboard navigation. User-derived keys belong in `Map`/`Set`, never dynamic object properties.
8. `scratch.txt` and all other untracked user files are user-owned. Never edit, delete, stage, or package them.
9. Do not describe the project as feature-parity complete until every in-scope row in `docs/feature-parity.md` is green.
10. File readers expose a shared zero-based Excel sheet index. Failed eager or lazy opens must produce `EngineError` and must not retain a session; nested and scalar values must remain strict-JSON-safe.
11. Every operation change needs matching runtime and executable generated-code tests for every editing-capable engine. Generated categorical columns may not collide, and engine-specific null/Unicode/aggregate defaults must be normalized explicitly.
12. Standalone runtime startup is single-flight. Restart must invalidate any pending start, and closing the final session must stop the Python process; packaged seed/verify acceptance guards these lifecycle rules.
13. Cleaning-plan shortcuts must be state-scoped, mirrored inside the webview, documented in the generated reference, and tested without intercepting editable-field undo.
14. Saved notebook-output queries use the pure `src/webviews/snapshotModel.ts` model. Null/NaN predicates and per-sort null placement must match live runtime semantics and remain directly unit-tested.
15. Visual baselines and axe acceptance use the lockfile-pinned Playwright Chromium plus deterministic Liberation Sans/Mono harness tokens. Install Chromium with `npx playwright-core install chromium`; do not silently fall back to a moving system browser or distribution font. CI must retain actual/diff artifacts on failure.
16. Engine registries contain factories, never shared adapters. Every live or transient session exclusively owns one engine instance; open failures, explicit close, orderly runtime shutdown, and notebook snapshot completion invoke cleanup at most once. Cleanup faults surface unless an earlier operation already failed. Normal process stops use bounded stdin/EOF shutdown; forced restart may kill only when recovery or the grace bound requires it.
17. A live lazy-file session represents exactly the source version fingerprinted while it opened. Every data read validates that fingerprint before and after work; a replacement, resize, schema change, or deletion must invalidate cached blocks and return a recoverable reopen diagnostic without preventing close. Initial open never profiles columns. Page blocks are session-local and bounded by both entry count and payload weight, and every filter, draft, plan, source, or disposal change invalidates them.
18. View-query freshness is determined by an opaque logical-view context plus each request's `viewRequestId`, never by filter equality or session revision alone. Mutations and exports remain exclusive; one read-only foreground query may overtake a leased immutable profiling view, profiles use bounded background capacity, and closing cancels queued profiles then waits for active leases. Partial summaries, statistics, values, errors, and pages may update UI or retained panel state only when their request still belongs to the confirmed active view.
19. Cancellation is authoritative only when the original runtime request returns its own correlated response. A cancellation acknowledgement may remove queued work, but it must never synthesize completion for already-running work or hide a mutation that may have committed.
20. Runtime and webview mutations publish atomically. A failed preview/apply/discard/undo restores revisions, plans, drafts, metadata, page/cache state, code, selected column, and progressive-profile ownership to the last confirmed snapshot.
21. The bundled runtime version lives in `python/openwrangler_runtime/version.py`, drives Python package metadata and the initialize handshake, and must remain PEP 440-equivalent to `package.json`; `npm run docs:check` enforces this.
22. `closeSession` is terminal cleanup: its revision is advisory so a caller holding the last confirmed revision can still dispose a runtime that may have committed an ambiguous response. Unknown sessions remain errors, and cleanup still runs at most once.
23. Pandas custom code receives recursively isolated object-dtype cells so draft, rollback, and generated-code execution cannot mutate nested source objects. Live and generated filters must distinguish null from NaN exactly as typed cells and saved notebook snapshots do.
24. Live-kernel opens carry a host-generated `requestedSessionId`. A failed, cancelled, timed-out, malformed, or mis-correlated open must issue a fresh bounded close for that known candidate ID so lost kernel output cannot orphan an unaddressable runtime session.
25. DuckDB file sessions own a hardened connection with extension auto-install and autoload disabled. Lazy relations stay native, terminal reads use independently owned short-lived connections, shutdown interruption is not advertised as request cancellation, and every connection is closed deterministically.
26. Persisted cleaning state is keyed by both source identity and confirmed backend. Recovery replays with that backend pinned; an automatic fallback must never reinterpret a saved plan through another engine.
27. Persisted cleaning and viewing sections recover independently. A missing, malformed, or stale view falls back to an empty view on the cleaned runtime without dropping valid steps or a draft; only cleaning replay failure may reopen the immutable original. Debounced presentation state must flush before a webview can disappear.
28. Applied-step inspection is bounded, read-only, and ephemeral. It may replay only the selected prefix, never mutate revisions or caches, and must clear across panel switches, recreated webviews, recovery, mutation, disposal, Original Data, and Escape while restoring the exact confirmed view. Diff truncation accounts for rows on either side of the returned block.

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
npx playwright-core install chromium # before local visual capture/verification
npm run clean
npm run build
npm run capture:screenshots # for visible changes
npm run package -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run test:packaged-editors -- openwrangler.vsix
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
