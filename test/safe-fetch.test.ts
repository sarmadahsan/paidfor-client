import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IntentConflictError, IntentIndeterminateError, PaymentRefusedError, SafeFetchError, safeFetch, type SafeFetchOptions } from "../src/index.js";
import { NETWORK, TX, USDC_SEPOLIA, fixture, payTo, startMock, type Mock } from "./mock.js";

let mock: Mock;
let dir: string;
const warnings: string[] = [];

beforeAll(async () => {
  mock = await startMock();
});
afterAll(() => mock.close());
beforeEach(async () => {
  mock.reset();
  warnings.length = 0;
  dir = await mkdtemp(join(tmpdir(), "x402-safe-fetch-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const account = privateKeyToAccount(generatePrivateKey());

function client(o: Partial<SafeFetchOptions> = {}) {
  return safeFetch(account, {
    maxPerCallUsd: 0.5,
    maxOverListedRatio: 1.1,
    refuseVerdicts: ["avoid"],
    indexUrl: `${mock.base}/v1`,
    receiptsDir: dir,
    network: NETWORK,
    telemetry: "off",
    logger: { warn: (m) => warnings.push(m) },
    ...o,
  });
}

/** Index answer for the mock seller host, built from a contract fixture. */
function indexAnswer(name: string, patch: Record<string, unknown> = {}) {
  const body = { ...(fixture(name) as Record<string, unknown>), host: "127.0.0.1", seller_url: "https://paidfor.dev/seller/127.0.0.1", ...patch };
  mock.st.index = { kind: "json", body };
}

const receipts = async () => (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "prices.json");

describe("safeFetch: paying", () => {
  it("pays once, verifies the signature, attaches and writes a receipt with the tx hash", async () => {
    indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.010000" } });
    const res = await client()(`${mock.base}/data?q=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, credits: 100 });
    expect(mock.st.verifyErrors).toEqual([]);
    expect(mock.st.paidCount).toBe(1);
    const r = res.receipt;
    expect(r).toMatchObject({
      outcome: "ok",
      paid: true,
      amount_usdc: "0.010000",
      tx_hash: TX,
      index: "ok",
      reference: { amount_usdc: "0.010000", source: "index_listed", ratio: 1, max_ratio: 1.1 },
      seller: { verdict: "ok" },
      validator_failures: [],
    });
    expect(Object.keys(r.validators)).toEqual(["http_status", "non_empty", "content_type", "not_truncated"]);
    expect(r.settlement.parsed?.success).toBe(true);
    expect(await receipts()).toHaveLength(1);
    // The index was asked about origin + path only, never the query string.
    expect(mock.st.indexCalls).toEqual([`/v1/check?url=${encodeURIComponent(`${mock.base}/data`)}`]);
  });

  it("proceeds on local checks when the index is down, slow or unknown, and says so in the receipt", async () => {
    for (const ix of [{ kind: "status", status: 503 }, { kind: "hang" }, { kind: "json", body: fixture("check-unknown") }] as const) {
      mock.reset();
      mock.st.index = ix;
      const t0 = Date.now();
      const res = await client({ indexTimeoutMs: 300 })(`${mock.base}/data`);
      expect(res.status).toBe(200);
      expect(res.receipt.index).toBe("unavailable");
      expect(res.receipt.paid).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3000);
    }
  });

  it("uses the 2 second index timeout by default", async () => {
    mock.st.index = { kind: "hang" };
    const t0 = Date.now();
    const res = await client()(`${mock.base}/data`);
    const took = Date.now() - t0;
    expect(res.receipt).toMatchObject({ index: "unavailable", index_note: "timeout after 2000ms", outcome: "ok" });
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(4000);
  });

  it("does not consult the index or sign for a free resource", async () => {
    mock.st.mode = "free";
    const res = await client()(`${mock.base}/free`);
    expect(await res.text()).toBe("free");
    expect(res.receipt).toMatchObject({ outcome: "no_payment_required", paid: false });
    expect(mock.st.indexCalls).toEqual([]);
  });

  it("hands the caller the full body even past the 2 MB validator cap", async () => {
    mock.st.mode = "big";
    const res = await client()(`${mock.base}/big`);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(3 * 1024 * 1024);
    expect(res.receipt.response?.body_truncated_for_validation).toBe(true);
  });
});

describe("safeFetch: refusals (nothing signed)", () => {
  it("refuses an 'avoid' seller and links the seller page", async () => {
    indexAnswer("check-avoid");
    const err = await client()(`${mock.base}/data`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentRefusedError);
    const e = err as PaymentRefusedError;
    expect(e.code).toBe("refused_verdict");
    expect(e.message).toContain('rates this seller "avoid"');
    expect(e.message).toContain("https://paidfor.dev/seller/127.0.0.1");
    expect(e.receipt).toMatchObject({ outcome: "refused_verdict", paid: false, seller: { verdict: "avoid" } });
    expect(mock.st.paidCount).toBe(0);
    expect(await receipts()).toHaveLength(1);
  });

  it("allows 'caution' but logs it", async () => {
    indexAnswer("check-caution-listed", { resource: { listed_price_usdc: "0.010000" } });
    const res = await client()(`${mock.base}/data`);
    expect(res.status).toBe(200);
    expect(warnings.join("\n")).toMatch(/caution/);
  });

  it("refuses a quote more than 10% over the index listed price", async () => {
    indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.009000" } }); // quote 0.010000 = 1.11x
    const err = (await client()(`${mock.base}/data`).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err.code).toBe("refused_ratio");
    expect(err.message).toMatch(/1\.11x the listed price on paidfor\.dev \(0\.009000 USDC\), above the 1\.1x limit/);
    expect(err.receipt?.reference).toMatchObject({ source: "index_listed", amount_usdc: "0.009000" });
    expect(mock.st.paidCount).toBe(0);
  });

  it("falls back to the last price this client paid when the index has none", async () => {
    const f = client();
    await f(`${mock.base}/data?a=1`); // pays 0.010000, index down
    mock.st.amount = "20000";
    const err = (await f(`${mock.base}/data?a=2`).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err.code).toBe("refused_ratio");
    expect(err.receipt?.reference).toMatchObject({ source: "local_last_paid", amount_usdc: "0.010000", ratio: 2 });
    expect(err.receipt?.index).toBe("unavailable");
    expect(mock.st.paidCount).toBe(1);
  });

  it("refuses above maxPerCallUsd", async () => {
    mock.st.amount = "600000";
    const err = (await client()(`${mock.base}/data`).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err.code).toBe("refused_max_per_call");
    expect(err.message).toContain("above maxPerCallUsd 0.500000 USDC");
    expect(mock.st.paidCount).toBe(0);
  });

  it("refuses when no exact USDC requirement exists on the configured network", async () => {
    mock.st.mode = "offnet";
    const err = (await client()(`${mock.base}/data`).catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe("no_acceptable_quote");
    expect(mock.st.paidCount).toBe(0);
  });

  it("a refused intent can be retried (nothing was signed)", async () => {
    mock.st.amount = "600000";
    const f = client();
    await expect(f(`${mock.base}/data`, {}, { intentId: "i-1" })).rejects.toBeInstanceOf(PaymentRefusedError);
    mock.st.amount = "10000";
    const res = await f(`${mock.base}/data`, {}, { intentId: "i-1" });
    expect(res.receipt.outcome).toBe("ok");
  });
});

describe("safeFetch: idempotency", () => {
  it("same intentId + same request returns the stored result and never signs again", async () => {
    const f = client();
    const a = await f(`${mock.base}/data`, { method: "POST", body: '{"x":1}', headers: { "content-type": "application/json" } }, { intentId: "topup-1" });
    expect(await a.json()).toEqual({ ok: true, credits: 100 });
    const b = await f(`${mock.base}/data`, { method: "POST", body: '{"x":1}', headers: { "content-type": "application/json" } }, { intentId: "topup-1" });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ ok: true, credits: 100 });
    expect(b.receipt).toMatchObject({ outcome: "replayed", replayed: true, paid: false, tx_hash: TX });
    expect(b.receipt.original?.intent_id).toBe("topup-1");
    expect(mock.st.paidCount).toBe(1);
    expect(mock.st.unpaidCount).toBe(1);
  });

  it("the store survives a new client instance (process restart)", async () => {
    await client()(`${mock.base}/data`, {}, { intentId: "k" });
    const res = await client()(`${mock.base}/data`, {}, { intentId: "k" });
    expect(res.receipt.replayed).toBe(true);
    expect(mock.st.paidCount).toBe(1);
  });

  it("same intentId + different request throws before contacting the seller", async () => {
    const f = client();
    await f(`${mock.base}/data`, { method: "POST", body: '{"x":1}' }, { intentId: "topup-2" });
    const err = await f(`${mock.base}/data`, { method: "POST", body: '{"x":2}' }, { intentId: "topup-2" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntentConflictError);
    expect(mock.st.unpaidCount).toBe(1);
    expect(mock.st.paidCount).toBe(1);
  });

  it("concurrent calls with one intentId: one pays, the other is refused as in flight", async () => {
    const f = client();
    const results = await Promise.allSettled([f(`${mock.base}/data`, {}, { intentId: "c" }), f(`${mock.base}/data`, {}, { intentId: "c" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as SafeFetchError).code).toBe("intent_in_flight");
    expect(mock.st.paidCount).toBe(1);
  });

  it("a lock held by another live process blocks; a lock from a dead process is stale", async () => {
    const lock = join(dir, "intents", createHash("sha256").update("x").digest("hex").slice(0, 40) + ".lock");
    await mkdir(join(dir, "intents"), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 1, at: Date.now() })); // pid 1 is always alive
    const err = (await client()(`${mock.base}/data`, {}, { intentId: "x" }).catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe("intent_in_flight");
    expect(mock.st.unpaidCount).toBe(0);
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect((await client()(`${mock.base}/data`, {}, { intentId: "x" })).receipt.outcome).toBe("ok");
  });

  it("signed and sent but no response: throws paid_no_response, and a retry refuses to sign again", async () => {
    mock.st.mode = "hang";
    const f = client();
    const err = (await f(`${mock.base}/data`, { signal: AbortSignal.timeout(500) }, { intentId: "h" }).catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe("paid_no_response");
    expect(err.receipt).toMatchObject({ outcome: "paid_no_response", paid: true });
    expect(err.receipt?.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    mock.st.mode = "ok";
    await expect(f(`${mock.base}/data`, {}, { intentId: "h" })).rejects.toBeInstanceOf(IntentIndeterminateError);
    expect(mock.st.paidCount).toBe(1);
  });

  it("the seller's own 402 after payment is stored and replayed, not re-signed", async () => {
    mock.st.mode = "settle_fail";
    const f = client();
    const a = await f(`${mock.base}/data`, {}, { intentId: "s" });
    expect(a.status).toBe(402);
    expect(a.receipt.validators.http_status).toMatchObject({ status: "fail", reason: "payment_rejected" });
    const b = await f(`${mock.base}/data`, {}, { intentId: "s" });
    expect(b.receipt.replayed).toBe(true);
    expect(mock.st.paidCount).toBe(1);
  });
});

describe("safeFetch: Conway auto-top-up (paid, 500, retried every 60 s)", () => {
  it("http_status flags the paid 500 and the retries replay it instead of paying again", async () => {
    mock.st.mode = "conway_500";
    const f = client();
    const first = await f(`${mock.base}/credits/topup`, { method: "POST", body: '{"amount_usd":5}' }, { intentId: "conway-acct42-2026-10-28" });
    expect(first.status).toBe(500);
    expect(first.receipt).toMatchObject({ outcome: "validator_failed", paid: true, tx_hash: TX, validator_failures: ["http_status"] });
    for (let i = 0; i < 5; i++) {
      const retry = await f(`${mock.base}/credits/topup`, { method: "POST", body: '{"amount_usd":5}' }, { intentId: "conway-acct42-2026-10-28" });
      expect(retry.status).toBe(500);
      expect(retry.receipt.replayed).toBe(true);
    }
    expect(mock.st.paidCount).toBe(1);
  });
});

describe("safeFetch: telemetry", () => {
  it("posts exactly the outcome payload, fire-and-forget, and swallows the 404", async () => {
    indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.010000" } });
    const res = await client({ telemetry: "anonymous" })(`${mock.base}/data?secret=abc`, {}, { intentId: "tel-1" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.st.telemetry).toHaveLength(1);
    const p = mock.st.telemetry[0] as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["amount_usdc", "client", "host", "latency_ms", "outcome", "path_hash", "v", "validator_failures"]);
    expect(p).toMatchObject({ v: 1, host: "127.0.0.1", outcome: "ok", amount_usdc: "0.010000", validator_failures: [], client: "x402-safe-fetch/0.2.2" });
    expect(p.path_hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(p);
    for (const leak of ["secret", "abc", "tel-1", account.address.toLowerCase().slice(2), account.address.slice(2)]) expect(raw).not.toContain(leak);
    const log = await readFile(join(dir, "debug.log"), "utf8");
    expect(log).toMatch(/telemetry_failed count=\d+ http 404/);
  });

  it("never delays the purchase when the telemetry route hangs", async () => {
    mock.st.telemetryStatus = "hang";
    const t0 = Date.now();
    const res = await client({ telemetry: "anonymous" })(`${mock.base}/data`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(800);
  });

  it("sends nothing when telemetry is off", async () => {
    await client()(`${mock.base}/data`);
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.st.telemetry).toEqual([]);
  });
});

describe("safeFetch: verified telemetry (v2)", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it("posts a v2 row that matches the contract example field by field", async () => {
    mock.st.mode = "conway_500";
    indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.010000" } });
    const res = await client({ telemetry: "verified" })(`${mock.base}/credits/topup/?secret=abc`, { method: "POST", body: '{"account":"acct_42"}' }, { intentId: "v2-1" });
    expect(res.status).toBe(500);
    await settle();
    expect(mock.st.telemetry).toHaveLength(1);
    const body = mock.st.telemetry[0] as Record<string, unknown>;
    const contract = fixture("telemetry-v2-contract") as Record<string, unknown>;
    const cproof = contract.proof as Record<string, unknown>;
    const proof = body.proof as Record<string, unknown>;

    // Same fields, same order, nothing extra, at both levels.
    expect(Object.keys(body)).toEqual(Object.keys(contract));
    expect(Object.keys(proof)).toEqual(Object.keys(cproof));

    expect(body.v).toBe(contract.v);
    expect(body.host).toBe("127.0.0.1");
    expect(body.path_hash).toBe(sha("/credits/topup"));
    expect(body.outcome).toBe(contract.outcome); // non_delivery
    expect(body.amount_usdc).toBe("0.010000");
    expect(body.amount_usdc).toMatch(/^\d+\.\d{6}$/);
    expect(Number.isInteger(body.latency_ms)).toBe(true);
    expect(body.validator_failures).toEqual(contract.validator_failures); // ["http_status:500"]
    expect(body.client).toBe(contract.client);

    expect(proof.network).toBe(NETWORK); // the contract example is mainnet; the mock seller is Base Sepolia
    expect(proof.scheme).toBe(cproof.scheme);
    expect(proof.asset).toBe(USDC_SEPOLIA.toLowerCase());
    expect(proof.pay_to).toBe(payTo.toLowerCase());
    expect(proof.payer).toBe(account.address.toLowerCase());
    expect(proof.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proof.tx_hash).toBe(TX);
    expect(typeof proof.settled_at).toBe("string");
    expect(new Date(proof.settled_at as string).toISOString()).toBe(proof.settled_at);
    expect(proof.response_sha256).toBe(sha(JSON.stringify({ error: "internal error" })));
    expect(proof.declared_timeout_s).toBe(cproof.declared_timeout_s); // 60, from the 402

    // Bodies, query strings, request parameters and the intent id never leave the machine.
    const raw = JSON.stringify(body);
    for (const leak of ["secret", "abc", "acct_42", "internal error", "v2-1"]) expect(raw).not.toContain(leak);
  });

  it("writes proof and verification_url into the receipt, and replays carry them", async () => {
    const f = client({ telemetry: "verified" });
    const res = await f(`${mock.base}/data`, {}, { intentId: "v2-r" });
    const r = res.receipt;
    expect(r.reported_outcome).toBe("ok");
    expect(r.payer).toBe(account.address.toLowerCase());
    expect(r.proof).toMatchObject({ payer: r.payer, nonce: r.nonce, tx_hash: TX, declared_timeout_s: 60 });
    expect(r.verification_url).toBe(`${mock.base}/v1/telemetry/${r.payer}/${r.nonce}`);
    const onDisk = JSON.parse(await readFile(join(dir, (await receipts())[0]!), "utf8"));
    expect(onDisk.proof).toEqual(r.proof);
    expect(onDisk.verification_url).toBe(r.verification_url);
    const again = await f(`${mock.base}/data`, {}, { intentId: "v2-r" });
    expect(again.receipt).toMatchObject({ replayed: true, proof: r.proof, verification_url: r.verification_url });
    await settle();
    expect(mock.st.telemetry).toHaveLength(1); // a replay sends nothing
  });

  it("adds the plain path only when the index answered unknown", async () => {
    indexAnswer("check-unknown");
    await client({ telemetry: "verified" })(`${mock.base}/v1/quote/?symbol=ETH&key=s3cret#frag`, {}, { intentId: "u-1" });
    // A known seller and an index that does not answer: no path.
    indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.010000" } });
    await client({ telemetry: "verified" })(`${mock.base}/v1/quote`, {}, { intentId: "u-2" });
    mock.st.index = { kind: "status", status: 503 };
    await client({ telemetry: "verified" })(`${mock.base}/v1/quote`, {}, { intentId: "u-3" });
    await settle();
    expect(mock.st.telemetry).toHaveLength(3);
    const [unknown, known, down] = mock.st.telemetry as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(unknown.path).toBe("/v1/quote/");
    expect(unknown.path_hash).toBe(sha("/v1/quote"));
    expect(unknown.proof).toBeDefined();
    for (const leak of ["symbol", "ETH", "s3cret", "frag"]) expect(JSON.stringify(unknown)).not.toContain(leak);
    expect(known).not.toHaveProperty("path");
    expect(down).not.toHaveProperty("path");
    expect(known.path_hash).toBe(unknown.path_hash);
  });

  it("anonymous telemetry never sends a path", async () => {
    indexAnswer("check-unknown");
    await client({ telemetry: "anonymous" })(`${mock.base}/v1/quote`, {}, { intentId: "u-4" });
    await settle();
    expect(mock.st.telemetry[0]).not.toHaveProperty("path");
  });

  it("a refusal sends a v2 row without proof", async () => {
    indexAnswer("check-avoid");
    const f = client({ telemetry: "verified" });
    const err = (await f(`${mock.base}/data`).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err.code).toBe("refused_verdict");
    expect(err.receipt).toMatchObject({ proof: null, verification_url: null, reported_outcome: "refused_verdict" });
    await settle();
    expect(mock.st.telemetry).toHaveLength(1);
    expect(mock.st.telemetry[0]).toMatchObject({ v: 2, outcome: "refused_verdict", amount_usdc: "0.000000" });
    expect(mock.st.telemetry[0]).not.toHaveProperty("proof");
  });

  it("paid but no response: proof with no tx hash and no body hash", async () => {
    mock.st.mode = "hang";
    const err = (await client({ telemetry: "verified" })(`${mock.base}/data`, { signal: AbortSignal.timeout(500) }).catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe("paid_no_response");
    expect(err.receipt?.proof).toMatchObject({ tx_hash: null, response_sha256: null, payer: account.address.toLowerCase() });
    await settle();
    expect(mock.st.telemetry[0]).toMatchObject({ v: 2, outcome: "paid_no_response", proof: { tx_hash: null } });
  });

  it('"anonymous" still sends v1 with no proof; the receipt keeps the proof locally', async () => {
    const res = await client({ telemetry: "anonymous" })(`${mock.base}/data`);
    expect(res.receipt.proof).not.toBeNull();
    expect(res.receipt.verification_url).toBeNull();
    await settle();
    expect(mock.st.telemetry[0]).toMatchObject({ v: 1, outcome: "ok" });
    expect(mock.st.telemetry[0]).not.toHaveProperty("proof");
    expect(JSON.stringify(mock.st.telemetry[0])).not.toContain(account.address.slice(2).toLowerCase());
  });

  it("prints the privacy notice once per receipts directory", async () => {
    client({ telemetry: "verified" });
    await settle();
    expect(warnings.filter((w) => w.includes("What verified telemetry sends and why"))).toHaveLength(1);
    client({ telemetry: "verified" });
    await settle();
    expect(warnings.filter((w) => w.includes("What verified telemetry sends and why"))).toHaveLength(1);
    client({ telemetry: "anonymous" });
    expect(warnings).toHaveLength(1);
  });

  it('refuses a plain-http remote indexUrl with "verified", allows loopback and https', () => {
    expect(() => client({ telemetry: "verified", indexUrl: "http://paidfor.dev/v1" })).toThrow(/needs an https indexUrl/);
    expect(() => client({ telemetry: "verified", indexUrl: "http://localhost:9/v1" })).not.toThrow();
    expect(() => client({ telemetry: "verified", indexUrl: "https://paidfor.dev/v1" })).not.toThrow();
    expect(() => client({ telemetry: "anonymous", indexUrl: "http://paidfor.dev/v1" })).not.toThrow();
  });

  it("never follows a redirect on the telemetry POST", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/telemetry")) seen.push(init ?? {});
      return globalThis.fetch(input, init);
    }) as typeof globalThis.fetch;
    await client({ telemetry: "verified", fetch: fetchImpl })(`${mock.base}/data`);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("error");
  });
});
