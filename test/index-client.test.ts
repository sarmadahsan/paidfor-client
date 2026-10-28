import { describe, expect, it } from "vitest";
import { lookupUrl, parseCheck, sellerPageUrl } from "../src/index-client.js";
import { fixture } from "./mock.js";

const IDX = "https://paidfor.dev/v1";

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
