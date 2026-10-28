import { describe, expect, it } from "vitest";
import { atomicToUsdc, exceedsRatio, quoteRatio, resourceKey, usdToAtomic, usdcStringToAtomic } from "../src/price.js";

describe("price", () => {
  it("converts USD caps to atomic units without loosening them", () => {
    expect(usdToAtomic(0.5)).toBe(500000n);
    expect(usdToAtomic(0.1 + 0.2)).toBe(300000n);
    expect(usdToAtomic(1)).toBe(1000000n);
    expect(usdToAtomic(0.0000019)).toBe(1n);
    expect(() => usdToAtomic(-1)).toThrow();
  });
  it("parses index price strings", () => {
    expect(usdcStringToAtomic("0.002000")).toBe(2000n);
    expect(usdcStringToAtomic("$1.5")).toBe(1500000n);
    expect(usdcStringToAtomic("0.0000001")).toBeUndefined();
    expect(usdcStringToAtomic("abc")).toBeUndefined();
    expect(usdcStringToAtomic(null)).toBeUndefined();
    expect(atomicToUsdc(2000n)).toBe("0.002000");
  });
  it("ratio limits are exact at the boundary", () => {
    expect(exceedsRatio(1100n, 1000n, 1.1)).toBe(false);
    expect(exceedsRatio(1101n, 1000n, 1.1)).toBe(true);
    expect(exceedsRatio(1n, 0n, 1.1)).toBe(true);
    expect(quoteRatio(2000n, 1000n)).toBe(2);
    expect(quoteRatio(0n, 0n)).toBe(1);
  });
  it("resource key drops the query string", () => {
    expect(resourceKey("get", "https://a.example.com/x/?q=1")).toBe("GET https://a.example.com/x");
  });
});
