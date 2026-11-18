import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTxOnlyPayload, reportOnly, settlementTx, withPaidforReporting, withPaidforReportingAxios, type AxiosLike } from "../src/index.js";
import { pathHash } from "../src/telemetry.js";
import { encodeHeaderJson } from "../src/x402/types.js";

const TX = "0x" + "cd".repeat(32);
const URL_ = "https://api.example.com/v1/quote?symbol=ETH";
/** x402 v2 settles with a CAIP-2 network in PAYMENT-RESPONSE; v1 (x402-fetch 1.x) with "base" in X-PAYMENT-RESPONSE. */
const v2Header = (o: Record<string, unknown> = {}) => ({ "PAYMENT-RESPONSE": encodeHeaderJson({ success: true, transaction: TX, network: "eip155:8453", payer: "0x" + "1".repeat(40), ...o }) });
const v1Header = (o: Record<string, unknown> = {}) => ({ "X-PAYMENT-RESPONSE": encodeHeaderJson({ success: true, transaction: TX, network: "base", payer: "0x" + "1".repeat(40), ...o }) });

/** A recording fetch for the index: answers like the route does for a verified row. */
function index() {
  const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ status: "verified" }), { status: 202, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { posts, fetch };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("report-only: the row", () => {
  it("is the tx_only row: host, plain path, path hash, outcome, status, the hash, and nothing else", () => {
    const p = buildTxOnlyPayload({ url: URL_, tx_hash: TX.toUpperCase().replace("0X", "0x"), outcome: "non_delivery", status: 500, quotedUsdc: "0.01" });
    expect(p).toEqual({
      v: 2,
      proof_level: "tx_only",
      host: "api.example.com",
      path: "/v1/quote",
      path_hash: pathHash(URL_),
      outcome: "non_delivery",
      amount_usdc: "0.010000",
      latency_ms: 0,
      validator_failures: ["http_status:500"],
      client: "x402-safe-fetch/0.7.0",
      proof: { network: "eip155:8453", tx_hash: TX },
    });
    expect(JSON.stringify(p)).not.toContain("symbol");
  });

  it("reads the settlement hash from either header version, and only on Base mainnet with success", () => {
    expect(settlementTx(v2Header())).toBe(TX);
    expect(settlementTx(v1Header())).toBe(TX);
    expect(settlementTx(v2Header({ network: "eip155:84532" }))).toBeNull();
    expect(settlementTx(v2Header({ success: false }))).toBeNull();
    expect(settlementTx(v2Header({ transaction: "" }))).toBeNull();
    expect(settlementTx({})).toBeNull();
  });

  it("refuses a plain-http index", () => {
    expect(() => reportOnly({ indexUrl: "http://paidfor.dev/v1" })).toThrow(/https/);
    expect(() => reportOnly({ indexUrl: "http://127.0.0.1:3000/v1" })).not.toThrow();
  });
});

describe("withPaidforReporting (x402-fetch, @x402/fetch)", () => {
  it("passes the response through and reports a paid call once, with the client header", async () => {
    const ix = index();
    const res0 = new Response("{}", { status: 200, headers: v2Header() });
    const inner = async (_i: RequestInfo | URL) => res0;
    const f = withPaidforReporting(inner, { fetch: ix.fetch });
    const res = await f(URL_);
    expect(res).toBe(res0);
    await f(URL_);
    await tick();
    expect(ix.posts).toHaveLength(1);
    expect(ix.posts[0]).toMatchObject({ url: "https://paidfor.dev/v1/telemetry", headers: { "X-Paidfor-Client": "x402-safe-fetch/0.7.0" }, body: { outcome: "ok", proof: { tx_hash: TX } } });
  });

  it("reports a paid non-2xx as non_delivery, sends nothing for a free call, and never throws when the index is down", async () => {
    const ix = index();
    const f = withPaidforReporting(async (_i: RequestInfo | URL) => new Response("", { status: 502, headers: v1Header() }), { fetch: ix.fetch });
    expect((await f(URL_)).status).toBe(502);
    const free = withPaidforReporting(async (_i: RequestInfo | URL) => new Response("ok", { status: 200 }), { fetch: ix.fetch });
    await free(URL_);
    await tick();
    expect(ix.posts.map((p) => p.body.outcome)).toEqual(["non_delivery"]);
    expect(ix.posts[0]!.body.validator_failures).toEqual(["http_status:502"]);

    const dir = await mkdtemp(join(tmpdir(), "report-only-"));
    const down = withPaidforReporting(async (_i: RequestInfo | URL) => new Response("{}", { status: 200, headers: v2Header() }), {
      receiptsDir: dir,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    });
    expect((await down(URL_)).status).toBe(200);
    await tick();
    expect(await readFile(join(dir, "debug.log"), "utf8")).toMatch(/report_failed count=1 Error: ECONNREFUSED/);
    await rm(dir, { recursive: true, force: true });
  });

  it("lets the caller classify, or skip and report later", async () => {
    const ix = index();
    const r = reportOnly({ fetch: ix.fetch, classify: () => null });
    await r.report({ url: URL_, status: 200, headers: new Headers(v2Header()) });
    expect(ix.posts).toHaveLength(0);
    const r2 = reportOnly({ fetch: ix.fetch });
    await r2.report({ url: URL_, status: 200, headers: new Headers(v2Header()), outcome: "wrong_goods", quotedUsdc: 0.002 });
    expect(ix.posts[0]!.body).toMatchObject({ outcome: "wrong_goods", amount_usdc: "0.002000" });
  });
});

describe("withPaidforReportingAxios (x402-axios, @x402/axios)", () => {
  /** Just enough of axios: response interceptors run in order, and a rejected response carries `response`. */
  function fakeAxios() {
    const handlers: [(r: unknown) => unknown, (e: unknown) => unknown][] = [];
    const inst: AxiosLike & { run(res: unknown, ok: boolean): Promise<unknown> } = {
      interceptors: { response: { use: (a, b) => handlers.push([a as never, b]) } },
      getUri: (c: unknown) => new URL((c as { url: string }).url, "https://api.example.com").href,
      async run(res, ok) {
        let p: Promise<unknown> = ok ? Promise.resolve(res) : Promise.reject({ response: res });
        for (const [a, b] of handlers) p = p.then(a, b);
        return p;
      },
    };
    return inst;
  }

  it("reports a paid response and a paid error response, passing both through unchanged", async () => {
    const ix = index();
    const ax = withPaidforReportingAxios(fakeAxios(), { fetch: ix.fetch });
    const ok = { status: 200, headers: { "payment-response": v2Header()["PAYMENT-RESPONSE"] }, config: { url: "/v1/quote?symbol=ETH" } };
    expect(await ax.run(ok, true)).toBe(ok);
    const bad = { status: 500, headers: { "x-payment-response": v1Header({ transaction: "0x" + "ef".repeat(32) })["X-PAYMENT-RESPONSE"] }, config: { url: "/v1/quote" } };
    await expect(ax.run(bad, false)).rejects.toMatchObject({ response: bad });
    await tick();
    expect(ix.posts.map((p) => [p.body.host, p.body.path, p.body.outcome])).toEqual([
      ["api.example.com", "/v1/quote", "ok"],
      ["api.example.com", "/v1/quote", "non_delivery"],
    ]);
  });
});
