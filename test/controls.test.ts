/**
 * The 0.8.0 controls, every one before the signature: the per-day and per-seller caps and the stranger cap (one spend
 * ledger), the pay-to check, the approval threshold, the freeze switch, and the nonce derived from the intent.
 */
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PaymentRefusedError, SafeFetchError, deriveNonce, safeFetch, type LedgerFile, type SafeFetchOptions } from "../src/index.js";
import { resetOnceNotices } from "../src/safe-fetch.js";
import { TX, fixture, payTo, startMock, type Mock } from "./mock.js";
import { NETWORK } from "./mock.js";

let mock: Mock;
let dir: string;
const warnings: string[] = [];

beforeAll(async () => {
  delete process.env.PAIDFOR_TEAM_KEY;
  mock = await startMock();
});
afterAll(() => mock.close());
beforeEach(async () => {
  mock.reset();
  resetOnceNotices();
  warnings.length = 0;
  dir = await mkdtemp(join(tmpdir(), "x402-safe-fetch-controls-"));
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const account = privateKeyToAccount(generatePrivateKey());

function client(o: Partial<SafeFetchOptions> = {}, receiptsDir = dir) {
  return safeFetch(account, {
    maxPerCallUsd: 0.5,
    indexUrl: `${mock.base}/v1`,
    receiptsDir,
    network: NETWORK,
    telemetryNotice: false,
    rpcUrl: `${mock.base}/rpc`,
    logger: { warn: (m) => warnings.push(m) },
    ...o,
  });
}

/** Index answer for the mock seller host, built from a contract fixture. */
function indexAnswer(name: string, patch: Record<string, unknown> = {}) {
  const body = { ...(fixture(name) as Record<string, unknown>), host: "127.0.0.1", seller_url: "https://paidfor.dev/seller/127.0.0.1", ...patch };
  mock.st.index = { kind: "json", body };
}
/** The mock seller listed with the given pay-to addresses on record. */
function listedWithPayTo(addresses: string[]) {
  const base = fixture("check-caution-listed") as Record<string, unknown>;
  indexAnswer("check-caution-listed", { verdict: "ok", seller: { ...(base.seller as Record<string, unknown>), verdict: "ok", pay_to_addresses: addresses }, resource: { listed_price_usdc: "0.010000" } });
}

const refused = async (p: Promise<unknown>): Promise<PaymentRefusedError> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(PaymentRefusedError);
  return e as PaymentRefusedError;
};
const ledger = async (): Promise<LedgerFile> => JSON.parse(await readFile(join(dir, "spend.json"), "utf8")) as LedgerFile;
const today = () => new Date().toISOString().slice(0, 10);
const settle = () => new Promise((r) => setTimeout(r, 200));
const OTHER = `0x${"5".repeat(40)}`;

describe("maxPerDayUsd: the day's total, across sellers and processes", () => {
  it("refuses the quote that would take the day over the cap, before signing, and names the cap", async () => {
    const f = client({ maxPerDayUsd: 0.025 }); // the mock quotes 0.010000
    await f(`${mock.base}/a`);
    await f(`${mock.base}/b`);
    const err = await refused(f(`${mock.base}/c`));
    expect(err.code).toBe("refused_max_per_day");
    expect(err.message).toContain("0.020000 USDC already paid today (UTC)");
    expect(err.message).toContain("over maxPerDayUsd 0.025000 USDC");
    expect(err.receipt).toMatchObject({ outcome: "refused_max_per_day", paid: false, reported_outcome: null, quote: { amount_usdc: "0.010000" } });
    expect(mock.st.paidCount).toBe(2);
    const l = await ledger();
    expect(l.days[today()]).toMatchObject({ settled_atomic: "20000", by_seller: { [payTo.toLowerCase()]: "20000" }, pending: {} });
  });

  it("is shared through the directory: another client (another process) sees what this one paid", async () => {
    await client({ maxPerDayUsd: 0.015 })(`${mock.base}/a`);
    const err = await refused(client({ maxPerDayUsd: 0.015 })(`${mock.base}/b`));
    expect(err.code).toBe("refused_max_per_day");
    expect(mock.st.paidCount).toBe(1);
  });

  it("replays, refusals, free resources and rejected payments do not count", async () => {
    const f = client({ maxPerDayUsd: 0.025, maxPerCallUsd: 0.5 });
    await f(`${mock.base}/a`, {}, { intentId: "r-1" });
    const again = await f(`${mock.base}/a`, {}, { intentId: "r-1" });
    expect(again.receipt.replayed).toBe(true);
    mock.st.mode = "free";
    await f(`${mock.base}/free`);
    mock.st.mode = "ok";
    indexAnswer("check-avoid");
    await expect(f(`${mock.base}/b`)).rejects.toBeInstanceOf(PaymentRefusedError);
    mock.st.index = { kind: "status", status: 503 };
    mock.st.mode = "reject_402";
    // A rejected payment takes a reservation and gives it back: nothing settled.
    const rej = await f(`${mock.base}/c`);
    expect(rej.receipt.outcome).toBe("payment_rejected");
    mock.st.mode = "ok";
    const l = await ledger();
    expect(l.days[today()]).toMatchObject({ settled_atomic: "10000", pending: {} });
    // The room left is one payment of 0.01: the cap is 0.025.
    await f(`${mock.base}/d`);
    await expect(f(`${mock.base}/e`)).rejects.toMatchObject({ code: "refused_max_per_day" });
  });

  it("a payment signed and sent with no response counts, since the money may have moved", async () => {
    mock.st.mode = "hang";
    const f = client({ maxPerDayUsd: 0.015 });
    const err = (await f(`${mock.base}/a`, { signal: AbortSignal.timeout(500) }, { intentId: "h" }).catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe("paid_no_response");
    expect((await ledger()).days[today()]).toMatchObject({ settled_atomic: "10000", pending: {} });
    mock.st.mode = "ok";
    await expect(f(`${mock.base}/b`)).rejects.toMatchObject({ code: "refused_max_per_day" });
  });

  it("a refusal by the cap sends no row to the index and is told to no one", async () => {
    const f = client({ maxPerDayUsd: 0.015 });
    await f(`${mock.base}/a`);
    await settle();
    const rows = mock.st.telemetry.length;
    await expect(f(`${mock.base}/b`)).rejects.toMatchObject({ code: "refused_max_per_day" });
    await settle();
    expect(mock.st.telemetry).toHaveLength(rows);
  });

  it("a ledger that cannot be written stops the payment before signing", async () => {
    await writeFile(join(dir, "spend.lock"), JSON.stringify({ pid: 1, at: Date.now() })); // pid 1 is always alive
    const err = (await client({ maxPerDayUsd: 1 })(`${mock.base}/a`).catch((e: unknown) => e)) as SafeFetchError;
    expect(err.code).toBe("sdk");
    expect(err.message).toMatch(/spend ledger/);
    expect(mock.st.paidCount).toBe(0);
  });

  it("without any cap option, no spend.json is written", async () => {
    await client()(`${mock.base}/a`);
    await expect(readFile(join(dir, "spend.json"))).rejects.toThrow();
  });

  it("rejects a cap that is not a positive number when the client is made", () => {
    for (const bad of [0, -1, Number.NaN, "1" as unknown as number]) {
      expect(() => client({ maxPerDayUsd: bad })).toThrow(TypeError);
      expect(() => client({ maxPerSellerPerDayUsd: bad })).toThrow(TypeError);
      expect(() => client({ maxFirstPaymentUsd: bad })).toThrow(TypeError);
      expect(() => client({ approveAbove: bad })).toThrow(TypeError);
    }
    expect(() => client({ frozen: "yes" as unknown as boolean })).toThrow(TypeError);
  });
});

describe("maxPerSellerPerDayUsd: per pay-to address", () => {
  it("refuses the second payment to the same pay-to and keys the ledger by that address", async () => {
    const f = client({ maxPerSellerPerDayUsd: 0.015 });
    await f(`${mock.base}/a`);
    const err = await refused(f(`${mock.base}/other/path`));
    expect(err.code).toBe("refused_max_per_seller_per_day");
    expect(err.message).toContain(`0.010000 USDC already went to ${payTo.toLowerCase()} today (UTC)`);
    expect(err.message).toContain("over maxPerSellerPerDayUsd 0.015000 USDC");
    expect(Object.keys((await ledger()).days[today()]!.by_seller)).toEqual([payTo.toLowerCase()]);
    expect(mock.st.paidCount).toBe(1);
  });
});

describe("maxFirstPaymentUsd: a lower cap for a stranger", () => {
  it("caps the first payment to a seller the index has no listing for and this client never paid", async () => {
    const f = client({ maxFirstPaymentUsd: 0.005 }); // the index answers 503: no listing
    const err = await refused(f(`${mock.base}/a`));
    expect(err.code).toBe("refused_max_first_payment");
    expect(err.message).toContain("above maxFirstPaymentUsd 0.005000 USDC for a first payment to 127.0.0.1");
    expect(mock.st.paidCount).toBe(0);
    // Under the cap it pays, and the seller is no longer a stranger: the full per-call cap applies from then on.
    mock.st.amount = "4000";
    await f(`${mock.base}/a`);
    mock.st.amount = "10000";
    const res = await f(`${mock.base}/b`);
    expect(res.receipt.outcome).toBe("ok");
    expect(mock.st.paidCount).toBe(2);
  });

  it("a listed seller is not a stranger, whatever the verdict", async () => {
    indexAnswer("check-caution-listed", { resource: { listed_price_usdc: "0.010000" } });
    const res = await client({ maxFirstPaymentUsd: 0.005 })(`${mock.base}/a`);
    expect(res.receipt).toMatchObject({ outcome: "ok", seller: { verdict: "caution" } });
  });

  it("history in the price book counts: a seller paid before the cap was set is known", async () => {
    await client()(`${mock.base}/a`); // no ledger yet; prices.json records the origin
    const res = await client({ maxFirstPaymentUsd: 0.005 })(`${mock.base}/b`);
    expect(res.receipt.outcome).toBe("ok");
  });

  it("an unknown verdict from a reachable index is also no listing", async () => {
    indexAnswer("check-unknown");
    await expect(client({ maxFirstPaymentUsd: 0.005 })(`${mock.base}/a`)).rejects.toMatchObject({ code: "refused_max_first_payment" });
  });
});

describe("approveAbove: a person decides above the threshold", () => {
  it("refuses with needs_approval, names the intent id, and the same intent pays with { approved: true }", async () => {
    const f = client({ approveAbove: 0.005 });
    const err = await refused(f(`${mock.base}/a`, {}, { intentId: "big-1" }));
    expect(err.code).toBe("needs_approval");
    expect(err.message).toContain("above approveAbove 0.005000 USDC and needs a person's approval");
    expect(err.message).toContain('intentId "big-1" and { approved: true }');
    expect(err.receipt).toMatchObject({ outcome: "needs_approval", paid: false, quote: { amount_usdc: "0.010000", pay_to: payTo } });
    expect(mock.st.paidCount).toBe(0);
    const res = await f(`${mock.base}/a`, {}, { intentId: "big-1", approved: true });
    expect(res.receipt).toMatchObject({ outcome: "ok", paid: true, tx_hash: TX });
  });

  it("at or under the threshold pays without asking; approved: true lifts only this threshold", async () => {
    const f = client({ approveAbove: 0.01 });
    expect((await f(`${mock.base}/a`)).receipt.outcome).toBe("ok");
    mock.st.amount = "600000";
    await expect(f(`${mock.base}/b`, {}, { approved: true })).rejects.toMatchObject({ code: "refused_max_per_call" });
  });

  it("sends no row to the index", async () => {
    await expect(client({ approveAbove: 0.005 })(`${mock.base}/a`)).rejects.toMatchObject({ code: "needs_approval" });
    await settle();
    expect(mock.st.telemetry).toEqual([]);
  });

  it("is refused together with team mode, whose account holds the approval rules", () => {
    expect(() => client({ approveAbove: 1, team: { key: "pft_x" } })).toThrow(/approveAbove is not used in team mode/);
    process.env.PAIDFOR_TEAM_KEY = "pft_env";
    try {
      expect(() => client({ approveAbove: 1 })).toThrow(/approveAbove is not used in team mode/);
      expect(() => client({ approveAbove: 1, team: false })).not.toThrow();
    } finally {
      delete process.env.PAIDFOR_TEAM_KEY;
    }
  });
});

describe("frozen: the freeze switch", () => {
  it("frozen: true refuses every payment with reason frozen, before the index is waited for", async () => {
    mock.st.index = { kind: "hang" };
    const t0 = Date.now();
    const err = await refused(client({ frozen: true })(`${mock.base}/a`));
    expect(err.code).toBe("frozen");
    expect(err.message).toContain("payments are frozen (frozen: true)");
    expect(err.receipt).toMatchObject({ outcome: "frozen", paid: false, reported_outcome: null });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(mock.st.paidCount).toBe(0);
  });

  it("a file named frozen in the receipts directory freezes a running client; removing it clears the freeze", async () => {
    const f = client();
    await writeFile(join(dir, "frozen"), "");
    const err = await refused(f(`${mock.base}/a`, {}, { intentId: "f-1" }));
    expect(err.code).toBe("frozen");
    expect(err.message).toContain(join(dir, "frozen"));
    expect(err.message).toContain("Remove that file");
    await unlink(join(dir, "frozen"));
    const res = await f(`${mock.base}/a`, {}, { intentId: "f-1" });
    expect(res.receipt.outcome).toBe("ok");
  });

  it("free resources and replays are not payments and still go through", async () => {
    const f = client();
    await f(`${mock.base}/a`, {}, { intentId: "before" });
    await writeFile(join(dir, "frozen"), "");
    expect((await f(`${mock.base}/a`, {}, { intentId: "before" })).receipt.replayed).toBe(true);
    mock.st.mode = "free";
    expect((await f(`${mock.base}/free`)).receipt.outcome).toBe("no_payment_required");
    mock.st.mode = "ok";
    await expect(f(`${mock.base}/b`)).rejects.toMatchObject({ code: "frozen" });
    await settle();
    expect(mock.st.telemetry.filter((row) => (row as { outcome: string }).outcome === "frozen")).toEqual([]);
    expect(mock.st.paidCount).toBe(1);
  });
});

describe("the pay-to check against the index", () => {
  it("a pay-to the index has not seen this seller use is a warning on the receipt and in the row, and the call pays", async () => {
    listedWithPayTo([OTHER]);
    const res = await client()(`${mock.base}/a`);
    expect(res.receipt.outcome).toBe("ok");
    expect(res.receipt.warnings).toEqual([
      expect.objectContaining({ code: "unknown_pay_to", pay_to: payTo.toLowerCase(), known_pay_to: [OTHER], message: expect.stringContaining(`the quote pays ${payTo.toLowerCase()}, which is not among the address paidfor.dev has seen 127.0.0.1 settle to (${OTHER})`) }),
    ]);
    await settle();
    expect(mock.st.telemetry[0]).toMatchObject({ outcome: "ok", warnings: ["unknown_pay_to"] });
    expect(mock.st.paidCount).toBe(1);
  });

  it("refuseUnknownPayTo refuses instead, before signing, and keeps the warning on the receipt", async () => {
    listedWithPayTo([OTHER, `0x${"6".repeat(40)}`]);
    const err = await refused(client({ refuseUnknownPayTo: true })(`${mock.base}/a`));
    expect(err.code).toBe("refused_pay_to");
    expect(err.message).toContain("is not among the 2 addresses paidfor.dev has seen 127.0.0.1 settle to");
    expect(err.message).toContain("refuseUnknownPayTo is on");
    expect(err.receipt?.warnings).toEqual([expect.objectContaining({ code: "unknown_pay_to" })]);
    expect(err.receipt?.reported_outcome).toBeNull();
    expect(mock.st.paidCount).toBe(0);
    await settle();
    expect(mock.st.telemetry).toEqual([]);
  });

  it("a pay-to on record, in any case, raises nothing", async () => {
    listedWithPayTo([payTo.toUpperCase().replace("0X", "0x")]);
    const res = await client({ refuseUnknownPayTo: true })(`${mock.base}/a`);
    expect(res.receipt.outcome).toBe("ok");
    expect(res.receipt.warnings).toEqual([]);
  });

  it("a seller the index does not know, or knows without an address on record, gets neither", async () => {
    const res = await client({ refuseUnknownPayTo: true })(`${mock.base}/a`); // index 503
    expect(res.receipt).toMatchObject({ outcome: "ok", warnings: [] });
    indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.010000" } }); // no pay_to_addresses
    const listed = await client({ refuseUnknownPayTo: true })(`${mock.base}/b`);
    expect(listed.receipt).toMatchObject({ outcome: "ok", warnings: [] });
    listedWithPayTo([]);
    const empty = await client({ refuseUnknownPayTo: true })(`${mock.base}/c`);
    expect(empty.receipt).toMatchObject({ outcome: "ok", warnings: [] });
  });

  it("the pay-to warning and a format warning both stay on the receipt", async () => {
    listedWithPayTo([OTHER]);
    mock.st.mode = "markdown";
    const res = await client()(`${mock.base}/a`);
    expect(res.receipt.outcome).toBe("ok");
    expect(res.receipt.warnings?.map((w) => w.code)).toEqual(["unknown_pay_to", "content_type_mismatch"]);
  });
});

describe("the nonce derived from the intent", () => {
  it("is the documented derivation, and the same purchase from a client with no state directory signs the same nonce", async () => {
    const a = await client()(`${mock.base}/a`, {}, { intentId: "lost-state" });
    const expected = deriveNonce({ intentId: "lost-state", payer: account.address, payTo, amountAtomic: "10000" });
    expect(a.receipt.nonce).toBe(expected);
    expect(mock.st.verifyErrors).toEqual([]);
    const fresh = await mkdtemp(join(tmpdir(), "x402-safe-fetch-lost-"));
    try {
      const b = await client({}, fresh)(`${mock.base}/a`, {}, { intentId: "lost-state" });
      expect(b.receipt.replayed).toBe(false);
      expect(b.receipt.nonce).toBe(expected);
      // Both signatures reached the seller with one nonce: the USDC contract settles at most one of them.
      expect(mock.st.nonces).toEqual([expected, expected]);
    } finally {
      await rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("another intent, amount or payer gives another nonce; the intent store still stops the second signature first", async () => {
    const f = client();
    const a = await f(`${mock.base}/a`, {}, { intentId: "n-1" });
    const b = await f(`${mock.base}/a`, {}, { intentId: "n-2" });
    expect(a.receipt.nonce).not.toBe(b.receipt.nonce);
    expect((await f(`${mock.base}/a`, {}, { intentId: "n-1" })).receipt.replayed).toBe(true);
    expect(mock.st.paidCount).toBe(2);
    mock.st.amount = "20000";
    const c = await f(`${mock.base}/b`, {}, { intentId: "n-3" });
    expect(c.receipt.nonce).toBe(deriveNonce({ intentId: "n-3", payer: account.address, payTo, amountAtomic: "20000" }));
  });

  it("an approval's nonce wins over the derived one", async () => {
    const REF = `0x${"7a".repeat(32)}` as const;
    const res = await client({ authorize: async () => ({ approve: true, nonce: REF, validBefore: Math.floor(Date.now() / 1000) + 120 }) })(`${mock.base}/a`, {}, { intentId: "appr" });
    expect(res.receipt.nonce).toBe(REF);
  });
});
