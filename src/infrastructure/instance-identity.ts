/**
 * Instance Identity — single source of truth for this MSAB process's
 * unique identifier across the fleet.
 *
 * Used as the `selfId` for Redis CAS room-ownership claims, cascade-relay
 * self-loop detection, and any place where one MSAB process must distinguish
 * itself from its peers.
 *
 * Resolution order:
 *   1. INSTANCE_ID_OVERRIDE env var (local two-instance testing only)
 *   2. EC2 IMDSv2 instance-id (production)
 *   3. os.hostname() fallback (non-EC2 environments)
 *
 * Production startup MUST assert the resolved id is non-empty and not the
 * string "unknown" — see config/index.ts. A non-unique id (two instances
 * sharing a selfId) would silently corrupt Redis CAS ownership and cause
 * audio split-brain.
 *
 * Result is memoized: IMDS is called at most once per process.
 */
import os from "node:os";

const IMDS_TIMEOUT_MS = 2_000;
const IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token";
const IMDS_INSTANCE_ID_URL =
  "http://169.254.169.254/latest/meta-data/instance-id";

let cached: string | null = null;
let inFlight: Promise<string> | null = null;

export async function getInstanceId(): Promise<string> {
  if (cached !== null) return cached;
  if (!inFlight) {
    inFlight = resolveOnce().then((id) => {
      cached = id;
      return id;
    });
  }
  return inFlight;
}

async function resolveOnce(): Promise<string> {
  const override = process.env.INSTANCE_ID_OVERRIDE?.trim();
  if (override) return override;

  const fromImds = await fetchImdsInstanceId();
  if (fromImds) return fromImds;

  return os.hostname();
}

async function fetchImdsInstanceId(): Promise<string | null> {
  try {
    const tokenRes = await fetch(IMDS_TOKEN_URL, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return null;
    const token = (await tokenRes.text()).trim();
    if (!token) return null;

    const idRes = await fetch(IMDS_INSTANCE_ID_URL, {
      headers: { "X-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
    });
    if (!idRes.ok) return null;
    const id = (await idRes.text()).trim();
    return id || null;
  } catch {
    return null;
  }
}
