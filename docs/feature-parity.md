# Feature parity matrix

Baseline: Microsoft Data Wrangler 1.24.2, observed and documented on 2026-07-15. This is a clean-room behavior matrix, not an implementation reference.

Status values: **Done** has automated and editor acceptance evidence; **Partial** is usable but incomplete; **Planned** is not release-ready. Data Explorer 1.0 requires every in-scope row to be **Done**.

| Surface                                             | Pandas | Polars | Status  | Required evidence                               |
| --------------------------------------------------- | -----: | -----: | ------- | ----------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes |    Yes | Partial | Import option, malformed-file, and editor tests |
| Notebook variable viewer and toolbar                |    Yes |    Yes | Partial | Real-kernel VS Code/Cursor tests                |
| Inline notebook renderer and full-view expansion    |    Yes |    Yes | Partial | MIME v1/v2 and persisted-output tests           |
| Virtual grid, column sizing, navigation             |    Yes |    Yes | Planned | Visual, keyboard, and performance tests         |
| Dataset summary and quick insights                  |    Yes |    Yes | Partial | Exact-count and typed-chart fixtures            |
| Basic and advanced viewing filters                  |    Yes |    Yes | Partial | Cross-engine predicate matrix                   |
| Multi-column viewing sorts                          |    Yes |    Yes | Partial | Null-order and stability tests                  |
| Editing mode and operation catalog                  |    Yes |    Yes | Planned | Real-editor operation search tests              |
| Draft preview and data diff                         |    Yes |    Yes | Planned | Row/column/cell diff fixtures                   |
| Cleaning-step history, edit, discard, undo          |    Yes |    Yes | Planned | Reducer, replay, and shortcut tests             |
| Generated code preview and editing                  |    Yes |    Yes | Planned | Syntax and execution golden tests               |
| Sort/filter cleaning steps                          |    Yes |    Yes | Planned | Cross-engine operation tests                    |
| Select/drop/rename/clone/cast/formula/length        |    Yes |    Yes | Planned | Cross-engine operation tests                    |
| Missing/duplicate row operations                    |    Yes |    Yes | Planned | Null/NaN/duplicate fixtures                     |
| One-hot and multi-label binarization                |    Yes |    Yes | Planned | Category and naming collision fixtures          |
| Find/replace/strip/split/case transforms            |    Yes |    Yes | Planned | Unicode, regex, and null fixtures               |
| Scale/round/floor/ceiling/datetime format           |    Yes |    Yes | Planned | Numeric, timezone, and invalid-value fixtures   |
| Group and aggregate                                 |    Yes |    Yes | Planned | Aggregation/type/name fixtures                  |
| Custom engine-native code                           |    Yes |    Yes | Planned | Trust, syntax, runtime, and recovery tests      |
| String/datetime/new-column by example               |    Yes |    Yes | Planned | Candidate ranking and ambiguity fixtures        |
| Copy/script/notebook code export                    |    Yes |    Yes | Planned | Clipboard/file/notebook edit tests              |
| CSV and Parquet data export                         |    Yes |    Yes | Planned | Atomic-write and source-protection tests        |
| Runtime selection, setup, change, clear             |    Yes |    Yes | Planned | Missing/dependency/permission tests             |
| Original icons, native views, themes, accessibility |    N/A |    N/A | Planned | VS Code/Cursor visual checklist                 |
| Runtime crash/reload/session replay                 |    Yes |    Yes | Planned | Failure-injection integration tests             |

## Explicitly deferred from 1.0

Copilot operations, Spark, DuckDB, non-dataframe tensor/list renderers, telemetry, and vscode.dev runtime support are out of scope. They must not block the 1.0 matrix and must not be represented as supported.
