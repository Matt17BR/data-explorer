# Releasing

## Version policy

`0.2.0-alpha.n` releases are parity-development checkpoints. `1.0.0` is allowed only after every in-scope feature-parity row is Done and all automated and manual gates pass. Update `package.json`, `CHANGELOG.md`, and parity evidence in the same pull request.

## Package gate

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run package -- --out data-explorer.vsix
npm run verify:vsix -- data-explorer.vsix
sha256sum data-explorer.vsix
```

The VSIX may contain production extension bundles, webview assets, the Python runtime source, package metadata, README, changelog, license, and third-party notices. It must not contain source TypeScript, tests, fixtures, scripts, profiles, source maps, caches, virtual environments, `.env` files, credentials, or untracked scratch files.

## GitHub workflow

Each milestone uses its own branch and pull request. Push independently green vertical slices; squash-merge only after required CI and acceptance evidence pass. Tag prereleases from `main` as `v0.2.0-alpha.n`. The release workflow builds a fresh VSIX, verifies its allowlist, publishes a SHA-256 checksum, and creates a GitHub prerelease.

Marketplace and Open VSX jobs remain disabled until `Matt17BR` is verified in both registries and repository secrets or federated publishing credentials are configured. Never store tokens in the repository, workflow text, artifacts, or logs.
