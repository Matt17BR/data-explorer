# Security policy

## Supported versions

Security fixes are applied to the latest prerelease until Open Wrangler 1.0 is published. After 1.0, the latest minor release receives fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability involving arbitrary code execution, path handling, dependency installation, notebook kernels, webview messaging, or exported data. Instead, use GitHub's private vulnerability reporting for `Matt17BR/openwrangler` and include reproduction steps, affected versions, and expected impact.

Open Wrangler executes user-requested dataframe and custom-code operations in the selected Python environment. Workspace Trust and explicit confirmations reduce accidental execution but are not a security sandbox.

Every pull request audits production npm dependencies, the Python environment, and bundled dependency licenses. `npm run license:check` fails when a production package has an unapproved SPDX license or is absent from `THIRD_PARTY_NOTICES.md`; package allowlisting separately rejects development files and credentials from the VSIX.
