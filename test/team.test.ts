import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PaymentRefusedError, TeamClient, TeamRefusedError, readDecision, safeFetch, type SafeFetchOptions, type TeamDecision } from "../src/index.js";
import { resetOnceNotices } from "../src/safe-fetch.js";
import { decodeHeaderJson } from "../src/x402/types.js";
import { NETWORK, TX, USDC_SEPOLIA, fixture, payTo, startMock, type Mock } from "./mock.js";

const KEY = "pft_test_0123456789abcdef";
const ORIGIN = "https://team.test";
const REF = `0x${"5c".repeat(32)}`;
const later = () => Math.floor(Date.now() / 1000) + 120;

type Sent = { url: string; headers: Record<string, string>; body: unknown };
type Answer = { status: number; body?: unknown; raw?: string } | "hang" | "throw";

let mock: Mock;
let dir: string;
const warnings: string[] = [];
let requests: Sent[];
let authorizeAnswer: () => Answer;
let outcomeAnswer: () => Answer;
let refusalAnswer: () => Answer;
let savedEnv: string | undefined;
let savedProject: string | undefined;

beforeAll(async () => {
  mock = await startMock();
  savedEnv = process.env.PAIDFOR_TEAM_KEY;
  savedProject = process.env.PAIDFOR_PROJECT;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.PAIDFOR_TEAM_KEY;
  else process.env.PAIDFOR_TEAM_KEY = savedEnv;
  if (savedProject === undefined) delete process.env.PAIDFOR_PROJECT;
  else process.env.PAIDFOR_PROJECT = savedProject;
  await mock.close();
});
beforeEach(async () => {
  delete process.env.PAIDFOR_TEAM_KEY;
  delete process.env.PAIDFOR_PROJECT;
  mock.reset();
  resetOnceNotices();
  warnings.length = 0;
  requests = [];
  authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later(), ledger_id: "led_1", intent_id: "x", verdict: "ok", seller: "127.0.0.1", usd: "0.01", replayed: false } });
  outcomeAnswer = () => ({ status: 200, body: { ok: true, replayed: false, row: {} } });
  refusalAnswer = () => ({ status: 404 }); // the route may not be live yet
  dir = await mkdtemp(join(tmpdir(), "x402-safe-fetch-team-"));
});
afterEach(async () => {
  await chmod(join(dir, "team-outcomes"), 0o700).catch(() => undefined);
  // Reporting is on by default: a fire-and-forget row may still be writing debug.log when a test ends.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const account = privateKeyToAccount(generatePrivateKey());

/** Every request recorded; anything under a team origin is answered by the fake team server, the rest goes to the mock seller. */
const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ url, headers, body });
  const path = new URL(url).pathname;
  if (url.startsWith(ORIGIN) || url.startsWith("https://paidfor.dev/v1/team")) {
    const a = path === "/v1/team/authorize" ? authorizeAnswer() : path === "/v1/team/outcome" ? outcomeAnswer() : path === "/v1/team/refusals" ? refusalAnswer() : { status: 404 };
    if (a === "throw") throw new TypeError("fetch failed");
    if (a === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    return new Response(a.raw ?? (a.body !== undefined ? JSON.stringify(a.body) : ""), { status: a.status, headers: { "content-type": "application/json" } });
  }
  return fetch(input, init);
};

/** `noTeam`: leave `team` out, as a caller relying on PAIDFOR_TEAM_KEY would. */
function client({ noTeam, ...o }: Partial<SafeFetchOptions> & { noTeam?: boolean } = {}) {
  return safeFetch(account, {
    maxPerCallUsd: 0.5,
    indexUrl: `${mock.base}/v1`,
    receiptsDir: dir,
    network: NETWORK,
    telemetryNotice: false,
    fetch: fakeFetch,
    logger: { warn: (m) => warnings.push(m) },
    ...(noTeam ? {} : { team: { key: KEY, origin: ORIGIN } }),
    ...o,
  });
}

const teamCalls = (path: string) => requests.filter((r) => r.url.endsWith(path));
const sellerRequests = () => requests.filter((r) => r.url.startsWith(mock.base));
const signedAuth = () =>
  sellerRequests()
    .map((r) => r.headers["payment-signature"])
    .filter((h): h is string => !!h)
    .map((h) => (decodeHeaderJson(h) as { payload: { authorization: { nonce: string; validBefore: string } } }).payload.authorization);

describe("team mode: approve", () => {
  it("asks first, signs the minted nonce and deadline, reports the outcome, and never shows the key to the seller", async () => {
    const validBefore = later();
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: validBefore, ledger_id: "led_1", some_future_field: { x: 1 } } });
    const res = await client()(`${mock.base}/data?q=1`, {}, { intentId: "buy-1" });
    expect(res.status).toBe(200);
    expect(mock.st.verifyErrors).toEqual([]);
    expect(signedAuth()).toEqual([expect.objectContaining({ nonce: REF, validBefore: String(validBefore) })]);

    const [ask] = teamCalls("/v1/team/authorize");
    expect(ask!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(ask!.body).toEqual({ wallet: account.address, intent_id: "buy-1", resource_url: `${mock.base}/data?q=1`, pay_to: payTo, amount_atomic: "10000", network: NETWORK, asset: USDC_SEPOLIA, scheme: "exact", protocol: "x402" });

    const reports = teamCalls("/v1/team/outcome");
    expect(reports.map((r) => r.body)).toEqual([
      { wallet: account.address, intent_id: "buy-1", auth_ref: REF, paid: true, settlement_ref: TX, outcome: "ok", http_status: 200, response_sha256: res.receipt.response!.sha256 },
    ]);
    expect(res.receipt.team).toMatchObject({ origin: ORIGIN, decision: "approve", auth_ref: REF, ledger_id: "led_1", warnings: [], usage: null, outcome_report: "sent" });

    for (const r of sellerRequests()) expect(JSON.stringify(r)).not.toContain(KEY);
    expect(sellerRequests().length).toBeGreaterThan(0);
    expect(warnings.join("\n")).not.toContain(KEY);
    // The receipt on disk names the decision but never the key.
    for (const f of (await readdir(dir)).filter((n) => n.endsWith(".json"))) expect(await readFile(join(dir, f), "utf8")).not.toContain(KEY);
  });

  it("passes a newer server's warnings and usage through, and ignores malformed warnings", async () => {
    const warn = { code: "budget_80", message: "80% of today's budget is used", upgrade_url: "https://paidfor.dev/team/upgrade" };
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later(), usage: { day_usd: "4.00" }, warnings: [warn, { code: 3 }, "x"] } });
    const res = await client()(`${mock.base}/x`);
    expect(res.receipt.team?.warnings).toEqual([warn]);
    expect(res.receipt.team?.usage).toEqual({ day_usd: "4.00" });
  });

  // The words and shape paidfor's server sends (lib/team/usage.ts planWarnings) for a second wallet on a Free account.
  const EXTRA_WALLET = {
    code: "extra_wallet",
    message: "This wallet is past the 1 active wallet the Free plan covers for 2026-11. Limits are not enforced yet, so nothing changes for now.",
    upgrade_url: "https://paidfor.dev/pricing",
  };
  const USAGE = { plan: "free", month: "2026-11", payments: 26, payments_included: 1000, active_wallets: 2, wallets_included: 1, enforced: false };

  it("carries the server's plan warning on the receipt of an approved payment, as the server sent it", async () => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later(), ledger_id: "led_1", usage: USAGE, warnings: [EXTRA_WALLET], telemetry: { report: "verified" } } });
    const res = await client()(`${mock.base}/x`);
    expect(res.receipt.paid).toBe(true);
    expect(res.receipt.team?.warnings).toEqual([EXTRA_WALLET]);
    expect(res.receipt.team?.usage).toEqual(USAGE);
    // And in the receipt written to disk.
    const files = (await readdir(dir)).filter((n) => n.endsWith(".json") && n !== "prices.json");
    const onDisk = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as { team?: { warnings: unknown } }));
    expect(onDisk.map((r) => r.team?.warnings)).toContainEqual([EXTRA_WALLET]);
  });

  it("reads warnings as @paidfor/mcp does: a message with no code counts, control characters become spaces", async () => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later(), warnings: [{ message: "Budget\nnearly used." }, { code: "x", message: "" }, { code: "quota_80", message: " 80% used. " }] } });
    const res = await client()(`${mock.base}/x`);
    expect(res.receipt.team?.warnings).toEqual([
      { code: "warning", message: "Budget nearly used." },
      { code: "quota_80", message: "80% used." },
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a decline", { decision: "decline", reason: "seller_caution_not_allowed", message: "This seller is rated caution." }],
    ["a payment waiting for a person", { decision: "needs_approval", approve_url: "https://paidfor.dev/team/approve/ab12", expires_at: "2026-11-10T12:30:00Z", message: "Over $0.50." }],
  ])("carries the server's warnings on the receipt of %s, which pays nothing", async (_n, body) => {
    authorizeAnswer = () => ({ status: 200, body: { ...body, usage: USAGE, warnings: [EXTRA_WALLET] } });
    const err = (await client()(`${mock.base}/x`).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(err.decision.warnings).toEqual([EXTRA_WALLET]);
    expect(err.receipt?.team?.warnings).toEqual([EXTRA_WALLET]);
    expect(mock.st.paidCount).toBe(0);
  });

  it("reports a paid call the seller failed (paid, with the outcome the receipt names)", async () => {
    mock.st.mode = "conway_500";
    const res = await client()(`${mock.base}/x`);
    expect(res.status).toBe(500);
    const [rep] = teamCalls("/v1/team/outcome");
    expect(rep!.body).toMatchObject({ paid: true, settlement_ref: TX, http_status: 500, outcome: res.receipt.reported_outcome });
    expect(["non_delivery", "ok", "wrong_goods"]).toContain((rep!.body as { outcome: string }).outcome);
  });

  it("an approval that cannot be used signs nothing and is reported as not paid", async () => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: "0x1234", valid_before: later() } });
    const err = await client()(`${mock.base}/x`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect((err as TeamRefusedError).decision.kind).toBe("approve");
    expect(mock.st.paidCount).toBe(0);
    expect(teamCalls("/v1/team/outcome").map((r) => r.body)).toEqual([{ wallet: account.address, intent_id: (err as TeamRefusedError).receipt!.intent_id, auth_ref: "0x1234", paid: false }]);
  });

  it("a local replay asks the team nothing and reports nothing", async () => {
    const c = client();
    await c(`${mock.base}/y`, {}, { intentId: "r-1" });
    requests = [];
    const again = await c(`${mock.base}/y`, {}, { intentId: "r-1" });
    expect(again.receipt.replayed).toBe(true);
    expect(requests).toEqual([]);
    expect(mock.st.paidCount).toBe(1);
  });
});

describe("team mode: anything but a clean approve pays nothing", () => {
  it.each<[string, () => Answer, TeamDecision["kind"], RegExp]>([
    ["a decline", () => ({ status: 200, body: { decision: "decline", reason: "wallet_daily_budget", message: "Today's budget of $5 is used." } }), "decline", /wallet_daily_budget.*Today's budget/],
    ["an already-settled intent", () => ({ status: 200, body: { decision: "already_settled", settlement_ref: TX, outcome: "ok" } }), "already_settled", /already paid.*nothing was paid again/],
    ["a bad key (401)", () => ({ status: 401, body: { error: "bad key" } }), "failed", /refused the team key/],
    ["an unregistered wallet (404)", () => ({ status: 404, body: { error: "unknown wallet" } }), "failed", /not registered.*team\.test\/team.*npx -y @paidfor\/mcp@latest init --wallet --link/],
    ["a 500", () => ({ status: 500, body: { error: "boom" } }), "failed", /HTTP 500/],
    ["a 503", () => ({ status: 503 }), "failed", /HTTP 503/],
    ["a 200 that is not JSON", () => ({ status: 200, raw: "<html>ok</html>" }), "failed", /could not be read/],
    ["an unknown decision", () => ({ status: 200, body: { decision: "maybe" } }), "failed", /could not be read/],
    ["an approve with no auth_ref", () => ({ status: 200, body: { decision: "approve", valid_before: later() } }), "failed", /could not be read/],
    ["a decline with no reason", () => ({ status: 200, body: { decision: "decline", message: "no" } }), "failed", /could not be read/],
    ["no answer in time", () => "hang", "failed", /could not be reached/],
    ["a network error", () => "throw", "failed", /could not be reached/],
  ])("%s", async (_n, answer, kind, message) => {
    authorizeAnswer = answer;
    const err = await client({ team: { key: KEY, origin: ORIGIN, authorizeTimeoutMs: 100 }, telemetry: "verified" })(`${mock.base}/x`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(err).toBeInstanceOf(PaymentRefusedError);
    const e = err as TeamRefusedError;
    expect(e.code).toBe("refused_authorize");
    expect(e.decision.kind).toBe(kind);
    expect(e.message).toMatch(message);
    expect(e.receipt?.paid).toBe(false);
    expect(e.receipt?.team?.decision).toBe(kind);
    expect(e.receipt?.team?.outcome_report).toBeNull();
    expect(mock.st.paidCount).toBe(0);
    expect(signedAuth()).toEqual([]);
    expect(teamCalls("/v1/team/outcome")).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.st.telemetry).toEqual([]);
  });

  it("needs_approval surfaces the link and the expiry, and the same intent pays once a person approves", async () => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "needs_approval", approve_url: "https://paidfor.dev/team/approve/ab12", expires_at: "2026-11-10T12:30:00Z", message: "Over $0.50." } });
    const c = client();
    const err = (await c(`${mock.base}/x`, {}, { intentId: "wait-1" }).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(err.decision).toMatchObject({ kind: "needs_approval", approve_url: "https://paidfor.dev/team/approve/ab12", expires_at: "2026-11-10T12:30:00Z" });
    expect(err.message).toMatch(/https:\/\/paidfor\.dev\/team\/approve\/ab12.*2026-11-10T12:30:00Z.*intentId "wait-1"/);
    expect(err.receipt?.team).toMatchObject({ decision: "needs_approval", approve_url: "https://paidfor.dev/team/approve/ab12", expires_at: "2026-11-10T12:30:00Z" });
    expect(mock.st.paidCount).toBe(0);

    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later() } });
    const res = await c(`${mock.base}/x`, {}, { intentId: "wait-1" });
    expect(res.receipt.paid).toBe(true);
    expect(res.receipt.nonce).toBe(REF);
  });

  it.each([1e300, -5, 0, 1.5, Number.NaN, Infinity, "1800000000", 253_402_300_800])("a decline with retry_after %s keeps its reason and drops the field", async (v) => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "decline", reason: "released_not_expired", message: "Wait for the approval to lapse.", retry_after: v } });
    expect(readDecision({ decision: "decline", reason: "r", retry_after: v })).not.toHaveProperty("retry_after");
    const err = (await client()(`${mock.base}/x`).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(err.decision).toMatchObject({ kind: "decline", reason: "released_not_expired" });
    expect(err.decision).not.toHaveProperty("retry_after");
    expect(err.message).toMatch(/released_not_expired.*Wait for the approval/);
    expect(err.message).not.toMatch(/could not get an approval|Invalid time/);
  });

  it("a decline with a sane retry_after keeps it and names the time", async () => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "decline", reason: "released_not_expired", message: "Wait.", retry_after: 1_800_000_000 } });
    const err = (await client()(`${mock.base}/x`).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err.decision).toMatchObject({ kind: "decline", retry_after: 1_800_000_000 });
    expect(err.message).toMatch(/Ask again after 2027-01-15T08:00:00\.000Z/);
  });

  it("readDecision ignores unknown fields and refuses anything off-contract", () => {
    expect(readDecision({ decision: "approve", auth_ref: REF, valid_before: 1, extra: true })).toEqual({ kind: "approve", auth_ref: REF, valid_before: 1, warnings: [] });
    expect(readDecision(null).kind).toBe("failed");
    expect(readDecision({ decision: "approve", auth_ref: REF, valid_before: "1" }).kind).toBe("failed");
    expect(readDecision({ decision: "needs_approval", approve_url: "u" }).kind).toBe("failed");
  });
});

describe("team mode: outcome queue", () => {
  it("keeps a report the server could not take on disk and sends it before the next payment", async () => {
    outcomeAnswer = () => ({ status: 503 });
    const c = client();
    const first = await c(`${mock.base}/a`, {}, { intentId: "q-1" });
    expect(first.receipt.team?.outcome_report).toBe("queued");
    expect(teamCalls("/v1/team/outcome")).toHaveLength(2); // the first try and one retry
    const queued = await readdir(join(dir, "team-outcomes"));
    expect(queued).toHaveLength(1);
    const entry = JSON.parse(await readFile(join(dir, "team-outcomes", queued[0]!), "utf8"));
    expect(entry).toMatchObject({ v: 1, origin: ORIGIN, body: { intent_id: "q-1", auth_ref: REF, paid: true } });
    expect(JSON.stringify(entry)).not.toContain(KEY);

    // A new client (as after a restart) drains it first.
    outcomeAnswer = () => ({ status: 200, body: { ok: true } });
    requests = [];
    await client()(`${mock.base}/b`, {}, { intentId: "q-2" });
    const order = requests.filter((r) => r.url.startsWith(ORIGIN)).map((r) => `${new URL(r.url).pathname} ${(r.body as { intent_id: string }).intent_id}`);
    expect(order).toEqual(["/v1/team/outcome q-1", "/v1/team/authorize q-2", "/v1/team/outcome q-2"]);
    expect(await readdir(join(dir, "team-outcomes"))).toEqual([]);
  });

  it("a report the server refuses for good is not kept", async () => {
    outcomeAnswer = () => ({ status: 409, body: { error: "auth_ref mismatch" } });
    const res = await client()(`${mock.base}/a`);
    expect(res.receipt.team?.outcome_report).toBe("rejected");
    expect(teamCalls("/v1/team/outcome")).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/refused with HTTP 409/);
  });

  it("leaves another key's queued reports and bare @paidfor/mcp-style entries alone", async () => {
    const q = join(dir, "team-outcomes");
    await mkdir(q, { recursive: true });
    await writeFile(join(q, "other.json"), JSON.stringify({ v: 1, origin: ORIGIN, key_hash: "0000000000000000", body: { wallet: account.address, intent_id: "other", auth_ref: REF, paid: false } }));
    await writeFile(join(q, "bare.json"), JSON.stringify({ wallet: account.address, intent_id: "bare", auth_ref: REF, paid: false }));
    outcomeAnswer = () => ({ status: 404, body: { error: "unknown intent" } }); // what another team's report would get
    mock.st.mode = "free";
    await client()(`${mock.base}/free`);
    expect(teamCalls("/v1/team/outcome")).toEqual([]);
    expect((await readdir(q)).sort()).toEqual(["bare.json", "other.json"]);
  });

  it("two keys queueing the same intent and auth_ref in one directory keep separate files", async () => {
    outcomeAnswer = () => ({ status: 503 });
    const q = join(dir, "team-outcomes");
    const body = { wallet: account.address, intent_id: "same", auth_ref: REF, paid: false };
    const a = new TeamClient({ origin: ORIGIN, key: KEY, queueDir: q, fetch: fakeFetch, retryDelayMs: 1 });
    const b = new TeamClient({ origin: ORIGIN, key: "pft_other_key", queueDir: q, fetch: fakeFetch, retryDelayMs: 1 });
    expect(await a.report(body)).toBe("queued");
    expect(await b.report({ ...body, paid: true, settlement_ref: TX, outcome: "ok" })).toBe("queued");
    expect(await readdir(q)).toHaveLength(2);
    expect(await a.pending()).toEqual([body]);
    expect(await b.pending()).toEqual([expect.objectContaining({ paid: true })]);
  });

  it("still reads an entry stored under the older file name, for its own key only", async () => {
    const q = join(dir, "team-outcomes");
    const a = new TeamClient({ origin: ORIGIN, key: KEY, queueDir: q, fetch: fakeFetch });
    outcomeAnswer = () => ({ status: 503 });
    const body = { wallet: account.address, intent_id: "old", auth_ref: REF, paid: false };
    await new TeamClient({ origin: ORIGIN, key: KEY, queueDir: q, fetch: fakeFetch, retryDelayMs: 1 }).report(body);
    const [name] = await readdir(q);
    const legacy = `${createHash("sha256").update(`old\n${REF}`).digest("hex").slice(0, 40)}.json`;
    await rename(join(q, name!), join(q, legacy));
    expect(await new TeamClient({ origin: ORIGIN, key: "pft_other_key", queueDir: q, fetch: fakeFetch }).pending()).toEqual([]);
    expect(await a.pending()).toEqual([body]);
    outcomeAnswer = () => ({ status: 200, body: { ok: true } });
    await a.flush();
    expect(await readdir(q)).toEqual([]);
  });

  it("drains bare entries only with adoptBareEntries", async () => {
    const q = join(dir, "team-outcomes");
    await mkdir(q, { recursive: true });
    await writeFile(join(q, "bare.json"), JSON.stringify({ wallet: account.address, intent_id: "bare", auth_ref: REF, paid: false }));
    const off = new TeamClient({ origin: ORIGIN, key: KEY, queueDir: q, fetch: fakeFetch });
    expect(await off.pending()).toEqual([]);
    await off.flush();
    expect(teamCalls("/v1/team/outcome")).toEqual([]);
    const on = new TeamClient({ origin: ORIGIN, key: KEY, queueDir: q, fetch: fakeFetch, adoptBareEntries: true });
    expect(await on.pending()).toHaveLength(1);
    await on.flush();
    expect(teamCalls("/v1/team/outcome").map((r) => (r.body as { intent_id: string }).intent_id)).toEqual(["bare"]);
    expect(await readdir(q)).toEqual([]);
  });

  it("keeps the report in memory when the disk cannot take it, and sends it before the next payment", async () => {
    await writeFile(join(dir, "team-outcomes"), "not a directory");
    outcomeAnswer = () => ({ status: 502 });
    const c = client();
    const first = await c(`${mock.base}/a`, {}, { intentId: "m-1" });
    expect(first.receipt.team?.outcome_report).toBe("queued");
    expect(warnings.join("\n")).toMatch(/kept in memory/);
    outcomeAnswer = () => ({ status: 200, body: { ok: true } });
    requests = [];
    await c(`${mock.base}/b`, {}, { intentId: "m-2" });
    expect(teamCalls("/v1/team/outcome").map((r) => (r.body as { intent_id: string }).intent_id)).toEqual(["m-1", "m-2"]);
  });
});

describe("team mode: configuration", () => {
  it("picks up PAIDFOR_TEAM_KEY when team is omitted, against https://paidfor.dev", async () => {
    process.env.PAIDFOR_TEAM_KEY = ` ${KEY}\n`;
    const res = await client({ noTeam: true })(`${mock.base}/x`);
    expect(res.receipt.team?.origin).toBe("https://paidfor.dev");
    const [ask] = teamCalls("/v1/team/authorize");
    expect(ask!.url).toBe("https://paidfor.dev/v1/team/authorize");
    expect(ask!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("team: false, or a caller's own authorize, ignores PAIDFOR_TEAM_KEY", async () => {
    process.env.PAIDFOR_TEAM_KEY = KEY;
    const off = await client({ team: false })(`${mock.base}/x`);
    expect(off.receipt.paid).toBe(true);
    expect(off.receipt.team).toBeUndefined();
    const own = await client({ noTeam: true, authorize: async () => ({ approve: true, nonce: REF as `0x${string}`, validBefore: later() }) })(`${mock.base}/y`);
    expect(own.receipt.nonce).toBe(REF);
    expect(requests.filter((r) => r.url.includes("/v1/team/"))).toEqual([]);
  });

  it("refuses team together with authorize, a plain-http origin off this machine, and an empty key", () => {
    expect(() => client({ authorize: async () => ({ approve: false, message: "no" }) })).toThrow(/team or authorize, not both/);
    expect(() => client({ team: { key: KEY, origin: "http://paidfor.dev" } })).toThrow(/must be https/);
    expect(() => client({ team: { key: "  " } })).toThrow(TypeError);
    expect(() => client({ team: { key: KEY, origin: "http://localhost:3000" } })).not.toThrow();
  });
});

describe("team mode: a payment the seller rejects", () => {
  it("is reported as not paid, so the approval is released, and the receipt says not paid", async () => {
    mock.st.mode = "reject_402";
    const res = await client()(`${mock.base}/x`, {}, { intentId: "empty" });
    expect(res.receipt).toMatchObject({ outcome: "payment_rejected", paid: false, nonce: REF });
    expect(teamCalls("/v1/team/outcome").map((r) => r.body)).toEqual([{ wallet: account.address, intent_id: "empty", auth_ref: REF, paid: false }]);
    expect(res.receipt.team?.outcome_report).toBe("sent");
  });

  it("a retry the server declines while the old approval can be used pays nothing; after it lapses the same intent pays", async () => {
    mock.st.mode = "reject_402";
    const c = client();
    await c(`${mock.base}/x`, {}, { intentId: "retry" });
    mock.st.mode = "ok";
    authorizeAnswer = () => ({ status: 200, body: { decision: "decline", reason: "released_not_expired", message: "Wait.", retry_after: later() } });
    const err = (await c(`${mock.base}/x`, {}, { intentId: "retry" }).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(mock.st.paidCount).toBe(1);
    // An approval with the same nonce (as a server handing back the standing one would) pays.
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later() } });
    const paid = await c(`${mock.base}/x`, {}, { intentId: "retry" });
    expect(paid.receipt).toMatchObject({ outcome: "ok", paid: true, nonce: REF });
    expect(teamCalls("/v1/team/outcome").map((r) => (r.body as { paid: boolean }).paid)).toEqual([false, true]);
  });

  it("an approval with a new nonce while the rejected one can still settle signs nothing and is released", async () => {
    mock.st.mode = "reject_402";
    const c = client();
    await c(`${mock.base}/x`, {}, { intentId: "two" });
    mock.st.mode = "ok";
    const other = `0x${"6d".repeat(32)}`;
    authorizeAnswer = () => ({ status: 200, body: { decision: "approve", auth_ref: other, valid_before: later() } });
    const err = (await c(`${mock.base}/x`, {}, { intentId: "two" }).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(err.message).toMatch(/can still be settled until/);
    expect(mock.st.nonces).toEqual([REF]);
    expect(teamCalls("/v1/team/outcome").map((r) => r.body)).toEqual([
      { wallet: account.address, intent_id: "two", auth_ref: REF, paid: false },
      { wallet: account.address, intent_id: "two", auth_ref: other, paid: false },
    ]);
  });
});

describe('team mode: the "caution" line (paidfor-index e2e issue 45)', () => {
  const caution = () => {
    mock.st.index = { kind: "json", body: { ...(fixture("check-caution-listed") as Record<string, unknown>), host: "127.0.0.1", seller_url: "https://paidfor.dev/seller/127.0.0.1", resource: { listed_price_usdc: "0.010000" } } };
  };
  const cautionLines = () => warnings.filter((w) => w.includes('rates "caution"'));

  it("says nothing about paying a caution seller the account declines", async () => {
    caution();
    authorizeAnswer = () => ({ status: 200, body: { decision: "decline", reason: "seller_caution_not_allowed", message: "This seller is rated caution and is not on this wallet's trusted list." } });
    const err = (await client()(`${mock.base}/data`).catch((e: unknown) => e)) as TeamRefusedError;
    expect(err).toBeInstanceOf(TeamRefusedError);
    expect(err.receipt?.seller.verdict).toBe("caution");
    expect(mock.st.paidCount).toBe(0);
    expect(cautionLines()).toEqual([]);
  });

  it("says nothing while a person has still to approve it", async () => {
    caution();
    authorizeAnswer = () => ({ status: 200, body: { decision: "needs_approval", approve_url: "https://paidfor.dev/team/approve/ab12", expires_at: "2026-11-10T12:30:00Z", message: "" } });
    await expect(client()(`${mock.base}/data`)).rejects.toBeInstanceOf(TeamRefusedError);
    expect(cautionLines()).toEqual([]);
  });

  it("says it once when the account approves and the payment goes ahead", async () => {
    caution();
    const res = await client()(`${mock.base}/data`);
    expect(res.receipt.paid).toBe(true);
    expect(cautionLines()).toHaveLength(1);
    expect(cautionLines()[0]).toMatch(/^x402-safe-fetch: paying 127\.0\.0\.1, which paidfor\.dev rates "caution"/);
  });
});

describe("team mode: refusals made before asking the team", () => {
  const settle = () => new Promise((r) => setTimeout(r, 50));
  /** Index answer for the mock seller host. */
  const indexAnswer = (name: string, patch: Record<string, unknown> = {}) => {
    mock.st.index = { kind: "json", body: { ...(fixture(name) as Record<string, unknown>), host: "127.0.0.1", seller_url: "https://paidfor.dev/seller/127.0.0.1", ...patch } };
  };

  it.each<[string, () => Partial<SafeFetchOptions>, string, string]>([
    ["an avoid seller", () => (indexAnswer("check-avoid"), {}), "refused_verdict", "avoid"],
    ["a quote over the listed price", () => (indexAnswer("check-caution-listed", { verdict: "ok", resource: { listed_price_usdc: "0.005000" } }), {}), "refused_ratio", "ok"],
    ["a quote over maxPerCallUsd", () => ({ maxPerCallUsd: 0.001 }), "refused_max_per_call", "unknown"],
  ])("%s is told to the team, and the thrown error is unchanged", async (_n, setup, reason, verdict) => {
    const err = (await client({ ...setup(), team: { key: KEY, origin: ORIGIN, project: "research-q4" } })(`${mock.base}/data?q=1`, {}, { intentId: "ref-1" }).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(err).toBeInstanceOf(PaymentRefusedError);
    expect(err).not.toBeInstanceOf(TeamRefusedError);
    expect(err.code).toBe(reason);
    expect(teamCalls("/v1/team/authorize")).toEqual([]);
    expect(teamCalls("/v1/team/outcome")).toEqual([]);
    await settle();
    const sent = teamCalls("/v1/team/refusals");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ORIGIN}/v1/team/refusals`);
    expect(sent[0]!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(sent[0]!.body).toEqual({
      wallet: account.address,
      intent_id: "ref-1",
      resource_url: `${mock.base}/data?q=1`,
      pay_to: payTo,
      amount_atomic: "10000",
      network: NETWORK,
      asset: USDC_SEPOLIA,
      scheme: "exact",
      protocol: "x402",
      reason,
      verdict,
      project: "research-q4",
    });
    expect(mock.st.paidCount).toBe(0);
    expect(warnings.join("\n")).not.toContain(KEY);
  });

  it.each<[string, () => Answer]>([
    ["a 404 (route not live yet)", () => ({ status: 404 })],
    ["a 500", () => ({ status: 500, body: { error: "boom" } })],
    ["a network error", () => "throw"],
    ["no answer at all", () => "hang"],
  ])("%s is swallowed: never awaited, never logged, never changes the error", async (_n, answer) => {
    refusalAnswer = answer;
    indexAnswer("check-avoid");
    const t0 = Date.now();
    const err = (await client()(`${mock.base}/x`).catch((e: unknown) => e)) as PaymentRefusedError;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(err.code).toBe("refused_verdict");
    expect(err.message).toMatch(/rates this seller "avoid"/);
    await settle();
    expect(teamCalls("/v1/team/refusals")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("a refusal notice that never answers is abandoned after 2 s", async () => {
    let aborted: number | undefined;
    const t0 = Date.now();
    const f: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/team/refusals")) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => ((aborted = Date.now() - t0), reject(init.signal!.reason))));
      }
      return fakeFetch(input, init);
    };
    await expect(client({ fetch: f, maxPerCallUsd: 0.001 })(`${mock.base}/x`)).rejects.toBeInstanceOf(PaymentRefusedError);
    await new Promise((r) => setTimeout(r, 2300));
    expect(aborted).toBeGreaterThanOrEqual(1900);
    expect(aborted).toBeLessThan(2300);
  });

  it("a refusal by the team itself, or without team mode, sends no refusal notice", async () => {
    authorizeAnswer = () => ({ status: 200, body: { decision: "decline", reason: "wallet_daily_budget", message: "no" } });
    await expect(client()(`${mock.base}/x`)).rejects.toBeInstanceOf(TeamRefusedError);
    indexAnswer("check-avoid");
    await expect(client({ team: false })(`${mock.base}/x`)).rejects.toBeInstanceOf(PaymentRefusedError);
    await settle();
    expect(teamCalls("/v1/team/refusals")).toEqual([]);
  });
});

describe("team mode: project", () => {
  it("sends team.project, trimmed, on every authorize", async () => {
    await client({ team: { key: KEY, origin: ORIGIN, project: "  research-q4 " } })(`${mock.base}/x`);
    expect(teamCalls("/v1/team/authorize")[0]!.body).toMatchObject({ project: "research-q4" });
  });

  it("sends no project field when none is set", async () => {
    await client()(`${mock.base}/x`);
    expect(teamCalls("/v1/team/authorize")[0]!.body).not.toHaveProperty("project");
  });

  it("reads PAIDFOR_PROJECT only when team mode comes from the environment", async () => {
    process.env.PAIDFOR_TEAM_KEY = KEY;
    process.env.PAIDFOR_PROJECT = "Data team.v2_x";
    await client({ noTeam: true })(`${mock.base}/x`);
    expect(teamCalls("/v1/team/authorize")[0]!.body).toMatchObject({ project: "Data team.v2_x" });
    requests = [];
    await client()(`${mock.base}/y`);
    expect(teamCalls("/v1/team/authorize")[0]!.body).not.toHaveProperty("project");
    requests = [];
    process.env.PAIDFOR_PROJECT = "   ";
    await client({ noTeam: true })(`${mock.base}/z`);
    expect(teamCalls("/v1/team/authorize")[0]!.body).not.toHaveProperty("project");
  });

  it.each(["", "a/b", "x".repeat(65), "tab\there", "émoji", 7 as unknown as string])("refuses the tag %j when the client is made", (bad) => {
    expect(() => client({ team: { key: KEY, origin: ORIGIN, project: bad } })).toThrow(/team\.project .* is not a project tag: a project tag is 1 to 64 letters/);
  });

  it("refuses a bad PAIDFOR_PROJECT when the client is made", () => {
    process.env.PAIDFOR_TEAM_KEY = KEY;
    process.env.PAIDFOR_PROJECT = "q4/research";
    expect(() => client({ noTeam: true })).toThrow(/PAIDFOR_PROJECT "q4\/research" is not a project tag/);
    expect(() => client({ noTeam: true, team: false })).not.toThrow();
  });

  it("accepts the longest tag the server takes", () => {
    expect(() => client({ team: { key: KEY, origin: ORIGIN, project: "x".repeat(64) } })).not.toThrow();
  });
});

describe("team mode: reporting to the index follows the account (issue 41)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const approve = (telemetry?: unknown) => () => ({ status: 200, body: { decision: "approve", auth_ref: REF, valid_before: later(), ...(telemetry !== undefined ? { telemetry } : {}) } });
  const PAID_OFF = { report: "off", opt_out_allowed: true, opted_out: true };
  const FREE = { report: "verified", opt_out_allowed: false, opted_out: false };
  const indexAnswer = (name: string) => {
    mock.st.index = { kind: "json", body: { ...(fixture(name) as Record<string, unknown>), host: "127.0.0.1", seller_url: "https://paidfor.dev/seller/127.0.0.1" } };
  };

  it("reads the account's answer strictly; anything but report: off means report", () => {
    const base = { decision: "approve", auth_ref: REF, valid_before: 1 };
    expect(readDecision({ ...base, telemetry: PAID_OFF }).telemetry).toBe("off");
    expect(readDecision({ ...base, telemetry: FREE }).telemetry).toBe("verified");
    for (const t of [undefined, null, "off", { report: "OFF" }, { report: false }, []]) expect(readDecision({ ...base, telemetry: t }).telemetry).toBeUndefined();
  });

  it("a paid team that turned reporting off sends no row, and says nothing about it", async () => {
    authorizeAnswer = approve(PAID_OFF);
    const res = await client()(`${mock.base}/data`);
    expect(res.status).toBe(200);
    expect(res.receipt.proof).not.toBeNull();
    expect(res.receipt.verification_url).toBeNull();
    await settle();
    expect(mock.st.telemetry).toEqual([]);
    // The team's own ledger still hears about it.
    expect(teamCalls("/v1/team/outcome")).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("not honoured"))).toEqual([]);
  });

  it("the account decides even when the code asks for verified", async () => {
    authorizeAnswer = approve(PAID_OFF);
    await client({ telemetry: "verified" })(`${mock.base}/data`);
    await settle();
    expect(mock.st.telemetry).toEqual([]);
  });

  it('a free team cannot opt out: telemetry: "off" still reports verified rows, and says so once', async () => {
    authorizeAnswer = approve(FREE);
    const f = client({ telemetry: "off" });
    await f(`${mock.base}/data`);
    await f(`${mock.base}/data`);
    await settle();
    expect(mock.st.telemetry).toHaveLength(2);
    for (const row of mock.st.telemetry) expect(row).toMatchObject({ v: 2, proof: { payer: account.address.toLowerCase() } });
    expect(warnings.filter((w) => w.includes('telemetry: "off" is not honoured'))).toHaveLength(1);
  });

  it("an older server that sends no telemetry field: report (fail towards reporting)", async () => {
    authorizeAnswer = approve();
    const res = await client({ telemetry: "off" })(`${mock.base}/data`);
    expect(res.receipt.verification_url).toMatch(/\/telemetry\//);
    await settle();
    expect(mock.st.telemetry).toHaveLength(1);
  });

  it("a refusal before the team is asked follows the last answer, and reports when there was none", async () => {
    indexAnswer("check-avoid");
    const f = client();
    await f(`${mock.base}/data`).catch(() => undefined);
    await settle();
    expect(mock.st.telemetry).toEqual([expect.objectContaining({ outcome: "refused_verdict" })]);
    mock.reset();
    authorizeAnswer = approve(PAID_OFF);
    await f(`${mock.base}/data`); // the team answers off
    indexAnswer("check-avoid");
    await f(`${mock.base}/data`).catch(() => undefined);
    await settle();
    expect(mock.st.telemetry).toEqual([]);
  });

  it("an answer that stops saying off (a downgrade) turns reporting back on from that payment", async () => {
    const f = client();
    authorizeAnswer = approve(PAID_OFF);
    await f(`${mock.base}/data`);
    authorizeAnswer = approve({ report: "verified", opt_out_allowed: false, opted_out: true });
    await f(`${mock.base}/data`);
    await settle();
    expect(mock.st.telemetry).toHaveLength(1);
  });

  it("payments in flight at the same time each follow their own answer (one's answer never decides another's row)", async () => {
    let n = 0;
    authorizeAnswer = () => (++n === 1 ? approve(PAID_OFF)() : "throw");
    // A's paid request waits on the seller while B asks the team and gets no answer.
    const slow: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).get("payment-signature")) await new Promise((r) => setTimeout(r, 300));
      return fakeFetch(input, init);
    };
    const f = client({ fetch: slow });
    const a = f(`${mock.base}/data`, {}, { intentId: "overlap-a" });
    await new Promise((r) => setTimeout(r, 100));
    const b = f(`${mock.base}/data`, {}, { intentId: "overlap-b" }).catch((e: unknown) => e);
    expect(await b).toBeInstanceOf(TeamRefusedError);
    const res = await a;
    expect(res.status).toBe(200);
    expect(res.receipt.verification_url).toBeNull();
    await settle();
    expect(mock.st.telemetry).toEqual([]);
  });

  it("a format warning (issue 40) is reported as ok with its code when reporting is on, and dropped when the account says off", async () => {
    mock.st.mode = "markdown";
    authorizeAnswer = approve(FREE);
    const on = await client()(`${mock.base}/v1/article`, {}, { intentId: "fmt-on" });
    expect(on.receipt).toMatchObject({ outcome: "ok", reported_outcome: "ok" });
    expect(on.receipt.warnings?.map((w) => w.code)).toEqual(["content_type_mismatch"]);
    await settle();
    expect(mock.st.telemetry).toEqual([expect.objectContaining({ v: 2, outcome: "ok", warnings: ["content_type_mismatch"], proof: expect.any(Object) })]);
    mock.st.telemetry.length = 0;
    authorizeAnswer = approve(PAID_OFF);
    const off = await client()(`${mock.base}/v1/article`, {}, { intentId: "fmt-off" });
    expect(off.receipt.warnings?.map((w) => w.code)).toEqual(["content_type_mismatch"]);
    expect(off.receipt.verification_url).toBeNull();
    await settle();
    expect(mock.st.telemetry).toEqual([]);
  });

  it("the server cannot be asked: nothing is paid, and the next refusal reports", async () => {
    const f = client();
    authorizeAnswer = approve(PAID_OFF);
    await f(`${mock.base}/data`);
    authorizeAnswer = () => "throw";
    await expect(f(`${mock.base}/data`)).rejects.toBeInstanceOf(TeamRefusedError);
    indexAnswer("check-avoid");
    await f(`${mock.base}/data`).catch(() => undefined);
    await settle();
    expect(mock.st.telemetry).toEqual([expect.objectContaining({ outcome: "refused_verdict" })]);
  });
});
