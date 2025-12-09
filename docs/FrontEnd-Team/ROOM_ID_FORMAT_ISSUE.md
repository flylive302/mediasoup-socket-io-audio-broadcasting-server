# Room ID Format Mismatch - MSAB Server Issue Report

> **From**: Frontend Team  
> **To**: MSAB Server Team  
> **Date**: 2025-12-08  
> **Priority**: High

---

## Issue Summary

When the frontend attempts to join a room via `room:join`, the MSAB server responds with `"Invalid payload"` error.

**Error observed in browser console:**
```
[RoomShell] Failed to join audio: Error: Invalid payload
    at joinRoom (useRoomAudio.ts:228:13)
```

---

## Root Cause Analysis

### Frontend Payload (What we send)

```typescript
socket.emit('room:join', { roomId: "1" }, callback);
// OR
socket.emit('room:join', { roomId: "42" }, callback);
```

The `roomId` is the **Laravel room ID** (numeric string from the HTTP API).

### MSAB Expected Payload (Per Documentation)

According to `MSAB-FRONTEND-INTEGRATION.md` lines 133-137:

```typescript
{
  roomId: string; // UUID of the room
}
```

The documentation specifies that `roomId` should be a **UUID**, but our Laravel backend returns **numeric IDs** for rooms.

---

## Evidence: Laravel Room Response

From `rooms-api-reference.md`:

```json
{
  "id": 1,
  "name": "General Chat",
  "logo": "...",
  "type": "public",
  "country": "US"
}
```

The room ID from Laravel is a **numeric value**, not a UUID.

---

## Proposed Solutions

### Option A: MSAB Server Accepts Numeric Room IDs (Recommended)

Update the MSAB server's `room:join` validation schema to accept:

```typescript
// Current (UUID only)
roomId: z.string().uuid()

// Updated (accepts numeric string or UUID)
roomId: z.string().min(1)
```

**Pros:**
- Minimal change
- Works with existing Laravel API
- No frontend changes needed

### Option B: Laravel Generates Room UUIDs

Laravel backend generates UUIDs for rooms instead of auto-increment IDs.

**Cons:**
- Requires database migration
- Breaking change for existing rooms
- Must update all API consumers

### Option C: Add `audio_room_id` Field

Laravel maintains a separate UUID field for MSAB integration:

```php
// Room model
$table->uuid('audio_room_id')->nullable()->unique();
```

**Cons:**
- Additional complexity
- Extra field to manage

---

## Recommendation

**Option A** is recommended. The MSAB server should accept the room ID format that Laravel provides.

Please update the Zod validation schema for `room:join` from:

```typescript
const JoinRoomSchema = z.object({
  roomId: z.string().uuid(),
});
```

To:

```typescript
const JoinRoomSchema = z.object({
  roomId: z.string().min(1),
});
```

This will allow both numeric strings (`"1"`, `"42"`) and UUIDs to work.

---

## Frontend Code Reference

Our `room:join` emission is at:
- File: `app/composables/useRoomAudio.ts`
- Line: 225

```typescript
const response = await emitAsync<{ roomId: string }, JoinRoomResponse>('room:join', { roomId });
```

Where `roomId` comes from `room.id` in the store (Laravel's room ID as string).

---

## Testing After Fix

Once the MSAB server is updated, the frontend should:

1. Successfully connect to audio server ✅ (already working)
2. Join room without "Invalid payload" error
3. Receive RTP capabilities
4. Proceed with audio transport setup

Please let us know when this change is deployed so we can verify the fix.
