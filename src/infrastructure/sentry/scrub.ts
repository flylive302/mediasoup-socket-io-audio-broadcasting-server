/**
 * Removes secrets from a Sentry event before it leaves the process.
 *
 * Two independent redaction rules apply to every string value encountered
 * while walking the event:
 *   a. JWT-shaped substrings — structural detection, catches tokens we don't
 *      have a name for (e.g. a Laravel Sanctum/JWT that ends up embedded in
 *      a log line or URL).
 *   b. Known secret values — exact substring match against live config
 *      secrets (or an explicit `secrets` list, mainly for tests).
 * As defense in depth, values are also redacted purely by KEY NAME
 * (authorization/cookie/token/secret/password/api-key/...) regardless of
 * shape, in case a secret doesn't match either rule above.
 *
 * This runs synchronously inside Sentry's `beforeSend` on every event, so it
 * must be cheap, bounded, and must never throw or hang — telemetry code can
 * never be allowed to break or stall the app it's observing.
 */
import type { ErrorEvent } from "@sentry/node";
import { config } from "@src/config/index.js";

const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/;

const KEY_NAME_PATTERN =
  /(authorization|cookie|token|secret|password|api[-_]?key|x-internal-key|dsn)/i;

/** Ignore secrets shorter than this — a 1-char match would redact the whole event. */
const MIN_SECRET_LENGTH = 8;

const MAX_DEPTH = 8;
const MAX_NODES = 5000;

let memoizedDefaultSecrets: readonly string[] | undefined;

/** Computed once (module-level lazy memo) — this must stay cheap on every event. */
function getDefaultSecrets(): readonly string[] {
  if (memoizedDefaultSecrets) return memoizedDefaultSecrets;

  const candidates = [
    config.JWT_SECRET,
    config.LARAVEL_INTERNAL_KEY,
    config.REDIS_PASSWORD,
    config.INTERNAL_API_KEY,
    config.CLOUDFLARE_TURN_API_KEY,
    config.CLOUDFLARE_TURN_KEY_ID,
    config.HLS_R2_ACCESS_KEY_ID,
    config.HLS_R2_SECRET_ACCESS_KEY,
    config.SENTRY_DSN,
  ];

  memoizedDefaultSecrets = candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return memoizedDefaultSecrets;
}

export function scrubSecrets(
  event: ErrorEvent,
  secrets?: readonly string[],
): ErrorEvent {
  try {
    const activeSecrets = (secrets ?? getDefaultSecrets()).filter(
      (secret) => secret.length >= MIN_SECRET_LENGTH,
    );
    const visited = new WeakSet<object>();
    const state = { nodesVisited: 0 };

    walk(
      event as unknown as Record<string, unknown>,
      0,
      visited,
      state,
      activeSecrets,
    );
  } catch {
    // Telemetry must never break the app — return the event unchanged.
  }
  return event;
}

function redactString(value: string, secrets: readonly string[]): string {
  if (JWT_PATTERN.test(value)) return "[Filtered]";
  for (const secret of secrets) {
    if (value.includes(secret)) return "[Filtered]";
  }
  return value;
}

/** Plain data objects only — excludes arrays (walked separately) and Buffers/typed arrays (left untouched). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function walk(
  node: Record<string, unknown> | unknown[],
  depth: number,
  visited: WeakSet<object>,
  state: { nodesVisited: number },
  secrets: readonly string[],
): void {
  if (depth > MAX_DEPTH) return;
  if (state.nodesVisited >= MAX_NODES) return;
  if (visited.has(node)) return;
  visited.add(node);

  const record = node as unknown as Record<string | number, unknown>;
  const keys: Array<string | number> = Array.isArray(node)
    ? node.map((_, index) => index)
    : Object.keys(node);

  for (const key of keys) {
    if (state.nodesVisited >= MAX_NODES) return;
    state.nodesVisited++;

    const value = record[key];

    if (typeof value === "string") {
      const keyIsSensitive =
        typeof key === "string" && KEY_NAME_PATTERN.test(key);
      record[key] = keyIsSensitive
        ? "[Filtered]"
        : redactString(value, secrets);
    } else if (Array.isArray(value)) {
      walk(value, depth + 1, visited, state, secrets);
    } else if (isPlainObject(value)) {
      walk(value, depth + 1, visited, state, secrets);
    }
    // numbers, booleans, null, undefined, Buffers/typed arrays: left untouched.
  }
}
