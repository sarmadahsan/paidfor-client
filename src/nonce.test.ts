import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NONCE_KEY, deriveNonce } from "./nonce.js";

const base = { intentId: "report:3f2c", payer: "0x9EF8182F369F55E477E8D5F1C6BCAF1B58B738A4", payTo: "0x367F1B3D8CA90D1E087481A9A40D585BF3451A03", amountAtomic: "10000" };

describe("deriveNonce", () => {
  it("is 32 bytes of 0x-hex, the same for the same purchase, whatever the case of the addresses", () => {
    const n = deriveNonce(base);
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveNonce({ ...base, payer: base.payer.toLowerCase(), payTo: base.payTo.toLowerCase() })).toBe(n);
  });

  it("is the documented HMAC over the JSON array, under the public key", () => {
    const message = JSON.stringify([base.intentId, base.payer.toLowerCase(), base.payTo.toLowerCase(), base.amountAtomic]);
    expect(deriveNonce(base)).toBe(`0x${createHmac("sha256", NONCE_KEY).update(message).digest("hex")}`);
    expect(NONCE_KEY).toBe("x402-safe-fetch:eip3009-nonce:v1");
  });

  it("changes with any of the four inputs", () => {
    const n = deriveNonce(base);
    expect(deriveNonce({ ...base, intentId: "report:3f2d" })).not.toBe(n);
    expect(deriveNonce({ ...base, payer: `0x${"1".repeat(40)}` })).not.toBe(n);
    expect(deriveNonce({ ...base, payTo: `0x${"2".repeat(40)}` })).not.toBe(n);
    expect(deriveNonce({ ...base, amountAtomic: "10001" })).not.toBe(n);
  });

  it("an intent id with the JSON separators in it cannot collide with another", () => {
    expect(deriveNonce({ ...base, intentId: 'a","b' })).not.toBe(deriveNonce({ ...base, intentId: "a" }));
  });
});
