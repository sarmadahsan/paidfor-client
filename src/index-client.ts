/**
 * The only file that knows the shape of GET {indexUrl}/check?url=. Contract (paidfor-index lib/check.ts):
 *   { input, host, verdict: "avoid"|"caution"|"ok"|"unknown", verdict_text, seller: {..., verdict, url} | null,
 *     resource: { url, listed_price_usdc: "0.002000" | null, modal_quote_usdc, ... } | null,
 *     probe, seller_url, evidence_url, methodology_url, generated_at }
 * Every field is optional here. Advisory only: this never throws, and anything other than a parseable answer
 * with a known verdict inside the timeout comes back as { available: false }.
 */
export type Verdict = "avoid" | "caution" | "ok" | "unknown";

export interface IndexCheck {
  available: boolean;
  /** Why the index could not be used (timeout, http 503, unknown verdict, ...). */
  note?: string;
  host: string | null;
  verdict: Verdict;
  verdict_text: string | null;
  seller_url: string | null;
  evidence_url: string | null;
  /** Listed price for this exact resource, USDC decimal string, when the index has one. */
  listed_price_usdc: string | null;
}

const VERDICTS: readonly Verdict[] = ["avoid", "caution", "ok", "unknown"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Seller page on the site that hosts the index: https://paidfor.dev/v1 -> https://paidfor.dev/seller/<host>. */
export function sellerPageUrl(indexUrl: string, host: string): string {
  return `${new URL(indexUrl).origin}/seller/${encodeURIComponent(host)}`;
}

/** Strip query and fragment: the index matches on host + path and never needs request parameters. */
export function lookupUrl(resourceUrl: string): string {
  const u = new URL(resourceUrl);
  return `${u.origin}${u.pathname}`;
}

export function parseCheck(body: unknown, indexUrl: string, resourceUrl: string): IndexCheck {
  const b = obj(body) ?? {};
  const seller = obj(b.seller);
  const resource = obj(b.resource);
  let host = str(b.host) ?? str(seller?.domain);
  if (!host) {
    try {
      host = new URL(resourceUrl).hostname.toLowerCase();
    } catch {
      host = null;
    }
  }
  const rawVerdict = str(b.verdict) ?? str(seller?.verdict);
  const verdict: Verdict = rawVerdict && (VERDICTS as readonly string[]).includes(rawVerdict) ? (rawVerdict as Verdict) : "unknown";
  const out: IndexCheck = {
    available: verdict !== "unknown",
    host,
    verdict,
    verdict_text: str(b.verdict_text),
    seller_url: str(b.seller_url) ?? str(seller?.url) ?? (host ? sellerPageUrl(indexUrl, host) : null),
    evidence_url: str(b.evidence_url) ?? str(seller?.evidence_url),
    listed_price_usdc: str(resource?.listed_price_usdc),
  };
  if (verdict === "unknown") out.note = rawVerdict ? "verdict unknown" : "no verdict in response";
  return out;
}

export interface CheckOptions {
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export async function checkIndex(indexUrl: string, resourceUrl: string, o: CheckOptions = {}): Promise<IndexCheck> {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const unavailable = (note: string): IndexCheck => {
    let host: string | null = null;
    try {
      host = new URL(resourceUrl).hostname.toLowerCase();
    } catch {
      /* ignore */
    }
    return { available: false, note, host, verdict: "unknown", verdict_text: null, seller_url: host ? sellerPageUrl(indexUrl, host) : null, evidence_url: null, listed_price_usdc: null };
  };
  const timeoutMs = o.timeoutMs ?? 2000;
  try {
    const url = `${indexUrl.replace(/\/$/, "")}/check?url=${encodeURIComponent(lookupUrl(resourceUrl))}`;
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      return unavailable(`http ${res.status}`);
    }
    // The timeout signal also bounds the body read.
    const body: unknown = await res.json();
    return parseCheck(body, indexUrl, resourceUrl);
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return unavailable(name === "TimeoutError" || name === "AbortError" ? `timeout after ${timeoutMs}ms` : `error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
