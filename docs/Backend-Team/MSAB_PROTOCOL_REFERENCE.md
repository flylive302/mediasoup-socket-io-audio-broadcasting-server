# MSAB Server Integration Protocol

> **Target Audience:** MSAB Server Typescript Team
> **Version:** 1.0.0
> **Base URL:** `https://api.flylive.app` (Production)

This document defines the strict API contract between the MSAB Audio Server and the Laravel Backend.

## Authentication & Security

**Headers Required:**
All internal requests MUST include the shared secret key.

```http
X-Internal-Key: <YOUR_SECURE_SECRET>
Accept: application/json
Content-Type: application/json
```

---

## 1. Validate User Token

**Endpoint:** `POST /api/v1/internal/auth/validate`
**Auth:** Bearer Token (User's Sanctum Token)

**Response (200 OK):**
Strict JSON payload with nested economy object. `decimal` strings used for precision.

```json
{
  "id": 12345,
  "name": "St. Fox",
  "avatar": "https://cdn.flylive.app/avatars/12345.jpg",
  "signature": "st-fox-1",
  "economy": {
    "coins": "100.5000",
    "diamonds": "50.0000",
    "wealth_xp": "1200.0000",
    "charm_xp": "800.0000"
  },
  "is_blocked": false
}
```

**Error (401):** `{"message": "Unauthenticated."}`
---

## 2. Process Gift Transactions (Batch)

**Endpoint:** `POST /api/v1/internal/gifts/batch`

**Behavior:** Atomic processing. Checks sender balance (Coins). Updates Wealth/Charm XP.
**Idempotency:** `transaction_id` is tracked. Duplicates are ignored (count as processed).

**Payload:**

```json
{
  "transactions": [
    {
      "transaction_id": "unique-uuid-v4",
      "sender_id": 45,
      "recipient_id": 99,
      "gift_id": 1,
      "quantity": 10,
      "timestamp": 1700000000000,
      "room_id": "room-uuid-optional" // if available
    }
  ]
}
```

**Response (200 OK):**

```json
{
  "processed_count": 1,
  "failed": [
    {
      "transaction_id": "failed-uuid",
      "code": 4002,
      "reason": "Insufficient coin balance"
    }
  ]
}
```

---

## 4. Room Status Updates

**Endpoint:** `POST /api/v1/internal/rooms/{id}/status`

**Payload:**

```json
{
  "is_live": true,
  "participant_count": 50,
  "started_at": "2024...", // Optional
  "ended_at": null
}
```
