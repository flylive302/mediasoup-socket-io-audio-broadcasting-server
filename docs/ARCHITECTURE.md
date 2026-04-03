# FlyLive Architecture Standard

> This document is the single source of truth for code architecture across all FlyLive repositories.
> It applies to **Frontend (Nuxt 4)**, **MSAB (Node.js + Socket.io)**, and **Backend (Laravel 12)**.
> Both human developers and AI assistants must follow these rules.

---

## Core Pipeline: INTENT → GATE → EXECUTE → REACT

Every user action, socket event, and API request follows exactly four stages:

| Stage | Purpose | Can Fail? | Blocks Response? |
|-------|---------|-----------|-----------------|
| **INTENT** | Receives the trigger (click, socket event, HTTP request) | No | — |
| **GATE** | Validates preconditions (permissions, input, business rules) | Yes — early return | Yes |
| **EXECUTE** | Performs the core mutation (state, DB, socket emit) | Yes — critical error | Yes |
| **REACT** | Fires side effects (notifications, analytics, animations) | No — fire-and-forget | Never |

### The Rule

> **A function belongs to exactly ONE stage. If it does work from two stages, split it.**

### Stage Function Pattern

```
// Public orchestrator — the ONLY function callers interact with
async function doSomething(): Promise<Result> {
  // GATE
  const error = validate(...)
  if (error) { onFailure(error); return }

  // EXECUTE
  const result = execute(...)

  // REACT
  onSuccess(result)
  return result
}

// Private stage helpers (same file, or separate file if >150 lines)
function validate(...): string | null { /* GATE logic only */ }
function execute(...): Result { /* mutations only */ }
function onSuccess(result): void { /* side effects only */ }
function onFailure(error): void { /* error feedback only */ }
```

---

## Frontend (Nuxt 4)

### Directory Responsibilities

```
app/
├── pages/              → Route binding + SSR data loading
├── components/         → UI + event binding (INTENT trigger)
├── composables/        → Business logic pipeline (GATE/EXECUTE/REACT)
├── stores/             → Global reactive state containers
├── events/             → Socket event → store mutation mapping (REACT)
├── services/           → Low-level infrastructure (cache, downloads, network)
├── types/              → TypeScript interfaces and type aliases
├── constants/          → Static values and configuration
└── utils/              → Pure helper functions (no reactivity, no store imports)
```

### Pages

| ✅ Allowed | ❌ Never |
|-----------|---------|
| `definePageMeta()` | Business logic |
| `useFetch()` / `useAsyncData()` for SSR data | Direct store mutations |
| Composing layout with components | Validation logic |
| Middleware references | Direct API calls via `$fetch` |

### Components

| ✅ Allowed | ❌ Never |
|-----------|---------|
| Template markup + styling | API calls (`$fetch`, `useFetch`) |
| `defineProps()`, `defineEmits()` | Business logic / validation rules |
| Call composable methods (e.g., `send()`, `leave()`) | Direct `socket.emit()` |
| Read store state for display binding | Complex `computed()` with business logic |
| Simple local UI state (`ref` for open/close/toggle) | Cross-domain store writes |
| `watch()` for UI-only effects (scroll, focus, animation) | `watch()` triggering API calls or mutations |

> Components are the **INTENT** layer. User interacts → component calls composable → composable runs the pipeline.

### Stores

| ✅ Allowed | ❌ Never |
|-----------|---------|
| `ref()` for reactive state | API calls / `$fetch` / `useFetch` |
| Simple setter functions (`setX()`, `updateX()`, `patchX()`) | `watch()` side effects |
| `computed()` for derived state | `navigateTo()` or routing |
| `persist` configuration | Toast / notification calls |
| `$reset()` for clearing state | Complex business logic |
| Reading other stores inside `computed()` | Calling actions on other stores |

**Store Design Rules:**
- One store per domain concept (auth, room, gift, agency)
- If a store exceeds ~300 lines or contains refs from **3+ unrelated concerns**, split it
- Split by **lifecycle** (persistent data vs ephemeral session data), not by entity type
- Stores never import or call methods on other stores — cross-store coordination belongs in composables

### Composables

Composables are the **brain** of the frontend. Each composable has one of these roles:

| Role | Naming | Contains |
|------|--------|----------|
| **Action / Orchestrator** | `use*Sending.ts`, `use*Actions.ts`, `use*Membership.ts` | Pipeline functions: GATE → EXECUTE → REACT |
| **Data / Query** | `use*Data.ts`, `use*Catalog.ts` | `computed()`, data fetching, derived state |
| **Event Handler / Reactor** | `use*EventHandlers.ts` | Socket event → store mutation + toast mapping |
| **Infrastructure** | `use*Audio.ts`, `use*Lifecycle.ts`, `use*Socket.ts` | Low-level transport, connection management |

**Composable Rules:**
- Composables CAN call API endpoints and emit socket events (this is their job)
- Composables CAN write to multiple stores in the EXECUTE stage
- Composables CAN show toasts and trigger navigation in the REACT stage
- Composables should NOT hold long-lived reactive state — that belongs in stores
- Each public function should have identifiable GATE/EXECUTE/REACT sections

### Events

| ✅ Allowed | ❌ Never |
|-----------|---------|
| `socket.on()` registration | Business logic / validation |
| Store mutations (simple field updates) | API calls |
| Toast notifications | Complex computed logic |
| Navigation on disconnect/kick | State initialization |

> Events are **REACT** handlers for server-pushed data. They map incoming socket events to store mutations. No business logic.

### Services, Types, Constants, Utils

| Directory | Contains | Golden Rule |
|-----------|----------|-------------|
| `services/` | Low-level infra (cache, asset downloading, network) | No store imports, no UI concerns |
| `types/` | TypeScript interfaces, type aliases | No runtime code |
| `constants/` | Static values, enums, configuration maps | No imports from stores or composables |
| `utils/` | Pure functions (formatting, parsing, calculations) | No Vue reactivity (`ref`, `computed`), no store imports |

---

## MSAB (Node.js + Socket.io)

### Directory Responsibilities

```
src/
├── domains/            → Domain logic (one folder per domain)
│   └── {domain}/
│       ├── handler.ts       → INTENT: socket.on() + pipeline orchestration
│       ├── *.buffer.ts      → REACT: persistence queuing to Laravel
│       ├── *.types.ts       → Domain-specific types
│       └── index.ts         → Re-exports
├── socket/             → Connection bootstrap + Zod schemas
├── auth/               → JWT middleware + types
├── integrations/       → External service clients (LaravelClient, EventRouter)
├── infrastructure/     → Logging, metrics, workers
├── shared/             → Cross-domain utilities, errors, lifecycle hooks
├── client/             → Client tracking (ClientManager)
└── config/             → Configuration
```

### Handler Pattern

Each handler function should follow the pipeline:

```typescript
socket.on("domain:action", createHandler("domain:action", schema, async (payload, sock) => {
  // GATE — all validation, returns early on failure
  const gateResult = validate(payload, sock, ctx);
  if (!gateResult.ok) return gateResult.error;

  // EXECUTE — core processing + room broadcast
  const result = process(payload, sock, ctx);

  // REACT — fire-and-forget side effects
  afterAction(result, ctx);

  return { success: true };
})(socket, context));
```

**Handler Rules:**
- `createHandler()` + Zod schema for every event — never skip validation
- GATE functions should be **pure** (no side effects, easily testable)
- EXECUTE does core logic + emits to room participants
- REACT queues to buffer, records activity — always fire-and-forget (`.catch(log)`)
- Stage functions can be private helpers at the bottom of the handler file
- Extract to separate files only if handler exceeds ~150 lines

### Other Directories

| Directory | Contains | Never |
|-----------|----------|-------|
| `socket/` | App context assembly, connection lifecycle, schemas | Business logic |
| `auth/` | JWT verification middleware | Domain logic |
| `integrations/` | HTTP clients, pub/sub wiring, user socket tracking | Business rules |
| `infrastructure/` | Logging, metrics, worker threads | Domain state |
| `shared/` | Error codes, lifecycle hooks, cross-domain utilities | Domain-specific logic |

---

## Backend (Laravel 12)

### Directory Responsibilities

```
app/
├── Http/
│   ├── Controllers/    → INTENT: validate request, delegate, respond
│   ├── Requests/       → GATE: form validation rules
│   ├── Resources/      → Response transformation
│   ├── Responses/      → Pre-built response objects
│   └── Middleware/      → Auth, rate limiting, CORS
├── Services/           → EXECUTE: domain logic + DB transactions
├── Events/             → REACT triggers (event classes)
├── Listeners/          → REACT handlers (one side effect per listener)
├── Jobs/               → REACT async (queued side effects)
├── Actions/            → Optional thin orchestrators
├── Models/             → Eloquent entities
├── Repositories/       → Data access abstraction
├── Contracts/          → Interfaces
├── DTOs/               → Data transfer objects
├── ValueObjects/       → Immutable value calculations
├── Enums/              → Type-safe constants
├── Policies/           → GATE: authorization
├── Observers/          → REACT: model lifecycle hooks
└── Providers/          → Service container bindings
```

### Controllers (INTENT)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| Accept request, type-hint dependencies | DB queries or Eloquent calls |
| Authorize via Policy (`$this->authorize()`) | Complex business logic |
| Delegate to Service or Action | Direct model mutations |
| Return response (Resource/JsonResponse) | Event dispatching |

```php
// Controller is THIN — authorize, delegate, respond
public function store(StoreRequest $request, SomeService $service): JsonResponse
{
    $this->authorize('create', Model::class);                    // GATE
    $dto = SomeDTO::fromRequest($request);                       // INTENT
    $result = $service->process($dto);                           // EXECUTE
    event(new SomeEvent($dto, $result));                         // REACT
    return response()->json(SomeResource::make($result), 201);   // Response
}
```

### Form Requests (GATE)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| Input validation rules | Business logic |
| Type casting / normalization | DB queries (keep validation fast) |
| `authorize()` for simple auth checks | Side effects |

### Policies (GATE)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| Authorization checks | Business calculations |
| Role / permission verification | DB mutations |
| Ownership validation | Side effects |

### Services (EXECUTE)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| `DB::transaction()` for atomic operations | HTTP responses |
| Model mutations (create, update, delete) | Request/Response objects |
| Business calculations and domain logic | `event()` dispatching |
| Cross-model operations | View/template logic |
| Return result DTOs or domain objects | Direct queue dispatching |

**Key Rule:** Services return results. They do NOT dispatch events or queue jobs. The **controller** handles REACT after the service returns.

```php
// Service — EXECUTE only, returns result
public function process(SomeDTO $dto): SomeResult
{
    return DB::transaction(function () use ($dto) {
        // ... mutations only ...
        return new SomeResult(...);
    });
}

// Controller — dispatches REACT after service completes
$result = $service->process($dto);
event(new SomeEvent($dto, $result));  // REACT — controller's job
```

### Events + Listeners (REACT)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| One listener per side effect | Core business logic |
| Notifications (push, email, SMS) | DB transactions |
| Statistics recording | Authorization |
| Cache invalidation | Further event dispatching (avoid cascades) |
| External API calls | |

**Adding a new side effect to any action = creating a new Listener and attaching it to the existing Event. Zero changes to existing code.**

### Jobs (Async REACT)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| Long-running async side effects | Core business logic |
| External API integrations | Synchronous DB transactions |
| Batch processing | Validation |

### Observers (Model Lifecycle REACT)

| ✅ Allowed | ❌ Never |
|-----------|---------|
| `created()`, `updated()`, `deleted()` hooks | Complex business logic |
| Audit logging | Cross-model mutations |
| Cache invalidation | Event dispatching (use Events instead) |
| Setting default values on `creating()` | |

---

## Cross-Cutting Rules

### Cross-Domain Writes (All Repos)

| Stage | Read From | Write To |
|-------|-----------|----------|
| **GATE** | Any domain (for validation) | None |
| **EXECUTE** | Any domain | Any domain needed for the action's core purpose |
| **REACT** | Own domain result | Own domain's secondary state only (queues, counters, UI state) |

### Error Handling

| Stage | On Failure |
|-------|-----------|
| **GATE** | Return error immediately. Show user feedback (toast/response). Do NOT proceed to EXECUTE. |
| **EXECUTE** | Throw/rollback. If DB transaction, the framework handles rollback. Surface error to caller. |
| **REACT** | Log and continue. REACT failures are NEVER surfaced to the user. They are non-critical. |

### Store Splitting (Frontend)

- Split when a store has refs from **3+ unrelated concerns** or exceeds **~300 lines**
- Split by **lifecycle** (persistent vs ephemeral), not by entity type
- **Never** create a store with fewer than ~3 refs and ~2 functions — it's too granular
- Each store split removes one reactive dependency chain — verify that's actually needed

### File Size Guidelines

| Threshold | Action |
|-----------|--------|
| **< 150 lines** | GATE/EXECUTE/REACT can be inline sections in one function |
| **150–300 lines** | Extract stage helpers as private functions at the bottom of the file |
| **> 300 lines** | Consider splitting into separate files per stage or per sub-domain |

---

## Quick Reference

```
┌─────────────────────────────────────────────────────────────────┐
│                    PIPELINE PATTERN                              │
│                                                                 │
│  INTENT    →   GATE       →   EXECUTE      →   REACT           │
│  (trigger)    (can we?)       (core work)      (side effects)   │
│                                                                 │
│  FRONTEND                                                       │
│  component → validate()  → api/emit+store  → toast/animate     │
│                                                                 │
│  MSAB                                                           │
│  handler   → validate()  → process+emit    → buffer/log        │
│                                                                 │
│  LARAVEL                                                        │
│  controller→ request     → service(DB txn) → event→listeners   │
│              +policy                                            │
│                                                                 │
│  EVERY function is ONE stage. NEVER mix stages.                 │
├─────────────────────────────────────────────────────────────────┤
│                    FILE RULES                                   │
│                                                                 │
│  Stores     = ref + computed + setters ONLY (no API, no toast)  │
│  Composables= pipeline logic (GATE/EXECUTE/REACT)               │
│  Components = UI + binding ONLY (call composables, read stores) │
│  Events     = socket → store mapping ONLY (REACT)               │
│  Services   = EXECUTE ONLY (return result, no events)           │
│  Controllers= THIN (authorize, delegate, respond, dispatch)     │
│  Listeners  = ONE side effect per listener                      │
│  Handlers   = socket.on() → validate → process → react         │
└─────────────────────────────────────────────────────────────────┘
```
