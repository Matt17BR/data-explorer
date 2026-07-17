# Open Wrangler

Open Wrangler is an open-source dataframe viewer and cleaner for VS Code and Cursor. Open a file or notebook dataframe, explore it in a fast virtualized grid, build a repeatable cleaning plan, and export engine-native Python or cleaned data—all without changing the source.

Polars and Pandas are first-class backends. DuckDB provides a native file-backed path for larger local datasets.

> Open Wrangler is an active preview. The core viewing and editing workflows work today, but the [1.0 parity matrix](docs/feature-parity.md) still has release gates to close.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-acceptance/vscode-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/editor-acceptance/vscode-light.png">
  <img alt="Open Wrangler running in VS Code" src="docs/images/editor-acceptance/vscode-dark.png">
</picture>

## What it does

- Opens CSV, TSV, Parquet, JSONL, XLSX, and XLS files from the Explorer, editor tab, editor title bar, or Command Palette.
- Pages through wide and large datasets with row and column virtualization, typed values, keyboard navigation, column search, and progressive insights.
- Keeps filters and sorts separate from cleaning steps, so exploration never silently changes exported results.
- Previews every transformation as a data diff with editable, backend-native Python before you apply it.
- Provides 27 built-in operations across row, column, text, categorical, numeric, datetime, grouping, custom-code, and by-example workflows.
- Replays, edits, and undoes cleaning steps while preserving the original dataframe.
- Opens live Polars and Pandas variables from Jupyter and can insert the generated cleaning function back into the originating notebook.
- Copies code, saves a Python script, or atomically exports cleaned data to a new CSV or Parquet file.

<table>
  <tr>
    <th width="50%">Explore</th>
    <th width="50%">Transform</th>
  </tr>
  <tr>
    <td><img src="docs/images/grid-view.png" alt="Virtualized dataframe grid with column insights"></td>
    <td><img src="docs/images/acceptance/draft-preview-dark-1280.png" alt="Transformation preview with data diff and generated code"></td>
  </tr>
  <tr>
    <td>Filter, sort, profile, and navigate without changing the cleaning plan.</td>
    <td>Review the data diff and generated code before applying a step.</td>
  </tr>
</table>

## Install

Open Wrangler requires desktop VS Code or Cursor and Python 3.10–3.14.

Prebuilt releases are not published yet. To try the current preview from a clone of this repository:

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run package -- --out openwrangler.vsix
```

On Windows, use `py -m venv .venv` and `.venv\Scripts\python.exe` in the equivalent commands.

In the Extensions view, choose **Views and More Actions → Install from VSIX…**, select `openwrangler.vsix`, then open a supported data file and choose **Open in Open Wrangler** from its editor action or context menu. Future preview builds will appear on [GitHub Releases](https://github.com/Matt17BR/openwrangler/releases).

Open Wrangler resolves your configured Python path, selected Python environment, or a system interpreter in that order. It checks only the packages required for the chosen backend and file format. If anything is missing, it names the exact interpreter and dependencies and asks before running `pip`; it never installs packages silently.

## Engines and formats

| Backend | File sessions                   | Notebook variables | Notes                                                            |
| ------- | ------------------------------- | ------------------ | ---------------------------------------------------------------- |
| Polars  | CSV, TSV, Parquet, JSONL, Excel | Yes                | Native operations and lazy scans where the format allows         |
| DuckDB  | CSV, TSV, Parquet, JSONL        | Not yet            | Native lazy relations; no Pandas, Polars, or Arrow conversion    |
| Pandas  | CSV, TSV, Parquet, JSONL, Excel | Yes                | Position-safe support for duplicate and non-string column labels |

`auto` mode tries Polars, then DuckDB, then Pandas, skipping unavailable or incompatible choices. You can pin a backend in the Open Wrangler settings.

## Cleaning workflow

1. Filter, sort, inspect distributions, and select the columns you care about.
2. Add an operation and configure it.
3. Check the draft grid, diff, and generated code.
4. Apply or discard the draft, then export the committed plan when ready.

Applied steps form a replayable history. The latest step can be edited, steps can be undone, and viewing filters remain independent. The [generated reference](docs/reference.md) lists every operation, command, setting, and shortcut.

## Current limits

- This is a preview, not yet a claim of complete Microsoft Data Wrangler parity. Remaining evidence is tracked in [the parity matrix](docs/feature-parity.md).
- PySpark is planned, but not implemented. The [engine proposal](https://github.com/Matt17BR/openwrangler/issues/36) requires distributed execution with no full-frame collection or implicit local-dataframe conversion.
- DuckDB currently supports file-backed sessions only; Excel files and notebook variables use Polars or Pandas.
- Browser-hosted `vscode.dev` runtimes are outside the current scope.

## Develop and contribute

After the source setup above, use `npm run build` while iterating and `npm test` for the complete TypeScript and Python regression suites.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). The [architecture guide](docs/architecture.md) explains the extension/runtime boundaries, and [testing.md](docs/testing.md) covers the acceptance suites. Security issues should follow [SECURITY.md](SECURITY.md).

Open Wrangler is an independent clean-room implementation inspired by the publicly documented behavior of Microsoft Data Wrangler. It does not use Microsoft code, branding, or assets and is not affiliated with Microsoft. Licensed under [MIT](LICENSE).
