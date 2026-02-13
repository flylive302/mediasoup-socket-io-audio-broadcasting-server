# User Events

> **Domain**: User  
> **Source**: `src/domains/user/`

---

## Client → Server (Socket.IO)

| Event           | Handler           | Description               |
| --------------- | ----------------- | ------------------------- |
| `user:get-room` | `user.handler.ts` | Get the room a user is in |

See: [get-room](./get-room/README.md)

---

## Laravel → Frontend (Relay)

Economy and Achievement relay events affect users but are grouped by their own domains:

- [Economy Events](../Relay/Economy/README.md) — `balance.updated`, `reward.earned`
- [Achievement Events](../Relay/Achievement/README.md) — `badge.earned`, `level.up`
