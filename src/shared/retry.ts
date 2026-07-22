/**
 * Bounded async retry with exponential backoff.
 *
 * Media-pipe setup (pipeToRouter, reverse/edge cascade pipes) can fail
 * transiently — worker churn, in-flight transport teardown, brief
 * inter-instance network blips. A single silent failure used to leave a
 * speaker permanently inaudible to a subset of listeners (2026-07-10 audio
 * review), so pipe setup MUST retry before giving up, and give up LOUDLY.
 *
 * Throws the last error (or returns the last falsy result via `accept`)
 * only after all attempts are exhausted.
 */
export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Delay before the 2nd attempt; doubles each retry (default 200ms). */
  baseDelayMs?: number;
  /** Reject a resolved value and retry when it returns false. */
  accept?: (result: unknown) => boolean;
  /**
   * Return false to abort immediately (rethrow) instead of retrying — for
   * errors where a retry is futile by construction (prod-bugs 09: mediasoup
   * "handler already exists" means the entity is half-created; retrying the
   * same call can only collide again).
   */
  shouldRetry?: (err: unknown) => boolean;
}

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const accept = options.accept ?? (() => true);
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  let lastResult: T | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn(attempt);
      if (accept(result)) return result;
      lastResult = result;
    } catch (err) {
      if (!shouldRetry(err)) throw err;
      lastError = err;
    }
    if (attempt < attempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
      );
    }
  }

  if (lastError !== undefined) throw lastError;
  return lastResult as T;
}
