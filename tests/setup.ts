/**
 * Vitest global setup — hermetic test environment.
 *
 * `src/config/index.ts` validates `process.env` with Zod at import time and
 * throws if the few non-defaulted vars (JWT_SECRET, LARAVEL_API_URL,
 * LARAVEL_INTERNAL_KEY) are missing. Some tests transitively import the real
 * config (e.g. via status-coalescer / leave-finalizer / auto-close.service),
 * so without these the suite passes locally (a developer `.env` is loaded by
 * dotenv) but fails in CI where no `.env` exists.
 *
 * Set safe dummy values BEFORE any test module loads so the suite is
 * self-contained and CI-stable. `??=` keeps any real env (local `.env` via
 * dotenv, or CI-provided) authoritative; tests that assert on specific config
 * values mock `@src/config/index.js` directly.
 */
process.env.NODE_ENV ??= "test";
process.env.JWT_SECRET ??= "test-jwt-secret-padding-0000000000000000";
process.env.LARAVEL_API_URL ??= "http://localhost:8000";
process.env.LARAVEL_INTERNAL_KEY ??= "test-laravel-internal-key-padding-000000";
