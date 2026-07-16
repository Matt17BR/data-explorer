# Feature parity matrix

Baseline: Microsoft Data Wrangler 1.24.2, observed and documented on 2026-07-15. This is a clean-room behavior matrix, not an implementation reference.

Status values: **Done** has automated and editor acceptance evidence; **Partial** is usable but incomplete; **Planned** is not release-ready. Open Wrangler 1.0 requires every in-scope row to be **Done**.

| Surface                                             | Pandas | Polars | Status | Required evidence                                 |
| --------------------------------------------------- | -----: | -----: | ------ | ------------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes |    Yes | Done   | Format/options/errors and packaged editors green  |
| Notebook variable viewer and toolbar                |    Yes |    Yes | Done   | Real kernel plus packaged stable-API matrix green |
| Inline notebook renderer and full-view expansion    |    Yes |    Yes | Done   | MIME v2 renderer, expansion, packaged green       |
| Virtual grid, column sizing, navigation             |    Yes |    Yes | Done   | Browser perf/a11y plus packaged paging green      |
| Dataset summary and quick insights                  |    Yes |    Yes | Done   | Typed profiles/stats plus packaged queries green  |
| Basic and advanced viewing filters                  |    Yes |    Yes | Done   | AND/OR engine, browser, and packaged green        |
| Multi-column viewing sorts                          |    Yes |    Yes | Done   | Stable null-order engine and packaged green       |
| Editing mode and operation catalog                  |    Yes |    Yes | Done   | Full registry plus packaged group matrix green    |
| Draft preview and data diff                         |    Yes |    Yes | Done   | Typed/identity diff and packaged previews green   |
| Cleaning-step history, edit, discard, undo          |    Yes |    Yes | Done   | Runtime, reload, keyboard, packaged green         |
| Generated code preview and editing                  |    Yes |    Yes | Done   | Native code plus edited packaged exports green    |
| Sort/filter cleaning steps                          |    Yes |    Yes | Done   | Native/code edges plus packaged preview/apply     |
| Select/drop/rename/clone/cast/formula/length        |    Yes |    Yes | Done   | Native/code matrix plus packaged preview/apply    |
| Missing/duplicate row operations                    |    Yes |    Yes | Done   | Null/NaN, keep modes, generated-code parity       |
| One-hot and multi-label binarization                |    Yes |    Yes | Done   | Null/blank/collision and generated-code parity    |
| Find/replace/strip/split/case transforms            |    Yes |    Yes | Done   | Unicode/null plus packaged text preview/apply     |
| Scale/round/floor/ceiling/datetime format           |    Yes |    Yes | Done   | Numeric edges plus packaged preview/apply         |
| Group and aggregate                                 |    Yes |    Yes | Done   | Nullable order plus packaged preview/apply        |
| Custom engine-native code                           |    Yes |    Yes | Done   | Trust, diagnostics, packaged crash/replay green   |
| String/datetime/new-column by example               |    Yes |    Yes | Done   | Candidate matrix plus packaged confirmation       |
| Copy/script/notebook code export                    |    Yes |    Yes | Done   | Edited clipboard/script/notebook packaged green   |
| CSV and Parquet data export                         |    Yes |    Yes | Done   | Cross-engine atomic and packaged exports green    |
| Runtime selection, setup, change, clear             |    Yes |    Yes | Done   | Resolver plus packaged missing/decline flow green |
| Original icons, native views, themes, accessibility |    N/A |    N/A | Done   | Packaged VS Code/Cursor visual matrix green       |
| Runtime crash/reload/session replay                 |    Yes |    Yes | Done   | Packaged injected recovery/replay green           |

## Recorded acceptance evidence

Viewing slice, 2026-07-15:

- `npm test`: 9 TypeScript and 16 Python tests passed. The Polars file test asserts a lazy source and fails if `to_pandas()` is called.
- `npm run test:extension-host` passed against local VS Code 1.128.0, activating the extension, verifying commands/views/settings, and opening `fixtures/sample.csv` through the real custom-editor contribution.
- The allowlisted prerelease VSIX installed successfully into isolated VS Code 1.128.0 and Cursor 3.11.19 profiles.
- The in-app browser exercised the built webview at 800px: drawer open/close, advanced OR selection, value-free null predicates, settled progressive requests, keyboard cell navigation, and column search/focus restoration.
- The 1,000 by 40 wide harness retained 7 rendered data columns and 39 rendered rows while exposing the full 41-column/1,001-row accessible grid counts. It jumped to column 39 and fetched rows 201–400 without unbounding the DOM.
- Approved browser baselines are checked into `docs/images/acceptance/` for light, dark, high contrast, 800/1280/1920px widths, and 80/100/150/200% zoom. `docs/images/wide-grid.png` records the wide-grid fixture.

This evidence advances viewing rows to **Partial**, not **Done**. Full interactive Cursor acceptance, malformed/type-edge fixtures, automated accessibility scans, and performance gates are still mandatory.

Editing engine slice, 2026-07-15:

- `npm test`: 9 TypeScript and 27 Python tests passed. Eleven parameterized operation tests cover the complete 27-operation registry across Pandas and Polars.
- Representative multi-step plans compile to standalone engine-native code and execute to the same semantic output as the runtime adapters.
- Polars transformation tests replace `DataFrame.to_pandas()` with a hard failure. No operation or generated Polars plan crosses through Pandas.

This evidence advances the operation rows to **Partial**. Editor controls, exhaustive typed-edge fixtures, workspace-trust enforcement for custom code, and real-editor acceptance remain mandatory.

Editing session slice, 2026-07-15:

- `npm test`: 9 TypeScript and 34 Python tests passed. Both engines cover preview, typed page diff, apply, latest-step edit, discard, stale-revision rejection, undo replay, immutable source protection, and viewing-mode rejection.
- Protocol v2 now validates transform steps and carries applied steps, an optional draft, preview diffs, generated code, and plan mutation responses.
- The extension coordinator maintains distinct public/runtime revisions and replays applied steps, the active draft, and the viewing query after runtime replacement.

This evidence advances draft/history rows to **Partial**. Stable identities through structural operations, UI shortcuts, persisted-plan reload, failure-injected editor recovery, and real-editor acceptance remain mandatory.

Editing UI slice, 2026-07-15:

- `npm test`: 13 TypeScript and 36 Python tests passed. React tests verify all 26 catalog entries, validated form output, explicit conversion of viewing filters into a cleaning step, and structural-step editing against its original input schema.
- `npm run test:extension-host` passed against local VS Code 1.128.0 with the new operation/apply/discard/edit/undo commands registered and the real custom editor opened.
- The in-app browser verified the complete accessible operation dialog and editable generated-code textbox. Automated captures record the operation dialog, draft grid/diff/code layout, and VS Code-token CodeMirror highlighting in `docs/images/acceptance/`.
- Custom-code preview requests are rejected by the extension host when Workspace Trust is absent. CodeMirror is shipped as a dedicated bottom-panel bundle; Monaco is not included.

This evidence keeps editing rows **Partial**. Stable structural identities, packaged reload acceptance, exhaustive operation-edge UI tests, packaged VS Code/Cursor interaction, and keyboard shortcut coverage remain mandatory.

Persistence slice, 2026-07-15:

- `npm test`: 16 TypeScript and 36 Python tests passed. Persistence tests cover stable source/import keys, replayable-state round trips, and rejection of malformed or unknown saved operations.
- Applied steps, the optional draft, and the independent viewing query are stored in workspace state and replayed through the validated runtime protocol when a source is reopened.
- `npm run test:extension-host` remained green on VS Code 1.128.0 after enabling workspace-state restoration.

This advances reload replay but keeps the row **Partial** until a failure-injected packaged-editor test applies a plan, reloads VS Code and Cursor, and verifies the reconstructed grid and cleanup behavior.

Export slice, 2026-07-15:

- `npm test`: 16 TypeScript and 43 Python tests passed. Both engines export committed plans to CSV and Parquet; Polars export fails the test if `to_pandas()` is called.
- Runtime tests prove view-only filters do not enter exported data, pending drafts and source overwrite are rejected, successful writes replace an existing destination, and failed writes preserve it while removing temporary files.
- Protocol v2 carries revision-checked export requests and typed completion responses. VS Code commands copy the editable code buffer, save a Python script, and prompt for an explicit cleaned-data destination under Workspace Trust.

This advances export rows to **Partial**. Notebook insertion, command-dialog integration tests, dependency diagnostics for Pandas-to-Parquet export, and packaged VS Code/Cursor interaction remain mandatory.

By-example slice, 2026-07-15:

- `npm test`: 17 TypeScript and 57 Python tests passed. Candidate fixtures cover slicing, splitting, concatenation with literals, regex extraction/replacement, lower/upper/capitalize, datetime parse/format, constants, and column arithmetic.
- The synthesizer ranks by deterministic complexity and canonical program order, rejects inconsistent examples, revalidates persisted programs, and reports equally simple matches as draft warnings.
- Pandas and Polars execute and compile the same selected AST natively. Cross-engine tests cover string synthesis, datetime formatting, arithmetic, session preview/apply, and a hard Polars-to-Pandas prohibition.
- The operation builder validates example JSON before dispatch; protocol-normalized steps persist the selected program so reload does not reselect a different candidate.

This advances by-example to **Partial**. More compound programs, null/type-edge inference, editable example-row capture from the real grid, keyboard acceptance, and packaged editor testing remain mandatory.

Notebook MIME and insertion slice, 2026-07-15:

- `npm test`: 20 TypeScript and 62 Python tests passed. Pandas/Polars helpers emit complete MIME v2 snapshots and remain engine-native.
- Shared TypeScript normalization validates MIME v2 into a read-only current session shape and rejects malformed or unknown-version payloads. The renderer presents invalid output as an accessible error.
- Formatters are registered inside the active kernel only after trusted stable-API access. Live-variable sources retain their originating notebook URI.
- The insertion command uses the currently edited CodeMirror buffer and a tagged Python cell. The real VS Code extension-host suite applies and verifies the notebook edit against an untitled Jupyter notebook.

This advances notebook rows to **Partial**. Real local/remote kernel formatter display, permission denial, kernel restart, saved v2 output in packaged VS Code/Cursor, and originating-notebook interaction remain mandatory.

Interface documentation and navigation slice, 2026-07-15:

- `docs/reference.md` is generated from the package command/settings/MIME contributions, Python operation IR registry, and canonical protocol schema. `npm run reference:check` reproduces it in memory and fails on byte-level drift as part of every strict check and package build.
- The extension contributes a native Getting Started walkthrough plus Open Source File and Open Getting Started commands. The extension-host suite verifies all 21 public commands and the walkthrough contribution against a real VS Code host.
- `npm run check`, all 20 TypeScript and 62 Python tests, the VS Code 1.128 extension-host suite, production build, and 51-entry VSIX allowlist verification passed.

This closes public-interface documentation drift and command-surface gaps, but does not advance feature rows to **Done** without the remaining packaged cross-editor acceptance.

Identity and structural-diff slice, 2026-07-15:

- Both engines attach private session row identities and preserve them through filters, sorts, projections, row deletion, and value transformations. Group/custom results receive a new identity generation; no identity enters user schema, profiling, duplicate counts, custom-code input, generated code, or CSV/Parquet exports.
- Column lineage is independent of names and positions. Automated tests cover rename, reorder, deletion, latest-step replacement, group keys/aggregates, and duplicate Pandas labels with deterministic IDs.
- Page diffs now join rows and columns by identity, so a sort is no longer reported as changed cells and a rename is no longer reported as a remove/add pair. Group replacements report the old and new row sets explicitly.
- All 20 TypeScript and 69 Python tests pass, including native Pandas/Polars lineage fixtures and the hard Polars-to-Pandas prohibition. Pandas viewing additionally covers duplicate and non-string labels; the 52-entry production VSIX passes the package allowlist.

This advances structural diff and typed-edge evidence but keeps the rows **Partial** until identifier-based operation parameters, packaged editor interaction, and the remaining nested/type matrix are green.

Jupyter recovery slice, 2026-07-15:

- A real local IPykernel test bootstraps the bundled agent, registers automatic MIME v2 formatters, renders live Pandas and Polars dataframes, opens both engines through protocol v2, restarts the kernel, bootstraps again, and receives a valid response after restart.
- The extension kernel lifecycle caches and bootstraps once, performs at most one reacquire/bootstrap retry after execution failure, and never retries acquisition/permission denial or cancellation. Configured timeouts actively cancel kernel execution before recovery.
- All 25 TypeScript and 70 Python tests pass. The lifecycle suite covers success, restart, repeated failure, denial/cancellation, and timeout; the real-kernel test guarantees cleanup in `finally`, and the 53-entry production VSIX passes its allowlist.

This advances notebook recovery and formatter evidence but keeps the notebook rows **Partial** until remote kernels and packaged VS Code/Cursor permission, restart, saved-output, and originating-notebook interaction are recorded.

Packaged editor slice, 2026-07-15:

- The 53-entry allowlisted VSIX installed into fresh VS Code 1.128.0 and Cursor 3.11.19 user/extension directories. Tests ran from a separate harness extension, ensuring no TypeScript checkout or development extension shadowed the packaged extension.
- Both editors activated the package, verified its publisher/gallery and Activity Bar assets, all 21 commands, Getting Started walkthrough, and MIME v2 contribution. Each opened the CSV custom editor, completed a real Polars runtime session through the packaged Python source, reopened the exact source URI, and applied a real notebook cell edit.
- This stronger test exposed and fixed the custom-editor path failing to enable webview scripts; previous tab-only extension-host acceptance could not detect that the runtime session never opened. Open Source File now also waits briefly for an in-flight active session instead of blocking on a notification.
- Linux CI now installs and exercises the VSIX against current VS Code after allowlist verification. Local release acceptance auto-detects and repeats the package test in Cursor without touching normal profiles.

This advances cross-editor/package evidence but keeps UI rows **Partial** until the full operation/export/reload/theme interaction checklist and screenshots are recorded from both packaged editors.

Visual and accessibility hardening slice, 2026-07-15:

- `npm run test:webview-acceptance` renders the production editor, notebook renderer, and Code Preview bundles into 22 Playwright-readable harnesses. It compares actual screenshots against checked-in baselines with an anti-aliasing-tolerant 1% pixel-delta gate and never mutates baselines during verification.
- Automated axe runs cover WCAG 2.0, 2.1, and 2.2 A/AA rules across dark, light, high-contrast dark/light, 800/1280/1920px widths, 80/100/150/200% zoom, operation/draft/by-example states, and explicit empty/loading/error/recovery/Unicode fixtures. Every non-minor violation is a CI failure.
- Scan findings produced product fixes: column menus and resizers now remain 24px targets at 80% zoom, resizers support Arrow/Home/End keys, generated-code overflow is keyboard focusable, empty grids announce `No rows`, and status/error regions use live semantics. Light-theme type labels now meet contrast requirements.

This advances theme and accessibility evidence but keeps the row **Partial** until the same core theme/zoom checklist is recorded in packaged VS Code and Cursor.

Performance hardening slice, 2026-07-15:

- On the reference Linux workstation, `npm run benchmark:runtime` returned the first complete 100k×50 CSV grid in 309.326ms and the first 1M×20 Parquet grid in 2,189.545ms, below the 3s/5s release limits. The source and every block remained native lazy Polars.
- Cached runtime page p95 was 66.800ms for CSV and 72.630ms for Parquet; distributed uncached page p95 was 68.077ms and 73.578ms, below the 100ms/500ms gates. Every close left zero retained `SessionManager` entries.
- Playwright measured the production 1,000×40 virtual grid independently at 31.6ms cached-scroll p95 and 92.8ms uncached-block p95. A smoke fixture runs in the normal Python suite, while a scheduled strict workflow uploads full-size JSON reports.

This advances the virtual-grid and recovery rows but keeps them **Partial** until packaged-editor reload/multi-session disposal and the remaining editor checklist are recorded.

Data-format and typed-edge hardening slice, 2026-07-15:

- Parameterized Pandas/Polars acceptance opens quoted/delimited CSV, headerless CSV, TSV, JSONL, Parquet, and named or zero-based Excel sheets. Pandas also retains its Latin-1 fixture; Polars CSV, TSV, JSONL, and Parquet sources are asserted to remain lazy.
- Nested Polars Parquet coverage now includes unsigned 64-bit integers, decimal, time-zone datetime, list, struct, binary, categorical, duration, null, NaN, infinity, and a 20,000-character Unicode value while making `to_pandas()` fail. Container dtypes are classified by their outer type, and nested profiling remains available.
- NumPy/Pandas scalar tests prove large integers, nullable integers/booleans, `pd.NA`, `pd.NaT`, timezone timestamps, NaN, and infinity produce typed, strict-JSON-safe cells. Pandas frames with rows but zero visible columns and fully empty Polars frames remain schema-, summary-, and page-safe.
- Missing and malformed file opens now produce structured engine diagnostics for eager and lazy readers without retaining a session. Polars Excel correctly translates the public zero-based sheet index to the reader's one-based ID.

This completes automated format and source-type edge evidence but keeps entry-point and summary rows **Partial** until the packaged-editor fixture checklist and interactive import/error states are recorded in VS Code and Cursor.

Operation-edge hardening slice, 2026-07-15:

- Pandas and Polars runtime results and executable generated functions agree on stable multi-sort with independent null placement per column, `dropMissingRows` any/all semantics, `dropDuplicates` last/none modes, and finite-only min-max scaling. Round, floor, and ceiling preserve infinities without Pandas overflow.
- One-hot encoding ignores null categories in both engines. Multi-label encoding ignores null/blank labels and emits no empty-name column. Both operations reject existing/generated output-name collisions before returning a dataframe; Polars remains native throughout.
- Grouping preserves source encounter order. Polars nullable `nUnique`, `first`, and `last` now match Pandas, while duplicate aliases or aliases replacing a group key fail IR validation.
- Unicode casing uses one deterministic mapping across engines (`ß`, dotted `İ`, accents), nulls are preserved, and engine exceptions from custom code become structured diagnostics. Expanded IR validation rejects malformed sort/filter, categorical, text, numeric, datetime, and boolean parameters before execution.

This completes the listed automated operation-edge evidence but keeps operation rows **Partial** until identifier-based duplicate-column parameters and the packaged VS Code/Cursor operation checklist are green.

Packaged reload and recovery slice, 2026-07-15:

- The installed 53-entry VSIX passed a two-process seed/verify acceptance in isolated VS Code 1.128.0 and Cursor 3.11.19 profiles. The seed process applied a real Polars formula step, committed an independent descending viewing sort, closed the session, verified the Python runtime stopped, and reopened the source once before process exit.
- A fresh editor process reopened the same URI from workspace state and verified the step, sort, transformed schema, first row, and generated value. It then opened a concurrent Pandas TSV session, switched active-session ownership, injected a standalone runtime restart, and fetched both sessions concurrently.
- Recovery started exactly one replacement Python process, assigned both sessions new runtime IDs, replayed the Polars plan/view and Pandas source, and preserved both public session identities. A real CSV export matched the committed plan while the original fixture remained byte-for-byte unchanged.
- Both sessions were explicitly closed; acceptance waited for zero coordinator sessions and a stopped runtime. Runtime startup is single-flight across concurrent requests, stale starts are invalidated by a restart epoch, and the final session releases the standalone process.
- The extension-host acceptance also performs the seed/verify split with shared isolated VS Code state. Test controls are returned by activation only when `OPEN_WRANGLER_EXTENSION_TESTS=1`; production activation exposes no recovery or diagnostics surface.

This makes runtime crash/reload/session replay **Done**. Cleaning-history, export, and editor rows remain **Partial** because their remaining keyboard, Parquet-command, and full interactive operation/theme checklists are tracked separately.

Release-guardrail slice, 2026-07-15:

- Required CI coverage now enforces TypeScript/webview floors of 60% statements, 55% branches, 60% functions, and 65% lines plus a 78% Python-runtime floor. The initial accepted reports are 63.36/59.28/66.12/67.94% and 80.37%, respectively, and CI uploads their HTML/JSON/XML artifacts.
- A production dependency policy resolves the actual installed manifest for every non-development package, accepts only explicitly approved licenses, and requires a matching notice group. The current webview bundle contains 17 MIT packages and one CC-BY-4.0 Codicons package; the notice file now reflects Codicons' actual license.
- Pull-request validation retains npm and Python vulnerability audits. Main pushes and tag builds package and verify on Linux/Python 3.10, macOS/Python 3.12, and Windows/Python 3.14; the release artifact job is blocked on that matrix.
- Screenshot capture now resolves the hosted CI interpreter before a local `.venv`, fixing the first full validate run's only failure while keeping local deterministic-environment preference.

These are release guardrails rather than user-visible parity rows. They remain mandatory for every subsequent slice and release tag.

Cleaning-history keyboard slice, 2026-07-15:

- Editing sessions expose state-scoped shortcuts for apply (`Ctrl/Cmd+Enter`), discard (`Escape`), edit latest (`Ctrl/Cmd+Shift+E`), and undo latest (`Ctrl/Cmd+Alt+Z`). VS Code context keys enable them only for an active Open Wrangler custom editor with the matching draft/history state.
- The production webview handles the same keys when focus remains inside its sandbox. It does not steal undo/edit shortcuts from inputs, textareas, selects, or editable code; buttons publish `aria-keyshortcuts` and visible hover titles.
- React interaction tests cover all four actions and editable-field isolation. Playwright loads the production draft bundle, triggers every shortcut by keyboard, validates the emitted protocol request, opens the latest-step editor, and closes it with Escape while the normal 22-harness axe/pixel/performance matrix remains green.
- The generated public reference includes the keybinding table. Real extension-host and installed-VSIX acceptance verify the exact VS Code/Cursor keybinding contributions, stateful history replay, and final cleanup.

This makes cleaning-step history/edit/discard/undo **Done**. The wider editing-mode row remains **Partial** until its complete packaged operation interaction checklist is green.

Packaged file and data-export slice, 2026-07-15:

- The installed VSIX custom editor now opens CSV, TSV, JSONL, Parquet, and XLSX in both isolated VS Code 1.128.0 and Cursor 3.11.19 runs. Acceptance pins TSV to Pandas and JSONL/Parquet/Excel to Polars, verifies exact shapes/backends through the active coordinator, closes every editor, and waits for zero sessions and a stopped runtime before continuing.
- The packaged test environment creates Parquet and a named Excel sheet through independent libraries, so those readers exercise real typed files rather than renamed or mocked payloads. The runtime suite separately covers both engines, CSV delimiter/quote/header/encoding variants, Excel name and zero-based index selection, malformed/missing inputs, lazy Polars formats, and typed edge data.
- After an injected runtime restart, both the transformed Polars session and concurrent Pandas session export CSV and Parquet. Acceptance verifies response shapes, CSV schemas, Parquet `PAR1` framing, and byte-identical CSV/TSV source fixtures. Unit/runtime coverage continues to enforce view-filter exclusion, draft/source-path rejection, atomic replacement, failure cleanup, and no Polars-to-Pandas conversion.
- The same expanded matrix passes development-host, installed-VSIX, reload/replay, and cleanup paths; temporary generated inputs and outputs are removed from isolated test directories.

This makes file entry points and CSV/Parquet data export **Done**. Code/notebook export remains a separate **Partial** row until its remaining real-kernel command interactions are green.

Packaged operation-group slice, 2026-07-15:

- The extension-host and installed-VSIX suites open independent Pandas and Polars editing sessions and run representative row/order, column/formula, text, numeric, by-example, custom-code, and group/aggregation steps. Every step must complete draft preview, typed page diff, engine-native generated-code inspection, and explicit apply before the next step begins.
- The complete 27-operation registry remains covered by parameterized native-runtime and executable generated-code tests for both engines. Operation-edge fixtures add null/NaN, stable sort, duplicate keep modes, categorical collisions, Unicode, non-finite numbers, nullable aggregation, invalid parameters, and structured custom-code failures; Polars fails immediately on any `to_pandas()` path.
- The packaged by-example draft resolves and persists a deterministic uppercase program before confirmation. The broader automated candidate matrix covers slicing, splitting, concatenation, literals, regex extraction/replacement, casing, datetime parsing/formatting, and simple arithmetic, including ambiguity and failure diagnostics.
- Both engine sessions force a standalone runtime restart immediately after applying custom code, then fetch the replayed plan before grouping. The final schema and seven-step history are asserted, source CSV bytes remain unchanged, and close waits for zero coordinator sessions and no Python process.
- This matrix passes the development host plus the exact allowlisted VSIX in isolated VS Code 1.128.0 and Cursor 3.11.19 profiles. The production-bundle browser suite separately exercises the complete operation dialog, validated forms, draft/diff/code layout, by-example warnings, and apply/discard/edit/undo keyboard paths.

This makes the editing catalog, draft/diff, every deterministic operation family, custom code, and by-example rows **Done**. Generated-code editing/export remains a separate **Partial** row until its clipboard/script/originating-notebook command matrix is fully recorded.

Packaged viewing-query slice, 2026-07-15:

- Independent Pandas and Polars viewing sessions run an advanced OR predicate across string and numeric columns followed by a two-column sort. The installed VSIX must return the same two typed rows in the same order, retain the exact view model, and keep the cleaning plan empty.
- Both engines resolve filtered column summaries, numeric profile bounds, exact missing/duplicate dataset counts, and searched distinct values through protocol v2. The source remains byte-identical and every session close waits for the standalone runtime to stop.
- The same matrix passes the development extension host and the exact package in isolated VS Code 1.128.0 and Cursor 3.11.19. Native engine fixtures separately cover AND/OR, null/NaN predicates, value filters, per-column null ordering, stable ties, typed/nested summaries, and lazy Polars query pushdown.
- The production-bundle Playwright gate covers row and column virtualization, bounded prefetch, column search, keyboard navigation/resizing, focus restoration, advanced-filter interaction, responsive layouts, all supported themes/zooms, and WCAG scans. Its wide-grid p95 is 31.6ms cached and 92.8ms uncached, below the 100ms/500ms limits; release-size runtime gates are also green.

This makes virtual grid/navigation, summaries/Quick Insights, viewing filters, and multi-column viewing sorts **Done**. Import error-state interaction and editor chrome/theme sign-off remain tracked under their separate rows.

Editable code and runtime-selection slice, 2026-07-15:

- After every packaged Pandas and Polars representative plan, acceptance replaces the Code Preview buffer with an identifiable edit, invokes the real Copy Code command, reads the editor clipboard, invokes Export Python Script with an isolated destination, and verifies both outputs byte-for-byte. The production CodeMirror bundle separately covers editing, syntax highlighting, overflow/focus behavior, and VS Code tokens under the visual/axe matrix.
- Successful copy/export notifications no longer block command completion while awaiting toast dismissal; clipboard and file writes remain awaited. The generated function before editing is still executed against both engines and compared with the native adapter result, with Polars conversion prohibited.
- Runtime acceptance invokes Change Runtime with an executable wrapper around the same supported interpreter but isolated from site packages. A Polars open returns the structured `missing_dependencies` diagnostic before process startup, points to the explicit install command, and retains no session.
- The Install Runtime Dependencies command receives an explicit decline and returns without running pip, changing configuration, or starting a process. Clear Runtime removes the workspace override and reveals the configured fallback. Resolver tests cover relative/absolute paths, the exact Python 3.10–3.14 range, and engine/format-specific modules; normal resolution still prefers explicit configuration, then the Python extension, then system interpreters.
- These command paths pass the development host and the rebuilt allowlisted VSIX in isolated VS Code 1.128.0 and Cursor 3.11.19. All temporary scripts and exported code are removed with the editor profile.

This makes generated-code preview/editing and runtime selection/setup/change/clear **Done**. The combined code-export row remains **Partial** only for its originating-notebook command path.

Packaged notebook and remote-kernel slice, 2026-07-15:

- Kernel bootstrap no longer inserts the local extension path. The extension validates and encodes only the packaged `openwrangler_runtime` sources, transfers them over `executeCode`, writes them beneath a content-addressed kernel-temporary directory, and imports the agent there. Unit tests reject incomplete/path-unsafe bundles and prove generated bootstrap code contains no local extension path.
- A stable-Jupyter-API acceptance extension runs a persistent Python namespace with an explicitly empty `PYTHONPATH`, creating a remote-filesystem boundary while retaining real Pandas and Polars dependencies. The installed Open Wrangler package transfers its own runtime, opens live variables for both engines, resolves typed pages, and never converts Polars to Pandas.
- A real local IPykernel test independently registers automatic Pandas/Polars MIME v2 formatters, renders both types, transports protocol v2 sessions, restarts the kernel, and bootstraps again. Lifecycle tests cover permission/acquisition denial, user cancellation, timeout cancellation, one-shot reacquisition, and repeated failure.
- The packaged VS Code 1.128.0 and Cursor 3.11.19 flows open a real `.ipynb` containing saved MIME v2 output, verify that item survives deserialization, apply a Pandas notebook step, and invoke Insert Generated Code. The inserted tagged cell contains the edited CodeMirror buffer exactly and targets the originating notebook.
- The acceptance kernel object is then replaced while a Polars variable session is active. The first request rejects on the stale object, the stable API is reacquired, the transferred runtime is bootstrapped again, the unknown session is replayed from the still-live variable, and the original public session returns the expected page. A separate denied-access attempt creates no coordinator session.
- The production renderer/axe harness renders MIME v2 and clicks **Open in Open Wrangler**, asserting the full-view message contains the validated payload. Malformed versions remain accessible errors. This entire matrix runs from the allowlisted VSIX in isolated editor profiles.

This makes notebook variable launch, inline v2 rendering and full-view expansion, and clipboard/script/originating-notebook code export **Done**.

Open Wrangler rename and packaged-editor visual acceptance refresh, 2026-07-16:

- The renamed `matt17br.openwrangler@0.2.0-alpha.2` VSIX contains 55 allowlisted entries and has SHA-256 `24095102798b47b2ed5017fd8e143caf4d0baa3817b85cc70121221c34d501b9`. It is installed into disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. Playwright connects to each isolated Electron workbench, opens the packaged custom editor and Open Wrangler Activity Bar container, and captures the real workbench below the native test-host title strip rather than reconstructing it in a browser shell.
- Both editors record dark and light themes at normal zoom plus a high-contrast theme at VS Code zoom level 4 (approximately 200%). The harness temporarily disables OS theme auto-detection, waits for the public active-theme kind to change, captures the workbench, and restores every setting. Cursor's isolated first-run login overlay is bypassed with its documented `--skip-onboarding` test-process flag; no normal editor profile is read or changed.
- The six checked-in captures under `docs/images/editor-acceptance/` visibly include the original faceted-table Activity Bar mark, native Operations, Summary, Filters/Sorts, and Cleaning Steps views, the custom grid, and the Code Preview panel. Extension-host assertions independently verify that the 128/256px gallery PNG and monochrome `currentColor` SVG are present in the installed package.
- The production-bundle matrix remains the exhaustive UI gate: 22 Playwright/axe harnesses cover dark, light, high-contrast dark/light, 800/1280/1920px widths, 80–200% zoom, interaction/state fixtures, keyboard paths, and WCAG 2.0/2.1/2.2 A/AA rules. The editor screenshots prove those token-driven surfaces integrate into both real workbench chromes.

- The packaged runtime-selection path exercises the canonical `openWrangler.pythonPath` setting, dependency diagnostics, explicit install decline, override clearing, and resolver fallback without mutating an environment.

This makes original icons, native views, themes, and accessibility **Done**. Every in-scope row in the Open Wrangler 1.0 clean-room parity matrix is now **Done**; `1.0.0` remains gated on the release workflow and cross-platform tag validation rather than an unfinished feature row.

Final release-gate correction slice, 2026-07-15:

- Focused snapshot-model and filter/summary interaction tests raised TypeScript/webview coverage to 69.70% statements, 68.15% branches, 71.90% functions, and 72.61% lines; Python remains at 80.37%. The combined suite now contains 51 TypeScript and 113 Python tests.
- Those tests exposed and fixed saved-notebook snapshot semantics: null numeric cells no longer compare as zero, and multi-column sorts honor the requested null placement independently of ascending/descending direction.
- Visual and axe acceptance now use the Chromium revision pinned by `playwright-core` and the lockfile. CI installs that exact browser instead of inheriting a moving system Chrome, retaining the 1% visual threshold while eliminating browser-version drift.
- The rebuilt allowlisted VSIX passed the complete installed-package suite and real theme captures in VS Code 1.128.1 and Cursor 3.11.19 after these corrections.

## Explicitly deferred from 1.0

Copilot operations, Spark, DuckDB, non-dataframe tensor/list renderers, telemetry, and vscode.dev runtime support are out of scope. They must not block the 1.0 matrix and must not be represented as supported.
