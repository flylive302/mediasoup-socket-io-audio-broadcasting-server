# Broadcast Event Documentation Template

> **Copy this file** when creating documentation for a new **S→C** (Server to Client) broadcast event.  
> For **C→S** events, use `TEMPLATE.md` instead.  
> Replace all placeholders with actual values.
> Delete this header section after copying.

---

# `EVENT_NAME` Broadcast

> **Domain**: DOMAIN_NAME  
> **Direction**: S→C (Broadcast)  
> **Triggered By**: `triggering:event`  
> **Emitted From**: `src/domains/DOMAIN/handler.ts`

---

## 1. Event Overview

### Purpose

Brief description of what this broadcast communicates to clients.

### Key Characteristics

| Property      | Value                                     |
| ------------- | ----------------------------------------- |
| Target        | All sockets in room / excluding sender    |
| Emitted From  | `handler.ts` → `socket.to()` or `io.to()` |
| Trigger Event | `triggering:event` (C→S)                  |

### When Emitted

- Condition 1 that triggers this broadcast
- Condition 2 (if multiple triggers)

---

## 2. Event Payload

### TypeScript Interface

```typescript
/**
 * Payload for `EVENT_NAME` broadcast event.
 * Frontend should use this type when listening.
 */
interface EventNamePayload {
  field1: string;
  field2: number;
}
```

### JSON Example

```json
{
  "field1": "value",
  "field2": 123
}
```

### Field Details

| Field    | Type     | Always Present | Description | Example   |
| -------- | -------- | -------------- | ----------- | --------- |
| `field1` | `string` | ✅             | Description | `"value"` |
| `field2` | `number` | ✅             | Description | `123`     |

---

## 3. Frontend Integration

### Listening (Nuxt)

```typescript
// composables/useDomain.ts
socket.on("EVENT_NAME", (payload: EventNamePayload) => {
  // Handle broadcast
});
```

### Recommended Frontend Handling

| Action       | Description                   |
| ------------ | ----------------------------- |
| State update | What state to update          |
| UI reaction  | What visual change to trigger |

---

## 4. Trigger Source

This event is emitted by the following C→S event handler(s):

| Trigger Event      | Handler                         | Condition            |
| ------------------ | ------------------------------- | -------------------- |
| `triggering:event` | `src/domains/DOMAIN/handler.ts` | After successful ... |

> 📖 See full documentation: [triggering:event](../DOMAIN/trigger/README.md)

---

## 5. Error & Edge Cases

| Scenario                | Behavior                                |
| ----------------------- | --------------------------------------- |
| User disconnects before | Broadcast still sent to remaining users |
| Room is empty           | No recipients, event is a no-op         |

---

## 6. Document Metadata

| Property         | Value        |
| ---------------- | ------------ |
| **Event**        | `EVENT_NAME` |
| **Domain**       | DOMAIN_NAME  |
| **Direction**    | S→C          |
| **Created**      | YYYY-MM-DD   |
| **Last Updated** | YYYY-MM-DD   |

### Schema Change Log

| Date       | Change         | Breaking | Migration Notes |
| ---------- | -------------- | -------- | --------------- |
| YYYY-MM-DD | Initial schema | —        | —               |

---

_Documentation generated following [MSAB Documentation Standard](DOCUMENTATION_STANDARD.md)_
