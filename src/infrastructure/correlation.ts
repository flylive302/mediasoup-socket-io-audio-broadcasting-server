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
 *
 * observability-audio-quality 11 adds a SECOND, optional field: `vendorTraceId`. The API's error
 * tracker stamps every outgoing HTTP call (including the ones that reach `/api/events`) with its own
 * `sentry-trace` header. This service does not mint that format and does not turn it into a span —
 * span sampling stays off here (see `instrument.ts`) — it only reads the trace id inbound and carries
 * it alongside `correlationId` so a log line can be joined to the same operation in the error tracker.
 * Unset unless the ingest route found and parsed a usable header.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { generateCorrelationId } from "@src/shared/crypto.js";

export interface CorrelationStore {
  correlationId: string;
  vendorTraceId?: string;
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
 * Record the inbound vendor trace id on the current correlated operation.
 *
 * A no-op outside `withCorrelation` — there is no store to attach it to, and a secondary field with
 * nothing to be secondary to would be meaningless. Mutates the existing store object rather than
 * replacing it, so the write is visible to every reader already holding a reference across awaits.
 */
export function setVendorTraceId(vendorTraceId: string): void {
  const store = storage.getStore();
  if (store) store.vendorTraceId = vendorTraceId;
}

/**
 * The current ambient vendor trace id, or undefined when none was read for this operation.
 */
export function currentVendorTraceId(): string | undefined {
  return storage.getStore()?.vendorTraceId;
}

/**
 * The vendor's own `sentry-trace` header shape: `<trace_id>-<span_id>[-<sampled>]`, hex — the vendor
 * emits lowercase, and the `i` flag accepts uppercase rather than dropping an otherwise-valid id.
 * Only the trace id (the first segment) is kept — the span id and sampling flag describe the
 * SENDER's span tree, which this service does not participate in.
 */
const SENTRY_TRACE_PATTERN = /^([0-9a-f]{32})-[0-9a-f]{16}(-[01])?$/i;

/**
 * Parse an inbound `sentry-trace` header into just its trace id, or undefined when the header is
 * absent or does not match the vendor's format.
 *
 * Rejecting on any mismatch is deliberate, same posture as `resolveCorrelationId`: this value is
 * written into log lines, so it is untrusted input on a path that reaches storage. Fastify may hand
 * back an array if the header repeats; the first value is used and the rest ignored.
 */
export function parseVendorTraceId(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;

  const match = SENTRY_TRACE_PATTERN.exec(value.trim());
  return match?.[1];
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
  const store = storage.getStore();
  if (!store) return {};

  const fields: Record<string, string> = { correlationId: store.correlationId };
  if (store.vendorTraceId !== undefined) fields.vendorTraceId = store.vendorTraceId;
  return fields;
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
