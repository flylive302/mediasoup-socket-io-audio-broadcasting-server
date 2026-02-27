# Laravel Requirements: Cross-Region Room Routing

> **Context:** MSAB now serves 3 AWS regions (Mumbai, UAE, Frankfurt). When a room goes live, MSAB reports which region is hosting it. The frontend needs this info to connect users to the correct regional MSAB instance.

---

## What We Need

MSAB already sends `hosting_region` in the room status update payload. Laravel needs to:

1. **Store** it
2. **Expose** it in room API responses

---

## 1. Database Migration

Add a nullable column to the `rooms` table:

```php
Schema::table('rooms', function (Blueprint $table) {
    $table->string('hosting_region', 20)->nullable()->default(null);
});
```

**Values:** `"ap-south-1"` (Mumbai), `"me-south-1"` (UAE), `"eu-central-1"` (Frankfurt), or `null` (room not live).

---

## 2. Accept `hosting_region` in Room Status Update

MSAB already calls this endpoint. Just accept the new field:

**Endpoint:** `POST /api/v1/internal/rooms/{id}/status`

**Updated payload:**

```json
{
  "is_live": true,
  "participant_count": 5,
  "hosting_region": "ap-south-1"
}
```

**On close:**

```json
{
  "is_live": false,
  "participant_count": 0,
  "ended_at": "2026-02-27T01:00:00Z",
  "hosting_region": null
}
```

**Logic:** When `is_live = false`, always set `hosting_region = null` (defensive — in case MSAB forgets to send it).

---

## 3. Expose `hosting_region` in Room API Responses

### Room Detail

```
GET /api/v1/rooms/{id}

Response:
{
  "id": 42,
  "name": "...",
  "country": "IN",
  "is_live": true,
  "participant_count": 5,
  "hosting_region": "ap-south-1",   ← NEW
  ...
}
```

### Room List

```
GET /api/v1/rooms

Response:
[
  { "id": 42, "hosting_region": "ap-south-1", ... },
  { "id": 43, "hosting_region": null, ... },
  ...
]
```

---

## Region-to-Endpoint Mapping

This is static and will be hardcoded in the frontend. No Laravel config API is needed for now.

| Region            | Endpoint                               |
| ----------------- | -------------------------------------- |
| `ap-south-1`      | `wss://mumbai.audio.flyliveapp.com`    |
| `me-south-1`      | `wss://uae.audio.flyliveapp.com`       |
| `eu-central-1`    | `wss://frankfurt.audio.flyliveapp.com` |
| `null` (not live) | `wss://audio.flyliveapp.com` (default) |

---

## Summary of Changes

| What                                           | Effort      |
| ---------------------------------------------- | ----------- |
| Migration: add `hosting_region` column         | ~5 min      |
| Room status endpoint: accept `hosting_region`  | ~15 min     |
| Room detail/list API: include `hosting_region` | ~15 min     |
| **Total**                                      | **~35 min** |
