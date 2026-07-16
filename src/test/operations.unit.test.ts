import { describe, expect, it } from "vitest";
import { canEditLatestStep, canStartOperation } from "../shared/operations";
import type { TransformStep } from "../shared/protocol";

const appliedStep: TransformStep = {
  id: "drop-missing",
  kind: "dropMissingRows",
  params: {}
};

describe("operation entry-point predicates", () => {
  it("allows a new operation only for an editing session without a draft", () => {
    expect(canStartOperation({ mode: "editing", draftStep: undefined })).toBe(true);
    expect(canStartOperation({ mode: "viewing", draftStep: undefined })).toBe(false);
    expect(canStartOperation({ mode: "editing", draftStep: appliedStep })).toBe(false);
    expect(canStartOperation(undefined)).toBe(false);
  });

  it("allows native edit-latest actions only when an applied step exists and no draft is active", () => {
    expect(canEditLatestStep({ mode: "editing", draftStep: undefined, steps: [appliedStep] })).toBe(true);
    expect(canEditLatestStep({ mode: "editing", draftStep: undefined, steps: [] })).toBe(false);
    expect(canEditLatestStep({ mode: "editing", draftStep: appliedStep, steps: [appliedStep] })).toBe(false);
    expect(canEditLatestStep({ mode: "viewing", draftStep: undefined, steps: [appliedStep] })).toBe(false);
    expect(canEditLatestStep(undefined)).toBe(false);
  });
});
