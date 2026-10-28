/**
 * Outcome telemetry. Exactly the payloads in docs/telemetry.md. "anonymous" sends v1: no bodies, no wallet
 * address, no request parameters, no intent id. "verified" sends v2: the v1 fields with harness outcome names,
 * plus `proof` (payer, nonce, pay-to, tx hash) for paid calls so the index can check the payment on Base.
 * Fire-and-forget with a 1 s timeout; failures are only counted in <receiptsDir>/debug.log.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelemetryOutcome, TelemetryProof } from "./proof.js";
import { REFUSED_OUTCOMES } from "./proof.js";

export const CLIENT_ID = "x402-safe-fetch/0.2.0";

export interface TelemetryPayload {
  v: 1;
  host: string;
  path_hash: string;
  outcome: string;
  amount_usdc: string;
  latency_ms: number;
  validator_failures: string[];
  client: typeof CLIENT_ID;
}

/** sha256 hex of the URL path with any trailing slash removed. Query string and fragment never enter it. */
export function pathHash(url: string): string {
  const p = new URL(url).pathname.replace(/\/$/, "") || "/";
  return createHash("sha256").update(p).digest("hex");
}

export function buildPayload(i: { url: string; outcome: string; amountUsdc: string; latencyMs: number; validatorFailures: string[] }): TelemetryPayload {
  return {
    v: 1,
    host: new URL(i.url).hostname.toLowerCase(),
    path_hash: pathHash(i.url),
    outcome: i.outcome,
    amount_usdc: i.amountUsdc,
    latency_ms: Math.max(0, Math.round(i.latencyMs)),
    validator_failures: [...i.validatorFailures],
    client: CLIENT_ID,
  };
}

export interface TelemetryPayloadV2 {
  v: 2;
  host: string;
  path_hash: string;
  outcome: TelemetryOutcome;
  amount_usdc: string;
  latency_ms: number;
  validator_failures: string[];
  client: typeof CLIENT_ID;
  /** Present only when an authorization was signed and sent. Never on a refused outcome. */
  proof?: TelemetryProof;
}

export function buildPayloadV2(i: {
  url: string;
  outcome: TelemetryOutcome;
  amountUsdc: string;
  latencyMs: number;
  validatorFailures: string[];
  proof: TelemetryProof | null;
}): TelemetryPayloadV2 {
  const p: TelemetryPayloadV2 = {
    ...buildPayload({ ...i, outcome: i.outcome }),
    v: 2,
    outcome: i.outcome,
  };
  if (i.proof && !REFUSED_OUTCOMES.has(i.outcome)) p.proof = { ...i.proof };
  return p;
}

let failures = 0;

/** Never awaited by callers, never throws, never rejects. Returns the promise only so tests can wait on it. */
export function sendTelemetry(indexUrl: string, payload: TelemetryPayload | TelemetryPayloadV2, o: { receiptsDir: string; fetchImpl?: typeof globalThis.fetch }): Promise<void> {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const logFailure = async (why: string) => {
    failures++;
    try {
      await mkdir(o.receiptsDir, { recursive: true });
      await appendFile(join(o.receiptsDir, "debug.log"), `${new Date().toISOString()} telemetry_failed count=${failures} ${why}\n`);
    } catch {
      /* swallowed */
    }
  };
  return (async () => {
    try {
      const res = await fetchImpl(`${indexUrl.replace(/\/$/, "")}/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1000),
      });
      res.body?.cancel().catch(() => undefined);
      if (!res.ok) await logFailure(`http ${res.status}`);
    } catch (e) {
      await logFailure(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  })().catch(() => undefined);
}

export function telemetryFailureCount(): number {
  return failures;
}
