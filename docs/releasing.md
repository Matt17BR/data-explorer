# Releasing

## Version policy

Numeric `0.<odd-minor>.x` releases are Marketplace-compatible preview-channel checkpoints and keep `package.json.preview` set to `true`. Publish them with the registry's explicit prerelease flag; do not encode the channel in a hyphenated manifest version. `1.0.0` is allowed only after every in-scope feature-parity row is Done and all automated and manual gates pass. Update `package.json`, `python/openwrangler_runtime/version.py`, `CHANGELOG.md`, and parity evidence in the same pull request. The Python package reads its version from `version.py`, and `npm run docs:check` rejects any extension/runtime mismatch.

## Package gate

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run package -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run test:coverage
npm run license:check
npm run benchmark:runtime
sha256sum openwrangler.vsix
```

The VSIX may contain production extension bundles, webview assets, the Python runtime source, package metadata, README, changelog, license, and third-party notices. It must not contain source TypeScript, tests, fixtures, scripts, benchmark sources, profiles, source maps, caches, virtual environments, `.env` files, credentials, or untracked scratch files. Allowlist verification also reads packaged `webview.css` and the compiled webview host: the Codicon font URL must be bundle-relative so the checked-in font resolves beside the stylesheet, and the CSP must allow `webview.cspSource` through `font-src`. After allowlist verification, `npm run test:packaged-editors -- openwrangler.vsix` must install and exercise the artifact from isolated profiles; development-host success is not a substitute. The packaged gate uses two editor processes per product to prove backend-pinned persisted-plan replay, concurrent Pandas/Polars/DuckDB crash recovery for supported file sessions, export source safety, and final process cleanup. Notebook acceptance remains Pandas/Polars-only until DuckDB kernel ownership is implemented and separately gated.

The strict runtime benchmark and Playwright cached/uncached scroll gates must pass on the Linux release reference workstation. The runtime must import Polars before timing, record an accepted per-file source-cache eviction, and keep the canonical stdio first-grid round trip below 3s for the 100k×50 CSV and 5s for the 1M×20 Parquet fixture; a warm-source median cannot substitute for this gate. The report must retain separately named direct-manager cache metrics, real stdio protocol/JSON cache-miss round trips, the same-session statistics-contention latency, active-call proof, overlap result, native-frame evidence, source/machine/package provenance, and process resource samples. An in-process timing may not be cited as product-boundary performance, and none of these numbers may be described as VS Code, Cursor, webview, or editor first paint. The isolated benchmark bootstrap must prove from `header_stats` entry/exit events that statistics remained active when the page envelope finished sending; completed-before-send or otherwise inconclusive evidence fails release. The cache-miss response gap must then prove substantial overlap against the uncontented baseline, and both ordinary and contended stdio pages must remain within 500ms. Attach the generated `tmp/performance/report.json` values to parity evidence; opt-in Pandas and DuckDB smoke reports prove native coverage but do not replace the strict Polars release gate. Scheduled CI reports provide regression history but do not replace final local acceptance.

## GitHub workflow

Each milestone uses its own branch and pull request. Push independently green vertical slices; squash-merge only after required CI and acceptance evidence pass. Tag a preview release from `main` with the exact numeric manifest version, for example `v0.3.0`. The release workflow builds and verifies one canonical VSIX, distributes those exact bytes to the cross-platform validation matrix, publishes its SHA-256 checksum, and creates a GitHub prerelease because the manifest's preview flag is enabled.

Tag builds first validate packaging and tests on Linux/Python 3.10, macOS/Python 3.12, and Windows/Python 3.14. The Linux release job runs only after that matrix succeeds.

Marketplace and Open VSX jobs remain disabled until the `Matt17BR` publisher/namespace is owned and authorized in each registry and repository secrets or federated publishing credentials are configured. Verification badges are not a first-publication prerequisite. Never store tokens in the repository, workflow text, artifacts, or logs.
