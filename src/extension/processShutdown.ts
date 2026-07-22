import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
export const FORCED_SHUTDOWN_CONFIRMATION_TIMEOUT_MS = 2_000;

const stopping = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

export function stopChildProcessGracefully(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs = GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  confirmationTimeoutMs = FORCED_SHUTDOWN_CONFIRMATION_TIMEOUT_MS
): Promise<void> {
  const existing = stopping.get(proc);
  if (existing) return existing;

  const shutdown = new Promise<void>((resolve, reject) => {
    let settled = false;
    let gracefulTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    let forceKillDetail: string | undefined;
    let forceKillStarted = false;

    const hasExited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
    const cleanup = (): void => {
      if (gracefulTimer) clearTimeout(gracefulTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
      proc.off("exit", confirmExit);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const confirmExit = (): void => settle();
    const forceKill = (): void => {
      if (settled || forceKillStarted) return;
      forceKillStarted = true;
      if (gracefulTimer) {
        clearTimeout(gracefulTimer);
        gracefulTimer = undefined;
      }
      if (hasExited()) {
        settle();
        return;
      }
      try {
        if (!proc.kill("SIGKILL")) forceKillDetail = "the operating system did not accept the termination signal";
      } catch (error) {
        forceKillDetail = error instanceof Error ? error.message : String(error);
      }
      if (hasExited()) {
        settle();
        return;
      }
      confirmationTimer = setTimeout(
        () => {
          if (hasExited()) {
            settle();
            return;
          }
          settle(
            new Error(
              `Open Wrangler could not confirm that its Python runtime exited after forced termination${forceKillDetail ? ` (${forceKillDetail})` : ""}.`
            )
          );
        },
        Math.max(0, confirmationTimeoutMs)
      );
      confirmationTimer.unref();
    };

    proc.once("exit", confirmExit);
    if (hasExited()) {
      settle();
      return;
    }

    if (timeoutMs <= 0) {
      forceKill();
    } else {
      gracefulTimer = setTimeout(forceKill, timeoutMs);
      gracefulTimer.unref();
      try {
        if (proc.stdin.destroyed || !proc.stdin.writable) forceKill();
        else proc.stdin.end();
      } catch {
        forceKill();
      }
    }
  });
  stopping.set(proc, shutdown);
  void shutdown.then(
    () => {
      if (stopping.get(proc) === shutdown) stopping.delete(proc);
    },
    () => undefined
  );
  return shutdown;
}
