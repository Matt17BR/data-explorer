import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;

const stopping = new WeakSet<ChildProcessWithoutNullStreams>();

export function stopChildProcessGracefully(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs = GRACEFUL_SHUTDOWN_TIMEOUT_MS
): void {
  if (stopping.has(proc)) return;
  stopping.add(proc);

  let finished = false;
  const timer = setTimeout(
    () => {
      if (finished || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill();
    },
    Math.max(0, timeoutMs)
  );
  timer.unref();
  proc.once("exit", () => {
    finished = true;
    clearTimeout(timer);
  });
  try {
    if (proc.stdin.destroyed || !proc.stdin.writable) {
      proc.kill();
    } else {
      proc.stdin.end();
    }
  } catch {
    proc.kill();
  }
}
