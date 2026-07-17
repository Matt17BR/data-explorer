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
3. User data is not overwritten. Exports target a separate destination and use atomic replacement.
4. Python execution, dependency installation, custom code, and exports require a trusted workspace.
5. Every runtime request is versioned, validated, correlated, cancellable where possible, and safe to ignore when stale.
6. Disposing a panel closes its runtime session. A runtime crash rejects pending work and offers replay/recovery.
7. Webviews use VS Code theme tokens, a restrictive CSP, same-origin validated messages, accessible labels, and keyboard navigation. User-derived keys belong in `Map`/`Set`, never dynamic object properties.
8. `scratch.txt` and all other untracked user files are user-owned. Never edit, delete, stage, or package them.
9. Do not describe the project as feature-parity complete until every in-scope row in `docs/feature-parity.md` is green.
10. File readers expose a shared zero-based Excel sheet index. Failed eager or lazy opens must produce `EngineError` and must not retain a session; nested and scalar values must remain strict-JSON-safe.
11. Every operation change needs matching runtime and executable generated-code tests for every editing-capable engine. Generated categorical columns may not collide, and engine-specific null/Unicode/aggregate defaults must be normalized explicitly. Integer group sums and by-example arithmetic share the checked `-(10^38 - 1)..10^38 - 1` envelope; nullable wide Pandas values and decimal mean/median normalization require typed-page regressions.
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
23. Pandas custom code receives recursively isolated object-dtype cells so draft, rollback, and generated-code execution cannot mutate nested source objects. Live and generated filters must distinguish null from NaN exactly as typed cells and saved notebook snapshots do; requesting NaN inclusion for a non-float column is a valid explicit-false value condition, never an empty expression or ignored filter.
24. Live-kernel opens carry a host-generated `requestedSessionId`. A failed, cancelled, timed-out, malformed, or mis-correlated open must issue a fresh bounded close for that known candidate ID so lost kernel output cannot orphan an unaddressable runtime session.
25. DuckDB file sessions own a hardened connection with extension auto-install and autoload disabled. Lazy relations stay native, terminal reads use independently owned short-lived connections, shutdown interruption is not advertised as request cancellation, and every connection is closed deterministically.
26. Persisted cleaning state is keyed by both source identity and confirmed backend. Recovery replays with that backend pinned; an automatic fallback must never reinterpret a saved plan through another engine.
27. Persisted cleaning and viewing sections recover independently. A missing, malformed, or stale view falls back to an empty view on the cleaned runtime without dropping valid steps or a draft; only cleaning replay failure may reopen the immutable original. Debounced presentation state must flush before a webview can disappear.
28. Applied-step inspection is bounded, read-only, and ephemeral. It may replay only the selected prefix, never mutate revisions or caches, and must clear across panel switches, recreated webviews, recovery, mutation, disposal, Original Data, and Escape while restoring the exact confirmed view. Diff truncation accounts for rows on either side of the returned block.
29. All 26 operations that address input columns accept only public `{id, name}` references: row/order, structural, categorical/text/numeric/datetime, `groupBy` keys and aggregation inputs, and `byExample` source/program leaves. Transform filters/sorts remain a distinct stable-reference IR from name-addressed viewing queries. By-example inputs are ordered arrays aligned to source-reference order; name-keyed maps and legacy strings are invalid. The runtime binds each reference against the exact input schema and lineage to a private `{id, name, position}` before adapter dispatch; persisted steps and protocol metadata never expose positions. Unknown, stale, type/name-mismatched, malformed, or disallowed repeated identities, duplicate input-lineage IDs, output collisions, private row-identity names, and non-portable group/by-example type combinations fail closed. Repeated group aggregation inputs are valid when aliases are unique. Pandas live execution and generated code address bound inputs positionally under duplicate and non-string labels; Polars and DuckDB receive verified native names. By-example synthesis stays within 16 sources, 64 examples, 256 AST nodes, depth 64, 64 concat parts, 8 KiB per string, and 64 KiB total UTF-8 text, with budgets checked before synthesis and after canonicalization. There is no compatibility fallback. Edited latest steps retain their IDs and derive globally unique outputs as `c:step:<stepId>:<created-output-ordinal>` so replay publishes the same lineage.
30. Webview build assets must use bundle-relative URLs and the webview CSP must allow their exact origin. In particular, the packaged Codicon font must resolve beside `webview.css` and `font-src` must allow `webview.cspSource`; an absolute `/codicon.ttf` URL or blocked font is a release-blocking visual defect. Browser baselines must exercise the actual production CSS and font asset.
31. The private row-identity namespace is case-insensitively unreachable from every public operation, including legacy string-based column parameters and aggregation aliases. Pandas must recognize its sentinel under flat and MultiIndex columns; DuckDB must reject schemas whose identifiers differ only by case before they can target the wrong stable column. Binding rejects explicit drop-all and the post-transform guard rejects dynamically empty encoders or custom code; immutable zero-column sources remain valid where an engine supports them. A webview may hold only one draft: every add-operation and edit-latest entry point stays disabled until apply/discard, the no-argument Add Cleaning Step command opens the generic operation picker, and a new draft diff uses the immediately previous committed schema while a replacement uses the recorded latest-step input schema.
32. Every schema crossing the host/webview or runtime boundary has non-empty, unique column IDs and positions exactly `0..n-1`. This applies independently to active, latest-step-input, and applied-step inspection schemas; malformed kernel/runtime responses fail before entering session or UI state.
33. Every live grid page is a required two-dimensional window. Open, page, preview, inspection, apply, discard, and undo requests carry bounded row and column ranges; each response carries the exact ordered stable column IDs aligned with every row value vector. Cache identity includes the resolved projection. Pandas projects by position, lazy Polars projects before collection, and DuckDB uses an explicit terminal select while still fetching the private row ID. Full-schema ARIA coordinates, filters, sorts, generated code, and exports remain independent of the transported projection. Saved notebook snapshots stay full-width because they have no live session for missing blocks; legacy MIME-v2 pages without `columnIds` migrate only after an exact schema-width check.
34. The public dependency-install command accepts no confirmation state and always shows a modal naming the exact requirements and interpreter; only its literal affirmative action may run pip. The `OPEN_WRANGLER_EXTENSION_TESTS=1` activation API exposes only a deterministic decline—there is no modal-free affirmative path or sticky production override. `openWrangler.pythonPath` changes and later successful probes invalidate stale install targets, while a decline preserves the current retryable diagnostic.
35. After trust and active-code prerequisites pass, the public Python-script export command accepts no destination argument and always uses VS Code's Save dialog. Only the environment-gated test API may supply a deterministic destination, and it must call the same source guard and writer. The coordinator pins the immutable open-request source instead of trusting runtime-returned source metadata. Script exports accept only the current local host or matching VS Code remote authority, protect every retained source URI/path through normalized, canonical, and usable filesystem-identity checks, reserve an exclusive sibling temp, flush and close it, revalidate that temp's type/identity plus the source, destination, parent mapping, and remote authority immediately before one atomic rename, and clean only that still-identified temp on failure. Never truncate, unlink, follow, or replace the active source or a destination symlink.
36. On Linux, native VS Code/Cursor acceptance defaults to the zero-window headless Ozone platform with desktop display and editor-IPC variables removed; login-shell environment resolution, updates, telemetry, crash reporting, and persistent secret storage are disabled; and runtime, home, config, cache, and data directories are private. It must never silently fall back to the current desktop or touch normal editor profiles. Cursor requires a functioning session-bus address for GTK initialization even in headless Ozone, so retain that address while removing keyring, SSH-agent, desktop-session, and editor-IPC routes. A visible, potentially focus-stealing run requires the explicit `OPEN_WRANGLER_EDITOR_DISPLAY=current` debug opt-in; `OPEN_WRANGLER_EDITOR_DISPLAY=xvfb` is an explicit compatibility fallback and must remain isolated.
37. Every live notebook launch owns the exact open `NotebookDocument` captured at command or renderer-message receipt; renderer actions additionally require the exact visible sender `NotebookEditor`. Never recover origin from `activeNotebookEditor` after an await, a URI match, or another split. Retain document identity through coordinator state, Jupyter activation, kernel lookup, bootstrap, dispatch, response publication, recovery, and generated-code insertion. Each dispatched session ID stays mapped to its exact kernel so a malformed, cancelled, timed-out, stale, or mis-correlated open can make one bounded direct cleanup attempt even after lifecycle invalidation. Terminal close may use that mapped kernel but must never reacquire by URI against a replacement document. Generated-code insertion must repeat its exact-object/version/uniqueness preflight immediately before dispatch and report success only after that same document contains the uniquely marked cell. Because the stable VS Code notebook-edit API is URI-addressed, an accepted edit that cannot be proven against the original object is indeterminate and must never be retried, rolled back, or reported as successful; a stale pre-dispatch origin fails without editing a replacement.

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
