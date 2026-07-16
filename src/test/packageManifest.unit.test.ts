import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CommandContribution {
  command?: string;
  title?: string;
  shortTitle?: string;
  icon?: string;
}

interface MenuContribution {
  command?: string;
  when?: string;
  group?: string;
}

interface WalkthroughStep {
  description?: string;
}

interface PackageManifest {
  contributes?: {
    configuration?: {
      properties?: Record<string, { type?: string; default?: unknown; minimum?: number; maximum?: number }>;
    };
    configurationDefaults?: Record<string, unknown>;
    commands?: CommandContribution[];
    menus?: Record<string, MenuContribution[]>;
    walkthroughs?: Array<{ steps?: WalkthroughStep[] }>;
  };
}

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as PackageManifest;

describe("operation command contributions", () => {
  it("contributes a generic no-argument start-operation entry point", () => {
    expect(manifest.contributes?.commands).toContainEqual(
      expect.objectContaining({
        command: "openWrangler.startOperation",
        title: "Open Wrangler: Add Cleaning Step"
      })
    );
    expect(
      manifest.contributes?.walkthroughs
        ?.flatMap((walkthrough) => walkthrough.steps ?? [])
        .some((step) => step.description?.includes("(command:openWrangler.startOperation)"))
    ).toBe(true);
  });

  it("hides edit-latest from cleaning-step context menus while plan changes are unavailable", () => {
    expect(manifest.contributes?.menus?.["view/item/context"]).toContainEqual({
      command: "openWrangler.editLatestStep",
      when: "view == openWrangler.cleaningSteps && viewItem == openWrangler.latestCleaningStep && openWrangler.canChangePlan",
      group: "inline@10"
    });
  });
});

describe("file launch contributions", () => {
  const resourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|xlsx|xls)$/i";

  it("uses one canonical, compact command for every file launch surface", () => {
    expect(manifest.contributes?.configurationDefaults?.["cursor.general.pinnedTitleActions"]).toEqual([
      "openWrangler.openFile"
    ]);
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openFile",
      title: "Open in Open Wrangler",
      icon: "$(open-preview)"
    });

    expect(manifest.contributes?.menus?.["explorer/context"]).toContainEqual({
      command: "openWrangler.openFile",
      when: `!explorerResourceIsFolder && ${resourcePredicate}`,
      group: "navigation@50"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.openFile",
      when: `${resourcePredicate} && ` + "(!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)",
      group: "navigation@1"
    });
    expect(manifest.contributes?.menus?.["editor/title/context"]).toContainEqual({
      command: "openWrangler.openFile",
      when: `${resourcePredicate} && (!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)`,
      group: "navigation@50"
    });
    expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
      command: "openWrangler.launchDataViewer",
      when: "false"
    });
  });

  it("keeps the supported extension predicate case-insensitive and closed to unrelated files", () => {
    const match = /\.(csv|tsv|parquet|jsonl|xlsx|xls)$/i;
    for (const file of ["data.csv", "DATA.TSV", "frame.PARQUET", "rows.jsonl", "book.XLSX", "legacy.xls"]) {
      expect(match.test(file)).toBe(true);
    }
    expect(match.test("notes.txt")).toBe(false);
    expect(match.test("data.csv.backup")).toBe(false);
  });
});

describe("grid block configuration", () => {
  it("bounds the default horizontal fetch block", () => {
    expect(manifest.contributes?.configuration?.properties?.["openWrangler.fetchColumnBlockSize"]).toEqual(
      expect.objectContaining({
        type: "number",
        default: 16,
        minimum: 1,
        maximum: 256
      })
    );
  });
});
