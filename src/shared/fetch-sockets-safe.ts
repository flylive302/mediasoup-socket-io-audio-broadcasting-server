/**
 * fetch-sockets-safe — bounded, ghost-tolerant `io.in(room).fetchSockets()`.
 *
 * realtime-20: the Redis adapter's `fetchSockets()` waits for one response per
 * subscribed node and REJECTS (it does not resolve-partial) once `requestsTimeout`
 * elapses — see `@socket.io/redis-adapter` `RedisAdapter.fetchSockets`. A node that
 * was SIGKILLed before `io.close()`/Redis `quit()` lingers as a subscriber in the
 * adapter, so every cross-node `fetchSockets()` blocks the full `requestsTimeout`
 * and then throws. On the request-latency-critical join path (`room:join` and the
 * origin's `/internal/room/:id/participants`) that throw fails the whole join.
 *
 * This helper bounds the wait and degrades instead of throwing: on timeout/error
 * it falls back to LOCAL sockets only (`.local` short-circuits the Redis round-trip
 * in the adapter, so it can never block on a ghost), and to an empty list if even
 * that fails. Same-region participants are preserved; cross-region ones reconcile
 * via the normal `room:userJoined` relay moments later.
 */
import type { Server, RemoteSocket, DefaultEventsMap } from "socket.io";
import type { Logger } from "@src/infrastructure/logger.js";

/** Backstop in case a transport path ignores the adapter's `requestsTimeout`. */
const DEFAULT_TIMEOUT_MS = 3_000;

export async function fetchSocketsSafe<SocketData>(
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>,
  roomId: string,
  logger: Logger,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RemoteSocket<DefaultEventsMap, SocketData>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("fetchSockets timeout")),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([io.in(roomId).fetchSockets(), timeout]);
  } catch (err) {
    logger.warn(
      { err, roomId },
      "fetchSocketsSafe: cross-node fetch failed/timed out — falling back to local sockets",
    );
    try {
      // `.local` skips the Redis adapter fan-out entirely, so a ghost subscriber
      // cannot block it.
      return await io.in(roomId).local.fetchSockets();
    } catch (localErr) {
      logger.error(
        { err: localErr, roomId },
        "fetchSocketsSafe: local fetch also failed — returning empty list",
      );
      return [];
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
