# `vip.gifted` Broadcast

> **Domain**: VIP  
> **Direction**: S→C (Broadcast via Relay)  
> **Triggered By**: Laravel `MSABEventService::emitVipGifted()`  
> **Emitted From**: Redis pub/sub → `EventRouter` relay

---

## 1. Event Overview

### Purpose

Notifies a user that they received VIP as a gift from another user. Used to trigger gift receipt animations and notifications on the frontend.

### Key Characteristics

| Property      | Value                                                     |
| ------------- | --------------------------------------------------------- |
| Target        | Recipient's sockets (private)                             |
| Emitted From  | `EventRouter` relay (pure pass-through)                   |
| Trigger Event | Laravel `VipService::giftVip()` → `MSABEventService`     |

### When Emitted

- A user gifts VIP to another user (follower/following relationship required)

---

## 2. Event Payload

### TypeScript Interface

```typescript
/**
 * Payload for `vip.gifted` relay event.
 */
interface VipGiftedPayload {
  sender: {
    id: number;
    name: string;
    avatar: string;
  };
  vip_level: number;
  vip_level_name: string;
  vip_color: string;
  duration_days: number;
}
```

### JSON Example

```json
{
  "sender": {
    "id": 42,
    "name": "Player1",
    "avatar": "https://cdn.flyliveapp.com/avatars/42.jpg"
  },
  "vip_level": 3,
  "vip_level_name": "Platinum",
  "vip_color": "#b0c4de",
  "duration_days": 30
}
```

### Field Details

| Field             | Type     | Always Present | Description                      | Example          |
| ----------------- | -------- | -------------- | -------------------------------- | ---------------- |
| `sender.id`       | `number` | ✅             | Gift sender user ID              | `42`             |
| `sender.name`     | `string` | ✅             | Gift sender display name         | `"Player1"`      |
| `sender.avatar`   | `string` | ✅             | Gift sender avatar URL           | `"https://..."` |
| `vip_level`       | `number` | ✅             | VIP level gifted                 | `3`              |
| `vip_level_name`  | `string` | ✅             | Display name of gifted VIP level | `"Platinum"`     |
| `vip_color`       | `string` | ✅             | Hex color of gifted VIP level    | `"#b0c4de"`      |
| `duration_days`   | `number` | ✅             | Duration of the VIP gift in days | `30`             |

---

## 3. Frontend Integration

### Listening (Nuxt)

```typescript
// composables/vip/useVipGift.ts
socket.on("vip.gifted", (payload: VipGiftedPayload) => {
  showGiftNotification({
    senderName: payload.sender.name,
    senderAvatar: payload.sender.avatar,
    vipLevelName: payload.vip_level_name,
    vipColor: payload.vip_color,
    durationDays: payload.duration_days,
  });
});
```

### Recommended Frontend Handling

| Action       | Description                                         |
| ------------ | --------------------------------------------------- |
| Notification | Show gift receipt notification with sender info     |
| Animation    | Play VIP gift animation (SVGA)                      |
| State update | VIP state is updated by the companion `vip.updated` |

> [!NOTE]  
> `vip.gifted` is always accompanied by `vip.updated`. The gift event provides sender context for UI; the update event carries the actual VIP state change.

---

## 4. Trigger Source

| Trigger               | Handler                                | Condition                    |
| --------------------- | -------------------------------------- | ---------------------------- |
| VIP gift purchase     | `VipService::giftVip()`               | After successful coin deduct |
| `MSABEventService`    | `emitVipGifted(recipient, sender, vl)` | Emitted alongside `vip.updated` |

---

## 5. Error & Edge Cases

| Scenario                   | Behavior                                  |
| -------------------------- | ----------------------------------------- |
| Recipient has no sockets   | Event buffered — delivered on reconnect   |
| Self-gift attempt          | Blocked by `VipService` validation        |
| No follower relationship   | Blocked by `VipService` validation        |

---

## 6. Document Metadata

| Property         | Value         |
| ---------------- | ------------- |
| **Event**        | `vip.gifted`  |
| **Domain**       | VIP           |
| **Direction**    | S→C           |
| **Created**      | 2026-02-20    |
| **Last Updated** | 2026-02-20    |

### Schema Change Log

| Date       | Change         | Breaking | Migration Notes |
| ---------- | -------------- | -------- | --------------- |
| 2026-02-20 | Initial schema | —        | —               |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
