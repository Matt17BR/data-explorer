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
- A validated 26-operation transformation registry with native Pandas and Polars execution and standalone code generation.
- Revision-safe draft preview, typed page diffs, apply/discard/latest-step edit/undo, and runtime plan replay.
- A searchable VS Code-native operation builder, synchronized Cleaning Steps view, draft diff surface, and editable CodeMirror code panel.

### Changed

- Package publisher changed from `local` to `Matt17BR`.
- File-only use no longer declares Jupyter as a hard extension dependency.
- Supported Python versions are 3.10 through 3.14.
- File-backed Polars CSV/TSV, Parquet, and JSONL inputs now stay lazy through viewing filters, sorts, projections, and page slices.
- GitHub workflows use the current Node 24-based official action majors.

### Known gaps

- Persisted editing plans, by-example operations, exports, notebook MIME v2, and release-grade isolated VS Code/Cursor tests are tracked in `docs/feature-parity.md` and are not yet parity complete.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
