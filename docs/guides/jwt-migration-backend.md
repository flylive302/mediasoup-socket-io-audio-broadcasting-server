# JWT Migration Guide — Laravel Backend

## Overview

The FlyLive Audio Server now authenticates WebSocket connections via **JWT (HMAC-SHA256)** instead of HTTP round-trips to Laravel's `/api/v1/internal/auth/validate` endpoint. This eliminates ~100-200ms of auth latency per connection.

---

## What You Need to Create

### 1. JWT Generation

When a user authenticates (login or token refresh), generate a JWT containing the full user payload. Use **HMAC-SHA256** with a shared secret.

**Shared Secret:** Store as `MSAB_JWT_SECRET` in Laravel `.env`. This value MUST match the `JWT_SECRET` in the audio server's `.env`.

**JWT Payload — Required Fields:**

```json
{
  "id": 42,
  "name": "John Doe",
  "signature": "1234567",
  "email": "john@example.com",
  "avatar": "https://cdn.flyliveapp.com/avatars/42.jpg",
  "frame": "gold",
  "gender": "male",
  "date_of_birth": "1990-01-01",
  "phone": "+1234567890",
  "country": "US",
  "coins": "1000",
  "diamonds": "500",
  "wealth_xp": "2500",
  "charm_xp": "1200",
  "is_blocked": false,
  "isSpeaker": false,
  "iat": 1707500000,
  "exp": 1707586400
}
```

> [!IMPORTANT]
> **All fields are required.** The audio server validates the JWT payload with Zod, and missing fields will cause auth rejection.

**`exp` Claim:** Set to 24 hours from `iat` (recommended). The audio server has a fallback max age of 86400s if `exp` is missing, but always include `exp`.

### 2. Laravel Example (using `firebase/php-jwt`)

```bash
composer require firebase/php-jwt
```

```php
use Firebase\JWT\JWT;

class AudioServerTokenService
{
    public function generateToken(User $user): string
    {
        $secret = config('services.msab.jwt_secret');

        $payload = [
            'id'            => $user->id,
            'name'          => $user->name,
            'signature'     => $user->signature,
            'email'         => $user->email,
            'avatar'        => $user->avatar ?? '',
            'frame'         => $user->frame ?? '',
            'gender'        => $user->gender ?? '',
            'date_of_birth' => $user->date_of_birth ?? '',
            'phone'         => $user->phone ?? '',
            'country'       => $user->country ?? '',
            'coins'         => (string) $user->coins,
            'diamonds'      => (string) $user->diamonds,
            'wealth_xp'     => (string) $user->wealth_xp,
            'charm_xp'      => (string) $user->charm_xp,
            'is_blocked'    => (bool) $user->is_blocked,
            'isSpeaker'     => false,
            'iat'           => time(),
            'exp'           => time() + 86400, // 24 hours
        ];

        return JWT::encode($payload, $secret, 'HS256');
    }
}
```

### 3. Expose the Token

Return the audio server JWT in the login/auth response. Example:

```php
// In your AuthController or TokenController
return response()->json([
    'user'              => $user,
    'token'             => $sanctumToken,  // Existing Sanctum token for API
    'audio_server_token' => $audioServerTokenService->generateToken($user),
]);
```

### 4. Environment Variable

Add to your `.env`:

```
MSAB_JWT_SECRET=<same-value-as-audio-server-JWT_SECRET>
```

Add to `config/services.php`:

```php
'msab' => [
    'jwt_secret' => env('MSAB_JWT_SECRET'),
],
```

---

## What You Can Remove

| Item                                      | Status                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `/api/v1/internal/auth/validate` endpoint | **Can be removed** if no other service calls it. The audio server no longer uses it. |

---

## Token Revocation (Unchanged)

When banning/blocking a user, continue writing to Redis:

```
SET auth:revoked:<sha256_hash_of_jwt> 1 EX 86400
```

The audio server still checks this on every connection.

---

## Data Freshness

- The JWT contains a snapshot of the user at issue time.
- For real-time updates (avatar, name, coins), use the **existing MSAB Redis pub/sub events** — these already push updates to connected sockets.
- For blocking, the Redis revocation check catches it immediately.
