export const allowedVsixEntryPatterns = [
  /^\[Content_Types\]\.xml$/u,
  /^extension\.vsixmanifest$/u,
  /^extension\/$/u,
  /^extension\/(package\.json|LICENSE\.txt|README\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md)$/iu,
  /^extension\/dist\/$/u,
  /^extension\/dist\/(extension|shared)\/$/u,
  /^extension\/dist\/(extension|shared)\/.+\.js$/u,
  /^extension\/media\/$/u,
  /^extension\/media\/(activity-icon\.svg|codicon\.ttf|icon(-128)?\.png|icon\.svg|codePreview\.js|notebookRenderer\.js|protocolValidation\.js|webview\.(css|js))$/u,
  /^extension\/python\/$/u,
  /^extension\/python\/openwrangler_runtime\/$/u,
  /^extension\/python\/openwrangler_runtime\/[^/]+\.py$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/[^/]+\.py$/u
];

export const requiredVsixEntries = [
  "extension/package.json",
  "extension/dist/extension/activate.js",
  "extension/dist/extension/webviewPanel.js",
  "extension/media/webview.js",
  "extension/media/webview.css",
  "extension/media/codicon.ttf",
  "extension/media/protocolValidation.js",
  "extension/media/icon.png",
  "extension/python/openwrangler_runtime/server.py",
  "extension/python/openwrangler_runtime/version.py"
];

export function inspectVsixEntries(entries) {
  return {
    forbidden: entries.filter((entry) => !allowedVsixEntryPatterns.some((pattern) => pattern.test(entry))),
    missing: requiredVsixEntries.filter((entry) => !entries.includes(entry))
  };
}
