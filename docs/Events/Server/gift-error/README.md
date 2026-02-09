# Event: `gift:error`

> **Domain**: Gift  
> **Direction**: Server → Specific User  
> **Transport**: Socket.IO  
> **Triggered By**: Gift batch processing failure

---

## 1. Event Overview

### Purpose

Notifies sender when a gift transaction fails during batch processing.

### Key Characteristics

| Property     | Value                                   |
| ------------ | --------------------------------------- |
| Target       | Only sender's socket                    |
| Emitted From | `giftBuffer.ts:88`, `giftBuffer.ts:126` |

---

## 2. Event Payload

```typescript
{
  transaction_id: string,
  error: string,
  gift_id: number,
  recipient_id: number
}
```

---

## 3. Document Metadata

| Property | Value                            |
| -------- | -------------------------------- |
| Created  | 2026-02-09                       |
| Source   | `src/domains/gift/giftBuffer.ts` |
