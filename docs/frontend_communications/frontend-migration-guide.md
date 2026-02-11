# MSAB Frontend Migration Guide

> **Backend Version**: Post-Remediation (Feb 2026)
> **Priority**: 🔴 Must deploy frontend + backend simultaneously
> **Estimated Frontend Effort**: 4-6 hours

---

## Quick Summary

| Area | What Changed | Impact |
|---|---|---|
| Media handlers | Responses wrapped in `{ success, data }` | All transport/produce/consume callbacks |
| `room:userJoined` | Shape unchanged — still sends `userId` + `user` | Push `user` into participants store |
| `room:join` ACK | Seats use `userId` instead of `user` object | Update seat rendering logic |
| `room:join` payload | New `seatCount` field (optional) | Send room's seat count on join |
| `seat:updated` | Replaced `user` object with `userId` | Look up user from participants store |
| `gift:received` | Removed `senderName`, `senderAvatar` | Look up sender from participants |
| `seat:invite:received` | `invitedBy` → `invitedById` | Look up inviter from participants |
| `speaker:active` | Only emits on speaker change | No code change needed (behavior note) |

---

## 1. Media Handler Responses

All 7 media event callbacks now return a unified shape. The actual response data is nested inside `data`.

### Before
```json
// transport:create callback
{
  "id": "uuid",
  "iceParameters": { ... },
  "iceCandidates": [ ... ],
  "dtlsParameters": { ... }
}

// audio:produce callback
{ "id": "producer-uuid" }

// audio:consume callback
{
  "id": "consumer-uuid",
  "producerId": "producer-uuid",
  "kind": "audio",
  "rtpParameters": { ... }
}

// transport:connect callback
{ "success": true }

// Error case
{ "error": "Room not found" }
```

### After
```json
// transport:create callback
{
  "success": true,
  "data": {
    "id": "uuid",
    "iceParameters": { ... },
    "iceCandidates": [ ... ],
    "dtlsParameters": { ... }
  }
}

// audio:produce callback
{
  "success": true,
  "data": { "id": "producer-uuid" }
}

// audio:consume callback
{
  "success": true,
  "data": {
    "id": "consumer-uuid",
    "producerId": "producer-uuid",
    "kind": "audio",
    "rtpParameters": { ... }
  }
}

// transport:connect callback
{ "success": true }

// Error case (all events)
{ "success": false, "error": "Room not found" }
```

### Migration

```typescript
// ❌ Before
socket.emit('transport:create', payload, (response) => {
  if (response.error) { handleError(response.error); return; }
  const { id, iceParameters, iceCandidates, dtlsParameters } = response;
});

// ✅ After
socket.emit('transport:create', payload, (response) => {
  if (!response.success) { handleError(response.error); return; }
  const { id, iceParameters, iceCandidates, dtlsParameters } = response.data;
});
```

### Affected Events

| Event | Old Response | New Response |
|---|---|---|
| `transport:create` | `{ id, iceParameters, ... }` | `{ success, data: { id, iceParameters, ... } }` |
| `transport:connect` | `{ success: true }` or `{ error }` | `{ success: true }` or `{ success: false, error }` |
| `audio:produce` | `{ id }` or `{ error }` | `{ success, data: { id } }` |
| `audio:consume` | `{ id, producerId, kind, rtpParameters }` | `{ success, data: { id, producerId, kind, rtpParameters } }` |
| `consumer:resume` | `{ success }` or `{ error }` | `{ success }` or `{ success: false, error }` |
| `audio:selfMute` | `{ success }` or `{ error }` | `{ success }` or `{ success: false, error }` |
| `audio:selfUnmute` | `{ success }` or `{ error }` | `{ success }` or `{ success: false, error }` |

> [!TIP]
> `consumer:resume` may now return `{ success: true, data: { deferred: true } }` when the speaker is not currently active. The consumer will auto-resume later. Frontend can treat this the same as `{ success: true }`.

---

## 2. `room:join` — Payload & ACK Changes

### 2a. Join Payload (Sending)

New optional `seatCount` field. If omitted, defaults to 15.

```typescript
// ❌ Before
socket.emit('room:join', { roomId: '123', ownerId: 456 }, ackCallback);

// ✅ After — send seat count based on room type
socket.emit('room:join', {
  roomId: '123',
  ownerId: 456,
  seatCount: 8,  // or 15, or whatever this room needs (1-15)
}, ackCallback);
```

### 2b. Join ACK — Seats Array

Seats no longer contain full `user` objects. They contain `userId` instead.

```typescript
// ❌ Before — seats in ACK
interface SeatFromACK {
  seatIndex: number;
  user: {
    id: number;
    name: string;
    avatar: string;
    signature: string;
    frame: string;
    gender: string;
    country: string;
    phone: string;
    email: string;
    date_of_birth: string;
    wealth_xp: string;
    charm_xp: string;
  } | null;
  isMuted: boolean;
}

// ✅ After — seats in ACK
interface SeatFromACK {
  seatIndex: number;
  userId: number;
  isMuted: boolean;
}
```

### Migration

```typescript
// ❌ Before
const seat = ackData.seats[0];
renderSeat(seat.seatIndex, seat.user?.name, seat.user?.avatar, seat.isMuted);

// ✅ After — look up user from participants array (also in the ACK)
const seat = ackData.seats[0];
const user = ackData.participants.find(p => p.id === seat.userId);
renderSeat(seat.seatIndex, user?.name, user?.avatar, seat.isMuted);
```

> [!NOTE]
> The `participants` array in the ACK still contains full user objects. Use it as the lookup source for seat user data.

---

## 3. `room:userJoined` Event — No Breaking Change ✅

This event **still sends full user data** alongside `userId`. No migration needed.

```json
{
  "userId": 123,
  "user": {
    "id": 123,
    "name": "John",
    "avatar": "...",
    "signature": "...",
    "frame": "...",
    "gender": "male",
    "country": "US",
    "phone": "...",
    "email": "...",
    "date_of_birth": "...",
    "wealth_xp": "1000",
    "charm_xp": "500"
  }
}
```

### How to use it

When you receive this event, **push the `user` into your local participants store**. This ensures you always have full data for every user in the room:

- **Joiner** gets the full `participants[]` of everyone already in the room via the `room:join` ACK
- **Existing users** get the new joiner's full `user` data via this `room:userJoined` event

```typescript
socket.on('room:userJoined', ({ userId, user }) => {
  // Add the new user to local participants store
  participantsStore.addOrUpdate(user);
});
```

> [!NOTE]
> This is the recommended pattern for keeping your participants store in sync. The participants store is then used by `seat:updated`, `gift:received`, and `seat:invite:received` handlers to look up user details by `userId`.

---

## 4. `seat:updated` Event

Emitted when a user takes a seat or accepts an invite.

### Before
```json
{
  "seatIndex": 3,
  "user": {
    "id": 123,
    "name": "John",
    "avatar": "...",
    "signature": "...",
    "frame": "...",
    "gender": "male",
    "country": "US",
    "phone": "...",
    "email": "...",
    "date_of_birth": "...",
    "wealth_xp": "1000",
    "charm_xp": "500"
  },
  "isMuted": false
}
```

### After
```json
{
  "seatIndex": 3,
  "userId": 123,
  "isMuted": false
}
```

### Migration

```typescript
// ❌ Before
socket.on('seat:updated', ({ seatIndex, user, isMuted }) => {
  updateSeat(seatIndex, user.name, user.avatar, isMuted);
});

// ✅ After — look up user from Pinia participants store
socket.on('seat:updated', ({ seatIndex, userId, isMuted }) => {
  const user = participantsStore.getById(userId);
  updateSeat(seatIndex, user?.name, user?.avatar, isMuted);
});
```

---

## 5. `gift:received` Event

### Before
```json
{
  "senderId": 123,
  "senderName": "John",
  "senderAvatar": "https://...",
  "roomId": "456",
  "giftId": 789,
  "recipientId": 101,
  "quantity": 1
}
```

### After
```json
{
  "senderId": 123,
  "roomId": "456",
  "giftId": 789,
  "recipientId": 101,
  "quantity": 1
}
```

### Migration

```typescript
// ❌ Before
socket.on('gift:received', ({ senderId, senderName, senderAvatar, ...gift }) => {
  showGiftAnimation(senderName, senderAvatar, gift);
});

// ✅ After
socket.on('gift:received', ({ senderId, ...gift }) => {
  const sender = participantsStore.getById(senderId);
  showGiftAnimation(sender?.name, sender?.avatar, gift);
});
```

---

## 6. `seat:invite:received` Event

### Before
```json
{
  "seatIndex": 5,
  "invitedBy": {
    "id": 123,
    "name": "John"
  },
  "expiresAt": 1707600000000,
  "targetUserId": 456
}
```

### After
```json
{
  "seatIndex": 5,
  "invitedById": 123,
  "expiresAt": 1707600000000,
  "targetUserId": 456
}
```

### Migration

```typescript
// ❌ Before
socket.on('seat:invite:received', ({ seatIndex, invitedBy, expiresAt }) => {
  showInviteDialog(invitedBy.name, seatIndex, expiresAt);
});

// ✅ After
socket.on('seat:invite:received', ({ seatIndex, invitedById, expiresAt }) => {
  const inviter = participantsStore.getById(invitedById);
  showInviteDialog(inviter?.name, seatIndex, expiresAt);
});
```

---

## 7. Behavioral Changes (No Code Required)

### `speaker:active` — Change-Gated Emission

Previously emitted every ~200ms regardless. Now **only emits when the active speaker set changes**. No frontend code change needed — this is purely a performance improvement.

### `participant_count` Lag

The `participant_count` on the Laravel API may lag by a few hundred ms after a user joins, since the Laravel update is now fire-and-forget. UI should not depend on this being instantly updated.

---

## TypeScript Interfaces Summary

```typescript
// ─── Unified Media Response ───
interface MediaResponse {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// ─── room:join ACK seats ───
interface SeatACK {
  seatIndex: number;
  userId: number;    // was: user: Partial<User>
  isMuted: boolean;
}

// ─── seat:updated event ───
interface SeatUpdatedEvent {
  seatIndex: number;
  userId: number;    // was: user: { id, name, avatar, ... }
  isMuted: boolean;
}

// ─── room:userJoined event ─── (unchanged)
interface UserJoinedEvent {
  userId: number;
  user: User;        // full user data — push into participants store
}

// ─── gift:received event ───
interface GiftReceivedEvent {
  senderId: number;
  // REMOVED: senderName, senderAvatar
  roomId: string;
  giftId: number;
  recipientId: number;
  quantity: number;
}

// ─── seat:invite:received event ───
interface SeatInviteReceivedEvent {
  seatIndex: number;
  invitedById: number;  // was: invitedBy: { id, name }
  expiresAt: number;
  targetUserId: number;
}

// ─── room:join payload ───
interface JoinRoomPayload {
  roomId: string;
  ownerId?: number;
  seatCount?: number;  // NEW: 1-15, defaults to 15
}
```

---

## Checklist

- [ ] Update all media event callbacks to read from `response.data` instead of `response` directly
- [ ] Ensure `room:userJoined` handler pushes `user` into participants store (shape unchanged)
- [ ] Update `room:join` ACK processing — seats now have `userId` not `user`
- [ ] Update `seat:updated` handler — use `userId` to look up user from participants
- [ ] Update `gift:received` handler — look up `senderName`/`senderAvatar` from participants
- [ ] Update `seat:invite:received` handler — use `invitedById` instead of `invitedBy.id`/`invitedBy.name`
- [ ] (Optional) Send `seatCount` in `room:join` payload for per-room seat configuration
- [ ] Test all flows end-to-end
