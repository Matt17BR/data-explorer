# Feature parity matrix

Baseline: Microsoft Data Wrangler 1.24.2, observed and documented on 2026-07-15. This is a clean-room behavior matrix, not an implementation reference.

Status values: **Done** has automated and editor acceptance evidence; **Partial** is usable but incomplete; **Planned** is not release-ready. Open Wrangler 1.0 requires every in-scope row to be **Done**.

The parity contract below remains specifically Pandas and Polars. DuckDB is an additive, experimental file-backed preview documented in its own matrix; its evidence does not retroactively turn a two-engine **Done** row into a three-engine claim or replace either parity engine's release gates.

| Surface                                             | Pandas | Polars | Status  | Required evidence                                    |
| --------------------------------------------------- | -----: | -----: | ------- | ---------------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes |    Yes | Partial | Add packaged `.xls` and malformed-input UI evidence  |
| Notebook variable viewer and toolbar                |    Yes |    Yes | Partial | Test against the released Jupyter extension          |
| Inline notebook renderer and full-view expansion    |    Yes |    Yes | Partial | Route full-view snapshots through active sessions    |
| Virtual grid, column sizing, navigation             |    Yes |    Yes | Partial | Add installed-editor native paint timing             |
| Dataset summary and quick insights                  |    Yes |    Yes | Done    | Typed profiles/stats plus packaged queries green     |
| Basic and advanced viewing filters                  |    Yes |    Yes | Done    | AND/OR engine, browser, and packaged green           |
| Multi-column viewing sorts                          |    Yes |    Yes | Done    | Stable null-order engine and packaged green          |
| Editing mode and operation catalog                  |    Yes |    Yes | Partial | Address duplicate/non-string column operations       |
| Draft preview and data diff                         |    Yes |    Yes | Done    | Typed/identity diff and packaged previews green      |
| Cleaning-step history, edit, discard, undo          |    Yes |    Yes | Done    | Installed selection/diff/clear and shortcuts green   |
| Generated code preview and editing                  |    Yes |    Yes | Done    | Native code plus edited packaged exports green       |
| Sort/filter cleaning steps                          |    Yes |    Yes | Done    | Native/code edges plus packaged preview/apply        |
| Select/drop/rename/clone/cast/formula/length        |    Yes |    Yes | Partial | Finish duplicate/non-string packaged matrix          |
| Missing/duplicate row operations                    |    Yes |    Yes | Done    | Null/NaN, keep modes, generated-code parity          |
| One-hot and multi-label binarization                |    Yes |    Yes | Done    | Null/blank/collision and generated-code parity       |
| Find/replace/strip/split/case transforms            |    Yes |    Yes | Done    | Unicode/null plus packaged text preview/apply        |
| Scale/round/floor/ceiling/datetime format           |    Yes |    Yes | Done    | Numeric edges plus packaged preview/apply            |
| Group and aggregate                                 |    Yes |    Yes | Done    | Nullable order plus packaged preview/apply           |
| Custom engine-native code                           |    Yes |    Yes | Partial | Add installed Restricted Mode acceptance             |
| String/datetime/new-column by example               |    Yes |    Yes | Done    | Candidate matrix plus packaged confirmation          |
| Copy/script/notebook code export                    |    Yes |    Yes | Done    | Edited clipboard/script/notebook packaged green      |
| CSV and Parquet data export                         |    Yes |    Yes | Done    | Cross-engine atomic and packaged exports green       |
| Runtime selection, setup, change, clear             |    Yes |    Yes | Done    | Resolver plus packaged missing/decline flow green    |
| Original icons, native views, themes, accessibility |    N/A |    N/A | Partial | Record packaged UI on every release platform         |
| Runtime crash/reload/session replay                 |    Yes |    Yes | Done    | Packaged injected recovery/replay green              |
| Column-projected grid-block transport               |    Yes |    Yes | Done    | Bounded row/column blocks plus native pushdown green |
| Duplicate/non-string Pandas column operations       |   View |    N/A | Partial | Complete all-operation and packaged-editor matrix    |
| Restricted Mode and trust-gated execution           |    N/A |    N/A | Partial | Separate trusted/untrusted installed-editor runs     |
| Installed-editor first-usable-grid performance      |    Yes |    Yes | Partial | Enforce 100k CSV and 1M Parquet paint timings        |
| Cross-platform VS Code/Cursor package acceptance    |    N/A |    N/A | Partial | Run installed editor/UI gates beyond Linux           |

## DuckDB file-backed preview matrix

DuckDB keeps data as native lazy `DuckDBPyRelation` plans. The preview neither converts through Pandas, Polars, or Arrow nor installs/loads DuckDB extensions automatically. **Partial** below means the native runtime path has automated evidence but the complete installed-editor and release matrix is still pending; **Planned** means the surface is intentionally unavailable in this preview.

| Surface                                      | Availability        | Status  | Recorded evidence                                       | Remaining acceptance gate                                    |
| -------------------------------------------- | ------------------- | ------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| CSV and TSV file sessions                    | Yes                 | Partial | Lazy native reads plus packaged VS Code/Cursor imports  | Malformed/options and cross-platform matrix                  |
| Parquet file sessions                        | Yes                 | Partial | Native typed reads, benchmark, and packaged editors     | Large mixed/nested fixture and cross-platform matrix         |
| JSONL file sessions                          | Yes                 | Partial | Offline native read plus packaged VS Code/Cursor import | Malformed JSONL and import-state interaction                 |
| Excel file sessions                          | No                  | Planned | Explicit diagnostic directs users to Pandas or Polars   | Deferred; no DuckDB Excel claim                              |
| `.duckdb` database/catalog/table browsing    | No                  | Planned | Not registered as a source kind                         | Deferred source/connection/security design                   |
| Notebook variables and inline MIME rendering | No                  | Planned | DuckDB advertises file sources only                     | Deferred kernel ownership, formatter, and recovery design    |
| Grid pages, typed cells, filters, and sorts  | Yes                 | Partial | Native tests plus packaged VS Code/Cursor query matrix  | Large mixed data and cross-platform matrix                   |
| Summaries, statistics, and distinct values   | Yes                 | Partial | Exact profiles plus packaged progressive-query matrix   | Large-data resource and repeated performance evidence        |
| Complete 27-operation catalog                | Yes                 | Partial | All kinds native/generated; packaged group matrix green | Full DuckDB-specific semantic edge matrix                    |
| Draft preview, diff, apply, and history      | Preview/apply slice | Partial | Runtime and packaged preview/diff/apply/replay          | DuckDB edit/discard/undo interaction matrix                  |
| Executable generated DuckDB code             | Yes                 | Partial | All kinds equal; packaged preview/copy/script green     | Edited-code execution acceptance                             |
| CSV and Parquet cleaned-data export          | Yes                 | Partial | Native/atomic packaged exports preserve source bytes    | Failure injection and cross-platform destination matrix      |
| Runtime crash/reload/session replay          | Yes                 | Partial | Backend-keyed two-process replay and injected recovery  | Cross-platform and repeated failure-injection matrix         |
| Runtime performance benchmark                | Diagnostic          | Partial | Opt-in direct/stdio smoke with provenance/resources     | Repeated full-size evidence; it is not a strict release gate |

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

This advances structural diff and typed-edge evidence but keeps the rows **Partial** until identifier-based operation parameters, packaged editor interaction, and the remaining nested/type matrix are green. The later stable-ID structural-operation slice below closes the parameter gap for seven operations; it does not retroactively close the broader duplicate/non-string matrix.

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

- Parameterized Pandas/Polars acceptance opens quoted/delimited CSV, headerless CSV, TSV, JSONL, Parquet, modern `.xlsx`, and a real legacy BIFF `.xls` workbook by name or zero-based sheet index. Pandas also retains its Latin-1 fixture; Polars CSV, TSV, JSONL, and Parquet sources are asserted to remain lazy.
- Nested Polars Parquet coverage now includes unsigned 64-bit integers, decimal, time-zone datetime, list, struct, binary, categorical, duration, null, NaN, infinity, and a 20,000-character Unicode value while making `to_pandas()` fail. Container dtypes are classified by their outer type, and nested profiling remains available.
- NumPy/Pandas scalar tests prove large integers, nullable integers/booleans, `pd.NA`, `pd.NaT`, timezone timestamps, NaN, and infinity produce typed, strict-JSON-safe cells. Pandas frames with rows but zero visible columns and fully empty Polars frames remain schema-, summary-, and page-safe.
- Missing and malformed file opens now produce structured engine diagnostics for eager and lazy readers without retaining a session. Polars Excel correctly translates the public zero-based sheet index to the reader's one-based ID. The runtime and extension agree on format-specific parsers: Pandas `.xlsx` uses `openpyxl>=3.1.5`, Pandas `.xls` uses `xlrd>=2.0.1`, and Polars uses `fastexcel>=0.9` for both.
- Invalid UTF-8 replacement decoding is deterministic: `utf8-lossy` routes automatic sessions directly to Pandas, maps to UTF-8 with replacement error handling, and never probes Polars/DuckDB or reaches Python as a codec literal.

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

This makes the recorded packaged readers and CSV/Parquet data export **Done**. The broader entry-point row remains **Partial** for packaged `.xls` and malformed-input UI evidence; code/notebook export is tracked separately.

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

This completed the then-recorded package/theme checklist. The matrix at the top is authoritative: the later 1.0 audit reopened incomplete behavior and evidence instead of preserving a stale all-green claim.

Final release-gate correction slice, 2026-07-15:

- Focused snapshot-model and filter/summary interaction tests hold TypeScript/webview coverage at 69.55% statements, 67.53% branches, 71.90% functions, and 72.57% lines; Python remains at 80.33%. The canonical-only suite contains 51 TypeScript and 112 Python tests.
- Those tests exposed and fixed saved-notebook snapshot semantics: null numeric cells no longer compare as zero, and multi-column sorts honor the requested null placement independently of ascending/descending direction.
- Visual and axe acceptance now use the Chromium revision pinned by `playwright-core` and the lockfile. CI installs that exact browser instead of inheriting a moving system Chrome, retaining the 1% visual threshold while eliminating browser-version drift.
- The rebuilt allowlisted VSIX passed the complete installed-package suite and real theme captures in VS Code 1.128.1 and Cursor 3.11.19 after these corrections.

Session-owned engine foundation, 2026-07-16:

- The ordered engine registry now creates a fresh Pandas or Polars adapter for every session, closes rejected detection candidates, validates factory/backend identity, and exposes immutable source/edit/lazy/export/interruption capabilities. Wire capabilities remain unchanged for all existing file, viewing, editing, and notebook-variable cases.
- Open responses are fully constructed before registration. Injected reader, schema, initial-page, initial-summary, and metadata failures each close the acquired adapter and leave the session map empty. Explicit close serializes behind in-flight work; concurrent shutdown joins pending opens and disposes every registered session; notebook snapshots enforce source capabilities and distinguish cleanup failure from an earlier rendering failure.
- Extension-host close failures are terminal and never replayed. Deactivation awaits bounded standalone and live-kernel cleanup, rejects work queued after close, closes late runtime opens without registering them, and lets the standalone server drain through stdin/EOF before force-kill fallback.
- `npm run check`, `npm test`, and `npm run test:coverage` pass with 58 TypeScript and 141 Python tests; Python runtime coverage rises to 82.69%. Focused registry, lifecycle, coordinator, process-shutdown, notebook, and server tests cover fresh ownership, diagnostic cleanup, capability gating, concurrent open/shutdown, late opens, transport failure, failed initialization, and unsupported backends.
- The strict runtime benchmark remains within every release ceiling: the 100k × 50 CSV reaches its first grid in 386.969 ms with 99.745 ms cached and 85.225 ms uncached page p95; the 1M × 20 Parquet reaches its first grid in 2,413.689 ms with 75.449 ms cached and 78.477 ms uncached page p95. Both retain zero sessions after close.
- The final 57-entry allowlisted VSIX has SHA-256 `4ac2368972e0f537c5611a59fb81918a177799086d621f6597782a184c9d064b` and passes the complete two-process packaged acceptance in isolated VS Code 1.128.1 and Cursor 3.11.19 profiles.

This strengthens the runtime crash/reload/session replay row without changing protocol v2 or the existing Pandas/Polars feature surface.

Progressive-grid, cache, and response-integrity slice, 2026-07-16:

- File-backed Polars open now returns exact shape, metadata-only schema, and the first typed block without an all-column null scan, eager summaries, or dataset statistics. Visible summaries stream one column at a time; exact dataset counts wait for the insights drawer. Numeric charts sample at most 4,096 deterministic valid values per column while null/NaN, distinct, top-value, and scalar metrics remain exact native aggregations.
- Every page, summary, values query, error, cancellation, and statistics response retains its request correlation. A separate opaque logical-view context protects the React model, retained panel snapshot, Activity Bar metadata, and persistence through A→B→A filters, rapid scrolling, runtime replay, and late background responses. Foreground page/mutation errors cannot be cleared or replaced by unrelated profiling work, and failed blocks expose an explicit same-block retry.
- One read-only page or values query can run beside an immutable background profiling lease. Transformations, exports, and close remain exclusive; waiting writers prevent new profiles from starving them. Queued obsolete profiles are cancelled without claiming to interrupt active Pandas/Polars work, superseded pages are rejected before persistence, replay rejects the former runtime generation and retires its old session, and grace-bounded kernel shutdown keeps a delayed close alive until active work settles.
- Runtime transformations and React foreground transitions now publish transactionally and restore their complete confirmed snapshot after late failures or cancellation. Grid and drawer summary owners release independently on hide, horizontal virtualization, and unmount; queued work is cancelled only after the last owner releases it. Stable schema IDs preserve filter selection through renames, empty-schema actions remain guarded, and scroll-driven page requests preserve roving keyboard focus.
- Both transports now apply strict nested protocol-v2 response validation, and the coordinator additionally requires the response kind, plan action, runtime ID, revision, column/export destination, and logical-view correlation expected by the request. Standalone cancellation waits for an authoritative original response. Jupyter acquisition/bootstrap are single-flight and generation-safe under one end-to-end deadline; only idempotent reads may retry after dispatch. Ambiguous mutations are never reissued, and later work first reconstructs the last confirmed runtime session. Cancelled, mismatched, failed, late-open, candidate, and retired-session cleanup use one bounded diagnostic path without restarting a live shared process on detached-cleanup timeout.
- Lazy-file sessions fingerprint the resolved source identity, size, and nanosecond modification time around every data read. Replacements, truncation, deletion, and schema changes clear the session-local 8-entry/16 MiB block cache and return a recoverable reopen diagnostic; view, draft, plan, and disposal changes also invalidate the cache. Pandas and Polars now expose the same disjoint null/NaN count contract, and alternating null/value data retains a non-empty deterministic histogram.
- Terminal close accepts the caller's last confirmed revision so an ambiguous mutation response cannot strand a newer live runtime session. Live and executable generated Pandas/Polars filters now match saved-output typed null/NaN predicates and value selections exactly, Polars distinct values omit those separately represented sentinels, and Pandas custom code receives recursively isolated object cells so nested source values remain immutable through preview and discard.
- The canonical stdio benchmark now measures real protocol-v2 newline-delimited JSON round trips separately from direct-manager cache timings and proves substantial page/profile overlap against an uncontented cache-miss baseline. On the reference Linux workstation, CSV cold-source first grid/warm reopen is 86.661/46.555ms, direct cached/cache-miss p95 is 0.100/31.625ms, stdio cache-miss p95 is 41.399ms, and the active-profile page is 42.584ms. Parquet is 59.695/43.600ms, 0.103/42.496ms, 46.386ms, and 56.941ms respectively. Both cold-source opens carry accepted per-file eviction evidence; both active-profile intervals were proven from runtime entry/exit events, returned the page before statistics, remained lazy, met every release and slice target, bounded cache weight, and retained zero sessions.
- `npm run check`, 208 TypeScript tests, 227 Python tests, extension-host/reload acceptance, the full strict benchmark, 22 visual/axe harnesses, and wide-grid cached/uncached p95 of 31.5/95.9ms are green. TypeScript coverage is 74.85% statements, 71.57% branches, 82.24% functions, and 77.90% lines; Python runtime coverage is 88.82%.
- The final 60-entry allowlisted `openwrangler.vsix` has SHA-256 `b93a06a9b024e764247c0619c7c5c22b5906bdef4f6a31a6e176dcdd31fe0d67`. That exact artifact passed the complete two-process installed-package matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, including persisted-plan replay, concurrent Pandas/Polars crash recovery, viewing and editing operation groups, code/data/notebook exports, runtime selection diagnostics, icons/native contributions, source safety, and zero retained sessions/processes. The checked-in real workbench dark/light captures were refreshed from those isolated profiles.

This hardens the already-complete viewing, Quick Insights, recovery, and lifecycle rows without broadening the 1.0 engine or operation scope.

Native DuckDB file-backed preview slice, 2026-07-16:

- `.venv/bin/python -m pytest -q python/tests/test_duckdb_engine.py` passed all 5 engine-specific tests. These cover hardened/lazy CSV, TSV, Parquet, and JSONL reads; typed pages; filters/sorts; exact profiles and values; concurrent page/profile reads; native exports and cleanup; all 27 operations; executable generated-code equality; collisions and custom-code failures; and a file-session preview/apply/profile/export/close flow.
- `.venv/bin/python -m pytest -q python/tests/test_duckdb_engine.py python/tests/test_engine_registry.py python/tests/test_engine_lifecycle.py python/tests/test_typed_cells.py python/tests/test_performance_backends.py` passed all 41 focused engine, registry, lifecycle, typed-cell, and benchmark integration tests.
- `.venv/bin/python -m pytest -q python/tests` passed all 236 Python tests in 11.59 seconds after DuckDB registration. Conversion guards fail any DuckDB relation path that calls the Pandas, Polars, or Arrow conversion APIs.
- The opt-in benchmark smoke records the selected backend, package/runtime/machine/source provenance, native and lazy frame types, driver and standalone-process resource samples, direct `SessionManager` calls, and real protocol-v2 stdio boundaries. It explicitly labels those measurements as runtime rather than VS Code, Cursor, webview, or editor first-paint timings.
- Performance strict mode remains defined only for the native Polars path. Pandas and DuckDB reports are diagnostic comparisons, and a non-Polars `--strict` invocation is rejected rather than presented as release-gate evidence.
- `npm run test:extension-host` passes with backend-keyed persisted state for the same CSV: Polars replays its two-times formula and DuckDB independently replays its three-times formula across fresh editor processes. A later injected standalone-runtime restart concurrently reconstructs those two sessions plus Pandas with new internal IDs and one shared process generation.
- The packaged file matrix opens DuckDB CSV, TSV, JSONL, and Parquet sessions through the contributed custom editor. Independent DuckDB viewing acceptance runs typed paging, an advanced OR predicate, multi-column sorting, progressive summaries, exact dataset statistics, and searched distinct values while keeping the cleaning plan empty.
- The packaged editing matrix runs representative row/order, formula, text, numeric, by-example, custom-code, and aggregation steps through preview, typed diff, native generated-code inspection, apply, custom-code crash replay, editable Code Preview copy/script export, and final cleanup. Generated code is rejected if it references Pandas, Polars, PyArrow, or relation conversion APIs.
- DuckDB CSV and Parquet exports succeed after concurrent runtime recovery, preserve the source bytes, exclude private row identity, and leave zero sessions/processes. A dependency-isolated interpreter reports the exact tested requirement `duckdb>=1.4.5,<1.6` before runtime startup, and declining installation performs no mutation.
- The 22 production-bundle pixel baselines and all axe scenarios pass unchanged. TypeScript/webview coverage is 74.43% statements, 71.30% branches, 81.51% functions, and 77.61% lines; Python runtime coverage is 87.53%, including 81% statement coverage in the DuckDB adapter.
- The reproducible DuckDB 1.5.4 smoke on Python 3.14.4 retains native lazy relations and zero sessions. CSV cold stdio open/warm reopen is 43.858/29.966ms, direct cached/cache-miss p95 is 0.058/11.180ms, and stdio cache-miss p95 is 13.284ms. Parquet is 35.960/22.137ms, 0.061/10.082ms, and 12.266ms respectively. These small diagnostic fixtures are not editor-paint or release-limit claims.
- The exact 61-entry allowlisted `openwrangler.vsix` has SHA-256 `bfb9222e8a92cb56722938e09414eaa8491e944645a90c1368723898a92716ca`. Its expanded two-process matrix passes in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, with six real-workbench captures, source-safe exports, backend-specific persistence, injected recovery, and final cleanup. `npm audit` and `pip-audit` report no known vulnerabilities.

This establishes a tested native DuckDB file preview, not full DuckDB parity. The DuckDB-specific semantic edge matrix, large mixed/nested data, repeated full-size measurements, and CI across Linux/macOS/Windows remain pending. Excel, notebook variables/MIME, and `.duckdb` database browsing remain explicitly deferred.

Applied-step inspection slice, 2026-07-16:

- Every applied Cleaning Steps node now selects its stable step ID; Original Data and Escape return to the exact confirmed dataframe view, while latest-step editing remains a separate inline/context action.
- The coordinator validates inspection kind, revision, stable ID, step index, and both page boundaries, treats the read as idempotently recoverable, publishes only the newest bounded inspection, and clears it before mutations, recovery, disposal, or active-session changes. Inspection pages are never persisted as grid view state.
- The editor pages through the selected step's input/output boundary with filters, sorts, and profiling explicitly paused. Changed cells and added/removed columns are theme-highlighted with accessible before/after descriptions. Code Preview, copy, and script export use selected prefix code until inspection is cleared.
- Focused runtime, coordinator, panel-decoder, React, and DataGrid tests cover all three engines, no Polars conversion, paging, strict mismatch rejection, supersession, local errors, mutation clearing, keyboard clear, confirmed-view restoration, transport-failure replay/retry, and diff accessibility.
- Extension-host and installed-VSIX acceptance drive `openWrangler.selectStep` through the real custom editor, assert the selected input/output schema, added-column diff, prefix code, and unchanged revision, then select Original Data and verify exact restoration of filter/sort state, widths, selected column, vertical/horizontal viewport, metadata, and full-plan code.

This makes cleaning-step history/edit/discard/undo **Done**. It does not make the overall release matrix green: broader duplicate/non-string operation acceptance, released-Jupyter integration, Restricted Mode, column-projected transport, installed-editor first-paint timing, and cross-platform packaged UI evidence remain explicitly **Partial** above.

Stable-ID structural-operation slice, 2026-07-16:

- `selectColumns`, `dropColumns`, `renameColumn`, `cloneColumn`, `castColumn`, `formula`, and `textLength` now require public `{id, name}` references. Legacy strings, name-only or ID-only objects, extra fields, unknown/stale IDs, ID/name mismatches, duplicate list selections, and duplicate input-lineage IDs fail closed; there is no name-based compatibility fallback. Formula operands may intentionally reference the same column.
- The runtime binds each accepted reference against the exact step-input schema and lineage to a private `{id, name, position}` value before any adapter runs. Public plan/draft metadata and persisted replay state remain position-free. The parallel bound plan and bound draft drive preview, code generation, apply, latest-step replacement, undo replay, and applied-step inspection, and both participate in transactional rollback. Replacement retains the applied step ID, derives new-output IDs deterministically from that ID and the current output order, and rejects duplicate identities before publication, so dynamic and cross-kind edits replay with the exact published identities.
- Pandas runtime execution and executable generated code use visible-column positions, so one of two equal labels can be selected, dropped, renamed, cloned, cast, used in a formula, or measured without silently targeting its neighbor. Select/drop/rename lineage follows the exact referenced IDs through duplicate labels. The tuple-form row sentinel used under Pandas MultiIndex columns remains hidden from shape, schema, paging, and export. Polars and DuckDB consume already-verified bound names while remaining engine-native; DuckDB rejects case-fold-equivalent schemas instead of silently targeting the wrong identifier.
- Every operation now rejects an explicit input/output column in the private row-identity namespace case-insensitively before adapter dispatch, including legacy string-based transforms and aggregation aliases, while source, custom-code, and dynamically generated outputs keep a second schema guard. Every transformed result must leave at least one visible column so runtime, generated-code, and export row counts cannot diverge on engines that cannot represent a positive-height zero-column frame; supported immutable zero-column sources remain viewable.
- The production browser harness now includes an operation dialog with equal labels, a stringified non-string label, and an empty label. Every stable-reference option includes its ordinal, making even formatter-like literal names unambiguous, and Select Columns preserves and displays interaction order. Vite emits the Codicon font through a bundle-relative URL, the CSP permits that exact origin, and refreshed screenshots prove the actual icon glyphs render instead of blank placeholders.
- The focused binder, lineage, session, and transaction suites run across Pandas, Polars, and DuckDB and cover preview, public/private separation, apply, replay, inspection, dynamic/cross-kind latest-step edit, undo, pre-dispatch stale/collision/case-folded private-namespace rejection, all-transform zero-column rejection, DuckDB case-fold ambiguity, Pandas MultiIndex identity and safe structural append, exact edited-output replay, one-draft enforcement, and late-failure rollback. React/native-view regressions keep draft diffs on the correct committed or replacement input schema, disable every add/edit path until apply/discard, and open the generic picker for a no-argument Add Cleaning Step command.
- Runtime/kernel response validation rejects empty or duplicate stable column IDs and duplicate, reordered, or gapped positions independently across active, latest-step-input, and applied-step inspection schemas before they can enter coordinator or webview state.
- All 27 TypeScript suites (283 tests) and 378 Python tests pass; coverage is 73.45% TypeScript statements/70.96% branches and 88.31% Python statements. The 24 production webview harnesses remain axe-clean, the strict 100k × 50 CSV and 1M × 20 Parquet Polars gates pass, and extension-host reload acceptance is green. The exact 63-entry allowlisted `openwrangler.vsix` has SHA-256 `7b7fb9011d9bb762993af26ca0ba6973c307d12915ca7345b75508fd60c178d1`; that artifact passed isolated VS Code 1.128.1 and Cursor 3.11.19 packaged acceptance and was force-installed as `matt17br.openwrangler@0.3.0` in both local editors with no retired extension identity present.
- The matrix rows remain **Partial**. The evidence closes the stable-reference foundation for these seven operations, not every operation that accepts a column, and does not yet provide the complete duplicate/non-string type matrix or installed VS Code/Cursor interaction for those datasets.

Editor file-launch slice, 2026-07-16:

- One canonical `openWrangler.openFile` command now appears as **Open in Open Wrangler** in the Explorer context menu, editor-tab context menu, editor-title toolbar, and Command Palette for CSV, TSV, Parquet, JSONL, XLSX, and XLS resources. The case-insensitive predicates accept local and VS Code remote files, keep the compact toolbar action out of the Open Wrangler custom editor itself, and use the built-in `open-preview` product icon rather than a copied asset or a second command alias. Because Cursor 3.11 hides third-party title actions by default, the manifest contributes the command to Cursor's pinned-title-action default; explicit user configuration remains authoritative and no activation code mutates editor settings.
- The handler prefers the resource URI supplied by VS Code menus, then resolves active text, third-party custom, or modified diff tabs. Direct targets and native-picker results share the same validation. Untitled and unsupported schemes/formats, disabled formats, directories, special filesystem nodes, missing/inaccessible resources, and cancelled import configuration all stop before a panel or Python runtime is created. The exact persisted `vscode-remote` URI, including its authority, reaches resource-scoped Python settings and Python-extension environment resolution instead of being reconstructed as `file://`; malformed legacy metadata alone falls back to its concrete path. A generated Parquet file additionally runs through the installed command and remains byte-identical.
- The isolated editor harness connects to the actual Electron workbench, opens a JSONL source as text, clicks the visible editor-title icon, reselects and right-clicks the source tab, verifies the exact **Open in Open Wrangler** menu label, and clicks it. A disposable third-party CSV custom editor repeats the title-action route to cover Edit CSV-style integrations. Every path must open the selected session, preserve source bytes, close cleanly, and leave zero sessions/processes; Open Wrangler's own custom editor must show neither a duplicate title action nor a duplicate tab-menu action.
- This interaction exposed and corrected the former `activeCustomEditor` predicate to VS Code's real `activeCustomEditorId` key for the title action and all four cleaning-plan keybindings. The argument-only Jupyter variable-viewer command now has a distinct internal title and is hidden from the Command Palette, while its Jupyter-provided **Open in Open Wrangler** surface remains unchanged.
- All 28 TypeScript suites (305 tests) and 378 Python tests pass. The exact 63-entry allowlisted `openwrangler.vsix` has SHA-256 `1ba6fe3a8ba4e8bce96c0aa5530c48b84f1d3f71ea50e3e1fe133d4c316440a1`. Those bytes passed the complete two-process installed-package suite in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, including the ordinary-tab toolbar and menu clicks, the third-party CSV custom-editor route and default import prompts, Cursor's declarative title-action pin with no stored profile override, own-editor duplicate suppression, source safety, and final zero-session/process cleanup. The packaged README's PySpark tracking link was also expanded and inspected from the archive rather than inferred from its source Markdown.
- Real-workbench evidence: [VS Code title icon](images/editor-acceptance/vscode-file-title-action.png), [VS Code tab menu](images/editor-acceptance/vscode-tab-context-menu.png), [Cursor title icon](images/editor-acceptance/cursor-file-title-action.png), and [Cursor tab menu](images/editor-acceptance/cursor-tab-context-menu.png).

This closes editor-tab and editor-title launch parity. The combined file-entry row stays **Partial** only for the separately named packaged `.xls` and malformed-input UI evidence.

Column-projected transport slice, 2026-07-16:

- Protocol v2 now requires independently bounded row and column windows for initial open, ordinary pages, draft preview, applied-step inspection, apply, discard, and undo. Every page carries the ordered stable column IDs that define its row-vector values; the extension host rejects offsets, limits, IDs, row widths, diffs, or same-revision schemas that do not match the confirmed request/session before any state is published. Notebook MIME-v2 snapshots remain self-contained: exact legacy full-width pages migrate, partial/nonzero-offset snapshots fail closed, and the explicit Python helper caps embedded pages at 10,000 rows.
- Pandas slices visible columns positionally so duplicate and non-string labels remain unambiguous. Lazy Polars scans select only the private row identity and requested visible columns before terminal collection; real CSV and Parquet tests instrument that public call order and prohibit `to_pandas()`. DuckDB emits an explicit projected terminal selection without Pandas, Polars, or Arrow conversion. Cache identity includes both axes, and filters/sorts may reference columns that are intentionally absent from the returned block.
- The production grid keeps full-schema search, widths, selection, keyboard coordinates, and ARIA counts while retaining only bounded two-dimensional blocks. Diagonal scroll and mutation races cannot publish misaligned vectors; unavailable cleaning actions expose a real busy state instead of silently doing nothing. The pinned-browser suite verifies exact far-column values, cross-block focus, no more than two prefetched column blocks, all 24 axe harnesses, and pixel baselines. Wide-grid cached/uncached scrolling is 32.0/92.1ms p95, below its 100/500ms browser limits; these are webview-bundle measurements, not native editor paint.
- The strict Polars benchmark requests the shipped 16-column width and rotates nonzero horizontal offsets. For the 100k×50 CSV, cold-source stdio open/warm reopen is 67.419/32.749ms, direct cached/cache-miss p95 is 0.132/28.897ms, stdio cache-miss p95 is 30.584ms, and the active-profile page is 27.926ms. For the 1M×20 Parquet fixture those values are 59.334/34.592ms, 0.188/32.555ms, 39.340ms, and 13.293ms. Native lazy frames, source-cache eviction, active-profile overlap, bounded 8-entry/16 MiB caches, and zero retained sessions are proven; the measurements cover runtime/stdio boundaries, not VS Code or Cursor first paint.
- `npm run check`, all 30 TypeScript suites (327 tests), all 408 Python tests, extension-host/reload acceptance, browser acceptance, strict benchmark, and coverage are green. TypeScript coverage is 75.57% statements, 72.37% branches, 80.63% functions, and 78.82% lines; Python runtime coverage is 88.27%.
- The fresh 63-entry allowlisted `openwrangler.vsix` has SHA-256 `573d55999a0588fb9d4ff9b832c884ccb96fceca55971bde0d29a6d4e65f0db1`. Those exact bytes passed the complete two-process packaged matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. A generated 300-column source was opened independently with Pandas, Polars, and DuckDB; each engine filtered and sorted on untransported columns, fetched columns 288–299 with exact endpoint values, preserved source bytes, closed all sessions, and stopped the standalone runtime.

This makes column-projected grid-block transport **Done** for Pandas and Polars and records additive DuckDB evidence. The broader virtual-grid row remains **Partial** only for native installed-editor paint timing; installed-editor performance and cross-platform package acceptance likewise remain **Partial** until their separately named gates are measured beyond this Linux workstation.

## Explicitly deferred from 1.0

Copilot operations, DuckDB Excel/notebook/`.duckdb` database-browsing surfaces, non-dataframe tensor/list renderers, telemetry, and vscode.dev runtime support are out of scope. They must not block the Pandas/Polars 1.0 matrix and must not be represented as supported. Native PySpark support is a tracked post-parity engine expansion in [issue #36](https://github.com/Matt17BR/openwrangler/issues/36); it remains unavailable until its distributed paging, Spark Connect, operation, recovery, and packaged-editor gates are green. Editor-tab and editor-title file launching are part of the current 1.0 surface and have the acceptance evidence recorded above; they are not a PySpark prerequisite or a separate engine expansion.
