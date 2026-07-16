# Contributing to Open Wrangler

Open Wrangler welcomes bug fixes, tests, documentation, and product improvements. Read `AGENTS.md` and the linked architecture and testing documents before making changes.

## Development setup

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run build
npm test
```

Set `OPEN_WRANGLER_PYTHON` when the development interpreter is not `.venv/bin/python`.

## Pull requests

- Keep a pull request limited to one documented milestone or issue.
- Add or update tests with every behavior change.
- Update the documentation listed in the `AGENTS.md` matrix.
- Run `npm run generate:reference` after changing commands, settings, operations, protocol messages, or notebook MIME types; never hand-edit `docs/reference.md`.
- Include screenshots for visible changes in light, dark, and high-contrast themes.
- Do not commit generated VSIX files, local virtual environments, editor profiles, notebook execution caches, or user scratch files.

All required checks must pass before merge. Feature work is tested in both VS Code and Cursor before a prerelease.
