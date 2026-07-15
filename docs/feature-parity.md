# Feature parity matrix

Baseline: Microsoft Data Wrangler 1.24.2, observed and documented on 2026-07-15. This is a clean-room behavior matrix, not an implementation reference.

Status values: **Done** has automated and editor acceptance evidence; **Partial** is usable but incomplete; **Planned** is not release-ready. Data Explorer 1.0 requires every in-scope row to be **Done**.

| Surface                                             | Pandas | Polars | Status  | Required evidence                               |
| --------------------------------------------------- | -----: | -----: | ------- | ----------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes |    Yes | Partial | Import option, malformed-file, and editor tests |
| Notebook variable viewer and toolbar                |    Yes |    Yes | Partial | Real-kernel VS Code/Cursor tests                |
| Inline notebook renderer and full-view expansion    |    Yes |    Yes | Partial | MIME v1/v2 compatibility green; editor TBD      |
| Virtual grid, column sizing, navigation             |    Yes |    Yes | Partial | Browser/keyboard green; editor/performance TBD  |
| Dataset summary and quick insights                  |    Yes |    Yes | Partial | Progressive exact stats green; typed edges TBD  |
| Basic and advanced viewing filters                  |    Yes |    Yes | Partial | AND/OR cross-engine green; full matrix TBD      |
| Multi-column viewing sorts                          |    Yes |    Yes | Partial | Null-order and stability tests                  |
| Editing mode and operation catalog                  |    Yes |    Yes | Partial | Registry/UI search green; editor matrix TBD     |
| Draft preview and data diff                         |    Yes |    Yes | Partial | Runtime/UI page diff green; identity edges TBD  |
| Cleaning-step history, edit, discard, undo          |    Yes |    Yes | Partial | Runtime/UI green; persistence/shortcuts TBD     |
| Generated code preview and editing                  |    Yes |    Yes | Partial | Native execution/CodeMirror/export green        |
| Sort/filter cleaning steps                          |    Yes |    Yes | Partial | Core cross-engine operation tests green         |
| Select/drop/rename/clone/cast/formula/length        |    Yes |    Yes | Partial | Core cross-engine operation tests green         |
| Missing/duplicate row operations                    |    Yes |    Yes | Partial | Core null/duplicate tests green; edges TBD      |
| One-hot and multi-label binarization                |    Yes |    Yes | Partial | Core category tests green; collisions TBD       |
| Find/replace/strip/split/case transforms            |    Yes |    Yes | Partial | Core cross-engine tests green; Unicode TBD      |
| Scale/round/floor/ceiling/datetime format           |    Yes |    Yes | Partial | Core cross-engine tests green; typed edges TBD  |
| Group and aggregate                                 |    Yes |    Yes | Partial | Core aggregation tests green; typed edges TBD   |
| Custom engine-native code                           |    Yes |    Yes | Partial | Native execution green; trust/recovery TBD      |
| String/datetime/new-column by example               |    Yes |    Yes | Partial | Native ranked candidates and warnings green     |
| Copy/script/notebook code export                    |    Yes |    Yes | Partial | All paths implemented; real-kernel editor TBD   |
| CSV and Parquet data export                         |    Yes |    Yes | Partial | Cross-engine atomic/source tests green          |
| Runtime selection, setup, change, clear             |    Yes |    Yes | Partial | Unit-tested resolver/probes; editor prompts TBD |
| Original icons, native views, themes, accessibility |    N/A |    N/A | Partial | Browser matrix green; editor checklist TBD      |
| Runtime crash/reload/session replay                 |    Yes |    Yes | Partial | Runtime/workspace replay green; injection TBD   |

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

- `npm test`: 20 TypeScript and 62 Python tests passed. New Pandas/Polars helpers emit complete MIME v2 snapshots and remain native; explicit legacy v1 output is still available for fixtures.
- Shared TypeScript normalization upgrades saved v1 metadata to a read-only current session shape and rejects malformed/unknown-version payloads. The renderer registers both MIME identifiers and presents invalid output as an accessible error.
- Formatters are registered inside the active kernel only after trusted stable-API access. Live-variable sources retain their originating notebook URI.
- The insertion command uses the currently edited CodeMirror buffer and a tagged Python cell. The real VS Code extension-host suite applies and verifies the notebook edit against an untitled Jupyter notebook.

This advances notebook rows to **Partial**. Real local/remote kernel formatter display, permission denial, kernel restart, persisted v1 output in packaged VS Code/Cursor, and originating-notebook interaction remain mandatory.

Interface documentation and navigation slice, 2026-07-15:

- `docs/reference.md` is generated from the package command/settings/MIME contributions, Python operation IR registry, and canonical protocol schema. `npm run reference:check` reproduces it in memory and fails on byte-level drift as part of every strict check and package build.
- The extension contributes a native Getting Started walkthrough plus Open Source File and Open Getting Started commands. The extension-host suite verifies all 21 public commands and the walkthrough contribution against a real VS Code host.
- `npm run check`, all 20 TypeScript and 62 Python tests, the VS Code 1.128 extension-host suite, production build, and 51-entry VSIX allowlist verification passed.

This closes public-interface documentation drift and command-surface gaps, but does not advance feature rows to **Done** without the remaining packaged cross-editor acceptance.

## Explicitly deferred from 1.0

Copilot operations, Spark, DuckDB, non-dataframe tensor/list renderers, telemetry, and vscode.dev runtime support are out of scope. They must not block the 1.0 matrix and must not be represented as supported.
