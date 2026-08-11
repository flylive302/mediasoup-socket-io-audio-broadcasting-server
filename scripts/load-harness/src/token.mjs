// Mints HS256 JWTs the way MSAB's src/auth/jwtValidator.ts verifies them:
// 3-part JWT, HMAC-SHA256 over `header.payload` with JWT_SECRET, payload must
// satisfy UserSchema (numeric `id`) and carry `exp` (or iat within max age).
// The load-test environment has its own JWT_SECRET; this never signs with a
// production secret because the guard refuses production targets outright.

import { createHmac } from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function mintToken(secret, userId, { name = `bot-${userId}`, ttlSeconds = 6 * 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ id: userId, name, iat: now, exp: now + ttlSeconds })
  );
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
