/**
 * gift-authority-tick-fanout 14: per-room gift tick fan-out.
 *
 * REACT only — this module never gates or executes anything; it only
 * accumulates already-accepted gift legs and lucky room results and emits
 * them as one merged `gift:batch` per room per tick, bounding how many
 * messages a phone in a spammed room receives per second.
 *
 * ── Sender exclusion ────────────────────────────────────────────────────
 * `emitToRoom` (the helper the direct/legacy gift emits use) excludes the
 * sender via `socket.to(roomId)`. A merged batch has no single sender socket
 * to exclude from — one batch can carry legs from several senders — so this
 * module emits to the WHOLE room (via `broadcastToRoom`, sender included)
 * and each item carries `senderId` so the client can skip rendering its own
 * gift a second time (it already rendered on tap). This is a deliberate
 * shape difference from the legacy per-recipient emit, not an oversight.
 *
 * ── Timer lifecycle ─────────────────────────────────────────────────────
 * A room's timer starts only on its first `enqueueGift`/`enqueueLucky` call
 * after being empty, runs on `giftRoomTickMs()` (read fresh every tick —
 * never cached), and is `unref()`'d so it never keeps the process alive. A
 * tick that finds nothing to emit stops and discards the room's timer; the
 * room is re-created lazily on the next enqueue.
 *
 * ── Cap and spill ───────────────────────────────────────────────────────
 * At most 200 merged items go out per emit. A room with more accumulates the
 * remainder and keeps ticking (or, on drain, keeps emitting synchronously)
 * until empty. Lucky entries are never capped or dropped — only gift items
 * are capped.
 */
import type { Server } from "socket.io";
import type { CascadeRelay } from "@src/domains/cascade/cascade-relay.js";
import { broadcastToRoom } from "@src/shared/room-emit.js";
import { giftRoomTickMs } from "./flags.js";
import { metrics } from "@src/infrastructure/metrics.js";

/** Cap on merged gift items per `gift:batch` emit — the rest spills to the next tick. */
export const MAX_ITEMS_PER_BATCH = 200;

export interface GiftBatchItemInput {
  senderId: number;
  giftId: number;
  recipientIds: number[];
  /** This tap's quantity — summed into the merged item's running total. */
  quantity: number;
  transactionId: string;
}

export interface GiftBatchItem {
  senderId: number;
  giftId: number;
  recipientIds: number[];
  quantity: number;
  count: number;
  transactionIds: string[];
}

export interface GiftBatchPayload {
  seq: number;
  roomId: string;
  items: GiftBatchItem[];
  lucky: unknown[];
}

/** Source of the current cascade relay — read at emit time, never cached. */
export interface CascadeRelaySource {
  cascadeRelay: CascadeRelay | null;
}

interface RoomAccumulator {
  seq: number;
  items: Map<string, GiftBatchItem>;
  lucky: unknown[];
  timer: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomAccumulator>();

let ioRef: Server | null = null;
let relaySourceRef: CascadeRelaySource | null = null;

/**
 * Wire the ticker's emit target. Idempotent and cheap to call repeatedly
 * (GiftHandler calls it on every `handle()` so it never needs its own
 * bootstrap ordering) — `context.cascadeRelay` is read fresh through
 * `relaySource` at every tick, since it is wired in after bootstrap.
 */
export function initRoomTicker(io: Server, relaySource: CascadeRelaySource): void {
  ioRef = io;
  relaySourceRef = relaySource;
}

/** Test-only: reset all module state (open timers, accumulators, wiring). */
export function resetRoomTickerForTests(): void {
  for (const acc of rooms.values()) {
    if (acc.timer) clearInterval(acc.timer);
  }
  rooms.clear();
  ioRef = null;
  relaySourceRef = null;
}

function mergeKey(senderId: number, giftId: number, recipientIds: number[]): string {
  return `${senderId}:${giftId}:${[...recipientIds].sort((a, b) => a - b).join(",")}`;
}

function getOrCreateRoom(roomId: string): RoomAccumulator {
  let acc = rooms.get(roomId);
  if (!acc) {
    acc = { seq: 0, items: new Map(), lucky: [], timer: null };
    rooms.set(roomId, acc);
  }
  return acc;
}

function ensureTimerStarted(roomId: string, acc: RoomAccumulator): void {
  if (acc.timer) return;
  const intervalMs = giftRoomTickMs();
  if (intervalMs <= 0) return; // ticker disabled; caller shouldn't enqueue, but never throw
  acc.timer = setInterval(() => tick(roomId), intervalMs);
  acc.timer.unref?.();
}

function stopRoom(roomId: string, acc: RoomAccumulator): void {
  if (acc.timer) {
    clearInterval(acc.timer);
    acc.timer = null;
  }
  rooms.delete(roomId);
}

/** Accumulate one accepted gift leg into its room. Starts the room's timer if idle. */
export function enqueueGift(roomId: string, item: GiftBatchItemInput): void {
  const acc = getOrCreateRoom(roomId);
  const key = mergeKey(item.senderId, item.giftId, item.recipientIds);
  const existing = acc.items.get(key);
  if (existing) {
    existing.quantity += item.quantity;
    existing.count += 1;
    existing.transactionIds.push(item.transactionId);
  } else {
    acc.items.set(key, {
      senderId: item.senderId,
      giftId: item.giftId,
      recipientIds: [...item.recipientIds],
      quantity: item.quantity,
      count: 1,
      transactionIds: [item.transactionId],
    });
  }
  ensureTimerStarted(roomId, acc);
}

/** Fold one lucky room-win payload into the room's next tick. Never coalesced or capped. */
export function enqueueLucky(roomId: string, payload: unknown): void {
  const acc = getOrCreateRoom(roomId);
  acc.lucky.push(payload);
  ensureTimerStarted(roomId, acc);
}

/**
 * Emit one `gift:batch` for this room if there is anything to send. Returns
 * whether it emitted, so callers (the timer tick and the drain flush) can
 * decide what to do next without duplicating the "is there anything left"
 * check.
 */
function emitIfAny(roomId: string, acc: RoomAccumulator): boolean {
  const allItems = [...acc.items.values()];
  if (allItems.length === 0 && acc.lucky.length === 0) return false;

  const items = allItems.slice(0, MAX_ITEMS_PER_BATCH);
  const spilled = allItems.length > MAX_ITEMS_PER_BATCH;

  for (const item of items) {
    acc.items.delete(mergeKey(item.senderId, item.giftId, item.recipientIds));
  }

  const lucky = acc.lucky;
  acc.lucky = [];

  acc.seq += 1;
  const payload: GiftBatchPayload = { seq: acc.seq, roomId, items, lucky };

  if (ioRef) {
    broadcastToRoom(ioRef, roomId, "gift:batch", payload, relaySourceRef?.cascadeRelay ?? null);
  }

  metrics.giftBatchItems.observe(items.length);
  metrics.giftBatchesTotal.inc();
  metrics.giftBatchRelayCallsTotal.inc();
  if (spilled) {
    metrics.giftBatchSpillTotal.inc();
  }

  return true;
}

function tick(roomId: string): void {
  const acc = rooms.get(roomId);
  if (!acc) return;
  const emitted = emitIfAny(roomId, acc);
  if (!emitted) {
    stopRoom(roomId, acc);
  }
}

/**
 * Drain every room synchronously — called before shutdown so nothing
 * accumulated is ever lost. Keeps emitting per room (draining any spilled
 * remainder across multiple `gift:batch` emits) until each room is empty,
 * then stops and discards its timer.
 */
export function flushAllRooms(): void {
  for (const [roomId, acc] of [...rooms.entries()]) {
    // eslint-disable-next-line no-empty
    while (emitIfAny(roomId, acc)) {}
    stopRoom(roomId, acc);
  }
}
