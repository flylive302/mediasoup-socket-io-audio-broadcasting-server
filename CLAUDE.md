# Audio Server (MSAB)

Shorthand for this subproject is **MSAB** or **msab**.

> Moved out of the monorepo root `CLAUDE.md` so it loads only when working in this directory.
> `Architecture.md` at the repo root is canonical for layer rules; if the two disagree, it wins.

Non-obvious commands and setup (the rest are plain `package.json` scripts):

```bash
npm run architecture:check
```

Requires Redis running locally. Dev server listens on port 3030.
Health check: `curl http://localhost:3030/health`

## Key conventions

- **`createHandler()` + Zod schema for every socket event** — never skip validation. See `Architecture.md` for the handler pipeline pattern.
- GATE functions must be **pure** (no side effects, easily testable).
- REACT (buffers, activity logging) is always **fire-and-forget** — `.catch(log)`.
- Handler files stay under ~150 lines; extract stage helpers as private functions at bottom of file before splitting.
- All config is Zod-validated at startup (`src/config/index.ts`) — invalid config causes immediate exit.
- **Two internal-auth secrets, both sent as `X-Internal-Key`** — `LARAVEL_INTERNAL_KEY` (Laravel↔MSAB) and `INTERNAL_API_KEY` (instance↔instance cascade). Easy to cross-wire.
- **Music playlist** (`domains/audio-player/`): per-room Redis mutex (`room:{id}:musicPlayer`). `audioPlayer:play` = manager-gated NX acquire; `audioPlayer:takeover` = owner-only (`verifyRoomOwner`) force-overwrite + targeted `audioPlayer:revoked` to the displaced DJ's room-scoped sockets (`ClientManager.getSocketIdsByUserInRoom`). Audio itself flows over the normal producer pipeline — these handlers coordinate metadata/state only.

## Directory responsibilities

Complex domains (seat, room) use a `handlers/` subdirectory for their sub-handlers rather than one large file.

```
src/domains/{domain}/handler.ts        → INTENT: socket.on() + pipeline orchestration
src/domains/{domain}/handlers/         → Sub-handlers for complex domains (seat, room)
src/domains/{domain}/*.buffer.ts       → REACT: batched persistence to Laravel
src/domains/{domain}/*.repository.ts   → Data access layer within the domain
src/domains/cascade/                   → SFU cascade relay (feature-flagged via CASCADE_ENABLED)
src/socket/                            → Connection bootstrap + Zod schemas
src/auth/                              → JWT/Sanctum middleware + caching
src/integrations/                      → HTTP client to Laravel, event routing
src/infrastructure/                    → Logging (Pino), metrics, CloudWatch, worker threads
src/shared/                            → Error codes, lifecycle hooks, cross-domain utils
src/client/clientManager.ts            → Track connected clients and their resources
src/config/                            → Zod-validated env config
src/api/                               → Internal HTTP endpoints (inter-instance communication)
```
