# Feature parity matrix

Baseline: Microsoft Data Wrangler 1.24.2, observed and documented on 2026-07-15. This is a clean-room behavior matrix, not an implementation reference.

Status values: **Done** has automated and editor acceptance evidence; **Partial** is usable but incomplete; **Planned** is not release-ready. Data Explorer 1.0 requires every in-scope row to be **Done**.

| Surface                                             | Pandas | Polars | Status  | Required evidence                               |
| --------------------------------------------------- | -----: | -----: | ------- | ----------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes |    Yes | Partial | Import option, malformed-file, and editor tests |
| Notebook variable viewer and toolbar                |    Yes |    Yes | Partial | Real-kernel VS Code/Cursor tests                |
| Inline notebook renderer and full-view expansion    |    Yes |    Yes | Partial | MIME v1/v2 and persisted-output tests           |
| Virtual grid, column sizing, navigation             |    Yes |    Yes | Partial | Browser/keyboard green; editor/performance TBD  |
| Dataset summary and quick insights                  |    Yes |    Yes | Partial | Progressive exact stats green; typed edges TBD  |
| Basic and advanced viewing filters                  |    Yes |    Yes | Partial | AND/OR cross-engine green; full matrix TBD      |
| Multi-column viewing sorts                          |    Yes |    Yes | Partial | Null-order and stability tests                  |
| Editing mode and operation catalog                  |    Yes |    Yes | Partial | Registry validation green; editor search TBD    |
| Draft preview and data diff                         |    Yes |    Yes | Partial | Runtime page diff green; identity edges/UI TBD  |
| Cleaning-step history, edit, discard, undo          |    Yes |    Yes | Partial | Runtime replay green; UI/shortcuts TBD          |
| Generated code preview and editing                  |    Yes |    Yes | Partial | Engine-native execution green; UI editing TBD   |
| Sort/filter cleaning steps                          |    Yes |    Yes | Partial | Core cross-engine operation tests green         |
| Select/drop/rename/clone/cast/formula/length        |    Yes |    Yes | Partial | Core cross-engine operation tests green         |
| Missing/duplicate row operations                    |    Yes |    Yes | Partial | Core null/duplicate tests green; edges TBD      |
| One-hot and multi-label binarization                |    Yes |    Yes | Partial | Core category tests green; collisions TBD       |
| Find/replace/strip/split/case transforms            |    Yes |    Yes | Partial | Core cross-engine tests green; Unicode TBD      |
| Scale/round/floor/ceiling/datetime format           |    Yes |    Yes | Partial | Core cross-engine tests green; typed edges TBD  |
| Group and aggregate                                 |    Yes |    Yes | Partial | Core aggregation tests green; typed edges TBD   |
| Custom engine-native code                           |    Yes |    Yes | Partial | Native execution green; trust/recovery TBD      |
| String/datetime/new-column by example               |    Yes |    Yes | Planned | Candidate ranking and ambiguity fixtures        |
| Copy/script/notebook code export                    |    Yes |    Yes | Planned | Clipboard/file/notebook edit tests              |
| CSV and Parquet data export                         |    Yes |    Yes | Planned | Atomic-write and source-protection tests        |
| Runtime selection, setup, change, clear             |    Yes |    Yes | Partial | Unit-tested resolver/probes; editor prompts TBD |
| Original icons, native views, themes, accessibility |    N/A |    N/A | Partial | Browser matrix green; editor checklist TBD      |
| Runtime crash/reload/session replay                 |    Yes |    Yes | Partial | Contract tests green; editor injection TBD      |

## Recorded acceptance evidence

Viewing slice, 2026-07-15:

- `npm test`: 9 TypeScript and 16 Python tests passed. The Polars file test asserts a lazy source and fails if `to_pandas()` is called.
- `npm run test:extension-host` passed against local VS Code 1.128.0, activating the extension, verifying commands/views/settings, and opening `fixtures/sample.csv` through the real custom-editor contribution.
- The allowlisted 44-entry VSIX installed successfully into isolated VS Code 1.128.0 and Cursor 3.11.19 profiles as `matt17br.data-explorer@0.2.0-alpha.1`.
- The in-app browser exercised the built webview at 800px: drawer open/close, advanced OR selection, value-free null predicates, settled progressive requests, keyboard cell navigation, and column search/focus restoration.
- The 1,000 by 40 wide harness retained 7 rendered data columns and 39 rendered rows while exposing the full 41-column/1,001-row accessible grid counts. It jumped to column 39 and fetched rows 201–400 without unbounding the DOM.
- Approved browser baselines are checked into `docs/images/acceptance/` for light, dark, high contrast, 800/1280/1920px widths, and 80/100/150/200% zoom. `docs/images/wide-grid.png` records the wide-grid fixture.

This evidence advances viewing rows to **Partial**, not **Done**. Full interactive Cursor acceptance, malformed/type-edge fixtures, automated accessibility scans, and performance gates are still mandatory.

Editing engine slice, 2026-07-15:

- `npm test`: 9 TypeScript and 27 Python tests passed. Eleven parameterized operation tests cover the complete 26-operation registry across Pandas and Polars.
- Representative multi-step plans compile to standalone engine-native code and execute to the same semantic output as the runtime adapters.
- Polars transformation tests replace `DataFrame.to_pandas()` with a hard failure. No operation or generated Polars plan crosses through Pandas.

This evidence advances the operation rows to **Partial**. Editor controls, exhaustive typed-edge fixtures, workspace-trust enforcement for custom code, and real-editor acceptance remain mandatory.

Editing session slice, 2026-07-15:

- `npm test`: 9 TypeScript and 34 Python tests passed. Both engines cover preview, typed page diff, apply, latest-step edit, discard, stale-revision rejection, undo replay, immutable source protection, and viewing-mode rejection.
- Protocol v2 now validates transform steps and carries applied steps, an optional draft, preview diffs, generated code, and plan mutation responses.
- The extension coordinator maintains distinct public/runtime revisions and replays applied steps, the active draft, and the viewing query after runtime replacement.

This evidence advances draft/history rows to **Partial**. Stable identities through structural operations, UI shortcuts, persisted-plan reload, failure-injected editor recovery, and real-editor acceptance remain mandatory.

## Explicitly deferred from 1.0

Copilot operations, Spark, DuckDB, non-dataframe tensor/list renderers, telemetry, and vscode.dev runtime support are out of scope. They must not block the 1.0 matrix and must not be represented as supported.
