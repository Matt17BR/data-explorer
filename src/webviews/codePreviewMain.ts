import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const host = document.querySelector<HTMLElement>("#root");
if (!host) throw new Error("Code Preview root was not found.");

let applyingHostUpdate = false;
const pythonHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--vscode-symbolIcon-keywordForeground, #c586c0)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--vscode-symbolIcon-stringForeground, #ce9178)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--vscode-symbolIcon-numberForeground, #b5cea8)" },
  { tag: [tags.comment, tags.docComment], color: "var(--vscode-descriptionForeground, #6a9955)", fontStyle: "italic" },
  { tag: tags.function(tags.variableName), color: "var(--vscode-symbolIcon-functionForeground, #dcdcaa)" },
  { tag: [tags.typeName, tags.className], color: "var(--vscode-symbolIcon-classForeground, #4ec9b0)" },
  { tag: [tags.propertyName, tags.variableName], color: "var(--vscode-editor-foreground, #d4d4d4)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--vscode-editor-foreground, #d4d4d4)" }
]);
const editor = new EditorView({
  parent: host,
  state: EditorState.create({
    doc: "# Open a dataframe to preview generated code.",
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      python(),
      syntaxHighlighting(pythonHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorState.tabSize.of(4),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Editable generated Python code preview",
        spellcheck: "false"
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingHostUpdate) {
          vscode.postMessage({ kind: "codeChanged", code: update.state.doc.toString() });
        }
      }),
      EditorView.theme({
        "&": {
          height: "100vh",
          color: "var(--vscode-editor-foreground)",
          backgroundColor: "var(--vscode-editor-background)"
        },
        ".cm-content": {
          caretColor: "var(--vscode-editorCursor-foreground)",
          fontFamily: "var(--vscode-editor-font-family, monospace)",
          fontSize: "var(--vscode-editor-font-size, 12px)"
        },
        ".cm-gutters": {
          color: "var(--vscode-editorLineNumber-foreground)",
          backgroundColor: "var(--vscode-editorGutter-background, var(--vscode-editor-background))",
          borderRight: "1px solid var(--vscode-panel-border)"
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          backgroundColor: "var(--vscode-editor-lineHighlightBackground)"
        },
        ".cm-focused .cm-selectionBackground, ::selection": {
          backgroundColor: "var(--vscode-editor-selectionBackground) !important"
        },
        ".cm-scroller": {
          fontFamily: "var(--vscode-editor-font-family, monospace)",
          lineHeight: "1.45"
        }
      })
    ]
  })
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== window.location.origin) return;
  const message = event.data;
  if (
    typeof message !== "object" ||
    message === null ||
    !("kind" in message) ||
    message.kind !== "codePreview" ||
    !("code" in message) ||
    typeof message.code !== "string"
  ) {
    return;
  }
  if (editor.state.doc.toString() === message.code) return;
  applyingHostUpdate = true;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: message.code } });
  applyingHostUpdate = false;
});

vscode.postMessage({ kind: "ready" });
