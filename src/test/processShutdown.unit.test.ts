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

    const shutdown = stopChildProcessGracefully(child, 2_000);
    expect(stopChildProcessGracefully(child, 2_000)).toBe(shutdown);

    expect(proc.actions).toEqual(["stdin.end"]);
    proc.emit("exit", 0, null);
    await expect(shutdown).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("force-kills after the grace bound but waits for confirmed exit", async () => {
    vi.useFakeTimers();
    const proc = new FakeChildProcess();

    const shutdown = stopChildProcessGracefully(proc as unknown as ChildProcessWithoutNullStreams, 2_000);
    let settled = false;
    void shutdown.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.actions).toEqual(["stdin.end", "kill"]);
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);

    proc.emit("exit", null, "SIGTERM");
    await expect(shutdown).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("fails closed when forced termination never produces exit confirmation", async () => {
    vi.useFakeTimers();
    const proc = new FakeChildProcess();
    const shutdown = stopChildProcessGracefully(proc as unknown as ChildProcessWithoutNullStreams, 10, 20);
    const rejected = expect(shutdown).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(10);
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
  });

  it("force-kills immediately when stdin cannot be ended and still awaits exit", async () => {
    vi.useFakeTimers();
    const unwritable = new FakeChildProcess();
    unwritable.stdin.writable = false;
    const unwritableShutdown = stopChildProcessGracefully(unwritable as unknown as ChildProcessWithoutNullStreams);

    const throwing = new FakeChildProcess();
    throwing.stdin.end.mockImplementation(() => {
      throw new Error("stdin failed");
    });
    const throwingShutdown = stopChildProcessGracefully(throwing as unknown as ChildProcessWithoutNullStreams);

    expect(unwritable.actions).toEqual(["kill"]);
    expect(throwing.actions).toEqual(["kill"]);
    expect(unwritable.kill).toHaveBeenCalledWith("SIGKILL");
    expect(throwing.kill).toHaveBeenCalledWith("SIGKILL");
    unwritable.emit("exit", null, "SIGTERM");
    throwing.emit("exit", null, "SIGTERM");
    await expect(unwritableShutdown).resolves.toBeUndefined();
    await expect(throwingShutdown).resolves.toBeUndefined();
  });
});
