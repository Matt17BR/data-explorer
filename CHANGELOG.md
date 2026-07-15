# Changelog

All notable changes to Data Explorer are documented here. The project follows Semantic Versioning while prerelease versions remain unstable.

## [0.2.0-alpha.1] - 2026-07-15

### Added

- Data Explorer 1.0 parity milestone, contributor guardrails, CI, release automation, and documentation ownership.
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
- Complete notebook MIME v2 snapshots, saved MIME v1 normalization, permission-aware kernel formatters, and originating-notebook code insertion.
- Generated command, setting, operation, protocol, and MIME references with byte-for-byte CI drift detection.
- Source reopening and Getting Started walkthrough commands.
- Private row lineage and deterministic column identities for accurate structural diffs across sorting, renaming, reordering, grouping, latest-step edits, and duplicate Pandas labels.
- Restart-aware Jupyter kernel lifecycle with bounded execution, active cancellation, one-shot recovery, and real Pandas/Polars formatter/transport acceptance.
- Isolated installed-VSIX acceptance for VS Code and Cursor, including a live packaged Polars session and source reopening.
- Playwright/axe WCAG scanning and pixel-diff visual acceptance across 23 production-bundle harnesses, including high-contrast light, Unicode, empty, loading, error, and recovery states.
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
- Remote-compatible kernel runtime transfer plus installed VS Code/Cursor notebook acceptance for saved MIME v1/v2 output, live Pandas/Polars variables, permission denial, kernel replacement/replay, and edited originating-notebook insertion.
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
- Cross-platform checks use a Pandas Index for mixed column labels and platform-native path fixtures, keeping Python 3.10 type analysis and Windows tests deterministic.

### Release status

- Every in-scope row in the checked-in clean-room parity matrix has automated or recorded acceptance evidence. The version remains an alpha until the cross-platform release/tag workflow passes; no `1.0.0` tag is created by this prerelease.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
