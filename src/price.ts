/**
 * Price checks. The ratio arithmetic is x402-audit src/classify.ts (bigint, RATIO_SCALE); the reference-price
 * order mirrors src/buy/reference.ts (declared/listed price first, then what this buyer has seen), with the
 * SQLite probe history replaced by a small local JSON file.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonDurable } from "./fsutil.js";

export const USDC_DECIMALS = 6;
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/** USDC contract per CAIP-2 network. Amounts are converted to USD only for these assets. */
export const USDC_BY_NETWORK: Readonly<Record<string, string>> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

const isAtomic = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

/** Dollars (as configured by the caller) to USDC atomic units, rounding down so a cap is never loosened. */
export function usdToAtomic(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new TypeError(`expected a non-negative USD amount, got ${usd}`);
  const [whole, frac = ""] = usd.toFixed(USDC_DECIMALS + 2).split(".");
  return BigInt(whole!) * USDC_UNIT + BigInt(frac.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0"));
}

/** "0.002000" (index format) to atomic units; undefined when unparseable or finer than 6 decimals. */
export function usdcStringToAtomic(s: unknown): bigint | undefined {
  if (typeof s !== "string") return undefined;
  const m = /^\s*\$?(\d+)(?:\.(\d+))?\s*$/.exec(s);
  if (!m) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS && /[1-9]/.test(frac.slice(USDC_DECIMALS))) return undefined;
  return BigInt(m[1]!) * USDC_UNIT + BigInt(frac.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0"));
}

export function atomicToUsdc(a: bigint | string): string {
  const v = typeof a === "bigint" ? a : BigInt(a);
  const whole = v / USDC_UNIT;
  const frac = (v % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** classify.ts: overchargeRatio = quote / reference with 12 digits of precision; reference 0 is 1 or +Infinity. */
const RATIO_SCALE = 10n ** 12n;
export function quoteRatio(quote: bigint, ref: bigint): number {
  if (ref === 0n) return quote === 0n ? 1 : Number.POSITIVE_INFINITY;
  return Number((quote * RATIO_SCALE) / ref) / Number(RATIO_SCALE);
}

/** Exact comparison: quote > ref * maxRatio, with maxRatio taken to 6 decimal places. */
export function exceedsRatio(quote: bigint, ref: bigint, maxRatio: number): boolean {
  const scaled = BigInt(Math.round(maxRatio * 1e6));
  return quote * 1_000_000n > ref * scaled;
}

/** Resource identity for the local price book: method + origin + path, query string dropped. */
export function resourceKey(method: string, url: string): string {
  const u = new URL(url);
  return `${method.toUpperCase()} ${u.origin}${u.pathname.replace(/\/$/, "")}`;
}

export type ReferenceSource = "index_listed" | "local_last_paid";

interface PriceEntry {
  amount_atomic: string;
  at: string;
}

/** Last price this client paid (and got a 2xx for) per resource, in <receiptsDir>/prices.json. */
export class PriceBook {
  private readonly file: string;
  private cache: Record<string, PriceEntry> | undefined;
  constructor(dir: string) {
    this.file = join(dir, "prices.json");
  }
  private async load(): Promise<Record<string, PriceEntry>> {
    if (this.cache) return this.cache;
    try {
      const j = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      this.cache = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, PriceEntry>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
  async get(key: string): Promise<bigint | undefined> {
    const e = (await this.load())[key];
    return e && isAtomic(e.amount_atomic) ? BigInt(e.amount_atomic) : undefined;
  }
  /** Whether any resource on `origin` has a recorded price, that is, this client has paid that seller before (0.8.0). */
  async hasOrigin(origin: string): Promise<boolean> {
    const o = origin.toLowerCase();
    return Object.keys(await this.load()).some((k) => {
      const url = k.slice(k.indexOf(" ") + 1).toLowerCase();
      return url === o || url.startsWith(`${o}/`);
    });
  }
  async set(key: string, amount: bigint, now = new Date()): Promise<void> {
    const all = await this.load();
    all[key] = { amount_atomic: amount.toString(), at: now.toISOString() };
    await writeJsonDurable(this.file, all);
  }
}
