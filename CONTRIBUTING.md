# Contributing to Data Explorer

Data Explorer welcomes bug fixes, tests, documentation, and product improvements. Read `AGENTS.md` and the linked architecture and testing documents before making changes.

## Development setup

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run build
npm test
```

Set `DATA_EXPLORER_PYTHON` when the development interpreter is not `.venv/bin/python`.

## Pull requests

- Keep a pull request limited to one documented milestone or issue.
- Add or update tests with every behavior change.
- Update the documentation listed in the `AGENTS.md` matrix.
- Include screenshots for visible changes in light, dark, and high-contrast themes.
- Do not commit generated VSIX files, local virtual environments, editor profiles, notebook execution caches, or user scratch files.

All required checks must pass before merge. Feature work is tested in both VS Code and Cursor before a prerelease.
