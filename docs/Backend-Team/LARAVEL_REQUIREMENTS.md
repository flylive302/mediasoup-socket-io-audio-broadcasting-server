# Laravel Backend Requirements: Bootstrap System

> **API Changes and New Endpoints for Bootstrap/Preloading System**
>
> This document outlines the Laravel backend changes needed to support the new bootstrap system.

---

## Changelog

| Date       | Change                                                                             |
| ---------- | ---------------------------------------------------------------------------------- |
| 2024-01-14 | **REMOVED** `feature_flags` from bootstrap response (no gradual rollout needed)    |
| 2024-01-14 | **ADDED** Web Push library recommendation: `laravel-notification-channels/webpush` |

---

## Overview

The frontend is consolidating multiple API calls into a single bootstrap endpoint. This requires a new endpoint and schema changes.

**Important**: We are migrating directly to new implementation (no feature flags, no gradual rollout).

---

## 1. New Endpoint: `/api/v1/bootstrap`

### Purpose

Single endpoint that returns all data needed for app initialization.

### Method

`GET /api/v1/bootstrap`

### Authentication

Required (Sanctum Bearer Token)

### Response Schema

```php
{
    "version": "1.0.0",

    "user": {
        // BootstrapUser - 18 fields (see section 2)
    },

    "config": {
        "wealth_levels": [...],   // LevelConfigItem[]
        "charm_levels": [...],    // LevelConfigItem[]
        "room_levels": [...],     // LevelConfigItem[] (NEW)
        "level_badges": [...]     // Badge[] for levels only
    },

    "gifts": {
        "catalog": [...],         // Top 30 by sort_order
        "total": 150              // Total gift count for pagination
    },

    "user_data": {
        "levels": {
            "wealth": {...},      // LevelStatus
            "charm": {...}        // LevelStatus
        },
        "badges": [...],          // UserBadge[]
        "income_target": {...},   // IncomeTarget | null
        "agency": {...}           // UserAgencyContext | null
    },

    "push_config": {
        "vapid_public_key": "..."
    }
}
```

### Cache Headers

```
Cache-Control: private, max-age=300
ETag: "abc123"
```

---

## 2. BootstrapUser Schema (18 fields)

Replace the full User response with minimal fields:

```php
class BootstrapUserResource extends JsonResource
{
    public function toArray($request)
    {
        return [
            // Identity
            'id' => $this->id,
            'name' => $this->name,
            'signature' => $this->signature,
            'avatar' => $this->getOriginalAvatarUrl(), // Single URL only

            // Phone (essential)
            'phone' => $this->phone,
            'phone_country' => $this->phone_country,
            'phone_country_code' => $this->phone_country_code,

            // Demographics
            'gender' => $this->gender,
            'date_of_birth' => $this->date_of_birth,

            // Economy
            'coins' => $this->coins,
            'diamonds' => $this->diamonds,
            'wealth_xp' => $this->wealth_xp,
            'charm_xp' => $this->charm_xp,

            // Profile completion
            'is_profile_complete' => $this->profile_completion?->is_complete ?? false,

            // Block fields (auth-time only)
            'is_blocked' => $this->is_blocked,
            'blocked_at' => $this->blocked_at,
            'blocked_reason' => $this->blocked_reason,
            'locked_until' => $this->locked_until,
        ];
    }
}
```

### Fields REMOVED from response:

- `email_verified_at`
- `last_login_at`
- `created_at`
- `updated_at`
- `permissions`
- `roles`
- `avatar.thumbnail`, `avatar.medium`, `avatar.large` (keep only original)

---

## 3. MinimalUser Schema (7 fields)

For all nested user references (room owner, members, agency members):

```php
class MinimalUserResource extends JsonResource
{
    public function toArray($request)
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'avatar' => $this->getOriginalAvatarUrl(),
            'gender' => $this->gender,
            'date_of_birth' => $this->date_of_birth,
            'wealth_xp' => $this->wealth_xp,
            'charm_xp' => $this->charm_xp,
        ];
    }
}
```

### Apply to:

- `Room.user` (owner)
- `RoomMember.user`
- `RoomJoinRequest.user`
- `RoomInvitation.inviter`, `invitee`
- `AgencyMember.user`
- `AgencyInvitation.user`, `invited_by`
- `AgencyJoinRequest.user`, `processed_by`

---

## 4. Room Schema Changes

### New Field: `room_xp`

Add `room_xp` column to rooms table (same pattern as user's wealth_xp/charm_xp).

```php
// Migration
Schema::table('rooms', function (Blueprint $table) {
    $table->decimal('room_xp', 20, 3)->default(0);
});
```

### New Field: `sort_order`

For room display priority:

```php
$table->integer('sort_order')->default(0);
```

### Room Resource

```php
class RoomResource extends JsonResource
{
    public function toArray($request)
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'logo' => $this->getOriginalLogoUrl(), // Single URL
            'type' => $this->type,
            'country' => $this->country,
            'is_live' => $this->is_live,
            'participant_count' => $this->participant_count,
            'sort_order' => $this->sort_order,
            'room_xp' => $this->room_xp,

            'owner' => new MinimalUserResource($this->user),
        ];
    }
}
```

---

## 5. Level Configuration Changes

### New: Room Levels

Add room level configuration (same structure as wealth/charm):

```php
// LevelConfigItem structure
{
    "level": 1,
    "name": "Bronze Room",
    "required_xp": 1000,
    "badge_id": 45  // Reference to badge, not full object
}
```

### Badge ID Reference

Level config should return `badge_id` only, not full badge object:

```php
// BEFORE (duplicated data)
"badge": { "id": 1, "name": "...", "image_url": "..." }

// AFTER (reference only)
"badge_id": 1
```

Separate `level_badges` array contains full badge objects.

---

## 6. Gift Pagination

### Bootstrap Request

Return first 30 gifts sorted by `sort_order`:

```php
Gift::orderBy('sort_order')->take(30)->get()
```

### Include Total Count

```php
"gifts": {
    "catalog": [...],
    "total": Gift::count()
}
```

---

## 7. Endpoints Becoming Redundant

After bootstrap is implemented, these endpoints will see reduced traffic:

| Endpoint              | Status        | Notes                            |
| --------------------- | ------------- | -------------------------------- |
| `GET /auth/user`      | Keep          | Still needed for refreshing user |
| `GET /profile/levels` | Keep          | Still needed for refresh         |
| `GET /levels/config`  | Keep          | Still needed for refresh         |
| `GET /gifts/all`      | **Deprecate** | Use `/gifts` with pagination     |

### Recommendation

- Keep all existing endpoints for backward compatibility
- Add deprecation headers to `/gifts/all`
- New clients use `/api/v1/bootstrap` + pagination

---

## 8. Avatar Response Changes

### Current

```php
'avatar' => [
    'thumbnail' => $this->getAvatarUrl('thumbnail'),
    'medium' => $this->getAvatarUrl('medium'),
    'large' => $this->getAvatarUrl('large'),
    'original' => $this->getAvatarUrl('original'),
]
```

### After

```php
'avatar' => $this->getAvatarUrl('original')
```

Frontend handles transforms via Nuxt Image + ImageKit.

### Apply to:

- User responses
- Room logo responses
- Agency logo responses

---

## 9. Web Push Notifications Setup

> **UPDATED**: Added library recommendation

### Recommended Package

**[laravel-notification-channels/webpush](https://github.com/laravel-notification-channels/webpush)**

This is the official Laravel notification channel for Web Push, built on `minishlink/web-push`.

### Installation

```bash
composer require laravel-notification-channels/webpush
php artisan vendor:publish --provider="NotificationChannels\WebPush\WebPushServiceProvider"
php artisan webpush:vapid
php artisan migrate
```

### VAPID Keys

The `webpush:vapid` command generates keys and adds them to `.env`:

```env
VAPID_PUBLIC_KEY="BEl62iU..."
VAPID_PRIVATE_KEY="8rZvwGU..."
VAPID_SUBJECT="mailto:admin@flylive.com"
```

### Config

```php
// config/webpush.php
return [
    'vapid' => [
        'subject' => env('VAPID_SUBJECT'),
        'public_key' => env('VAPID_PUBLIC_KEY'),
        'private_key' => env('VAPID_PRIVATE_KEY'),
    ],
];
```

### Bootstrap Response

Only return the public key:

```php
'push_config' => [
    'vapid_public_key' => config('webpush.vapid.public_key'),
]
```

### User Model

```php
use NotificationChannels\WebPush\HasPushSubscriptions;

class User extends Authenticatable
{
    use HasPushSubscriptions;
}
```

### Subscription Endpoint

```php
// routes/api.php
Route::post('/push-subscriptions', [PushSubscriptionController::class, 'store']);
Route::delete('/push-subscriptions', [PushSubscriptionController::class, 'destroy']);

// Controller
public function store(Request $request)
{
    $request->user()->updatePushSubscription(
        $request->input('endpoint'),
        $request->input('keys.p256dh'),
        $request->input('keys.auth')
    );

    return response()->json(['success' => true]);
}
```

### Sending Notifications

```php
use NotificationChannels\WebPush\WebPushChannel;
use NotificationChannels\WebPush\WebPushMessage;

class GiftReceivedNotification extends Notification
{
    public function via($notifiable)
    {
        return [WebPushChannel::class];
    }

    public function toWebPush($notifiable, $notification)
    {
        return (new WebPushMessage)
            ->title('Gift Received!')
            ->body('You received a gift from someone')
            ->icon('/icon-192x192.png')
            ->data(['url' => '/gifts']);
    }
}
```

---

## 10. MSAB Event Triggers

Laravel needs to emit events to MSAB when:

| Action                  | Event                          |
| ----------------------- | ------------------------------ |
| Gift sent               | `balance.updated` (both users) |
| Badge earned            | `badge.earned`                 |
| Reward claimed          | `reward.earned`                |
| Income target complete  | `income_target.completed`      |
| Room receives gift      | `room.level_up` (if leveled)   |
| Agency invitation sent  | `agency.invitation`            |
| Agency request received | `agency.join_request`          |
| Agency request approved | `agency.join_request_approved` |
| Agency member kicked    | `agency.member_kicked`         |
| Agency dissolved        | `agency.dissolved`             |

See [MSAB_REQUIREMENTS.md](./MSAB_REQUIREMENTS.md) for event payloads.

---

## 11. Summary of Changes

### Database

| Table              | Change                               |
| ------------------ | ------------------------------------ |
| rooms              | Add `room_xp`, `sort_order` columns  |
| push_subscriptions | Created by webpush package migration |

### New Resources

| Resource                     | Purpose                       |
| ---------------------------- | ----------------------------- |
| `BootstrapUserResource`      | 18-field user for bootstrap   |
| `MinimalUserResource`        | 7-field user for references   |
| `BootstrapController`        | Handle `/api/v1/bootstrap`    |
| `PushSubscriptionController` | Handle push subscription CRUD |

### Modified Resources

| Resource              | Change                                         |
| --------------------- | ---------------------------------------------- |
| `UserResource`        | Return single avatar URL                       |
| `RoomResource`        | Use MinimalUserResource for owner, add room_xp |
| `LevelConfigResource` | Return badge_id instead of full badge          |

### New Endpoints

| Endpoint                  | Method | Purpose                     |
| ------------------------- | ------ | --------------------------- |
| `/api/v1/bootstrap`       | GET    | Consolidated bootstrap data |
| `/api/push-subscriptions` | POST   | Store push subscription     |
| `/api/push-subscriptions` | DELETE | Remove push subscription    |

### New Packages

| Package                                 | Purpose                |
| --------------------------------------- | ---------------------- |
| `laravel-notification-channels/webpush` | Web Push notifications |

---

## Questions for Backend Team

1. Current ImageKit integration for avatar transforms?
2. Room XP calculation logic (from gifts received)?
3. Level config storage (database vs config file)?
4. MSAB event emission mechanism from Laravel?
