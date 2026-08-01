/**
 * Rotation-overlap key matching.
 *
 * A two-sided secret is held by two independently deployed services. They
 * cannot flip to a new value at the same instant: Laravel's side is a console
 * edit (seconds) while MSAB's is a drain-gated fleet roll (~35 minutes). With a
 * single accepted value, everything in that gap is rejected — and the realtime
 * bridge drops those events permanently (3 retries, no `failed_jobs` row, no
 * replay).
 *
 * So verifiers accept the current value plus any `*_PREVIOUS` values for the
 * duration of a rotation. Outside a rotation the previous list is empty and
 * behaviour is identical to a single-value check.
 *
 * See docs/issues/secrets-repo-cleanup/01b-coordinated-rotation-runbook.md
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Timing-safe equality for two secrets.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length
 * check has to come first — which does leak length. That is acceptable here
 * (these are fixed-length generated secrets) and is what the previous `!==`
 * comparisons leaked anyway, along with content.
 */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Does `presented` match the current key or any rotation-overlap key?
 *
 * Empty candidates are dropped: an unset key must never authorise a request
 * that presents an empty header. Returns false when no candidate is
 * configured at all.
 *
 * The loop is not short-circuited, so match position does not affect timing.
 */
export function matchesRotatableKey(
  presented: string | undefined,
  current: string | undefined,
  previous: readonly string[] = [],
): boolean {
  if (!presented) return false;

  const accepted = [current, ...previous].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (accepted.length === 0) return false;

  let matched = false;
  for (const candidate of accepted) {
    if (secretEquals(candidate, presented)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Parse a comma-separated `*_PREVIOUS` env value into a list of secrets.
 * Blank entries are dropped so a trailing comma or an empty var yields [].
 */
export function parsePreviousKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}
