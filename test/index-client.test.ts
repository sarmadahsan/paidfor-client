import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIndex, lookupUrl, parseCheck, sellerPageUrl } from "../src/index-client.js";
import { CLIENT_ID, buildPayload, sendTelemetry } from "../src/telemetry.js";
import { fixture } from "./mock.js";

const IDX = "https://paidfor.dev/v1";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("parseCheck (contract fixtures)", () => {
  it("avoid seller with a listed resource", () => {
    const c = parseCheck(fixture("check-avoid"), IDX, "https://api.vapinetwork.ai/shim/o1/token");
    expect(c).toMatchObject({ available: true, verdict: "avoid", host: "api.vapinetwork.ai", listed_price_usdc: "0.002000", seller_url: "https://paidfor.dev/seller/api.vapinetwork.ai" });
  });
  it("caution seller", () => {
    const c = parseCheck(fixture("check-caution-listed"), IDX, "https://odds.rjhsignaltech.workers.dev/v1/balance");
    expect(c).toMatchObject({ available: true, verdict: "caution", listed_price_usdc: "0.001000" });
  });
  it("unknown counts as unavailable", () => {
    const c = parseCheck(fixture("check-unknown"), IDX, "https://never-seen.example.com/api");
    expect(c).toMatchObject({ available: false, verdict: "unknown", listed_price_usdc: null, note: "verdict unknown" });
  });
  it("tolerates missing fields: verdict from seller, host and seller page derived", () => {
    const c = parseCheck(fixture("check-partial"), IDX, "https://x.example.com/a?b=1");
    expect(c).toMatchObject({ available: true, verdict: "ok", host: "x.example.com", seller_url: "https://paidfor.dev/seller/x.example.com", listed_price_usdc: null });
  });
  it("tolerates garbage", () => {
    for (const body of [null, 42, "x", [], { verdict: "great" }]) expect(parseCheck(body, IDX, "https://a.b/c").available).toBe(false);
  });
  it("helpers", () => {
    expect(lookupUrl("https://a.example.com/p/q?secret=1#f")).toBe("https://a.example.com/p/q");
    expect(sellerPageUrl("https://paidfor.dev/v1", "a.example.com")).toBe("https://paidfor.dev/seller/a.example.com");
  });
});

describe("X-Paidfor-Client header", () => {
  const recorder = () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(fixture("check-avoid")), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    return { calls, fetchImpl };
  };

  it("is sent on the index check", async () => {
    const r = recorder();
    await checkIndex(IDX, "https://api.vapinetwork.ai/shim/o1/token", { fetchImpl: r.fetchImpl });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toMatch(/^https:\/\/paidfor\.dev\/v1\/check\?/);
    expect(r.calls[0]!.headers.get("x-paidfor-client")).toBe(CLIENT_ID);
    expect(CLIENT_ID).toBe(`x402-safe-fetch/${pkg.version}`);
  });

  it("is sent on the telemetry post", async () => {
    const r = recorder();
    const payload = buildPayload({ url: "https://a.example.com/p", outcome: "ok", amountUsdc: "0.010000", latencyMs: 5, validatorFailures: [] });
    await sendTelemetry(IDX, payload, { receiptsDir: mkdtempSync(join(tmpdir(), "pf-hdr-")), fetchImpl: r.fetchImpl });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe("https://paidfor.dev/v1/telemetry");
    expect(r.calls[0]!.headers.get("x-paidfor-client")).toBe(CLIENT_ID);
  });
});
