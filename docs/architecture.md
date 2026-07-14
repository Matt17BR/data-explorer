# Architecture

## Product boundaries

Data Explorer has three cooperating processes:

1. The VS Code extension host owns commands, trusted-workspace enforcement, editor and view providers, session coordination, filesystem prompts, runtime processes, and Jupyter access.
2. Sandboxed webviews render the editor grid and auxiliary views. They receive validated state snapshots and send typed user intents; they never read files or execute Python directly.
3. The bundled Python runtime executes dataframe queries and transformation plans in either a standalone selected interpreter or the active Jupyter kernel.

The source dataframe is immutable from Data Explorer's perspective. A session stores a source descriptor, import options, engine, independent viewing query, committed transformation steps, optional draft step, and revision. Export is the only operation that writes data, and it always targets an explicit destination.

## Runtime and engines

The runtime exposes one protocol across standalone and notebook transports. Requests are correlated and versioned. Standalone requests use a framed standard-input/standard-output transport; notebook requests use the stable Jupyter kernel API and a marker-delimited encoded envelope.

Pandas and Polars adapters implement the same engine contract for schema, blocks, profiling, viewing queries, transformations, code generation, and exports. Engine results must agree on semantic output while generated code remains idiomatic to the source engine. Polars adapters may use eager frames for notebook values and lazy scans/plans for files; they never convert through Pandas.

Sessions serialize operations within a dataframe, can run independently of other sessions, and have bounded caches. Closing an editor releases its session. Runtime loss invalidates caches, rejects pending requests, and allows the extension to recreate file sessions or reacquire a notebook kernel and replay the serialized plan.

## UI composition

The data grid is a custom readonly editor because opening and cleaning a source does not mutate that document. Data Explorer contributes native view containers for Operations, Summary, Filters/Sorts, Cleaning Steps, and Code Preview. A session coordinator publishes the active editor's state to these views and routes actions back to the correct runtime session.

Grid blocks are columnar and use stable row/column identities. Rows and columns are virtualized; summaries and insights load progressively for visible columns. Webviews use VS Code theme tokens, external assets, nonce-protected scripts, validated messages, and accessible grid/menu/form semantics.

## Persistence and compatibility

Serializable import options, viewing state, widths, and transformation steps are stored by source URI. Binary dataframe content is never persisted. Notebook sessions can only replay when their variable exists again.

Protocol v2 is the active internal contract. Notebook MIME v1 remains renderable so saved notebook output does not break; new helpers emit MIME v2.
