# Data Explorer

Data Explorer is a visualization-first VS Code extension for exploring dataframes and local data files. It focuses on fast viewing, paging, summaries, and Excel-like filters instead of transformation pipelines.

It is loosely inspired by Microsoft’s VS Code Data Wrangler experience, but it is an independent implementation. Data Wrangler is closed source, which makes it difficult to contribute features upstream, adapt it for VS Code forks such as Cursor, or implement backend-native features like first-class Polars support. Data Explorer exists to make that exploration layer open, hackable, and Polars-friendly from the start.

## Screenshots

![Data Explorer grid view](docs/images/grid-view.png)

![Excel-like filter panel](docs/images/filter-panel.png)

![Notebook preview](docs/images/notebook-preview.png)

## Features

- Native Polars and Pandas runtime backends.
- Direct launch for CSV, TSV, Parquet, JSONL, XLSX, and XLS files.
- Paged dataframe grid with sticky headers and row numbers.
- Column schema, summary statistics, top values, and missing value counts.
- Multi-column sorting and column filters from the webview.
- Notebook variable launch command for Pandas and Polars dataframe names.
- Lightweight notebook output renderer for `data_wrangler_runtime.notebook.show(...)`.

## Example Usage

### Open a file

1. Install the extension in Cursor or VS Code.
2. Right-click a `.csv`, `.tsv`, `.parquet`, `.jsonl`, `.xlsx`, or `.xls` file.
3. Choose **Data Explorer: Open Current File**.
4. Use the left panel to select columns, search values, add predicates, and sort.

File-backed sessions default to Polars. Change `dataExplorer.defaultBackend` to `pandas` if you want Pandas file loading instead.

### Open a notebook variable

Use **Data Explorer: Open Notebook Variable** from a Jupyter notebook and enter the dataframe variable name:

```python
import polars as pl

df = pl.read_csv("sales.csv")
```

Data Explorer detects Polars and Pandas dataframe variables and opens them with the matching backend.

### Render an inline notebook preview

```python
import polars as pl
from data_wrangler_runtime.notebook import show

df = pl.read_csv("sales.csv")
show(df, label="sales")
```

This emits `application/vnd.data-explorer.viewer.v1+json`, which the bundled notebook renderer displays as a compact grid preview.

## Polars Support

Polars dataframes stay Polars in the runtime. The Polars backend uses native operations for:

- file reads with `polars.read_csv`, `read_parquet`, `read_ndjson`, and `read_excel`
- paging with `slice`
- filters with Polars expressions
- sorting with `DataFrame.sort`
- summaries with Polars null counts, distinct counts, value counts, and numeric aggregates

The test suite asserts that Polars file sessions do not call `to_pandas()`.

## Install Locally In Cursor

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run build
npm run package
cursor --install-extension data-explorer-0.1.0.vsix --force
```

The extension setting `dataExplorer.pythonPath` defaults to `.venv/bin/python`, so the local development install uses the editable runtime environment above.

## Development

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run build
npm test
```

Useful checks:

```bash
npm run test:ts
npm run test:python
npm run build
npm run package
```

Run the extension from Cursor or VS Code with `Launch Extension`, or package it with:

```bash
npm run package
```

## Current Scope

Data Explorer currently prioritizes visualization and exploration:

- grid viewing
- file-backed sessions
- notebook variable and notebook output entry points
- filters, sorting, schema, and summaries

It intentionally does not yet implement Data Wrangler-style cleaning step history, transform code generation, or by-example/FlashFill operations.
