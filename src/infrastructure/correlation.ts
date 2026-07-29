/**
 * Ambient correlation context.
 *
 * One identifier per logical operation, carried implicitly so that no log call site has to mention
 * it. This is the realtime service's half of the cross-repo contract; the API's half stores the same
 * field in Laravel's Context, which its logger appends to every record automatically.
 *
 * The field name is `correlationId` in logs and `X-Correlation-ID` on the wire, matching the API.
 *
 * Why AsyncLocalStorage rather than a module-level variable: this process interleaves many
 * concurrent socket events, and every handler awaits. A plain variable would be overwritten by
 * whichever operation started most recently, so log lines would be attributed to the wrong request
 * — silently, and more often under load, which is exactly when the attribution matters.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { generateCorrelationId } from "@src/shared/crypto.js";

export interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/**
 * Longest inbound identifier accepted before it is discarded and a fresh one minted.
 *
 * Mirrors the API's bound. An identifier arrives from another service and is written into every
 * log line, so it is untrusted input on a path that reaches storage.
 */
const MAX_INBOUND_LENGTH = 128;

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

/**
 * Run `fn` with an ambient correlation identifier bound to it and everything it awaits.
 *
 * Adopts `inbound` when it is usable and mints otherwise, so a caller that already has an
 * identifier keeps it and one that does not still gets a join key.
 */
export function withCorrelation<T>(
  inbound: string | undefined,
  fn: () => T,
): T {
  return storage.run({ correlationId: resolveCorrelationId(inbound) }, fn);
}

/**
 * The current ambient correlation identifier, or undefined outside any correlated operation.
 *
 * Prefer letting the logger add it. Read it directly only when it must cross a boundary the
 * logger does not reach — an outbound HTTP header, or a Sentry scope.
 */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Pino `mixin`: the fields merged into every log record.
 *
 * Lives here rather than inline in the logger so there is exactly one definition to test. Returns
 * an empty object outside a correlated operation, leaving startup and timer lines unchanged rather
 * than stamping them with a misleading identifier.
 *
 * An explicit `correlationId` in a log object still wins, because Pino merges the log object over
 * the mixin's output. The relay path depends on that to log the sender's identifier.
 */
export function correlationMixin(): Record<string, string> {
  const correlationId = currentCorrelationId();

  return correlationId === undefined ? {} : { correlationId };
}

/**
 * Decide whether an inbound identifier may be adopted, minting a replacement when it may not.
 *
 * Rejecting is always safe: losing a caller's chosen identifier costs one broken join, while
 * adopting an arbitrary string writes attacker-controlled content into every subsequent log line.
 */
export function resolveCorrelationId(inbound: string | undefined): string {
  if (inbound === undefined) {
    return generateCorrelationId();
  }

  const trimmed = inbound.trim();

  if (
    trimmed === "" ||
    trimmed === "unknown" ||
    trimmed.length > MAX_INBOUND_LENGTH ||
    !SAFE_IDENTIFIER.test(trimmed)
  ) {
    return generateCorrelationId();
  }

  return trimmed;
}
