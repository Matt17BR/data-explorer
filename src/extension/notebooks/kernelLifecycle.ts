export class RestartableKernel<TKernel> {
  private kernel: TKernel | undefined;
  private bootstrapped = false;

  constructor(private readonly acquire: () => Promise<TKernel>) {}

  async run<TResult>(
    bootstrap: (kernel: TKernel) => Promise<void>,
    execute: (kernel: TKernel) => Promise<TResult>,
    shouldRetry: (error: unknown) => boolean = () => true
  ): Promise<TResult> {
    const kernel = await this.current();
    await this.ensureBootstrapped(kernel, bootstrap);
    try {
      return await execute(kernel);
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      this.invalidate();
      const replacement = await this.current();
      await this.ensureBootstrapped(replacement, bootstrap);
      return execute(replacement);
    }
  }

  invalidate(): void {
    this.kernel = undefined;
    this.bootstrapped = false;
  }

  private async current(): Promise<TKernel> {
    this.kernel ??= await this.acquire();
    return this.kernel;
  }

  private async ensureBootstrapped(kernel: TKernel, bootstrap: (kernel: TKernel) => Promise<void>): Promise<void> {
    if (this.bootstrapped) return;
    await bootstrap(kernel);
    this.bootstrapped = true;
  }
}

export async function withKernelTimeout<TResult>(
  work: Promise<TResult>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<TResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error(`Open Wrangler kernel request timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
