import { describe, expect, it } from "vitest";
import { ignoreRetiredRendererProbeFailure, isRetiredRendererTarget } from "./extensionHost/playwrightLifecycle";

interface FakeFrame {
  isDetached(): boolean;
}

interface FakePage {
  isClosed(): boolean;
  mainFrame(): FakeFrame;
}

function frame(detached = false): FakeFrame {
  return { isDetached: () => detached };
}

function page(mainFrame: FakeFrame, closed = false): FakePage {
  return {
    isClosed: () => closed,
    mainFrame: () => mainFrame
  };
}

const connectedBrowser = { isConnected: () => true };

describe("notebook renderer Playwright lifecycle", () => {
  it("retires a closed auxiliary page without treating the workbench as closed", () => {
    const workbench = page(frame());
    const auxiliary = page(frame(true), true);

    expect(isRetiredRendererTarget(workbench, auxiliary, auxiliary.mainFrame())).toBe(true);
    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        connectedBrowser,
        auxiliary,
        auxiliary.mainFrame(),
        new Error("target closed")
      )
    ).not.toThrow();
  });

  it("retires detached renderer frames, including workbench child frames", () => {
    const workbenchMain = frame();
    const workbench = page(workbenchMain);
    const rendererFrame = frame(true);

    expect(isRetiredRendererTarget(workbench, workbench, rendererFrame)).toBe(true);
    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        connectedBrowser,
        workbench,
        rendererFrame,
        new Error("frame detached")
      )
    ).not.toThrow();
  });

  it("fails closed when the workbench closes", () => {
    const workbenchMain = frame(true);
    const workbench = page(workbenchMain, true);
    const auxiliary = page(frame(true), true);
    const error = new Error("workbench closed");

    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, auxiliary, auxiliary.mainFrame(), error)
    ).toThrow(error);
  });

  it("fails closed when the CDP browser disconnects", () => {
    const workbench = page(frame());
    const auxiliary = page(frame(true), true);
    const error = new Error("browser disconnected");

    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        { isConnected: () => false },
        auxiliary,
        auxiliary.mainFrame(),
        error
      )
    ).toThrow(error);
  });

  it("does not retire the detached workbench main frame", () => {
    const workbenchMain = frame(true);
    const workbench = page(workbenchMain);
    const error = new Error("main frame detached");

    expect(isRetiredRendererTarget(workbench, workbench, workbenchMain)).toBe(false);
    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, workbench, workbenchMain, error)
    ).toThrow(error);
  });

  it("rethrows an unrelated locator failure from a live target", () => {
    const workbench = page(frame());
    const auxiliaryMain = frame();
    const auxiliary = page(auxiliaryMain);
    const error = new Error("locator failed");

    expect(isRetiredRendererTarget(workbench, auxiliary, auxiliaryMain)).toBe(false);
    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, auxiliary, auxiliaryMain, error)
    ).toThrow(error);
  });
});
