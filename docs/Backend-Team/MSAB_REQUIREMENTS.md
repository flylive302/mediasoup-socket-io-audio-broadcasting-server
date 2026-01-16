# MSAB Team Requirements: Bootstrap System Integration

> **Socket Events Required for Bootstrap/Preloading System**
> 
> This document outlines the MSAB (Mediasoup Audio Bridge) changes needed to support the new bootstrap system.

---

## Overview

The frontend is replacing polling-based notifications with MSAB socket events. This requires implementing several new event types.

---

## 1. Events Already Implemented ✅

These are working and require no changes:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `gift:send` | Client → Server | Send gift |
| `gift:received` | Server → Client | Broadcast gift animation |
| `gift:error` | Server → Client | Gift transaction failed |
| `chat:message` | Bidirectional | Chat messages |
| `room:join` | Client → Server | Join room |
| `room:userJoined` | Server → Client | User joined room |
| `room:userLeft` | Server → Client | User left room |
| `speaker:active` | Server → Client | Active speaker changed |

---

## 2. Events to Implement (Priority: HIGH)

### Balance & XP Events

#### `balance.updated`

Broadcast when user's coins/diamonds/XP changes.

**Trigger**: Gift sent/received, purchase, reward claim

**Payload**:
```typescript
{
  user_id: number
  coins?: string
  diamonds?: string
  wealth_xp?: string
  charm_xp?: string
}
```

**Target**: Only the affected user (private)

---

### Reward Events

#### `reward.earned`

Broadcast when user earns a reward.

**Payload**:
```typescript
{
  user_id: number
  reward: {
    id: number
    type: string
    amount: string
    description: string
  }
}
```

**Target**: Only the affected user (private)

---

#### `badge.earned`

Broadcast when user earns a badge.

**Payload**:
```typescript
{
  user_id: number
  badge: {
    id: number
    name: string
    image_url: string
    category: 'wealth' | 'charm' | 'room' | 'special'
  }
}
```

**Target**: Only the affected user (private)

---

### Income Events

#### `income_target.completed`

Broadcast when host completes income target.

**Payload**:
```typescript
{
  user_id: number
  target: {
    id: number
    tier: number
    reward_coins: string
  }
}
```

**Target**: Only the affected user (private)

---

### Room Events

#### `room.level_up`

Broadcast when room levels up.

**Payload**:
```typescript
{
  room_id: number
  new_level: number
  new_room_xp: string
}
```

**Target**: All users in the room

---

## 3. Agency Events to Implement (Priority: MEDIUM)

These events enable realtime agency notifications.

### `agency.invitation`

Broadcast when user receives agency invitation.

**Payload**:
```typescript
{
  invitation_id: number
  agency: {
    id: number
    name: string
    logo: string | null
  }
  invited_by: {
    id: number
    name: string
  }
}
```

**Target**: Only the invited user (private)

---

### `agency.join_request`

Broadcast to agency owner when someone requests to join.

**Payload**:
```typescript
{
  request_id: number
  user: {
    id: number
    name: string
    avatar: string | null
  }
  message?: string
}
```

**Target**: Agency owner only (private)

---

### `agency.join_request_approved`

Broadcast when join request is approved.

**Payload**:
```typescript
{
  agency_id: number
  agency_name: string
}
```

**Target**: The requesting user (private)

---

### `agency.join_request_rejected`

Broadcast when join request is rejected.

**Payload**:
```typescript
{
  agency_id: number
  agency_name: string
}
```

**Target**: The requesting user (private)

---

### `agency.member_kicked`

Broadcast when member is removed from agency.

**Payload**:
```typescript
{
  agency_id: number
  agency_name: string
  reason?: string
}
```

**Target**: The kicked member (private)

---

### `agency.dissolved`

Broadcast when agency is dissolved.

**Payload**:
```typescript
{
  agency_id: number
  agency_name: string
}
```

**Target**: All agency members (private to each)

---

## 4. Config Invalidation Events (Priority: LOW)

For cache invalidation when admin updates config.

### `config:invalidate`

**Payload**:
```typescript
{
  type: 'levels' | 'badges' | 'gifts' | 'all'
  version?: string
}
```

**Target**: All connected clients (broadcast)

---

### `asset:invalidate`

**Payload**:
```typescript
{
  asset_ids: string[]
}
```

**Target**: All connected clients (broadcast)

---

## 5. Implementation Notes

### Authentication

All private events require user authentication via the existing socket auth mechanism.

### Event Routing

| Event Type | Routing |
|------------|---------|
| Balance/Reward/Badge/Income | User's socket only |
| Room events | All sockets in room |
| Agency events | Target user(s) socket only |
| Config invalidation | Broadcast to all |

### Laravel Integration

Events should be triggered from Laravel when:
- Database records change (gift sent, badge earned, etc.)
- Use Laravel's event system to emit to MSAB
- MSAB relays to appropriate socket(s)

---

## 6. Summary

| Priority | Events | Count |
|----------|--------|-------|
| HIGH | balance, reward, badge, income, room.level_up | 5 |
| MEDIUM | agency.* | 6 |
| LOW | config/asset invalidation | 2 |
| **Total new events** | | **13** |

---

## Questions for MSAB Team

1. Current mechanism for Laravel → MSAB event emission?
2. User socket tracking for private events?
3. Timeline for implementation?
