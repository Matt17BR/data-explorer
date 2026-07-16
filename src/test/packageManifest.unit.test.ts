import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CommandContribution {
  command?: string;
  title?: string;
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
