# Changelog

All notable changes to Open Wrangler are documented here. The project follows Semantic Versioning while prerelease versions remain unstable.

## [0.3.0] - Unreleased

### Added

- Added **Open in Open Wrangler** to supported-file editor toolbars and editor-tab context menus alongside the existing Explorer and Command Palette entry points, with actual workbench click acceptance in isolated VS Code and Cursor profiles. A declarative Cursor configuration default pins the canonical action because Cursor hides third-party title actions by default; explicit user settings still take precedence.
- Added selectable Cleaning Steps history: each applied step opens a paged input→output inspection with identity-aware cell/column highlighting and generated code through that step, while Original Data restores the exact confirmed view.
- Added a native, lazy DuckDB file backend for UTF-8 CSV/TSV, Parquet, and JSONL viewing, profiling, all 27 deterministic operations, executable code generation, draft/history workflows, and atomic CSV/Parquet export without conversion through Pandas, Polars, or Arrow.
- Added opt-in Pandas and DuckDB runtime benchmark modes with deterministic synthetic fixtures, native/lazy frame evidence, machine and package provenance, process-memory samples, and an explicit boundary separating runtime timings from editor first paint. Polars remains the strict release-performance gate.
- Added pull-request CodeQL analysis for JavaScript/TypeScript and Python, cross-platform pull-request runtime coverage, canonical single-artifact release validation, and repository rules protecting `main` and `v*` release tags.

### Changed

- Replaced full-width page transport with required two-dimensional grid windows across open, paging, draft, history, apply, discard, and undo flows. Returned values are aligned to stable column IDs; cache keys include the projection; Pandas projects positionally, lazy Polars projects before collection, and DuckDB uses explicit terminal columns while preserving private row identity. Horizontal paging stays in the confirmed logical view, reconciles diagonal scroll and mutation races, exposes an accessible cleaning-action busy state, preserves full-schema keyboard/ARIA coordinates, and identifies duplicate/reordered diff columns by stable ID. The host rejects same-revision schema changes before publishing projected values. Previously saved full-width MIME-v2 notebook outputs are migrated only when their row width exactly matches the saved schema; incomplete self-contained snapshots fail closed, and explicit notebook snapshots are capped at the protocol's 10,000-row page limit.
- Hardened file launches to prefer the menu-supplied URI, recover text/custom/diff editor resources, preserve exact VS Code remote URIs during Python environment resolution, accept supported extensions case-insensitively, and reject untitled, virtual, unsupported, disabled, missing, inaccessible, directory, or special-filesystem targets before runtime startup. Corrected custom-editor menu/keybinding predicates to use VS Code's `activeCustomEditorId` context key.
- Established the Open Wrangler identity across the VS Code package, bundled runtime, protocol schema, repository metadata, documentation, test harnesses, and release artifacts.
- Consolidated commands, settings, custom-editor state, and notebook rendering on the canonical `openWrangler.*` namespace and MIME v2 identifier.
- Removed the unused pre-release identity and compatibility paths instead of carrying aliases or migrations into the experimental package.
- Refreshed real installed-VSIX evidence from fixture-only VS Code and Cursor profiles without development-workspace diagnostics or test-host title chrome.
- Replaced shared engine singletons with ordered factories and session-owned adapters, including diagnostic cleanup on failed opens, explicit close, runtime shutdown, and transient notebook rendering. Extension deactivation now awaits terminal session cleanup across standalone and Jupyter runtimes, while normal Python-process stops use bounded stdin/EOF shutdown before force-kill fallback.
- Refreshed the product description to state the open-source dataframe-wrangling purpose directly and documented the project's independent inspiration from Microsoft Data Wrangler.
- Deferred all live-session profiling until after the exact first grid, added correlated progressive view queries with interactive-over-background scheduling, and bounded each session's page cache by entries and payload weight.
- Made opaque logical-view contexts authoritative across the webview, retained panel snapshot, and native Activity Bar state; superseded pages and pre-recovery runtime responses can no longer overwrite current metadata. Foreground failures, profiling diagnostics, queued-view cancellation, retryable pages, and per-profile retries are isolated from one another.
- Allowed foreground paging to execute beside an immutable profiling lease while keeping transformations, exports, and close exclusive with writer preference. Recovery now retires the replaced runtime session transactionally, and a shutdown that reaches its grace bound still closes a live-kernel session after active work settles.
- Removed the lazy-Polars all-column null scan from initial schema discovery, kept exact summary counts in native Polars aggregations, sampled deterministic valid numeric values for charts, and normalized Pandas/Polars null-versus-NaN counts.
- Made notebook-kernel requests use the same canonical protocol-v2 success, error, cancellation, and correlation envelopes as the standalone runtime so logical dataframe errors remain recoverable responses.
- Made lazy file sessions detect source replacement, resize, schema changes, and deletion before cached metadata can diverge from newly read rows; affected sessions now request an explicit reopen while remaining safely closable.
- Hardened performance evidence with atomic fixture-contract validation, honest first-sample versus warm-source metrics, native lazy-profile measurements, and cache/session cleanup assertions.
- Added canonical stdio protocol round-trip and instrumented active-profile overlap gates with a release-blocking 500ms cache-miss ceiling, and limited cancellation acknowledgements to work that was genuinely still queued so running results remain authoritative.
- Made the bundled Python runtime version a package-wide source of truth and added a documentation gate that rejects extension/runtime prerelease drift.
- Made every runtime mutation and matching webview transition transactional, including rollback of revisions, plans, drafts, cached blocks, confirmed view state, values, profiling ownership, and focus after late failures or cancellations.
- Hardened webview host-message intake with explicit same-origin rejection and kept column-derived diagnostic keys in `Map` storage instead of dynamic object properties.
- Made terminal runtime cleanup accept the caller's last confirmed revision after an ambiguous mutation, recursively isolated Pandas object cells before live/generated custom code, and aligned live/generated null-versus-NaN filters with saved notebook snapshots.
- Made orderly runtime shutdown drain every session after cleanup faults and return their deterministic aggregate to initiating, joining, and later callers.
- Added a release-blocking warm-dependency/cold-source stdio first-grid gate with per-file Linux cache-eviction evidence, and required the runtime version module in packaged-VSIX verification.
- Added strict nested protocol-v2 request/response validation and semantic correlation at webview, persistence, notebook-output, transport, and coordinator boundaries; transformation parameters are discriminated by operation kind, and malformed kinds, actions, runtime IDs, revisions, columns, export paths, and view IDs cannot publish state.
- Made select, drop, rename, clone, cast, formula, and text-length steps address columns with stable `{id, name}` references. The runtime binds them to private input positions before execution, rejects stale/mismatched identities, duplicate list selections, output collisions, and case-folded private-row references without a string fallback, keeps bound plans transactional, and makes Pandas runtime/generated code positional for duplicate labels. Edited dynamic/cross-kind steps retain their applied ID and derive globally unique output lineage deterministically from current output order, so replay publishes the same identities; Pandas MultiIndex structural outputs append without overwriting tuple-labelled columns, sentinels stay private, and DuckDB rejects case-fold ambiguity instead of targeting the wrong column.
- Extended the same stable-reference contract to cleaning sorts, copied cleaning filters, missing-row keys, and duplicate-row keys. The public transform IR is deliberately separate from name-addressed viewing state; ambiguous viewing names fail before preview, saved filters reopen without being replaced by unrelated viewing state, and replacement from the current view is explicit. Binding also rejects a transform filter whose declared semantic type is stale for its referenced input column, preventing Pandas/Polars/DuckDB predicate drift; NaN inclusion on a non-float column compiles to the same explicit-false condition on every engine. Pandas runtime and executable generated code now build masks and stable sort/dedup keys from exact positions, including duplicate and integer labels, while Polars and DuckDB receive bound native names. Omitted/all-column modes exclude the private row identity, and restart/replay retains the exact targets without leaking bound positions into saved steps.
- Extended stable `{id, name}` input references to one-hot and multi-label encoding; find/replace, strip, split, and casing; min-max, round, floor, and ceiling; and datetime formatting. Legacy name strings, stale/mismatched references, repeated one-hot targets, and private-row identities fail before adapter dispatch. Pandas runtime and executable generated code select duplicate and non-string labels positionally, replace an omitted/same-name output with `isetitem`, append explicit outputs without ambiguous assignment, and derive categorical prefixes from the referenced public name while retaining collision and private-namespace guards. One-hot encoding now accepts numeric, boolean, date, and text values, excludes blank/null/NaN categories consistently, and orders generated names globally across engines; multi-label encoding handles categorical nulls; and default stripping uses one explicit Unicode/control-whitespace contract. The operation editor preserves explicit empty multi-label prefixes separately from the default prefix and accepts protocol-valid empty find patterns without changing them during an edit; empty literal finds insert replacements at text boundaries identically in all three engines and their generated code. Packaged live-kernel acceptance applies representative one-hot, uppercase, round, and datetime-format steps to exact duplicate/integer-labelled columns, then replays the full plan after kernel replacement while proving the source variable remains unchanged and public steps never expose bound positions.
- Completed the stable-reference contract for all 26 column-addressed operations. Group keys and aggregation inputs now use exact references while allowing one source to feed multiple aggregations; by-example sources and every saved-program column leaf use exact references, and example inputs are ordered scalar arrays aligned to source selection order. Public/persisted plans never expose private positions or accept legacy name maps. Pandas grouping and by-example execution/generated code address duplicate and non-string labels positionally, while Polars and DuckDB retain verified native expressions. Grouped null and NaN keys/values now share one typed-null contract without erasing computed NaN; decimal means/medians normalize to a portable nullable float; and integer group sums/by-example arithmetic widen past 64 bits through a checked 38-digit envelope instead of wrapping. Exact final-result semantics cover order-independent cancellation, native Polars UInt128 and DuckDB UHUGEINT, a bounded five-limb Polars group aggregate, NumPy/Python integer boxing, and Pandas Decimal sums that preserve precision and scale independently of caller context. Nullable Pandas integers wider than 64 bits retain exact keys, extrema, generated code, typed pages, and Parquet output; NumPy/Pandas temporal scalars retain nanosecond typed-cell precision. Regex replacements remain literal and by-example casing is deterministic ASCII-only. Synthesis is bounded by source/example/AST limits, 64 warnings, 8 KiB per string, and 64 KiB total UTF-8 text; cheap structural guards run before recursive accounting, which is enforced again on the retained canonical step.
- Required every retained by-example step to carry its canonical synthesized program, preventing metadata or persistence replay from silently choosing a new candidate. The operation editor now rejects unsafe integer JSON tokens before native parsing can round them, while exact engine-native execution retains the 38-digit arithmetic envelope.
- Normalized semantic-string group minima and maxima through Pandas nullable strings in both live and generated paths, preserving typed-null behavior across supported Pandas 2.x and 3.x environments instead of relying on their differing object-string reducers.
- Made distinct-value queries deterministic across Pandas, Polars, and DuckDB by sorting equal-frequency values by display text. This removes visual/profile flicker and stabilizes checked-in browser captures.
- Made Vite emit bundle-relative webview assets and explicitly allowed their origin through the main webview CSP, so the packaged Codicon font loads in VS Code, Cursor, and the browser harness instead of resolving against a broken `/codicon.ttf` root URL or being blocked; refreshed the visual baselines and added a duplicate/non-string/empty-label operation-dialog case.
- Kept draft diffs anchored to the immediately preceding committed schema after structural reorders, while replacement previews still use the latest step's recorded input. Add-operation and edit-latest entry points now remain disabled until the active draft is applied or discarded, the runtime rejects a second preview before adapter dispatch, and the no-argument Add Cleaning Step command opens the generic operation picker.
- Made the operation builder fully modal: its background becomes inert and hidden from assistive technology, keyboard focus wraps within the dialog, and close restores the exact opener or a stable workbench fallback.
- Rejected every transformed dataframe with no visible columns, including dynamic categorical and custom-code outputs, so runtime, generated-code, and export row counts cannot diverge on engines that cannot represent a positive-height zero-column frame. Immutable zero-column sources remain viewable where an engine supports them.
- Rejected runtime/kernel response schemas with empty or duplicate stable column IDs or noncontiguous positions before they can enter coordinator or webview state, including active, latest-step-input, and applied-step inspection schemas.
- Made standalone cancellation wait for the original request's authoritative result, prevented detached-cleanup timeouts from restarting a live shared runtime, and replaced non-authoritative close acknowledgements with one fresh bounded cleanup attempt plus diagnostics.
- Made Jupyter acquisition and bootstrap single-flight and generation-safe under concurrency, applied one deadline across acquisition through response parsing, and prohibited automatic mutation/export/session retries after ambiguous dispatch. A later request reconstructs the last confirmed session before continuing after an uncertain mutation.
- Assigned every live-kernel open a host-known candidate session identity and added bounded failure cleanup, preventing lost or malformed Jupyter output from leaving an unaddressable runtime session.
- Added explicit grid/drawer ownership for progressive summaries, complete confirmed-state rollback after foreground failures, stable-ID filter selection through renames, empty-schema guards, and scroll paging that preserves keyboard focus.
- Pinned persisted plans and recovery requests to the confirmed engine so automatic dependency fallback cannot replay a cleaning plan with different backend semantics.
- Replaced module-only dependency checks with version-aware engine/format probes; DuckDB is accepted only in the tested `>=1.4.5,<1.6` range and dependency installation remains an explicit user-confirmed action.
- Split engine shutdown interruption from request-level cancellation capabilities so DuckDB cleanup can interrupt terminal work without promising cancellation semantics the protocol cannot guarantee.
- Corrected legacy `.xls` support end to end: Pandas now probes and uses `xlrd>=2.0.1` instead of `openpyxl`, Polars explicitly uses its Calamine/`fastexcel>=0.9` reader, and real BIFF workbook acceptance covers both runtime engines plus extension dependency diagnostics.
- Defined `utf8-lossy` as a Pandas replacement-decoding policy: automatic file opens bypass Polars and DuckDB, invalid bytes become the Unicode replacement character, and the sentinel is never passed to Python as a codec name.
- Split workspace persistence into explicit cleaning and non-destructive viewing sections; filters/sorts, stable-ID widths and column selection, and vertical/horizontal position now restore by source and confirmed backend across reload and runtime recovery, with the active selection mirrored in native views.
- Moved preview releases to Marketplace-compatible numeric versions with `preview: true`; the release workflow now validates and publishes one checksummed VSIX byte-for-byte across its platform matrix.

## [0.2.0-alpha.1] - 2026-07-15

### Added

- Initial 1.0 parity milestone, contributor guardrails, CI, release automation, and documentation ownership.
- Original extension and Activity Bar icon sources.
- Strict TypeScript, Python, formatting, documentation, and VSIX-content checks.
- Protocol v2 JSON Schema, generated TypeScript contract, explicit Python validation, typed cell encodings, request cancellation, timeouts, and structured diagnostics.
- Stable extension-host session IDs with per-session serialization, concurrent dataframe sessions, cleanup, stale-revision rejection, and runtime replay.
- Python 3.10-3.14 environment resolution, engine/format dependency probes, and confirm-before-install runtime commands.
- Two-axis grid virtualization, resizable columns, roving keyboard navigation, column search, responsive insights drawer, and progressive profiling.
- Activity Bar Operations, Summary, Filters/Sorts, and Cleaning Steps views plus a bottom-panel Code Preview surface.
- CSV/TSV delimiter, encoding, quote, and header prompts; Excel sheet selection; configurable viewing behavior and file types.
- Advanced AND/OR viewing predicates with null/NaN operators and cross-engine tests.
- Light, dark, high-contrast, responsive-width, zoom, and wide-data browser acceptance baselines.
- Isolated VS Code extension-host acceptance and minimum/current editor CI coverage.
- A validated 27-operation transformation registry with native Pandas and Polars execution and standalone code generation.
- Revision-safe draft preview, typed page diffs, apply/discard/latest-step edit/undo, and runtime plan replay.
- A searchable VS Code-native operation builder, synchronized Cleaning Steps view, draft diff surface, and editable CodeMirror code panel.
- Workspace-scoped persistence and validated replay for applied steps, an optional draft, and independent viewing state.
- Editable-code clipboard/script export and atomic native Pandas/Polars cleaned-data export to CSV or Parquet.
- Deterministic by-example synthesis with ranked expression programs, ambiguity warnings, native engine execution, and generated code.
- Complete notebook MIME v2 snapshots, permission-aware kernel formatters, and originating-notebook code insertion.
- Generated command, setting, operation, protocol, and MIME references with byte-for-byte CI drift detection.
- Source reopening and Getting Started walkthrough commands.
- Private row lineage and deterministic column identities for accurate structural diffs across sorting, renaming, reordering, grouping, latest-step edits, and duplicate Pandas labels.
- Restart-aware Jupyter kernel lifecycle with bounded execution, active cancellation, one-shot recovery, and real Pandas/Polars formatter/transport acceptance.
- Isolated installed-VSIX acceptance for VS Code and Cursor, including a live packaged Polars session and source reopening.
- Playwright/axe WCAG scanning and pixel-diff visual acceptance across 22 production-bundle harnesses, including high-contrast light, Unicode, empty, loading, error, and recovery states.
- Strict release-size Polars benchmarks with JSON evidence, session-cleanup assertions, rendered cached/uncached scroll gates, and scheduled CI regression checks.
- Cross-engine file acceptance for quoted/headerless CSV, TSV, JSONL, Parquet, and named/indexed Excel sheets plus missing/malformed diagnostics.
- Native nested-Polars and Pandas/NumPy nullable typed-cell fixtures covering large integers, decimals, time zones, containers, binary, durations, NaN/infinity, zero-column frames, and long Unicode values.
- Cross-engine operation-edge acceptance for stable per-column null sorts, missing/duplicate modes, categorical collisions, Unicode casing, non-finite numerics, nullable ordered groups, and custom-code diagnostics.
- Two-process installed-VSIX acceptance in VS Code and Cursor for persisted Polars plans/view state, concurrent Pandas/Polars runtime recovery, source-safe export, and final process cleanup.
- Required TypeScript/Python coverage floors, bundled-production license policy checks, and Linux/macOS/Windows tag validation.
- State-scoped, accessible keyboard shortcuts for draft apply/discard and latest-step edit/undo, with production-bundle Playwright acceptance.
- Installed VS Code/Cursor input acceptance for CSV, TSV, JSONL, Parquet, and Excel plus native Pandas/Polars CSV and Parquet export verification.
- Installed VS Code/Cursor acceptance for representative steps from every operation group on Pandas and Polars, including preview/diff/code/apply, deterministic by-example confirmation, custom-code crash replay, immutable sources, and leak-free disposal.
- Installed VS Code/Cursor acceptance for native Pandas/Polars paging, advanced OR filters, multi-column sorts, progressive summaries, exact stats, searched values, view/plan separation, immutable sources, and leak-free disposal.
- Installed VS Code/Cursor acceptance for edited Code Preview clipboard/script output and explicit runtime change, dependency diagnostics, declined installation, and fallback clearing.
- Remote-compatible kernel runtime transfer plus installed VS Code/Cursor notebook acceptance for saved MIME v2 output, live Pandas/Polars variables, permission denial, kernel replacement/replay, and edited originating-notebook insertion.
- Real installed-VSIX workbench captures in VS Code and Cursor across dark, light, and high-contrast themes at 200% zoom, including the original Activity Bar/gallery identity and native views.

### Changed

- Package publisher changed from `local` to `Matt17BR`.
- File-only use no longer declares Jupyter as a hard extension dependency.
- Supported Python versions are 3.10 through 3.14.
- File-backed Polars CSV/TSV, Parquet, and JSONL inputs now stay lazy through viewing filters, sorts, projections, and page slices.
- GitHub workflows use the current Node 24-based official action majors.
- Custom-editor panels now enable their webview scripts and resources consistently, allowing file sessions to initialize through the contributed editor path.
- Column actions and resizing now provide zoom-safe touch targets plus keyboard resizing; loading, recovery, and generated-code regions expose explicit accessible status/focus semantics.
- Polars nested dtypes are classified by their outer container, Excel sheet indexes follow the public zero-based contract, and failed lazy-file opens no longer retain partial sessions.
- Transformation IR validation now rejects malformed option types, filter predicates, sorts, and group aliases before execution; runtime and generated Pandas/Polars code share deterministic null, category, group, numeric, and Unicode behavior.
- Standalone Python startup is single-flight, restart-safe, and automatically stops after the final session closes.
- Screenshot generation resolves hosted CI Python environments as well as local virtual environments.
- Successful code-copy and script-export notifications no longer hold command completion open while awaiting toast dismissal.
- Notebook kernels receive the packaged pure-Python runtime through the stable execution API and no longer require access to the local extension filesystem.
- Saved notebook snapshots no longer treat null numeric cells as zero, and their multi-column sorts honor explicit null placement independently of direction.
- Visual and accessibility acceptance use the lockfile-pinned Chromium revision, metric-compatible harness font tokens, and always-uploaded CI diffs instead of a moving system-browser/font fallback.
- Real-kernel acceptance uses a single bounded execution deadline with short message polls, tolerating cold shared-runner imports without hiding a hung kernel.
- Webview scrollbars and multi-select states now use VS Code theme tokens for consistent native contrast and deterministic rendering across editor and CI hosts.
- Editor compatibility jobs retry transient VS Code distribution downloads with a bounded backoff.
- Cross-platform checks use a Pandas Index for mixed column labels, platform-native path fixtures, and repository-enforced LF text checkouts, keeping Python 3.10 type analysis and Windows packaging deterministic.

### Release status

- That checkpoint recorded the then-known parity evidence, but it remained a preview and created no `1.0.0` tag. The current matrix is authoritative when later audits reopen incomplete behavior or acceptance gates.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
