# Laravel Backend Integration Requirements

> **Complete reference for integrating your Laravel application with the FlyLive Audio Server.**
>
> This document covers all required API endpoints, request/response formats, authentication, Redis integration, and configuration.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication Endpoint](#2-authentication-endpoint)
3. [Gift Batch Processing Endpoint](#3-gift-batch-processing-endpoint)
4. [Room Status Update Endpoint](#4-room-status-update-endpoint)
5. [Token Revocation (Redis)](#5-token-revocation-redis)
6. [Redis Data Structures Used by Audio Server] (#6-redis-data-structures-used-by-audio-server)
7. [Environment Configuration](#7-environment-configuration)
8. [Complete Implementation Examples](#8-complete-implementation-examples)
9. [Error Handling & Logging](#9-error-handling--logging)
10. [Testing Your Integration](#10-testing-your-integration)

---

## 1. Overview

The Audio Server communicates with your Laravel backend via **internal HTTP APIs** for:

1. **Token Validation** - Validating Sanctum tokens from frontend clients
2. **Gift Processing** - Batch processing gift transactions (balance deductions)
3. **Room Status Updates** - Syncing room live status and participant counts

### Security Model

All internal API calls include:

- `X-Internal-Key` header with a shared secret (32+ characters)
- For auth validation: `Authorization: Bearer <user_token>`

### Request Flow Diagram

```
Frontend → Audio Server → Laravel Backend
    ↓           ↓              ↓
  Token    Validate Token   Return User
    ↓           ↓              ↓
  Events   Process Gifts   Return Status
    ↓           ↓              ↓
  Media    Update Room     Persist State
```

---

## 2. Authentication Endpoint

### **Internal Token Validation**

The Audio Server calls this endpoint to validate Sanctum tokens on each new socket connection.

**Endpoint:** `POST /api/v1/internal/auth/validate`

**Purpose:** Validate the user's Sanctum token and return their profile data.

### Request

**Headers:**

```http
POST /api/v1/internal/auth/validate HTTP/1.1
Host: your-laravel-app.com
Content-Type: application/json
Accept: application/json
Authorization: Bearer {user_sanctum_token}
X-Internal-Key: {shared_secret_32_chars}
```

**Body:** None (empty)

### Response

**Success (200 OK):**

```json
{
  "id": 12345,
  "name": "John Doe",
  "email": "john@example.com",
  "avatar_url": "https://cdn.flylive.app/avatars/12345.jpg",
  "role": "user"
}
```

**Required Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | number | User's unique ID (primary key) |
| `name` | string | Display name |
| `email` | string | Email address |

**Optional Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `avatar_url` | string | Profile picture URL |
| `role` | string | User role (for authorization checks) |
| `*` | any | Any additional user data you want available on the socket |

**Error Responses:**

| Status | Body                                   | When                  |
| ------ | -------------------------------------- | --------------------- |
| 401    | `{"message": "Unauthenticated."}`      | Invalid/expired token |
| 403    | `{"message": "Invalid internal key."}` | Wrong X-Internal-Key  |
| 500    | `{"message": "Server error."}`         | Internal error        |

### Caching Behavior

The Audio Server caches successful validation responses in Redis:

- **Cache Key:** `auth:token:{sha256_hash}`
- **TTL:** 5 minutes (300 seconds)
- **Cache Invalidation:** Via token revocation (see Section 5)

### Laravel Implementation

```php
<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AuthController extends Controller
{
    /**
     * Validate a Sanctum token and return user data.
     * Used by the Audio Server to authenticate socket connections.
     */
    public function validate(Request $request): JsonResponse
    {
        // Token is already validated by auth:sanctum middleware
        $user = $request->user();

        if (!$user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        return response()->json([
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'avatar_url' => $user->avatar_url,
            'role' => $user->role,
            // Add any additional fields needed by the audio server
            'is_vip' => $user->is_vip,
            'coin_balance' => $user->coin_balance,
        ]);
    }
}
```

**Route:**

```php
// routes/api.php
Route::prefix('v1/internal')->middleware(['internal.auth'])->group(function () {
    Route::post('/auth/validate', [AuthController::class, 'validate'])
        ->middleware('auth:sanctum');
});
```

---

## 3. Gift Batch Processing Endpoint

### **Batch Transaction Processing**

The Audio Server batches gift transactions and sends them in bulk for efficiency.

**Endpoint:** `POST /api/v1/internal/gifts/batch`

**Purpose:** Process multiple gift transactions atomically, deducting sender balances and crediting recipients.

### Request

**Headers:**

```http
POST /api/v1/internal/gifts/batch HTTP/1.1
Host: your-laravel-app.com
Content-Type: application/json
Accept: application/json
Authorization: Bearer {internal_key}
X-Internal-Key: {shared_secret_32_chars}
```

**Body:**

```json
{
  "transactions": [
    {
      "transaction_id": "g_1700000000000_abc123_xyz99",
      "room_id": "550e8400-e29b-41d4-a716-446655440000",
      "sender_id": 45,
      "recipient_id": 99,
      "gift_id": "heart_bomb",
      "quantity": 10,
      "timestamp": 1700000000000
    },
    {
      "transaction_id": "g_1700000000001_def456_abc12",
      "room_id": "550e8400-e29b-41d4-a716-446655440000",
      "sender_id": 23,
      "recipient_id": 99,
      "gift_id": "rose",
      "quantity": 1,
      "timestamp": 1700000000001
    }
  ]
}
```

**Transaction Object Schema:**
| Field | Type | Description |
|-------|------|-------------|
| `transaction_id` | string | Unique ID generated by Audio Server (idempotency key) |
| `room_id` | string (UUID) | Room where gift was sent |
| `sender_id` | number | User ID of sender |
| `recipient_id` | number | User ID of recipient |
| `gift_id` | string | Gift type identifier |
| `quantity` | number | Number of gifts (≥1) |
| `timestamp` | number | Unix timestamp in milliseconds |

### Response

**Success (200 OK):**

```json
{
  "processed": 48,
  "failed": [
    {
      "transaction_id": "g_1700000000000_abc123_xyz99",
      "error": "insufficient_balance",
      "sender_id": 45
    },
    {
      "transaction_id": "g_1700000000002_ghi789_mno34",
      "error": "invalid_gift",
      "sender_id": 67
    }
  ]
}
```

**Response Schema:**
| Field | Type | Description |
|-------|------|-------------|
| `processed` | number | Count of successfully processed transactions |
| `failed` | array | Array of failed transactions |
| `failed[].transaction_id` | string | The failed transaction's ID |
| `failed[].error` | string | Error code (see below) |
| `failed[].sender_id` | number | Sender's user ID |

**Error Codes:**
| Code | Description |
|------|-------------|
| `insufficient_balance` | Sender has insufficient coins |
| `invalid_gift` | Gift ID does not exist |
| `invalid_recipient` | Recipient user does not exist |
| `duplicate_transaction` | Transaction ID already processed |
| `processing_error` | General processing failure |

### Important Notes

1. **Idempotency:** Use `transaction_id` to prevent duplicate processing. Store processed IDs.
2. **Atomicity:** Process all-or-nothing within a database transaction when possible.
3. **Performance:** This endpoint may receive 50-200 transactions per call during high activity.
4. **Error Notification:** The Audio Server notifies failed senders via Socket.IO.

### Laravel Implementation

```php
<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Models\Gift;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Cache;

class GiftController extends Controller
{
    /**
     * Process a batch of gift transactions.
     * Called by Audio Server every 500ms with accumulated gifts.
     */
    public function batch(Request $request): JsonResponse
    {
        $request->validate([
            'transactions' => 'required|array',
            'transactions.*.transaction_id' => 'required|string',
            'transactions.*.room_id' => 'required|uuid',
            'transactions.*.sender_id' => 'required|integer|min:1',
            'transactions.*.recipient_id' => 'required|integer|min:1',
            'transactions.*.gift_id' => 'required|string',
            'transactions.*.quantity' => 'required|integer|min:1',
            'transactions.*.timestamp' => 'required|integer',
        ]);

        $transactions = $request->input('transactions');
        $processed = 0;
        $failed = [];

        foreach ($transactions as $tx) {
            // Check for duplicate
            $cacheKey = "gift_tx:{$tx['transaction_id']}";
            if (Cache::has($cacheKey)) {
                $failed[] = [
                    'transaction_id' => $tx['transaction_id'],
                    'error' => 'duplicate_transaction',
                    'sender_id' => $tx['sender_id'],
                ];
                continue;
            }

            try {
                $result = $this->processTransaction($tx);

                if ($result['success']) {
                    $processed++;
                    // Mark as processed (24 hour expiry)
                    Cache::put($cacheKey, true, now()->addHours(24));
                } else {
                    $failed[] = [
                        'transaction_id' => $tx['transaction_id'],
                        'error' => $result['error'],
                        'sender_id' => $tx['sender_id'],
                    ];
                }
            } catch (\Exception $e) {
                report($e);
                $failed[] = [
                    'transaction_id' => $tx['transaction_id'],
                    'error' => 'processing_error',
                    'sender_id' => $tx['sender_id'],
                ];
            }
        }

        return response()->json([
            'processed' => $processed,
            'failed' => $failed,
        ]);
    }

    private function processTransaction(array $tx): array
    {
        return DB::transaction(function () use ($tx) {
            // Get gift price
            $gift = Gift::find($tx['gift_id']);
            if (!$gift) {
                return ['success' => false, 'error' => 'invalid_gift'];
            }

            $totalCost = $gift->price * $tx['quantity'];

            // Get sender with lock
            $sender = User::lockForUpdate()->find($tx['sender_id']);
            if (!$sender || $sender->coin_balance < $totalCost) {
                return ['success' => false, 'error' => 'insufficient_balance'];
            }

            // Get recipient
            $recipient = User::find($tx['recipient_id']);
            if (!$recipient) {
                return ['success' => false, 'error' => 'invalid_recipient'];
            }

            // Deduct from sender
            $sender->decrement('coin_balance', $totalCost);

            // Credit recipient (with platform cut if applicable)
            $recipientShare = $gift->value * $tx['quantity'];
            $recipient->increment('diamond_balance', $recipientShare);

            // Record transaction
            DB::table('gift_transactions')->insert([
                'transaction_id' => $tx['transaction_id'],
                'room_id' => $tx['room_id'],
                'sender_id' => $tx['sender_id'],
                'recipient_id' => $tx['recipient_id'],
                'gift_id' => $tx['gift_id'],
                'quantity' => $tx['quantity'],
                'total_cost' => $totalCost,
                'recipient_share' => $recipientShare,
                'created_at' => now(),
            ]);

            return ['success' => true];
        });
    }
}
```

---

## 4. Room Status Update Endpoint

### **Update Room Status**

The Audio Server notifies Laravel when room status changes.

**Endpoint:** `POST /api/v1/internal/rooms/{id}/status`

**Purpose:** Sync the room's live status, participant count, and closure time with the database.

### Request

**Headers:**

```http
POST /api/v1/internal/rooms/{roomId}/status HTTP/1.1
Host: your-laravel-app.com
Content-Type: application/json
Accept: application/json
Authorization: Bearer {internal_key}
X-Internal-Key: {shared_secret_32_chars}
```

**URL Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string (UUID) | The room's unique identifier |

**Body:**

```json
{
  "is_live": true,
  "participant_count": 42
}
```

**Or when closing:**

```json
{
  "is_live": false,
  "participant_count": 0,
  "closed_at": "2024-01-15T12:30:45.000Z"
}
```

**Request Body Schema:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `is_live` | boolean | Yes | Whether the room is currently active |
| `participant_count` | number | Yes | Current number of participants (≥0) |
| `closed_at` | string (ISO 8601) | No | Timestamp when room was closed |

### Response

**Success (200 OK):**

```json
{
  "success": true
}
```

**Success (204 No Content):** Also acceptable

**Error (404 Not Found):**

```json
{
  "message": "Room not found."
}
```

### When This Endpoint Is Called

| Scenario                  | `is_live`         | `participant_count` | `closed_at`       |
| ------------------------- | ----------------- | ------------------- | ----------------- |
| Room created (first join) | `true`            | `0`                 | -                 |
| User joins                | `true`            | `{updated count}`   | -                 |
| User leaves               | `true` or `false` | `{updated count}`   | -                 |
| Room closes               | `false`           | `0`                 | `{ISO timestamp}` |

### Laravel Implementation

```php
<?php

namespace App\Http\Controllers\Internal;

use App\Http\Controllers\Controller;
use App\Models\Room;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class RoomController extends Controller
{
    /**
     * Update room status from Audio Server.
     * Called when participants join/leave or room closes.
     */
    public function updateStatus(Request $request, string $roomId): JsonResponse
    {
        $request->validate([
            'is_live' => 'required|boolean',
            'participant_count' => 'required|integer|min:0',
            'closed_at' => 'nullable|date',
        ]);

        $room = Room::find($roomId);

        if (!$room) {
            return response()->json(['message' => 'Room not found.'], 404);
        }

        $room->update([
            'is_live' => $request->input('is_live'),
            'participant_count' => $request->input('participant_count'),
            'closed_at' => $request->input('closed_at'),
            'last_activity_at' => now(),
        ]);

        // Optional: Dispatch events for real-time updates elsewhere
        if (!$request->input('is_live') && $request->input('closed_at')) {
            event(new RoomClosed($room));
        }

        return response()->json(['success' => true]);
    }
}
```

---

## 5. Token Revocation (Redis)

When a user logs out or their token is revoked, you must add the token to the revocation list in Redis so the Audio Server can immediately reject connections using that token.

### Redis Key Format

```
auth:revoked:{sha256_hash_of_token}
```

### Setting Token Revocation

```php
<?php

use Illuminate\Support\Facades\Redis;

class TokenRevocationService
{
    /**
     * Revoke a token so the Audio Server rejects it.
     */
    public function revoke(string $token): void
    {
        $hash = hash('sha256', $token);
        $key = "auth:revoked:{$hash}";

        // TTL should be longer than auth cache (5 min) to ensure rejection
        // 24 hours is safe
        Redis::setex($key, 86400, '1');

        // Also clear the auth cache if you want immediate effect
        $cacheKey = "auth:token:{$hash}";
        Redis::del($cacheKey);
    }

    /**
     * Called when user logs out.
     */
    public function revokeAllUserTokens(int $userId): void
    {
        // Get all tokens for this user from personal_access_tokens table
        $tokens = DB::table('personal_access_tokens')
            ->where('tokenable_id', $userId)
            ->where('tokenable_type', User::class)
            ->pluck('token');

        foreach ($tokens as $tokenHash) {
            // Note: Sanctum stores hashed tokens, you may need the plain token
            // If you stored the plain token at creation time, use that
            $this->revoke($tokenHash);
        }
    }
}
```

### Usage in Logout Controller

```php
<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Services\TokenRevocationService;
use Illuminate\Http\Request;

class LogoutController extends Controller
{
    public function __construct(
        private TokenRevocationService $tokenRevocation
    ) {}

    public function logout(Request $request)
    {
        // Get the current token before deleting
        $token = $request->user()->currentAccessToken();

        // Revoke in Redis for Audio Server
        if ($token && method_exists($token, 'token')) {
            $this->tokenRevocation->revoke($token->token);
        }

        // Delete from Laravel
        $token?->delete();

        return response()->json(['message' => 'Logged out successfully.']);
    }
}
```

---

## 6. Redis Data Structures Used by Audio Server

The Audio Server uses Redis for state management. Understanding these structures helps with debugging and monitoring.

### Keys and Schemas

| Key Pattern           | Type          | TTL    | Description                             |
| --------------------- | ------------- | ------ | --------------------------------------- |
| `auth:token:{hash}`   | String (JSON) | 5 min  | Cached user data after auth validation  |
| `auth:revoked:{hash}` | String        | 24 hrs | Revoked token markers                   |
| `room:state:{roomId}` | String (JSON) | 24 hrs | Room state (status, participants, etc.) |
| `room:seats:{roomId}` | Hash          | None   | Seat occupancy (position → userId)      |
| `ratelimit:{key}`     | String        | Varies | Rate limit counters                     |
| `gifts:pending`       | List          | None   | Pending gift transactions queue         |

### Room State Schema

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ACTIVE",
  "participantCount": 15,
  "createdAt": 1700000000000,
  "lastActivityAt": 1700001234567,
  "speakers": ["user123", "user456"]
}
```

**Status Values:** `CREATED` | `ACTIVE` | `CLOSING` | `CLOSED`

### Monitoring Commands

```bash
# Check if a token is revoked
redis-cli EXISTS auth:revoked:{token_hash}

# Get room state
redis-cli GET room:state:{room_id}

# Check seat occupancy
redis-cli HGETALL room:seats:{room_id}

# Monitor gift queue size
redis-cli LLEN gifts:pending

# Watch all audio server keys
redis-cli KEYS "*" | grep -E "(auth:|room:|gift)"
```

---

## 7. Environment Configuration

### Audio Server `.env`

```env
# Server
NODE_ENV=production
PORT=3030
LOG_LEVEL=info

# Redis (should match Laravel's Redis connection for DB 3 or separate)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_DB=3

# Laravel Integration (CRITICAL)
LARAVEL_API_URL=https://api.flylive.app
LARAVEL_INTERNAL_KEY=your_secure_32_character_secret_key

# MediaSoup
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=your.public.ip.address
MEDIASOUP_RTC_MIN_PORT=10000
MEDIASOUP_RTC_MAX_PORT=59999

# Limits
MAX_ROOMS_PER_WORKER=100
MAX_CLIENTS_PER_ROOM=50
RATE_LIMIT_MESSAGES_PER_MINUTE=60

# Security
CORS_ORIGINS=https://app.flylive.app,https://www.flylive.app
```

### Laravel `.env` Additions

```env
# Audio Server Internal Key (must match audio server)
AUDIO_SERVER_INTERNAL_KEY=your_secure_32_character_secret_key

# Redis DB for Audio Server (if sharing Redis)
# Audio Server uses DB 3 by default to avoid conflicts
```

### Internal Auth Middleware for Laravel

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class InternalAuth
{
    /**
     * Validate internal API requests from Audio Server.
     */
    public function handle(Request $request, Closure $next)
    {
        $internalKey = $request->header('X-Internal-Key');
        $expectedKey = config('services.audio_server.internal_key');

        if (!$internalKey || !hash_equals($expectedKey, $internalKey)) {
            return response()->json(['message' => 'Invalid internal key.'], 403);
        }

        return $next($request);
    }
}
```

**Register in Kernel:**

```php
// app/Http/Kernel.php
protected $middlewareAliases = [
    // ...
    'internal.auth' => \App\Http\Middleware\InternalAuth::class,
];
```

**Config:**

```php
// config/services.php
return [
    // ...
    'audio_server' => [
        'internal_key' => env('AUDIO_SERVER_INTERNAL_KEY'),
    ],
];
```

---

## 8. Complete Implementation Examples

### Complete Routes File

```php
<?php
// routes/api.php

use App\Http\Controllers\Internal\AuthController;
use App\Http\Controllers\Internal\GiftController;
use App\Http\Controllers\Internal\RoomController;

// Internal APIs for Audio Server
Route::prefix('v1/internal')
    ->middleware(['internal.auth'])
    ->group(function () {
        // Token validation (also requires user's Sanctum token)
        Route::post('/auth/validate', [AuthController::class, 'validate'])
            ->middleware('auth:sanctum');

        // Gift batch processing
        Route::post('/gifts/batch', [GiftController::class, 'batch']);

        // Room status updates
        Route::post('/rooms/{roomId}/status', [RoomController::class, 'updateStatus']);
    });
```

### Gift Transaction Migration

```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('gift_transactions', function (Blueprint $table) {
            $table->string('transaction_id')->primary(); // Idempotency key
            $table->uuid('room_id')->index();
            $table->foreignId('sender_id')->constrained('users');
            $table->foreignId('recipient_id')->constrained('users');
            $table->string('gift_id');
            $table->unsignedInteger('quantity');
            $table->unsignedBigInteger('total_cost');
            $table->unsignedBigInteger('recipient_share');
            $table->timestamp('created_at');

            $table->index(['sender_id', 'created_at']);
            $table->index(['recipient_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('gift_transactions');
    }
};
```

### Room Model Updates

```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Room extends Model
{
    protected $keyType = 'string';
    public $incrementing = false;

    protected $fillable = [
        'id',
        'user_id', // Owner
        'name',
        'is_live',
        'participant_count',
        'closed_at',
        'last_activity_at',
    ];

    protected $casts = [
        'is_live' => 'boolean',
        'participant_count' => 'integer',
        'closed_at' => 'datetime',
        'last_activity_at' => 'datetime',
    ];
}
```

---

## 9. Error Handling & Logging

### Logging Internal API Calls

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class LogInternalApiCalls
{
    public function handle(Request $request, Closure $next)
    {
        $startTime = microtime(true);

        $response = $next($request);

        $duration = round((microtime(true) - $startTime) * 1000, 2);

        Log::channel('audio_server')->info('Internal API call', [
            'method' => $request->method(),
            'path' => $request->path(),
            'status' => $response->status(),
            'duration_ms' => $duration,
            'ip' => $request->ip(),
        ]);

        return $response;
    }
}
```

### Handling Failures Gracefully

The Audio Server handles Laravel API failures gracefully:

1. **Auth Validation Failure:** Socket connection is rejected
2. **Room Status Failure:** Logged but doesn't affect room operation
3. **Gift Batch Failure:** Transactions are re-queued and retried

Your Laravel implementation should:

- Return appropriate HTTP status codes
- Log errors with context
- Avoid blocking on external services
- Use database transactions for data integrity

---

## 10. Testing Your Integration

### Manual Testing with cURL

**Test Auth Endpoint:**

```bash
curl -X POST https://api.flylive.app/api/v1/internal/auth/validate \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer {user_token}" \
  -H "X-Internal-Key: {internal_key}"
```

**Test Gift Batch:**

```bash
curl -X POST https://api.flylive.app/api/v1/internal/gifts/batch \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "X-Internal-Key: {internal_key}" \
  -d '{
    "transactions": [
      {
        "transaction_id": "test_123",
        "room_id": "550e8400-e29b-41d4-a716-446655440000",
        "sender_id": 1,
        "recipient_id": 2,
        "gift_id": "rose",
        "quantity": 1,
        "timestamp": 1700000000000
      }
    ]
  }'
```

**Test Room Status:**

```bash
curl -X POST https://api.flylive.app/api/v1/internal/rooms/{room_id}/status \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "X-Internal-Key: {internal_key}" \
  -d '{
    "is_live": true,
    "participant_count": 5
  }'
```

### PHPUnit Tests

```php
<?php

namespace Tests\Feature\Internal;

use App\Models\User;
use App\Models\Gift;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class InternalApiTest extends TestCase
{
    use RefreshDatabase;

    private string $internalKey;

    protected function setUp(): void
    {
        parent::setUp();
        $this->internalKey = config('services.audio_server.internal_key');
    }

    public function test_auth_validate_returns_user_data(): void
    {
        $user = User::factory()->create();
        $token = $user->createToken('test')->plainTextToken;

        $response = $this->postJson('/api/v1/internal/auth/validate', [], [
            'Authorization' => "Bearer {$token}",
            'X-Internal-Key' => $this->internalKey,
        ]);

        $response->assertOk()
            ->assertJsonStructure(['id', 'name', 'email']);
    }

    public function test_auth_validate_rejects_invalid_token(): void
    {
        $response = $this->postJson('/api/v1/internal/auth/validate', [], [
            'Authorization' => 'Bearer invalid_token',
            'X-Internal-Key' => $this->internalKey,
        ]);

        $response->assertUnauthorized();
    }

    public function test_gift_batch_processes_transactions(): void
    {
        $sender = User::factory()->create(['coin_balance' => 1000]);
        $recipient = User::factory()->create();
        $gift = Gift::factory()->create(['price' => 100, 'value' => 80]);

        $response = $this->postJson('/api/v1/internal/gifts/batch', [
            'transactions' => [
                [
                    'transaction_id' => 'test_' . uniqid(),
                    'room_id' => fake()->uuid(),
                    'sender_id' => $sender->id,
                    'recipient_id' => $recipient->id,
                    'gift_id' => $gift->id,
                    'quantity' => 2,
                    'timestamp' => now()->timestamp * 1000,
                ],
            ],
        ], [
            'X-Internal-Key' => $this->internalKey,
        ]);

        $response->assertOk()
            ->assertJson(['processed' => 1, 'failed' => []]);

        $this->assertDatabaseHas('users', [
            'id' => $sender->id,
            'coin_balance' => 800, // 1000 - (100 * 2)
        ]);
    }

    public function test_gift_batch_handles_insufficient_balance(): void
    {
        $sender = User::factory()->create(['coin_balance' => 50]);
        $recipient = User::factory()->create();
        $gift = Gift::factory()->create(['price' => 100]);

        $response = $this->postJson('/api/v1/internal/gifts/batch', [
            'transactions' => [
                [
                    'transaction_id' => 'test_' . uniqid(),
                    'room_id' => fake()->uuid(),
                    'sender_id' => $sender->id,
                    'recipient_id' => $recipient->id,
                    'gift_id' => $gift->id,
                    'quantity' => 1,
                    'timestamp' => now()->timestamp * 1000,
                ],
            ],
        ], [
            'X-Internal-Key' => $this->internalKey,
        ]);

        $response->assertOk()
            ->assertJsonPath('processed', 0)
            ->assertJsonPath('failed.0.error', 'insufficient_balance');
    }
}
```

---

## Quick Reference

### Required Endpoints

| Endpoint                             | Method | Middleware                      | Purpose                   |
| ------------------------------------ | ------ | ------------------------------- | ------------------------- |
| `/api/v1/internal/auth/validate`     | POST   | `internal.auth`, `auth:sanctum` | Validate user tokens      |
| `/api/v1/internal/gifts/batch`       | POST   | `internal.auth`                 | Process gift transactions |
| `/api/v1/internal/rooms/{id}/status` | POST   | `internal.auth`                 | Update room status        |

### Required Headers on All Internal Requests

```http
Content-Type: application/json
Accept: application/json
X-Internal-Key: {32_character_shared_secret}
```

### Redis Keys to Set on Logout

```
auth:revoked:{sha256_of_token} = "1" (TTL: 24 hours)
```

---

**Audio Server URL:** `wss://audio.flylive.app:3030` (Production)

**Required Firewall Ports:** UDP 10000-59999 (WebRTC), TCP 3030 (Socket.IO)
