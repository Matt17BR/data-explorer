import { describe, expect, it, vi } from "vitest";
import { RestartableKernel, withKernelTimeout } from "../extension/notebooks/kernelLifecycle";

describe("RestartableKernel", () => {
  it("acquires and bootstraps once across successful requests", async () => {
    const kernel = { generation: 1 };
    const acquire = vi.fn(async () => kernel);
    const bootstrap = vi.fn(async () => undefined);
    const lifecycle = new RestartableKernel(acquire);

    await expect(lifecycle.run(bootstrap, async (value) => value.generation)).resolves.toBe(1);
    await expect(lifecycle.run(bootstrap, async (value) => value.generation)).resolves.toBe(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("reacquires, bootstraps, and retries once after a kernel failure", async () => {
    const kernels = [{ generation: 1 }, { generation: 2 }];
    const acquire = vi.fn(async () => kernels.shift()!);
    const bootstrap = vi.fn(async () => undefined);
    const execute = vi.fn(async (kernel: { generation: number }) => {
      if (kernel.generation === 1) throw new Error("kernel restarted");
      return kernel.generation;
    });

    await expect(new RestartableKernel(acquire).run(bootstrap, execute)).resolves.toBe(2);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry permission denial, acquisition failure, or cancellation", async () => {
    const deniedAcquire = vi.fn(async () => {
      throw new Error("permission denied");
    });
    await expect(
      new RestartableKernel(deniedAcquire).run(
        async () => undefined,
        async () => undefined
      )
    ).rejects.toThrow("permission denied");
    expect(deniedAcquire).toHaveBeenCalledTimes(1);

    const acquire = vi.fn(async () => ({ generation: 1 }));
    const cancelled = new Error("cancelled");
    await expect(
      new RestartableKernel(acquire).run(
        async () => undefined,
        async () => {
          throw cancelled;
        },
        () => false
      )
    ).rejects.toBe(cancelled);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("propagates a second execution failure without looping", async () => {
    const acquire = vi.fn(async () => ({}));
    const execute = vi.fn(async () => {
      throw new Error("still unavailable");
    });
    await expect(new RestartableKernel(acquire).run(async () => undefined, execute)).rejects.toThrow(
      "still unavailable"
    );
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("cancels work and reports the configured timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = withKernelTimeout(new Promise<never>(() => undefined), 250, cancel);
    const rejection = expect(pending).rejects.toThrow("timed out after 250 ms");
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
