# Seat Events

> **Domain**: Seat  
> **Source**: `src/domains/seat/`

---

## Client → Server (Socket.IO)

| Event                  | Handler           | Description                      |
| ---------------------- | ----------------- | -------------------------------- |
| `seat:take`            | `seat.handler.ts` | User takes a seat                |
| `seat:leave`           | `seat.handler.ts` | User leaves their seat           |
| `seat:assign`          | `seat.handler.ts` | Assign user to a seat            |
| `seat:remove`          | `seat.handler.ts` | Remove user from seat            |
| `seat:lock`            | `seat.handler.ts` | Lock a seat                      |
| `seat:unlock`          | `seat.handler.ts` | Unlock a seat                    |
| `seat:mute`            | `seat.handler.ts` | Mute a seated user               |
| `seat:unmute`          | `seat.handler.ts` | Unmute a seated user             |
| `seat:invite`          | `seat.handler.ts` | Invite user to seat              |
| `seat:invite-accept`   | `seat.handler.ts` | Accept seat invitation           |
| `seat:invite-decline`  | `seat.handler.ts` | Decline seat invitation          |
| `seat:invite-response` | `seat.handler.ts` | Response to seat invite (legacy) |

See: [take](./take/README.md) · [leave](./leave/README.md) · [assign](./assign/README.md) · [remove](./remove/README.md) · [lock](./lock/README.md) · [unlock](./unlock/README.md) · [mute](./mute/README.md) · [unmute](./unmute/README.md) · [invite](./invite/README.md) · [invite-accept](./invite-accept/README.md) · [invite-decline](./invite-decline/README.md) · [invite-response](./invite-response/README.md)

---

## Server → Client (Broadcast)

| Event                  | Target            | Description                   |
| ---------------------- | ----------------- | ----------------------------- |
| `seat:updated`         | Room              | Seat state changed            |
| `seat:cleared`         | Room (excl. self) | Seat was vacated              |
| `seat:locked`          | Room              | Seat was locked               |
| `seat:userMuted`       | Room              | Seated user was muted         |
| `seat:invite-pending`  | Room              | Seat invitation pending       |
| `seat:invite-received` | User              | User received seat invitation |

See: [seat-updated](./seat-updated/README.md) · [seat-cleared](./seat-cleared/README.md) · [seat-locked](./seat-locked/README.md) · [seat-userMuted](./seat-userMuted/README.md) · [seat-invite-pending](./seat-invite-pending/README.md) · [seat-invite-received](./seat-invite-received/README.md)
