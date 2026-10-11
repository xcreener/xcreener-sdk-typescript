/**
 * The few places the client touches its host runtime. Kept together so the
 * rest of the code stays portable across Node, Bun, Deno and edge runtimes.
 *
 * @internal
 */

interface MaybeProcess {
  process?: { env?: Record<string, string | undefined> };
}

/** `$XCREENER_API_KEY`, where the runtime has an environment to read. */
export function readEnvApiKey(): string | undefined {
  try {
    return (globalThis as MaybeProcess).process?.env?.XCREENER_API_KEY;
  } catch {
    // Deno without --allow-env throws on access rather than returning nothing.
    return undefined;
  }
}

/**
 * True in a browser page. Deno 2 and worker runtimes have no `document`, so
 * they are not mistaken for one.
 */
export function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}

/** Exponential backoff with jitter: about 0.5s, 1s, 2s and so on. */
export function backoffMs(attempt: number): number {
  return 2 ** attempt * 500 + Math.random() * 250;
}

/** Resolve after `ms`, or reject with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A readable one-line description of a failed fetch, for TransportError. */
export function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return `timed out after ${timeoutMs}ms`;
    // Node's fetch reports "fetch failed" and puts the real reason in `cause`.
    const cause = error.cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message || error.name;
  }
  return String(error);
}
