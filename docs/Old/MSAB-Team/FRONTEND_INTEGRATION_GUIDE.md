# Frontend Integration Guide: MSAB Real-Time Events

> **Document Type**: Frontend Team Integration Guide  
> **Date**: 2026-01-15  
> **Status**: MSAB Ready — Frontend Implementation Required

---

## Table of Contents

1. [Overview](#1-overview)
2. [Critical Change: Socket Connection Timing](#2-critical-change-socket-connection-timing)
3. [Complete Event Reference](#3-complete-event-reference)
4. [Socket.IO Client Setup](#4-socketio-client-setup)
5. [Event Handlers Implementation](#5-event-handlers-implementation)
6. [TypeScript Interfaces](#6-typescript-interfaces)
7. [Testing & Debugging](#7-testing--debugging)
8. [FAQ](#8-faq)

---

## 1. Overview

MSAB now supports **app-wide real-time events** beyond room functionality. Users can receive private notifications (balance updates, badges, agency invitations) even when not in a room.

### What's New

| Before                                | After                                     |
| ------------------------------------- | ----------------------------------------- |
| Socket connected only in rooms        | Socket connected throughout app session   |
| Only room events (gifts, chat, seats) | Room events + Private events + Broadcasts |
| Balance came from HTTP responses      | Balance updates pushed via socket         |

### Events Now Available

| Category     | Count | Examples                                                    |
| ------------ | ----- | ----------------------------------------------------------- |
| Economy      | 2     | `balance.updated`, `reward.earned`                          |
| Achievements | 1     | `badge.earned`                                              |
| Room         | 1     | `room.level_up`                                             |
| Income       | 2     | `income_target.completed`, `income_target.member_completed` |
| Agency       | 6     | `agency.invitation`, `agency.join_request`, etc.            |
| System       | 1     | `config:invalidate`                                         |

---

## 2. Critical Change: Socket Connection Timing

> [!CAUTION]
> **This is the most important change.** Without this, private events will NOT be delivered.

### Current Behavior (Must Change)

```typescript
// ❌ OLD: Connect only when entering room
const enterRoom = (roomId: string) => {
  socket.connect();
  socket.emit("room:join", { roomId });
};

const leaveRoom = () => {
  socket.disconnect();
};
```

### Required Behavior

```typescript
// ✅ NEW: Connect on app boot, stay connected
const initApp = () => {
  socket.connect(); // Connect when app starts
};

const enterRoom = (roomId: string) => {
  socket.emit("room:join", { roomId }); // Join room without reconnecting
};

const leaveRoom = (roomId: string) => {
  socket.emit("room:leave", { roomId }); // Leave room, stay connected
};

// Only disconnect on logout or app close
const logout = () => {
  socket.disconnect();
};
```

### Why This Matters

| Event               | Old Connection Model | New Connection Model |
| ------------------- | -------------------- | -------------------- |
| `gift:received`     | ✅ Works (in room)   | ✅ Works             |
| `balance.updated`   | ❌ Never received    | ✅ Works             |
| `badge.earned`      | ❌ Never received    | ✅ Works             |
| `agency.invitation` | ❌ Never received    | ✅ Works             |

---

## 3. Complete Event Reference

### 3.1 Economy Events

#### `balance.updated`

Fired when user's coins, diamonds, or XP changes.

**When**: After gift sent/received, purchase, reward claim

**Payload**:

```typescript
{
  coins: string; // "15000.000"
  diamonds: string; // "500.000"
  wealth_xp: string; // "25000.0000"
  charm_xp: string; // "12000.0000"
}
```

**Usage**:

```typescript
socket.on("balance.updated", (payload) => {
  userStore.updateBalance({
    coins: parseFloat(payload.coins),
    diamonds: parseFloat(payload.diamonds),
    wealthXp: parseFloat(payload.wealth_xp),
    charmXp: parseFloat(payload.charm_xp),
  });
});
```

---

#### `reward.earned`

Fired when user claims a reward.

**Payload**:

```typescript
{
  user_reward_id: number;
  reward: {
    id: number;
    name: string; // "Daily Bonus"
    type: string; // "coins"
    amount: string; // "100"
    description: string; // "Daily login reward"
  }
}
```

**Usage**:

```typescript
socket.on("reward.earned", (payload) => {
  showToast({
    type: "success",
    title: "Reward Claimed!",
    message: `You earned ${payload.reward.amount} ${payload.reward.type}`,
  });
});
```

---

### 3.2 Achievement Events

#### `badge.earned`

Fired when user earns a new badge.

**Payload**:

```typescript
{
  badge_id: number;
  badge_name: string; // "Gold Spender"
  badge_image: string; // "https://ik.imagekit.io/flylive/badges/gold-spender.png"
  category: "wealth" | "charm" | "room" | "special";
  context: string; // "level_up", "gift_received"
}
```

**Usage**:

```typescript
socket.on("badge.earned", (payload) => {
  showBadgeModal({
    name: payload.badge_name,
    image: payload.badge_image,
    category: payload.category,
  });

  // Refresh user badges
  userStore.fetchBadges();
});
```

---

### 3.3 Room Events

#### `room.level_up`

Fired when a room levels up (from gift XP).

**Note**: Currently sent to room owner only. May change to all room members.

**Payload**:

```typescript
{
  room_id: number;
  room_name: string; // "Star Room"
  previous_level: number; // 3
  new_level: number; // 4
  current_xp: string; // "15000.0000"
}
```

**Usage**:

```typescript
socket.on("room.level_up", (payload) => {
  showRoomLevelUpAnimation({
    previousLevel: payload.previous_level,
    newLevel: payload.new_level,
  });

  roomStore.updateLevel(payload.room_id, payload.new_level);
});
```

---

### 3.4 Income Target Events

#### `income_target.completed`

Fired when agency member completes income target.

**Payload**:

```typescript
{
  target_id: number;
  tier: string; // "T2"
  name: string; // "Silver Target"
  earned_coins: string; // "50000.0000"
  member_reward: number; // 100
  owner_reward: number; // 50
}
```

---

#### `income_target.member_completed`

Fired to agency OWNER when one of their members completes a target.

**Payload**: Same as above

---

### 3.5 Agency Events

#### `agency.invitation`

Fired when user receives agency invitation.

**Payload**:

```typescript
{
  invitation_id: number;
  agency: {
    id: number;
    name: string; // "StarAgency"
    logo: string | null; // "https://ik.imagekit.io/..."
  }
  invited_by: {
    id: number;
    name: string; // "John"
  }
}
```

**Usage**:

```typescript
socket.on("agency.invitation", (payload) => {
  notificationStore.addNotification({
    type: "agency_invitation",
    title: "Agency Invitation",
    message: `${payload.invited_by.name} invited you to ${payload.agency.name}`,
    data: payload,
  });
});
```

---

#### `agency.join_request`

Fired to agency OWNER when someone requests to join.

**Payload**:

```typescript
{
  request_id: number;
  user: {
    id: number;
    name: string;           // "NewUser"
    avatar: string | null;  // "https://ik.imagekit.io/..."
  };
  message?: string;         // "Please accept me"
}
```

---

#### `agency.join_request_approved`

Fired when your join request was approved.

**Payload**:

```typescript
{
  agency_id: number;
  agency_name: string; // "StarAgency"
}
```

---

#### `agency.join_request_rejected`

Fired when your join request was rejected.

**Payload**:

```typescript
{
  agency_id: number;
  agency_name: string; // "StarAgency"
}
```

---

#### `agency.member_kicked`

Fired when you are kicked from agency.

**Payload**:

```typescript
{
  agency_id: number;
  agency_name: string;      // "StarAgency"
  reason?: string;          // "Policy violation"
}
```

---

#### `agency.dissolved`

Fired when your agency is dissolved.

**Payload**:

```typescript
{
  agency_id: number;
  agency_name: string; // "StarAgency"
}
```

---

### 3.6 System Events

#### `config:invalidate`

Fired when admin updates configuration. Use to bust caches.

**Payload**:

```typescript
{
  type: 'levels' | 'badges' | 'gifts' | 'all';
  version?: string;
}
```

**Usage**:

```typescript
socket.on("config:invalidate", (payload) => {
  switch (payload.type) {
    case "levels":
      configStore.invalidateLevels();
      break;
    case "badges":
      configStore.invalidateBadges();
      break;
    case "gifts":
      configStore.invalidateGifts();
      break;
    case "all":
      configStore.invalidateAll();
      break;
  }
});
```

---

## 4. Socket.IO Client Setup

### Nuxt 3 Composable Example

```typescript
// composables/useSocket.ts
import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export const useSocket = () => {
  const config = useRuntimeConfig();
  const authStore = useAuthStore();

  const connect = () => {
    if (socket?.connected) return;

    socket = io(config.public.msabUrl, {
      auth: {
        token: authStore.token,
      },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socket.on("connect", () => {
      console.log("Socket connected:", socket?.id);
    });

    socket.on("disconnect", (reason) => {
      console.log("Socket disconnected:", reason);
    });

    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error.message);
    });

    // Register all event handlers
    registerEventHandlers(socket);
  };

  const disconnect = () => {
    socket?.disconnect();
    socket = null;
  };

  const getSocket = () => socket;

  return {
    connect,
    disconnect,
    getSocket,
  };
};
```

### App Initialization

```typescript
// plugins/socket.client.ts
export default defineNuxtPlugin(() => {
  const { connect } = useSocket();
  const authStore = useAuthStore();

  // Connect when user is authenticated
  watch(
    () => authStore.isAuthenticated,
    (isAuth) => {
      if (isAuth) {
        connect();
      }
    },
    { immediate: true }
  );
});
```

---

## 5. Event Handlers Implementation

### Centralized Handler Registration

```typescript
// composables/useSocketEvents.ts
export const registerEventHandlers = (socket: Socket) => {
  const userStore = useUserStore();
  const notificationStore = useNotificationStore();
  const roomStore = useRoomStore();
  const configStore = useConfigStore();

  // Economy
  socket.on("balance.updated", (payload) => {
    userStore.updateBalance(payload);
  });

  socket.on("reward.earned", (payload) => {
    showToast({
      type: "success",
      message: `Reward earned: ${payload.reward.name}`,
    });
  });

  // Achievements
  socket.on("badge.earned", (payload) => {
    showBadgeEarnedModal(payload);
    userStore.addBadge(payload);
  });

  // Room
  socket.on("room.level_up", (payload) => {
    if (roomStore.currentRoom?.id === payload.room_id) {
      showRoomLevelUpAnimation(payload);
    }
    roomStore.updateRoomLevel(payload.room_id, payload.new_level);
  });

  // Income Targets
  socket.on("income_target.completed", (payload) => {
    showToast({
      type: "success",
      message: `Target completed! Earned ${payload.earned_coins} coins`,
    });
  });

  socket.on("income_target.member_completed", (payload) => {
    notificationStore.add({
      type: "agency",
      message: `Team member completed ${payload.name}`,
    });
  });

  // Agency
  socket.on("agency.invitation", (payload) => {
    notificationStore.add({
      type: "agency_invitation",
      title: "Agency Invitation",
      data: payload,
    });
  });

  socket.on("agency.join_request", (payload) => {
    notificationStore.add({
      type: "agency_request",
      title: `${payload.user.name} wants to join`,
      data: payload,
    });
  });

  socket.on("agency.join_request_approved", (payload) => {
    showToast({
      type: "success",
      message: `Welcome to ${payload.agency_name}!`,
    });
    userStore.fetchAgency(); // Refresh agency data
  });

  socket.on("agency.join_request_rejected", (payload) => {
    showToast({
      type: "info",
      message: `Your request to ${payload.agency_name} was declined`,
    });
  });

  socket.on("agency.member_kicked", (payload) => {
    showToast({
      type: "warning",
      message: `You were removed from ${payload.agency_name}`,
    });
    userStore.clearAgency();
  });

  socket.on("agency.dissolved", (payload) => {
    showToast({
      type: "info",
      message: `${payload.agency_name} has been dissolved`,
    });
    userStore.clearAgency();
  });

  // System
  socket.on("config:invalidate", (payload) => {
    configStore.invalidate(payload.type);
  });
};
```

---

## 6. TypeScript Interfaces

```typescript
// types/socket-events.ts

export interface BalanceUpdatedPayload {
  coins: string;
  diamonds: string;
  wealth_xp: string;
  charm_xp: string;
}

export interface BadgeEarnedPayload {
  badge_id: number;
  badge_name: string;
  badge_image: string;
  category: "wealth" | "charm" | "room" | "special";
  context: string;
}

export interface RewardEarnedPayload {
  user_reward_id: number;
  reward: {
    id: number;
    name: string;
    type: string;
    amount: string;
    description: string;
  };
}

export interface RoomLevelUpPayload {
  room_id: number;
  room_name: string;
  previous_level: number;
  new_level: number;
  current_xp: string;
}

export interface IncomeTargetCompletedPayload {
  target_id: number;
  tier: string;
  name: string;
  earned_coins: string;
  member_reward: number;
  owner_reward: number;
}

export interface AgencyInvitationPayload {
  invitation_id: number;
  agency: {
    id: number;
    name: string;
    logo: string | null;
  };
  invited_by: {
    id: number;
    name: string;
  };
}

export interface AgencyJoinRequestPayload {
  request_id: number;
  user: {
    id: number;
    name: string;
    avatar: string | null;
  };
  message?: string;
}

export interface AgencyStatusPayload {
  agency_id: number;
  agency_name: string;
  reason?: string;
}

export interface ConfigInvalidatePayload {
  type: "levels" | "badges" | "gifts" | "all";
  version?: string;
}

// Socket event map for type-safe handlers
export interface ServerToClientEvents {
  "balance.updated": (payload: BalanceUpdatedPayload) => void;
  "badge.earned": (payload: BadgeEarnedPayload) => void;
  "reward.earned": (payload: RewardEarnedPayload) => void;
  "room.level_up": (payload: RoomLevelUpPayload) => void;
  "income_target.completed": (payload: IncomeTargetCompletedPayload) => void;
  "income_target.member_completed": (
    payload: IncomeTargetCompletedPayload
  ) => void;
  "agency.invitation": (payload: AgencyInvitationPayload) => void;
  "agency.join_request": (payload: AgencyJoinRequestPayload) => void;
  "agency.join_request_approved": (payload: AgencyStatusPayload) => void;
  "agency.join_request_rejected": (payload: AgencyStatusPayload) => void;
  "agency.member_kicked": (payload: AgencyStatusPayload) => void;
  "agency.dissolved": (payload: AgencyStatusPayload) => void;
  "config:invalidate": (payload: ConfigInvalidatePayload) => void;
}
```

---

## 7. Testing & Debugging

### Browser DevTools

```javascript
// In browser console, check socket status
const socket = window.__socket; // If you expose it globally
console.log("Connected:", socket.connected);
console.log("Socket ID:", socket.id);
```

### Debug Mode

```typescript
// Enable socket.io debug logs
localStorage.setItem("debug", "socket.io-client:*");
// Refresh page to see detailed logs
```

### Verify Event Reception

```typescript
// Temporary debug handler
socket.onAny((event, ...args) => {
  console.log("[Socket Event]", event, args);
});
```

---

## 8. FAQ

### Q: Why am I not receiving private events?

**A**: Check these in order:

1. Is socket connected? (`socket.connected === true`)
2. Is user authenticated? (token passed in `auth`)
3. Is socket connected on app boot? (not just room entry)

### Q: Events work in room but not outside?

**A**: You're likely connecting socket only when entering rooms. Change to connect on app boot.

### Q: Balance update shows old value?

**A**: The payload contains strings (for precision). Parse with `parseFloat()`:

```typescript
const coins = parseFloat(payload.coins);
```

### Q: How do I handle reconnection?

**A**: Socket.IO handles reconnection automatically. Events will resume once reconnected. Consider showing a "Reconnecting..." indicator:

```typescript
socket.on("disconnect", () => showReconnectingBanner());
socket.on("connect", () => hideReconnectingBanner());
```

### Q: What if user is offline when event fires?

**A**: Events to offline users are currently dropped. Push notifications for offline users are planned for a future phase.

---

## Summary Checklist

- [ ] Change socket connection to app boot (not room entry)
- [ ] Register handlers for all 13 events
- [ ] Update Pinia stores to handle real-time updates
- [ ] Add UI feedback for important events (badges, agency, etc.)
- [ ] Add TypeScript interfaces for type safety
- [ ] Test with browser debugging

---

_For questions, contact the MSAB team._
