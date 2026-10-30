/**
 * Report-only mode: no pre-pay check, no guard, no wallet. After a payment the caller made with their own x402 client,
 * send the index the tx_only telemetry row (docs/telemetry.md, "tx_only"): host, path, outcome, the quote if known, and
 * the settlement transaction hash from the seller's PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header. The index reads the
 * payer and the amount from that transaction on Base. Fire-and-forget: a report never delays or fails the caller's
 * request, and failures are only counted in <receiptsDir>/debug.log when a receiptsDir is given.
 *
 * withPaidforReporting(fetchWithPayment) wraps the fetch returned by `x402-fetch` (1.x) or `@x402/fetch` (2.x)
 * `wrapFetchWithPayment`; withPaidforReportingAxios(instance) adds a response interceptor to an instance wrapped by
 * `x402-axios` `withPaymentInterceptor` or `@x402/axios` `wrapAxiosWithPayment`. Both read only the response status
 * and the settlement header, never a body.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelemetryOutcome } from "./proof.js";
import { CLIENT_HEADER, CLIENT_ID, pathHash, plainPath } from "./telemetry.js";
import { decodeSettlementHeader } from "./x402/settlement.js";

export const DEFAULT_INDEX_URL = "https://paidfor.dev/v1";
/** The index checks the transaction on Base before it answers, so this waits longer than the 1 s of the other rows. */
export const REPORT_TIMEOUT_MS = 10_000;
const TX_RE = /^0x[0-9a-f]{64}$/;
/** x402 v1 names Base "base"; v2 uses CAIP-2. The index counts Base mainnet only. */
const BASE_NETWORKS = new Set(["base", "eip155:8453"]);

export type ReportOutcome = Extract<TelemetryOutcome, "ok" | "non_delivery" | "wrong_goods" | "overcharge" | "duplicate">;

/** The tx_only row, exactly as docs/telemetry.md lists it. */
export interface TxOnlyPayload {
  v: 2;
  proof_level: "tx_only";
  host: string;
  path?: string;
  path_hash: string;
  outcome: ReportOutcome;
  amount_usdc?: string;
  latency_ms: number;
  validator_failures: string[];
  client: typeof CLIENT_ID;
  proof: { network: "eip155:8453"; tx_hash: string };
}

export interface ReportOnlyOptions {
  /** Default https://paidfor.dev/v1. https only (loopback excepted), like "verified" telemetry. */
  indexUrl?: string;
  /** Where failed reports are counted (debug.log); nothing is written when omitted. */
  receiptsDir?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Decides the outcome from the paid response; default `ok` for 2xx, `non_delivery` otherwise. Return null to skip the
   * report (for example when your own validation runs later and you call `report()` yourself).
   */
  classify?: (r: { url: string; status: number }) => ReportOutcome | null;
  /** Called with the index's answer (or the error) for each report sent; for logs and tests. */
  onReport?: (r: { tx_hash: string; status: number | null; body: unknown; error?: string }) => void;
}

/** The settlement transaction hash on Base from a response's headers, or null when there is none (nothing was paid). */
export function settlementTx(headers: Record<string, string>): string | null {
  const s = decodeSettlementHeader(headers);
  const tx = s.parsed?.transaction?.toLowerCase();
  if (!s.parsed || s.parsed.success === false || !tx || !TX_RE.test(tx)) return null;
  if (s.parsed.network && !BASE_NETWORKS.has(s.parsed.network)) return null;
  return tx;
}

export function buildTxOnlyPayload(i: { url: string; tx_hash: string; outcome: ReportOutcome; status?: number | undefined; quotedUsdc?: string | number | undefined; latencyMs?: number | undefined }): TxOnlyPayload {
  const u = new URL(i.url);
  const path = plainPath(i.url);
  const quoted = i.quotedUsdc === undefined ? NaN : Number(i.quotedUsdc);
  return {
    v: 2,
    proof_level: "tx_only",
    host: u.hostname.toLowerCase(),
    ...(path ? { path } : {}),
    path_hash: pathHash(i.url),
    outcome: i.outcome,
    ...(Number.isFinite(quoted) && quoted > 0 ? { amount_usdc: quoted.toFixed(6) } : {}),
    latency_ms: Math.max(0, Math.round(i.latencyMs ?? 0)),
    validator_failures: i.status !== undefined && (i.status < 200 || i.status > 299) ? [`http_status:${i.status}`] : [],
    client: CLIENT_ID,
    proof: { network: "eip155:8453", tx_hash: i.tx_hash.toLowerCase() },
  };
}

const defaultClassify = ({ status }: { status: number }): ReportOutcome => (status >= 200 && status < 300 ? "ok" : "non_delivery");

function assertIndexUrl(indexUrl: string) {
  const u = new URL(indexUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`reportOnly: indexUrl must be https (got ${indexUrl})`);
}

/**
 * The report-only reporter. `report()` sends one row for one paid response and never throws; it returns the promise
 * only so callers and tests can wait. One transaction is reported once per reporter (the index dedupes across
 * channels anyway).
 */
export function reportOnly(o: ReportOnlyOptions = {}) {
  const indexUrl = (o.indexUrl ?? DEFAULT_INDEX_URL).replace(/\/$/, "");
  assertIndexUrl(indexUrl);
  const fetchImpl = o.fetch ?? globalThis.fetch;
  const sent = new Set<string>();
  let failures = 0;
  const logFailure = async (why: string) => {
    failures++;
    if (!o.receiptsDir) return;
    try {
      await mkdir(o.receiptsDir, { recursive: true });
      await appendFile(join(o.receiptsDir, "debug.log"), `${new Date().toISOString()} report_failed count=${failures} ${why}\n`);
    } catch {
      /* swallowed */
    }
  };

  async function send(payload: TxOnlyPayload): Promise<void> {
    const tx = payload.proof.tx_hash;
    try {
      const res = await fetchImpl(`${indexUrl}/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json", [CLIENT_HEADER]: CLIENT_ID },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
        redirect: "error",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) await logFailure(`http ${res.status}`);
      o.onReport?.({ tx_hash: tx, status: res.status, body });
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await logFailure(error);
      o.onReport?.({ tx_hash: tx, status: null, body: null, error });
    }
  }

  return {
    /**
     * Report one paid response. `headers` are the response headers (a Headers object or a plain record); without a
     * Base settlement transaction in them nothing is sent. `outcome` overrides the classifier.
     */
    report(i: { url: string; status: number; headers: Headers | Record<string, unknown>; outcome?: ReportOutcome; quotedUsdc?: string | number; latencyMs?: number }): Promise<void> {
      return (async () => {
        const rec: Record<string, string> = {};
        if (typeof (i.headers as Headers).forEach === "function" && typeof (i.headers as Headers).get === "function") (i.headers as Headers).forEach((v, k) => (rec[k] = v));
        else for (const [k, v] of Object.entries(i.headers)) if (typeof v === "string") rec[k] = v;
        const tx = settlementTx(rec);
        if (!tx || sent.has(tx)) return;
        const outcome = i.outcome ?? (o.classify ?? defaultClassify)({ url: i.url, status: i.status });
        if (!outcome) return;
        sent.add(tx);
        if (sent.size > 10_000) sent.delete(sent.values().next().value!);
        await send(buildTxOnlyPayload({ url: i.url, tx_hash: tx, outcome, status: i.status, quotedUsdc: i.quotedUsdc, latencyMs: i.latencyMs }));
      })().catch(() => undefined);
    },
    failureCount: () => failures,
  };
}

// x402-fetch 1.x types its input as RequestInfo, @x402/fetch 2.x as RequestInfo | URL: accept either.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FetchLike = (input: any, init?: any) => Promise<Response>;
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/**
 * One added line on an x402-fetch setup: `const fetchWithPay = withPaidforReporting(wrapFetchWithPayment(fetch, wallet))`.
 * The returned fetch behaves exactly like the one passed in; after each response that carries a settlement on Base it
 * reports the outcome (2xx `ok`, else `non_delivery`) without waiting.
 */
export function withPaidforReporting<F extends FetchLike>(fetchWithPayment: F, o: ReportOnlyOptions = {}): F {
  const r = reportOnly(o);
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = Date.now();
    const res = await fetchWithPayment(input, init);
    void r.report({ url: res.url || urlOf(input), status: res.status, headers: res.headers, latencyMs: Date.now() - started });
    return res;
  };
  return wrapped as F;
}

/** The parts of an Axios instance the interceptor uses (no axios import, so axios stays the caller's dependency). */
export interface AxiosLike {
  // `any` so a real AxiosInstance (whose handlers are typed to its own AxiosResponse) is assignable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interceptors: { response: { use(onFulfilled: (r: any) => any, onRejected: (e: any) => any): unknown } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUri?(config?: any): string;
}
interface AxiosResponseLike {
  status: number;
  headers: Record<string, unknown> | { toJSON?(): Record<string, unknown> };
  config?: { url?: string; baseURL?: string };
  request?: { res?: { responseUrl?: string }; responseURL?: string };
}

/**
 * One added line on an x402-axios setup: `withPaidforReportingAxios(withPaymentInterceptor(axios.create(), wallet))`
 * (or `wrapAxiosWithPayment` from `@x402/axios`). Adds one response interceptor that reports each paid response,
 * successful or not, and passes everything through unchanged. Returns the same instance.
 */
export function withPaidforReportingAxios<A extends AxiosLike>(instance: A, o: ReportOnlyOptions = {}): A {
  const r = reportOnly(o);
  const seen = (res: AxiosResponseLike | undefined) => {
    if (!res || typeof res.status !== "number") return;
    const h = res.headers as { toJSON?(): Record<string, unknown> } & Record<string, unknown>;
    const headers = typeof h?.toJSON === "function" ? h.toJSON() : (h ?? {});
    const url = res.request?.res?.responseUrl ?? res.request?.responseURL ?? (res.config ? safeUri(instance, res.config) : undefined);
    if (url) void r.report({ url, status: res.status, headers });
  };
  instance.interceptors.response.use(
    (res) => {
      seen(res);
      return res;
    },
    (err) => {
      seen((err as { response?: AxiosResponseLike })?.response);
      return Promise.reject(err);
    },
  );
  return instance;
}

function safeUri(instance: AxiosLike, config: { url?: string; baseURL?: string }): string | undefined {
  try {
    if (instance.getUri) return instance.getUri(config);
    return config.baseURL ? new URL(config.url ?? "", config.baseURL).href : config.url;
  } catch {
    return undefined;
  }
}
