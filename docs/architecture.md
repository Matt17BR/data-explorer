# Architecture

## Product boundaries

Data Explorer has three cooperating processes:

1. The VS Code extension host owns commands, trusted-workspace enforcement, editor and view providers, session coordination, filesystem prompts, runtime processes, and Jupyter access.
2. Sandboxed webviews render the editor grid and auxiliary views. They receive validated state snapshots and send typed user intents; they never read files or execute Python directly.
3. The bundled Python runtime executes dataframe queries and transformation plans in either a standalone selected interpreter or the active Jupyter kernel.

The source dataframe is immutable from Data Explorer's perspective. A session stores a source descriptor, import options, engine, independent viewing query, committed transformation steps, optional draft step, and revision. Export is the only operation that writes data, and it always targets an explicit destination.

## Runtime and engines

The runtime exposes one protocol across standalone and notebook transports. `protocol/data-explorer.v2.schema.json` is the canonical contract; `npm run generate:protocol` produces `src/shared/protocol.generated.ts`, and CI rejects stale generated types. Python's explicit decoder rejects malformed versions, correlation IDs, priorities, request shapes, revisions, and import descriptors before dispatch. Standalone requests use newline-delimited envelopes on standard input/output; notebook requests use the stable `@vscode/jupyter-extension` `kernels.getKernel()` and `executeCode()` surface with a marker-delimited encoded envelope.

Pandas and Polars adapters implement the same engine contract for schema, blocks, profiling, viewing queries, transformations, code generation, and exports. `python/data_wrangler_runtime/operations.py` is the validated operation registry and shared transformation IR boundary: it rejects unknown operations and malformed parameters before an adapter runs them. Engine results must agree on semantic output while generated code remains idiomatic to the source engine. File-backed Polars CSV/TSV, Parquet, and JSONL sessions use lazy scans; filters, multi-sort, projections, and page slices stay in the lazy plan until a bounded result is collected. Notebook values and Excel inputs may remain eager. Polars never converts through Pandas.

The extension host assigns stable public session IDs and monotonic public revisions while each runtime owns replaceable internal IDs and revisions. Sessions serialize requests within a dataframe and run concurrently across dataframes. Requests carry the current revision; stale requests and responses are rejected. Previewing a validated step creates one bounded draft frame, increments the revision, and returns a page-level typed diff plus generated code. Apply, discard, and undo each increment the revision; undo replays the validated plan from the immutable source. The input schema for the latest step is retained separately from the committed schema so structural steps remain editable after renames or drops. Closing an editor sends `closeSession`. A request timeout restarts the standalone runtime, while the coordinator recreates the source session, replays every applied step and an optional draft, restores the viewing query, and retries against its new internal ID without moving the public revision backward. Notebook execution reacquires the stable kernel API after a restart.

Runtime discovery resolves an explicit `dataExplorer.pythonPath`, then the active Python extension environment, then system interpreters. It accepts Python 3.10–3.14 and probes only engine/format-specific modules. Missing packages produce a structured diagnostic; installation always requires a modal user confirmation.

## UI composition

The data grid is a custom readonly editor because opening and cleaning a source does not mutate that document. Data Explorer contributes native view containers for Operations, Summary, Filters/Sorts, Cleaning Steps, and Code Preview. A session coordinator publishes the active editor's state to these views and routes actions back to the correct runtime session. The editor and Activity Bar share the same 26-operation registry. Each operation opens an accessible parameter form, while the bottom Code Preview uses CodeMirror with VS Code theme tokens; edited preview text is isolated from the applied plan.

Grid blocks use stable row/column identities and typed cells. Rows and columns are virtualized with bounded overscan, resizable widths, sticky headers, roving keyboard focus, and far-column focus restoration. Initial summaries cover a small leading projection; visible-column summaries and exact dataset-level missing/duplicate statistics load as lower-priority requests. Viewing queries support independent AND/OR composition within a column and across columns, plus ordered multi-sort, without entering the transformation plan. Webviews use VS Code theme tokens, external assets, nonce-protected scripts, validated messages, and accessible grid/menu/form semantics.

File commands collect delimiter, encoding, quoting, header, and Excel sheet options before opening a session. Custom-editor opens use deterministic defaults. Settings independently control file/notebook start mode, enabled file types, insights, filter mode, column width, fetch block size, code-panel reveal behavior, renderer messaging, backend selection, and the Python override.

Custom engine code is never dispatched from an untrusted workspace. The extension host enforces this independently of the webview, and the extension's workspace capability prevents all Python-backed sessions from activating before trust is granted.

## Persistence and compatibility

Serializable import options, viewing state, widths, and transformation steps are stored by source identity in VS Code workspace state. The persisted payload contains only the filter model, validated steps, and optional draft—not binary dataframe content, runtime IDs, profiles, or statistics. Reopening a source reconstructs the plan through the same preview/apply protocol before showing it; malformed or non-replayable state opens the immutable original with a warning. Notebook sessions can only replay when their variable exists again.

Protocol v2 is the active internal contract. Notebook MIME v1 remains renderable so saved notebook output does not break; new helpers emit MIME v2.
