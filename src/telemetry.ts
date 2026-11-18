/**
 * Outcome telemetry. Exactly the payloads in docs/telemetry.md. "anonymous" sends v1: no bodies, no wallet
 * address, no request parameters, no intent id. "verified" sends v2: the v1 fields with harness outcome names,
 * plus `proof` (payer, nonce, pay-to, tx hash) for paid calls so the index can check the payment on Base, and the
 * plain `path` only when the index answered `unknown` before paying, so it can buy that seller itself.
 * Fire-and-forget with a 1 s timeout; failures are only counted in <receiptsDir>/debug.log.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelemetryOutcome, TelemetryProof } from "./proof.js";
import { REFUSED_OUTCOMES } from "./proof.js";

export const CLIENT_ID = "x402-safe-fetch/0.7.1";
/** Sent on every request to the index so it can count calls per client. Carries only CLIENT_ID. */
export const CLIENT_HEADER = "X-Paidfor-Client";

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
  /** The plain URL path (no query string or fragment), only when the index answered `unknown` for this seller. */
  path?: string;
  /**
   * Warnings that did not fail the call (0.7.0), only when there are any: `content_type_mismatch` (usable content in
   * another format than the seller declared) or `missing_content_type`. Codes only, no evidence.
   */
  warnings?: string[];
}

/** Longest path sent; a longer one is left out rather than risk the row. */
export const MAX_PATH_LENGTH = 512;

/** The URL path exactly as it is hashed for path_hash, before the trailing slash is removed. Null past MAX_PATH_LENGTH. */
export function plainPath(url: string): string | null {
  const p = new URL(url).pathname || "/";
  return p.length <= MAX_PATH_LENGTH ? p : null;
}

export function buildPayloadV2(i: {
  url: string;
  outcome: TelemetryOutcome;
  amountUsdc: string;
  latencyMs: number;
  validatorFailures: string[];
  proof: TelemetryProof | null;
  /** The pre-pay index check answered `unknown`: send the plain path for this call. */
  unknownSeller?: boolean;
  /** Warning codes from the receipt; the field is sent only when there is at least one. */
  warnings?: readonly string[];
}): TelemetryPayloadV2 {
  const p: TelemetryPayloadV2 = {
    ...buildPayload({ ...i, outcome: i.outcome }),
    v: 2,
    outcome: i.outcome,
  };
  if (i.proof && !REFUSED_OUTCOMES.has(i.outcome)) p.proof = { ...i.proof };
  if (i.unknownSeller) {
    const path = plainPath(i.url);
    if (path) p.path = path;
  }
  if (i.warnings?.length) p.warnings = [...i.warnings];
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
        headers: { "content-type": "application/json", [CLIENT_HEADER]: CLIENT_ID },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1000),
        // The route answers directly; never let a redirect carry the row somewhere else (or to plain http).
        redirect: "error",
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
