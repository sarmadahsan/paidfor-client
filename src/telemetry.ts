/**
 * Anonymous outcome telemetry. Exactly the payload in docs/telemetry.md: no bodies, no wallet address,
 * no request parameters, no intent id. Fire-and-forget with a 1 s timeout; failures are only counted
 * in <receiptsDir>/debug.log.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const CLIENT_ID = "x402-safe-fetch/0.1.0";

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

let failures = 0;

/** Never awaited by callers, never throws, never rejects. Returns the promise only so tests can wait on it. */
export function sendTelemetry(indexUrl: string, payload: TelemetryPayload, o: { receiptsDir: string; fetchImpl?: typeof globalThis.fetch }): Promise<void> {
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
