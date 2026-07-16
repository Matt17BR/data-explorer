import * as vscode from "vscode";
import { PythonBridge } from "./pythonBridge";
import { getSetting, updateSetting } from "./configuration";

export function registerRuntimeCommands(context: vscode.ExtensionContext, bridge: PythonBridge): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.changeRuntime", async (providedPath?: unknown) => {
      const current = getSetting<string>("pythonPath", "");
      const selected =
        typeof providedPath === "string"
          ? providedPath
          : await vscode.window.showInputBox({
              title: "Change Open Wrangler Python Runtime",
              prompt:
                "Enter a Python 3.10-3.14 executable path. Leave the setting empty to use the Python extension selection.",
              value: current,
              placeHolder: "/path/to/python"
            });
      if (selected === undefined) return;
      await updateSetting("pythonPath", selected.trim() || undefined, vscode.ConfigurationTarget.Workspace);
      bridge.clearRuntimeSelection();
      void vscode.window.showInformationMessage("Open Wrangler will use the new Python runtime for the next request.");
      return selected.trim();
    }),
    vscode.commands.registerCommand("openWrangler.clearRuntime", async () => {
      await updateSetting("pythonPath", undefined, vscode.ConfigurationTarget.Workspace);
      bridge.clearRuntimeSelection();
      void vscode.window.showInformationMessage(
        "Open Wrangler will use the selected Python extension environment, then a system interpreter."
      );
      return true;
    }),
    vscode.commands.registerCommand("openWrangler.installRuntimeDependencies", (confirmed?: unknown) =>
      bridge.installMissingDependencies(typeof confirmed === "boolean" ? confirmed : undefined)
    )
  );
}
