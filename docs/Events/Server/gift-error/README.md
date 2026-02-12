# Broadcast Event: `gift:error`

> **Domain**: Gift  
> **Direction**: Server → Specific User  
> **Transport**: Socket.IO  
> **Triggered By**: Gift batch processing failure (API error or max retries exceeded)

---

## 1. Event Overview

### Purpose

Notifies the sender when their gift transaction failed during batch processing.

### Key Characteristics

| Property     | Value                                         |
| ------------ | --------------------------------------------- |
| Target       | Only sender's socket (via `sender_socket_id`) |
| Emitted From | `giftBuffer.ts` (`flush()` error handling)    |
| Emitted Via  | `this.io.to(sender_socket_id).emit()`         |

---

## 2. Event Payload

```typescript
{
  transactionId: string,   // Gift transaction UUID
  code: string,            // Error code (e.g. "PROCESSING_FAILED", or per-protocol code from Laravel)
  reason: string           // Human-readable error reason
}
```

### Error Sources

| Source               | When                                                 |
| -------------------- | ---------------------------------------------------- |
| Laravel API response | Individual gift rejected (e.g. insufficient balance) |
| Max retries exceeded | Batch failed 3+ times → dead-letter queue            |

---

## 3. Document Metadata

| Property         | Value                            |
| ---------------- | -------------------------------- |
| **Event**        | `gift:error`                     |
| **Created**      | 2026-02-09                       |
| **Last Updated** | 2026-02-12                       |
| **Source**       | `src/domains/gift/giftBuffer.ts` |

### Schema Change Log

| Date       | Change                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 2026-02-12 | Payload rewritten: `{ transaction_id, error, gift_id, recipient_id }` → `{ transactionId, code, reason }` |

---

_Documentation generated following [MSAB Broadcast Template](../../../BROADCAST_TEMPLATE.md)_
