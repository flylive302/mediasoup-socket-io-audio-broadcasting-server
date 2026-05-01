// Grace period for reconnecting speakers.
// Defers seat-clear by SEAT_CLEAR_GRACE_MS so a brief network blip (mobile
// backgrounding, iOS PWA suspension, etc.) does not drop the user's seat.
// Keys are `${roomId}:${userId}` strings.

const pendingSeatClears = new Map<string, ReturnType<typeof setTimeout>>();

export const SEAT_CLEAR_GRACE_MS = 15_000;

/**
 * Schedule a deferred seat clear.
 * Replaces any existing timer for the same key.
 */
export function scheduleSeatClear(key: string, callback: () => void): void {
  const existing = pendingSeatClears.get(key);
  if (existing !== undefined) clearTimeout(existing);
  pendingSeatClears.set(
    key,
    setTimeout(() => {
      pendingSeatClears.delete(key);
      callback();
    }, SEAT_CLEAR_GRACE_MS),
  );
}

/**
 * Cancel a pending seat clear (speaker reconnected in time).
 * Returns true if a timer was found and cancelled.
 */
export function cancelSeatClear(key: string): boolean {
  const timer = pendingSeatClears.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingSeatClears.delete(key);
    return true;
  }
  return false;
}
