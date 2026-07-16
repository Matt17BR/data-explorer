# Releasing

## Version policy

Numeric `0.<odd-minor>.x` releases are preview-channel checkpoints and keep `package.json.preview` set to `true`; do not encode the channel in a hyphenated manifest version. GitHub marks their releases as prereleases. Before any preview is sent to the Visual Studio Marketplace, the release workflow must build the one canonical artifact with `vsce package --pre-release` as required by the [official VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), then upload those exact bytes. The [official Open VSX publishing guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions) currently documents `ovsx publish <file>` but no equivalent prerelease flag, so its channel behavior must be reverified against the live registry before that final-priority automation is implemented. `1.0.0` is allowed only after every in-scope feature-parity row is Done and all automated and manual gates pass. Update `package.json`, `python/openwrangler_runtime/version.py`, `CHANGELOG.md`, and parity evidence in the same pull request. The Python package reads its version from `version.py`, and `npm run docs:check` rejects any extension/runtime mismatch.

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

Marketplace and Open VSX jobs are deliberately not implemented yet. They are the final release priority and may be added only after the `Matt17BR` publisher/namespace is owned and authorized in each registry and repository secrets or federated publishing credentials are configured. Verification badges are not a first-publication prerequisite. Never store tokens in the repository, workflow text, artifacts, or logs.

## Registry publication (final priority)

GitHub Releases remain the guaranteed distribution channel. Open VSX and the Visual Studio Marketplace are the last release priority, after the parity matrix, cross-platform hardening, canonical-VSIX acceptance, checksum, and GitHub prerelease are green. When implemented, the registry jobs must publish the exact checksum-verified GitHub artifact rather than rebuilding it.

The project owner must complete the identity and agreement steps that an agent cannot perform:

1. Reserve the exact `Matt17BR` publisher identifier in both registries so the single `package.json` identity works everywhere. Do not create a differently cased or alternate namespace without first changing and revalidating the package identity.
2. For Open VSX, create an Eclipse account whose GitHub Username matches the GitHub account used to sign in to Open VSX, link both accounts, sign the Eclipse Foundation Open VSX Publisher Agreement, generate a dedicated CI access token, create the `Matt17BR` namespace, and optionally claim verified ownership. Store the token only as a protected GitHub environment secret such as `OVSX_PAT`; never paste it into an issue, task, file, or log.
3. For the Visual Studio Marketplace, create the `Matt17BR` publisher in the publisher-management portal, accept its agreement, and retain owner access. A first verified VSIX may be uploaded manually. For automation, prefer Microsoft's current Entra workload-identity path: provision the Azure/Azure DevOps identity and service connection, then add that identity to the publisher as a Contributor. A transitional `VSCE_PAT` must have **Marketplace: Manage** across all accessible organizations, live only in protected repository secrets, and be treated as temporary because Microsoft retires global Azure DevOps PATs on December 1, 2026.
4. Approve the protected `publishing` GitHub environment and authorize implementation of the registry jobs only after a dry run confirms publisher ownership, artifact identity, each registry's then-current release-channel behavior, README/icon rendering, and rollback contacts.

The agent owns the reproducible workflow, package metadata, dry-run checks, exact-artifact handoff, release notes, and post-publish install verification. The project owner retains registry accounts, signs agreements, provisions identities or tokens, stores secrets, and gives the final publication approval.
