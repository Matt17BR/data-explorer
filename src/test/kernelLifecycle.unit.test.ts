import { describe, expect, it, vi } from "vitest";
import {
  KernelRequestCancelledError,
  RestartableKernel,
  withKernelTimeout
} from "../extension/notebooks/kernelLifecycle";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("single-flights concurrent acquisition and bootstrap", async () => {
    const acquired = deferred<{ generation: number }>();
    const bootstrapped = deferred<void>();
    const acquire = vi.fn(() => acquired.promise);
    const bootstrap = vi.fn(() => bootstrapped.promise);
    const execute = vi.fn(async (kernel: { generation: number }) => kernel.generation);
    const lifecycle = new RestartableKernel(acquire);

    const first = lifecycle.run(bootstrap, execute);
    const second = lifecycle.run(bootstrap, execute);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    acquired.resolve({ generation: 1 });
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    bootstrapped.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reacquires and retries an explicitly idempotent dispatched request once", async () => {
    const kernels = [{ generation: 1 }, { generation: 2 }];
    const acquire = vi.fn(async () => kernels.shift()!);
    const bootstrap = vi.fn(async () => undefined);
    const execute = vi.fn(async (kernel: { generation: number }) => {
      if (kernel.generation === 1) throw new Error("kernel restarted");
      return kernel.generation;
    });

    await expect(
      new RestartableKernel(acquire).run(bootstrap, execute, {
        retryAfterDispatch: true,
        shouldRetry: () => true
      })
    ).resolves.toBe(2);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("never replays an ambiguous dispatched mutation", async () => {
    const acquire = vi.fn(async () => ({ generation: 1 }));
    const execute = vi.fn(async () => {
      throw new Error("response lost after dispatch");
    });

    await expect(
      new RestartableKernel(acquire).run(async () => undefined, execute, {
        shouldRetry: () => true
      })
    ).rejects.toThrow("response lost after dispatch");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry acquisition failure or cancellation", async () => {
    const deniedAcquire = vi.fn(async () => {
      throw new Error("permission denied");
    });
    await expect(
      new RestartableKernel(deniedAcquire).run(
        async () => undefined,
        async () => undefined,
        { shouldRetry: (_error, phase) => phase !== "acquire" }
      )
    ).rejects.toThrow("permission denied");
    expect(deniedAcquire).toHaveBeenCalledTimes(1);

    const acquire = vi.fn(async () => ({ generation: 1 }));
    const cancelled = new KernelRequestCancelledError();
    await expect(
      new RestartableKernel(acquire).run(
        async () => undefined,
        async () => undefined,
        {
          beforeDispatch: () => {
            throw cancelled;
          },
          shouldRetry: () => false
        }
      )
    ).rejects.toBe(cancelled);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale execution failure invalidate its replacement", async () => {
    const firstExecution = deferred<number>();
    const kernels = [{ generation: 1 }, { generation: 2 }];
    const acquire = vi.fn(async () => kernels.shift()!);
    const bootstrap = vi.fn(async () => undefined);
    const lifecycle = new RestartableKernel(acquire);

    const stale = lifecycle.run(bootstrap, (kernel) =>
      kernel.generation === 1 ? firstExecution.promise : Promise.resolve(kernel.generation)
    );
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    lifecycle.invalidate();
    await expect(lifecycle.run(bootstrap, async (kernel) => kernel.generation)).resolves.toBe(2);

    firstExecution.reject(new Error("late generation-one failure"));
    await expect(stale).rejects.toThrow("late generation-one failure");
    await expect(lifecycle.run(bootstrap, async (kernel) => kernel.generation)).resolves.toBe(2);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it("rejects a late successful result from an invalidated generation", async () => {
    const firstExecution = deferred<number>();
    const kernels = [{ generation: 1 }, { generation: 2 }];
    const acquire = vi.fn(async () => kernels.shift()!);
    const bootstrap = vi.fn(async () => undefined);
    const lifecycle = new RestartableKernel(acquire);

    const stale = lifecycle.run(bootstrap, (kernel) =>
      kernel.generation === 1 ? firstExecution.promise : Promise.resolve(kernel.generation)
    );
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    lifecycle.invalidate();
    await expect(lifecycle.run(bootstrap, async (kernel) => kernel.generation)).resolves.toBe(2);

    firstExecution.resolve(1);
    await expect(stale).rejects.toThrow("stale kernel generation");
    await expect(lifecycle.run(bootstrap, async (kernel) => kernel.generation)).resolves.toBe(2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale acquisition failure clear a replacement", async () => {
    const staleAcquisition = deferred<{ generation: number }>();
    const replacement = { generation: 2 };
    const acquire = vi
      .fn<() => Promise<{ generation: number }>>()
      .mockImplementationOnce(() => staleAcquisition.promise)
      .mockResolvedValueOnce(replacement);
    const lifecycle = new RestartableKernel(acquire);
    const stale = lifecycle.run(
      async () => undefined,
      async (kernel) => kernel.generation
    );
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    lifecycle.invalidate();

    await expect(
      lifecycle.run(
        async () => undefined,
        async (kernel) => kernel.generation
      )
    ).resolves.toBe(2);
    staleAcquisition.reject(new Error("late acquisition failure"));
    await expect(stale).rejects.toThrow("late acquisition failure");
    await expect(
      lifecycle.run(
        async () => undefined,
        async (kernel) => kernel.generation
      )
    ).resolves.toBe(2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung acquisition and lets the next request acquire a replacement", async () => {
    vi.useFakeTimers();
    try {
      const hungAcquisition = deferred<{ generation: number }>();
      const acquire = vi
        .fn<() => Promise<{ generation: number }>>()
        .mockImplementationOnce(() => hungAcquisition.promise)
        .mockResolvedValueOnce({ generation: 2 });
      const lifecycle = new RestartableKernel(acquire);
      const operation = lifecycle.run(
        async () => undefined,
        async (kernel) => kernel.generation
      );
      const bounded = withKernelTimeout(operation, 40, () => lifecycle.invalidate());
      const rejection = expect(bounded).rejects.toThrow("timed out after 40 ms");

      await vi.advanceTimersByTimeAsync(40);
      await rejection;
      await expect(
        lifecycle.run(
          async () => undefined,
          async (kernel) => kernel.generation
        )
      ).resolves.toBe(2);

      hungAcquisition.resolve({ generation: 1 });
      await expect(operation).rejects.toThrow("stale kernel generation");
      expect(acquire).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the end-to-end deadline after bootstrap", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => new Promise<never>(() => undefined));
      const lifecycle = new RestartableKernel(async () => ({}));
      const operation = lifecycle.run(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }, execute);
      const bounded = withKernelTimeout(operation, 250, () => lifecycle.invalidate());
      const rejection = expect(bounded).rejects.toThrow("timed out after 250 ms");

      await vi.advanceTimersByTimeAsync(200);
      expect(execute).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the end-to-end deadline for an idempotent retry", async () => {
    vi.useFakeTimers();
    try {
      const acquire = vi
        .fn<() => Promise<{ generation: number }>>()
        .mockResolvedValueOnce({ generation: 1 })
        .mockResolvedValueOnce({ generation: 2 });
      const execute = vi.fn((kernel: { generation: number }) => {
        if (kernel.generation === 1) {
          return new Promise<number>((_resolve, reject) =>
            setTimeout(() => reject(new Error("kernel restarted")), 200)
          );
        }
        return new Promise<number>(() => undefined);
      });
      const lifecycle = new RestartableKernel(acquire);
      const operation = lifecycle.run(async () => undefined, execute, {
        retryAfterDispatch: true,
        shouldRetry: () => true
      });
      const bounded = withKernelTimeout(operation, 250, () => lifecycle.invalidate());
      const rejection = expect(bounded).rejects.toThrow("timed out after 250 ms");

      await vi.advanceTimersByTimeAsync(200);
      expect(execute).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(acquire).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an ambiguous execution when its outer deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const execution = deferred<number>();
      const acquire = vi.fn(async () => ({}));
      const execute = vi.fn(() => execution.promise);
      const lifecycle = new RestartableKernel(acquire);
      const operation = lifecycle.run(async () => undefined, execute, {
        shouldRetry: () => true
      });
      const bounded = withKernelTimeout(operation, 30, () => lifecycle.invalidate());
      const rejection = expect(bounded).rejects.toThrow("timed out after 30 ms");

      await vi.advanceTimersByTimeAsync(30);
      await rejection;
      execution.reject(new KernelRequestCancelledError());
      await expect(operation).rejects.toBeInstanceOf(KernelRequestCancelledError);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a second execution failure without looping", async () => {
    const acquire = vi.fn(async () => ({}));
    const execute = vi.fn(async () => {
      throw new Error("still unavailable");
    });
    await expect(
      new RestartableKernel(acquire).run(async () => undefined, execute, {
        retryAfterDispatch: true,
        shouldRetry: () => true
      })
    ).rejects.toThrow("still unavailable");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("cancels work and reports one end-to-end configured timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = withKernelTimeout(new Promise<never>(() => undefined), 250, cancel);
    const rejection = expect(pending).rejects.toThrow("timed out after 250 ms");
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("rejects a hung operation immediately when its external token is cancelled", async () => {
    const listeners = new Set<() => void>();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
    const onCancellation = vi.fn();
    const pending = withKernelTimeout(new Promise<never>(() => undefined), 60_000, vi.fn(), token, onCancellation);
    token.isCancellationRequested = true;
    for (const listener of listeners) listener();

    await expect(pending).rejects.toBeInstanceOf(KernelRequestCancelledError);
    expect(onCancellation).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});
