# Third-party notices

Open Wrangler is distributed under the MIT License. Its production webview bundles include the following independently licensed projects:

- CodeMirror and Lezer, including their bundled support packages — MIT License.
- React, React DOM, and Scheduler — MIT License.
- Codicons font from `@vscode/codicons` — Creative Commons Attribution 4.0 International (CC-BY-4.0).

The bundled pure-Python runtime interoperates with, but does not redistribute, the following packages from the user's selected environment:

- Pandas — BSD 3-Clause License. Loaded from the user's selected Python environment.
- Polars — MIT License. Loaded from the user's selected Python environment.
- PyArrow — Apache License 2.0. Loaded when required by a selected format/engine.
- openpyxl — MIT License. Loaded when required for Excel files.
- fastexcel — MIT License. Loaded when Polars opens Excel files.

Build and test tooling is not shipped in the VSIX. `npm run license:check` rejects a new bundled production package until its SPDX license and notice group are explicitly approved. Microsoft Data Wrangler is a behavioral reference only; its code and assets are not included.
