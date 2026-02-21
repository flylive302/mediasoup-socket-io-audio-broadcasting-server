# `vip.updated` Broadcast

> **Domain**: VIP  
> **Direction**: S→C (Broadcast via Relay)  
> **Triggered By**: Laravel `MSABEventService::emitVipUpdated()`  
> **Emitted From**: Redis pub/sub → `EventRouter` relay

---

## 1. Event Overview

### Purpose

Notifies a user that their VIP status has changed — purchase, gift receipt, or recharge-based grant. MSAB also uses this event as a post-relay hook to sync `socket.data.user.vip_level` for VIP guard enforcement.

### Key Characteristics

| Property      | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Target        | User's sockets (private)                               |
| Emitted From  | `EventRouter` relay + `syncVipLevelOnSockets()` hook   |
| Trigger Event | Laravel `VipService::purchaseVip/giftVip/checkAndGrant`|

### When Emitted

- User purchases VIP for themselves
- User receives VIP as a gift from another user
- User reaches a recharge event threshold that grants VIP

---

## 2. Event Payload

### TypeScript Interface

```typescript
/**
 * Payload for `vip.updated` relay event.
 */
interface VipUpdatedPayload {
  vip_level: number;
  vip_level_name: string;
  vip_color: string;
  vip_expires_at: string | null;
  privileges: string[];
}
```

### JSON Example

```json
{
  "vip_level": 4,
  "vip_level_name": "Diamond",
  "vip_color": "#00c8ff",
  "vip_expires_at": "2026-03-20T16:38:32+00:00",
  "privileges": ["exclusive_frame", "exclusive_badge", "anti_mute", "mall_discount"]
}
```

### Field Details

| Field              | Type       | Always Present | Description                         | Example                          |
| ------------------ | ---------- | -------------- | ----------------------------------- | -------------------------------- |
| `vip_level`        | `number`   | ✅             | Numeric VIP level (0 = none)        | `4`                              |
| `vip_level_name`   | `string`   | ✅             | Display name of VIP level           | `"Diamond"`                      |
| `vip_color`        | `string`   | ✅             | Hex color for VIP badge/name        | `"#00c8ff"`                      |
| `vip_expires_at`   | `string?`  | ✅             | ISO 8601 expiry (null if no VIP)    | `"2026-03-20T16:38:32+00:00"`   |
| `privileges`       | `string[]` | ✅             | Active privilege keys               | `["exclusive_frame", "anti_mute"]`|

---

## 3. Frontend Integration

### Listening (Nuxt)

```typescript
// composables/vip/useVip.ts
socket.on("vip.updated", (payload: VipUpdatedPayload) => {
  vipLevel.value = payload.vip_level;
  vipLevelName.value = payload.vip_level_name;
  vipColor.value = payload.vip_color;
  vipExpiresAt.value = payload.vip_expires_at;
  privileges.value = payload.privileges;
});
```

### Recommended Frontend Handling

| Action       | Description                                      |
| ------------ | ------------------------------------------------ |
| State update | Update VIP level, name, color, expiry in store   |
| UI reaction  | Update VIP badge, name color, privilege indicators|

---

## 4. MSAB Side-Effect

When `vip.updated` is received and successfully relayed, `EventRouter` executes a post-relay hook:

```typescript
syncVipLevelOnSockets(io, userId, vipLevel);
```

This updates `socket.data.user.vip_level` on all user sockets so VIP guards (`isVipAntiMuteProtected`, `isVipAntiKickProtected`) have real-time data.

---

## 5. Error & Edge Cases

| Scenario                       | Behavior                                    |
| ------------------------------ | ------------------------------------------- |
| User has no active sockets     | Event buffered — delivered on reconnect     |
| Socket sync fails              | Non-blocking — relay still completes        |
| VIP expires                    | Backend sends update with `vip_level: 0`    |

---

## 6. Document Metadata

| Property         | Value          |
| ---------------- | -------------- |
| **Event**        | `vip.updated`  |
| **Domain**       | VIP            |
| **Direction**    | S→C            |
| **Created**      | 2026-02-20     |
| **Last Updated** | 2026-02-20     |

### Schema Change Log

| Date       | Change         | Breaking | Migration Notes |
| ---------- | -------------- | -------- | --------------- |
| 2026-02-20 | Initial schema | —        | —               |

---

_Documentation generated following [MSAB Documentation Standard](../../DOCUMENTATION_STANDARD.md)_
