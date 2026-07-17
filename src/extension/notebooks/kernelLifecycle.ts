export type KernelLifecyclePhase = "acquire" | "bootstrap" | "beforeDispatch" | "execute";

export interface RestartableKernelRunOptions {
  /**
   * Execution may have reached the kernel before it failed. Retrying that phase
   * is therefore opt-in and is reserved for requests that are explicitly
   * idempotent.
   */
  retryAfterDispatch?: boolean;
  shouldRetry?: (error: unknown, phase: KernelLifecyclePhase) => boolean;
  /** Runs immediately before user code is handed to the kernel. */
  beforeDispatch?: () => void;
}

interface KernelGeneration<TKernel> {
  readonly kernel: TKernel;
  bootstrapped: boolean;
  bootstrapPromise?: Promise<void>;
}

interface KernelAcquisition<TKernel> {
  readonly promise: Promise<KernelGeneration<TKernel>>;
}

export interface KernelCancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class KernelRequestCancelledError extends Error {
  constructor() {
    super("Open Wrangler kernel request was cancelled.");
    this.name = "KernelRequestCancelledError";
  }
}

class StaleKernelGenerationError extends Error {
  constructor() {
    super("Open Wrangler ignored work from a stale kernel generation.");
    this.name = "StaleKernelGenerationError";
  }
}

export class RestartableKernel<TKernel> {
  private generation: KernelGeneration<TKernel> | undefined;
  private acquisition: KernelAcquisition<TKernel> | undefined;

  constructor(private readonly acquire: () => Promise<TKernel>) {}

  async run<TResult>(
    bootstrap: (kernel: TKernel) => Promise<void>,
    execute: (kernel: TKernel) => Promise<TResult>,
    options: RestartableKernelRunOptions = {}
  ): Promise<TResult> {
    for (let attempt = 0; ; attempt += 1) {
      let generation: KernelGeneration<TKernel> | undefined;
      let phase: KernelLifecyclePhase = "acquire";
      let dispatched = false;
      try {
        generation = await this.current();
        phase = "bootstrap";
        this.assertCurrent(generation);
        await this.ensureBootstrapped(generation, bootstrap);
        this.assertCurrent(generation);
        phase = "beforeDispatch";
        options.beforeDispatch?.();
        dispatched = true;
        phase = "execute";
        const result = await execute(generation.kernel);
        this.assertCurrent(generation);
        return result;
      } catch (error) {
        // A failed bootstrap or execution leaves that generation's state
        // uncertain. The identity check prevents a late failure from clearing a
        // replacement installed by another request.
        if (generation && (phase === "bootstrap" || phase === "execute")) {
          this.invalidateGeneration(generation);
        }
        const canRetryPhase = !dispatched || options.retryAfterDispatch === true;
        if (attempt > 0 || !canRetryPhase || options.shouldRetry?.(error, phase) !== true) {
          throw error;
        }
      }
    }
  }

  /**
   * Detaches the current generation and any in-flight acquisition. Promises
   * that settle later retain their own result but can no longer publish it as
   * the lifecycle's active kernel.
   */
  invalidate(): void {
    this.generation = undefined;
    this.acquisition = undefined;
  }

  private invalidateGeneration(expected: KernelGeneration<TKernel>): void {
    if (this.generation === expected) this.generation = undefined;
  }

  private current(): Promise<KernelGeneration<TKernel>> {
    if (this.generation) return Promise.resolve(this.generation);
    if (this.acquisition) return this.acquisition.promise;

    const promise = Promise.resolve()
      .then(() => this.acquire())
      .then(
        (kernel) => {
          const generation: KernelGeneration<TKernel> = { kernel, bootstrapped: false };
          if (this.acquisition?.promise === promise) {
            this.acquisition = undefined;
            this.generation = generation;
          }
          return generation;
        },
        (error: unknown) => {
          if (this.acquisition?.promise === promise) this.acquisition = undefined;
          throw error;
        }
      );
    this.acquisition = { promise };
    return promise;
  }

  private async ensureBootstrapped(
    generation: KernelGeneration<TKernel>,
    bootstrap: (kernel: TKernel) => Promise<void>
  ): Promise<void> {
    this.assertCurrent(generation);
    if (generation.bootstrapped) return;
    generation.bootstrapPromise ??= (async () => {
      await bootstrap(generation.kernel);
      this.assertCurrent(generation);
      generation.bootstrapped = true;
    })();

    const bootstrapPromise = generation.bootstrapPromise;
    try {
      await bootstrapPromise;
    } catch (error) {
      if (generation.bootstrapPromise === bootstrapPromise) generation.bootstrapPromise = undefined;
      throw error;
    }
  }

  private assertCurrent(generation: KernelGeneration<TKernel>): void {
    if (this.generation !== generation) throw new StaleKernelGenerationError();
  }
}

export async function withKernelTimeout<TResult>(
  work: Promise<TResult>,
  timeoutMs: number,
  onTimeout: () => void,
  cancellation?: KernelCancellationLike,
  onCancellation: () => void = () => undefined
): Promise<TResult> {
  let timeout: NodeJS.Timeout | undefined;
  let cancellationSubscription: { dispose(): void } | undefined;
  let aborted = false;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const abort = (error: Error, callback: () => void): void => {
          if (aborted) return;
          aborted = true;
          callback();
          reject(error);
        };
        timeout = setTimeout(
          () => abort(new Error(`Open Wrangler kernel request timed out after ${timeoutMs} ms.`), onTimeout),
          Math.max(0, timeoutMs)
        );
        cancellationSubscription = cancellation?.onCancellationRequested(() =>
          abort(new KernelRequestCancelledError(), onCancellation)
        );
        if (cancellation?.isCancellationRequested) {
          abort(new KernelRequestCancelledError(), onCancellation);
        }
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    cancellationSubscription?.dispose();
  }
}
