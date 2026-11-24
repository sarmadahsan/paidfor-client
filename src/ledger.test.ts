import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger, sellerKey, utcDay, type LedgerFile, type Reservation } from "./ledger.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x402-spend-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const PAY_TO = "0x367f1b3d8ca90d1e087481a9a40d585bf3451a03";
const HOST = "api.example.com";
const at = (iso: string) => new Date(iso);
const okRes = (r: Awaited<ReturnType<SpendLedger["reserve"]>>): Reservation => {
  if (!r.ok) throw new Error(`refused: ${r.refusal.rule}`);
  return r.reservation;
};
const file = async (): Promise<LedgerFile> => JSON.parse(await readFile(join(dir, "spend.json"), "utf8")) as LedgerFile;

describe("SpendLedger", () => {
  it("counts settled payments per UTC day and per seller, and refuses the quote that would go over", async () => {
    const l = new SpendLedger(dir);
    const caps = { perDay: 25_000n, perSellerPerDay: 20_000n };
    const now = at("2026-11-23T10:00:00Z");
    await l.settle(okRes(await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true, now })), true, 10_000n, now);
    await l.settle(okRes(await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true, now })), true, 10_000n, now);
    const perSeller = await l.reserve({ seller: PAY_TO, host: HOST, amount: 1n, caps, unlisted: false, known: true, now });
    expect(perSeller).toEqual({ ok: false, refusal: { rule: "per_seller_per_day", spent: 20_000n, cap: 20_000n, amount: 1n, seller: PAY_TO } });
    // Another seller: the day's total is what stops it.
    const other = `0x${"a".repeat(40)}`;
    expect(await l.reserve({ seller: other, host: "b.example.com", amount: 5_001n, caps, unlisted: false, known: true, now })).toEqual({ ok: false, refusal: { rule: "per_day", spent: 20_000n, cap: 25_000n, amount: 5_001n, seller: other } });
    expect((await l.reserve({ seller: other, host: "b.example.com", amount: 5_000n, caps, unlisted: false, known: true, now })).ok).toBe(true);
    const f = await file();
    expect(f.days["2026-11-23"]).toMatchObject({ settled_atomic: "20000", by_seller: { [PAY_TO]: "20000" } });
    expect(f.sellers[PAY_TO]).toMatchObject({ payments: 2 });
    expect(f.sellers[HOST]).toMatchObject({ payments: 2 });
  });

  it("a reservation not yet settled counts against both caps; one given back does not", async () => {
    const l = new SpendLedger(dir);
    const caps = { perDay: 15_000n };
    const held = okRes(await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true }));
    expect((await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true })).ok).toBe(false);
    await l.settle(held, false);
    expect((await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true })).ok).toBe(true);
    const f = await file();
    expect(f.days[utcDay(new Date())]!.settled_atomic).toBe("0");
    expect(f.sellers).toEqual({});
  });

  it("a paid reservation is counted with the amount signed when that differs from the quote", async () => {
    const l = new SpendLedger(dir);
    const r = okRes(await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps: { perDay: 50_000n }, unlisted: false, known: true }));
    await l.settle(r, true, 9_000n);
    expect((await file()).days[r.day]).toMatchObject({ settled_atomic: "9000", pending: {} });
  });

  it("the day rolls over at UTC midnight and days before yesterday are pruned", async () => {
    const l = new SpendLedger(dir);
    const caps = { perDay: 10_000n };
    const d1 = at("2026-11-21T23:59:59Z");
    await l.settle(okRes(await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true, now: d1 })), true, 10_000n, d1);
    expect((await l.reserve({ seller: PAY_TO, host: HOST, amount: 1n, caps, unlisted: false, known: true, now: d1 })).ok).toBe(false);
    const d2 = at("2026-11-22T00:00:00Z");
    expect((await l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true, now: d2 })).ok).toBe(true);
    expect(Object.keys((await file()).days).sort()).toEqual(["2026-11-21", "2026-11-22"]);
    const d4 = at("2026-11-24T12:00:00Z");
    okRes(await l.reserve({ seller: PAY_TO, host: HOST, amount: 1n, caps, unlisted: false, known: true, now: d4 }));
    const f = await file();
    expect(Object.keys(f.days).sort()).toEqual(["2026-11-24"]);
    // The seller history survives the pruning.
    expect(f.sellers[HOST]).toMatchObject({ payments: 1 });
  });

  it("the first-payment cap applies only to a seller with no listing and no history, by host or pay-to", async () => {
    const l = new SpendLedger(dir);
    const caps = { firstPayment: 5_000n };
    const stranger = { seller: PAY_TO, host: HOST, amount: 6_000n, caps, unlisted: true, known: false };
    expect(await l.reserve(stranger)).toEqual({ ok: false, refusal: { rule: "first_payment", spent: 0n, cap: 5_000n, amount: 6_000n, seller: PAY_TO } });
    // Listed, or known from elsewhere (the price book): not a stranger.
    expect((await l.reserve({ ...stranger, unlisted: false })).ok).toBe(true);
    expect((await l.reserve({ ...stranger, known: true })).ok).toBe(true);
    // Under the cap it pays, and from then on the seller has history under both keys.
    await l.settle(okRes(await l.reserve({ ...stranger, amount: 5_000n })), true);
    expect((await l.reserve(stranger)).ok).toBe(true);
    expect((await l.reserve({ ...stranger, seller: `0x${"b".repeat(40)}` })).ok).toBe(true); // same host, rotated pay-to
    expect((await l.reserve({ ...stranger, host: "other.example.com" })).ok).toBe(true); // same pay-to, another host
    expect(await l.hasPaid(HOST)).toBe(true);
    expect(await l.hasPaid("nobody.example.com")).toBe(false);
  });

  it("calls in one process line up: two at once never both fit in the last room", async () => {
    const l = new SpendLedger(dir);
    const caps = { perDay: 10_000n };
    const both = await Promise.all([l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true }), l.reserve({ seller: PAY_TO, host: HOST, amount: 10_000n, caps, unlisted: false, known: true })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
  });

  it("a lock held by another live process fails the call; a lock from a dead process is stale", async () => {
    const l = new SpendLedger(dir);
    const caps = { perDay: 10_000n };
    await writeFile(join(dir, "spend.lock"), JSON.stringify({ pid: 1, at: Date.now() }));
    await expect(l.reserve({ seller: PAY_TO, host: HOST, amount: 1n, caps, unlisted: false, known: true })).rejects.toThrow(/locked by process 1/);
    await writeFile(join(dir, "spend.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect((await l.reserve({ seller: PAY_TO, host: HOST, amount: 1n, caps, unlisted: false, known: true })).ok).toBe(true);
  });

  it("an unreadable ledger file is not silently replaced", async () => {
    await writeFile(join(dir, "spend.json"), "{not json");
    const l = new SpendLedger(dir);
    await expect(l.reserve({ seller: PAY_TO, host: HOST, amount: 1n, caps: { perDay: 10n }, unlisted: false, known: true })).rejects.toThrow();
  });

  it("sellerKey is the pay-to address, lowercase, or the host when the quote names no address", () => {
    expect(sellerKey("0x367F1B3D8CA90D1E087481A9A40D585BF3451A03", HOST)).toBe(PAY_TO);
    expect(sellerKey("not-an-address", "API.Example.com")).toBe(HOST);
    expect(sellerKey(undefined, HOST)).toBe(HOST);
  });
});
