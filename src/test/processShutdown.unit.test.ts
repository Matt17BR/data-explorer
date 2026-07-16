import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopChildProcessGracefully } from "../extension/processShutdown";

class FakeChildProcess extends EventEmitter {
  readonly actions: string[] = [];
  readonly stdin = {
    destroyed: false,
    writable: true,
    end: vi.fn(() => {
      this.actions.push("stdin.end");
    })
  };
  readonly kill = vi.fn(() => {
    this.actions.push("kill");
    this.killed = true;
    return true;
  });
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("graceful child-process shutdown", () => {
  it("ends stdin once and cancels the force-kill fallback after exit", async () => {
    vi.useFakeTimers();
    const proc = new FakeChildProcess();
    const child = proc as unknown as ChildProcessWithoutNullStreams;

    stopChildProcessGracefully(child, 2_000);
    stopChildProcessGracefully(child, 2_000);

    expect(proc.actions).toEqual(["stdin.end"]);
    proc.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("force-kills a process that does not exit before the bound", async () => {
    vi.useFakeTimers();
    const proc = new FakeChildProcess();

    stopChildProcessGracefully(proc as unknown as ChildProcessWithoutNullStreams, 2_000);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.actions).toEqual(["stdin.end", "kill"]);
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it("force-kills immediately when stdin cannot be ended", () => {
    vi.useFakeTimers();
    const unwritable = new FakeChildProcess();
    unwritable.stdin.writable = false;
    stopChildProcessGracefully(unwritable as unknown as ChildProcessWithoutNullStreams);

    const throwing = new FakeChildProcess();
    throwing.stdin.end.mockImplementation(() => {
      throw new Error("stdin failed");
    });
    stopChildProcessGracefully(throwing as unknown as ChildProcessWithoutNullStreams);

    expect(unwritable.actions).toEqual(["kill"]);
    expect(throwing.actions).toEqual(["kill"]);
  });
});
