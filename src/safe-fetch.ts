/**
 * safeFetch: @x402/fetch with buyer protection before and after paying.
 *
 * The payment plumbing is x402-audit src/x402/pay.ts: a fresh x402Client per call, checks in
 * onBeforePaymentCreation (runs before the scheme signs; `{ abort: true }` throws before any signature),
 * hard assertions plus a durable ledger write in onAfterPaymentCreation (runs after signing, before the paid
 * request is sent), and an inner fetch that sends at most one paid request and never follows a redirect
 * with a payment header attached. No onPaymentResponse / onPaymentCreationFailure hooks are registered,
 * so wrapFetchWithPayment never re-signs.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { x402Client, type PaymentPolicy } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { readBodyTee } from "./body.js";
import { IntentConflictError, IntentIndeterminateError, PaymentRefusedError, SafeFetchError, TeamRefusedError, type SafeFetchErrorCode } from "./errors.js";
import { UNKNOWN_SELLER_NOTE, checkIndex, type IndexCheck, type Verdict } from "./index-client.js";
import { IntentStore, type IntentLease, type StoredResponse } from "./intents.js";
import { PriceBook, USDC_BY_NETWORK, atomicToUsdc, exceedsRatio, quoteRatio, resourceKey, usdToAtomic, usdcStringToAtomic, type ReferenceSource } from "./price.js";
import { DEFAULT_MAX_RATIO, REFUSED_OUTCOMES, buildProof, failureLabels, harnessOutcome } from "./proof.js";
import { writeReceipt, type Outcome, type Receipt } from "./receipt.js";
import { PROJECT_RULE, TEAM_ORIGIN, TeamClient, cleanProject, outcomeFor, type TeamDecision, type TeamOptions, type TeamReceipt, type TeamRefusalReason } from "./team.js";
import { ALL_VALIDATORS, MAX_BODY_BYTES, type ValidatorName } from "./taxonomy.js";
import { CLIENT_ID, buildPayload, buildPayloadV2, sendTelemetry } from "./telemetry.js";
import { runAllValidators, validatorsByName } from "./validators/index.js";
import type { RequestRecord } from "./validators/types.js";
import { buildResponseRecord, headersToRecord } from "./x402/http.js";
import { quoteFromResponse, type QuoteResult } from "./x402/quote.js";
import { decodeSettlementHeader } from "./x402/settlement.js";
import {
  HEADERS,
  PaymentRequirementsSchema,
  PaymentRequirementsV1Schema,
  ResourceInfoSchema,
  caip2Network,
  errMsg,
  normalizeV1,
  normalizeV2,
  type NormalizedRequirements,
} from "./x402/types.js";

export type SafeNetwork = "eip155:8453" | "eip155:84532";

export interface SafeFetchOptions {
  /** Hard cap per call, in USD (USDC). Required. */
  maxPerCallUsd: number;
  /** Refuse quotes above reference * ratio. Default 1.1. */
  maxOverListedRatio?: number;
  /** Seller verdicts that block payment. Default ["avoid"]. "caution" is logged when not listed here. */
  refuseVerdicts?: Exclude<Verdict, "unknown">[];
  /** paidfor index base URL. Default "https://paidfor.dev/v1". `false` skips the index entirely. */
  indexUrl?: string | false;
  /** Validators to run on paid responses. Default: all four. */
  validators?: ValidatorName[];
  /**
   * Default "off". "anonymous" posts the outcome-only v1 payload in docs/telemetry.md. "verified" posts the v2
   * payload: the same fields plus a proof of payment (payer, nonce, pay-to, tx hash) the index checks on Base.
   */
  telemetry?: "anonymous" | "verified" | "off";
  /** Receipts, intents, price book and debug log. Default "./.x402-receipts" (resolved once, at creation). */
  receiptsDir?: string;
  /** Default Base mainnet. Only USDC on this network is paid. */
  network?: SafeNetwork;
  /** Underlying fetch (seller, index and telemetry). Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Index lookup timeout. Default 2000 ms. */
  indexTimeoutMs?: number;
  /** Where "caution" verdicts and non-fatal local write failures are reported. Default console. */
  logger?: { warn(msg: string): void };
  /**
   * The one-time notice that says what `telemetry: "verified"` sends. Default true: it goes to `logger.warn` (stderr
   * with the default console). `false` never shows it; a function receives the text instead of `logger`. Useful in
   * an MCP server, whose client may show anything on stderr as an error.
   */
  telemetryNotice?: boolean | ((msg: string) => void);
  /**
   * Asks someone else whether this payment may go ahead, after every local check has passed and before anything is
   * signed. An approval names the EIP-3009 nonce and `validBefore` to sign. Anything but a well-formed approval,
   * including a throw, is a `refused_authorize`: nothing is signed. Not asked for a free resource or a replay.
   * The low-level hook behind `team`; passing both throws.
   */
  authorize?: (request: AuthorizeRequest) => Promise<AuthorizeAnswer>;
  /**
   * Team mode: a paidfor team account's budgets, approvals and ledger. Before signing, every payment asks
   * `{origin}/v1/team/authorize` with the key and signs the nonce and deadline the team minted; anything but a clean
   * approval pays nothing and throws TeamRefusedError. Every approval's outcome is reported to `/v1/team/outcome`; a
   * report the server could not take is kept in `<receiptsDir>/team-outcomes` and sent before the next payment. A payment
   * refused locally before the team is asked (verdict, ratio, per-call cap) is told to `/v1/team/refusals`,
   * fire-and-forget. `project` tags every payment.
   *
   * When omitted (and `authorize` is not set), the key is read from the environment variable PAIDFOR_TEAM_KEY if it
   * is set, and the project tag from PAIDFOR_PROJECT. `false` turns team mode off whatever the environment says. Passing `team` together with `authorize` throws.
   */
  team?: TeamOptions | false;
}

/** The quote `authorize` is asked about. `network` is CAIP-2. */
export interface AuthorizeRequest {
  intentId: string;
  url: string;
  payer: string;
  payTo: string;
  amountAtomic: string;
  network: string;
  asset: string;
  scheme: string;
}

export type AuthorizeAnswer =
  | { approve: true; /** 32 bytes of 0x-hex. */ nonce: `0x${string}`; /** Unix seconds. */ validBefore: number }
  | { approve: false; message: string };

/** A facilitator refuses an authorization about to lapse, so an approval with less than this left is not signed. */
const MIN_AUTH_SECONDS_LEFT = 10;

export interface CallOptions {
  /**
   * Same intentId + same request: returns the stored result, never signs again. Same intentId + different request: throws.
   * After a `payment_rejected` the same intentId may be used again from the same wallet, network and asset; it signs
   * the rejected authorization's nonce again, so at most one of the two can ever settle. Any other wallet, network or
   * asset throws IntentConflictError.
   */
  intentId?: string;
}

export type SafeResponse = Response & { readonly receipt: Receipt };
export type SafeFetch = (input: string | URL | Request, init?: RequestInit, call?: CallOptions) => Promise<SafeResponse>;

/** A viem LocalAccount / ClientEvmSigner, or a viem WalletClient with an account attached. */
export type WalletLike =
  | ClientEvmSigner
  | {
      account: { address: `0x${string}` } | undefined;
      signTypedData(args: { account: unknown; domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<`0x${string}`>;
    };

function toSigner(w: WalletLike): ClientEvmSigner {
  if (w && typeof (w as ClientEvmSigner).address === "string" && typeof w.signTypedData === "function") return w as ClientEvmSigner;
  const wc = w as Extract<WalletLike, { account: unknown }>;
  if (wc && wc.account && typeof wc.account.address === "string" && typeof wc.signTypedData === "function") {
    const account = wc.account;
    return { address: account.address, signTypedData: (m) => wc.signTypedData({ account, ...m }) };
  }
  throw new TypeError("safeFetch: expected a viem account (address + signTypedData) or a WalletClient with an account");
}

interface NormalizedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  signal: AbortSignal | undefined;
}

async function normalizeRequest(input: string | URL | Request, init: RequestInit): Promise<NormalizedRequest> {
  const req = new Request(input, init);
  const method = req.method.toUpperCase();
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const b = new Uint8Array(await req.arrayBuffer());
    if (b.byteLength > 0) body = b;
  }
  return {
    url: req.url,
    method,
    headers: headersToRecord(req.headers),
    body,
    signal: init.signal ?? (input instanceof Request ? input.signal : undefined),
  };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Request identity for idempotency: method, full URL (query included) and body bytes. Headers are not part of it. */
export function hashRequest(r: { method: string; url: string; body?: Uint8Array | undefined }): string {
  return sha256(JSON.stringify([r.method.toUpperCase(), r.url, r.body ? sha256(r.body) : ""]));
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function wrapResponse(status: number, statusText: string, headers: HeadersInit, body: Uint8Array | ReadableStream<Uint8Array> | null, url: string, receipt: Receipt): SafeResponse {
  const res = new Response(NULL_BODY.has(status) ? null : (body as BodyInit | null), { status, statusText, headers });
  Object.defineProperty(res, "url", { value: url });
  Object.defineProperty(res, "receipt", { value: receipt, enumerable: true });
  return res as SafeResponse;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

let envNoticeShown = false;

/** A project tag as the server takes it, or a TypeError naming where the bad one came from. */
function projectTag(v: unknown, from: string): string {
  const p = cleanProject(v);
  if (p === null) throw new TypeError(`safeFetch: ${from} ${JSON.stringify(v)} is not a project tag: ${PROJECT_RULE}`);
  return p;
}

/** `team`, or PAIDFOR_TEAM_KEY (and PAIDFOR_PROJECT) when neither `team` nor `authorize` is given. */
function resolveTeam(o: SafeFetchOptions): { team: TeamOptions; fromEnv: boolean; project: string | undefined } | undefined {
  if (o.team === false) return undefined;
  if (o.team !== undefined) {
    if (!o.team || typeof o.team !== "object" || typeof o.team.key !== "string" || !o.team.key.trim()) {
      throw new TypeError("safeFetch: team must be { key: string, origin?: string, project?: string } or false");
    }
    if (o.authorize) throw new TypeError("safeFetch: pass team or authorize, not both (team supplies its own authorize)");
    const project = o.team.project === undefined ? undefined : projectTag(o.team.project, "team.project");
    return { team: o.team, fromEnv: false, project };
  }
  if (o.authorize) return undefined; // the caller asks someone itself; the environment is not consulted
  const env = typeof process !== "undefined" ? process.env : undefined;
  const key = env?.PAIDFOR_TEAM_KEY?.trim();
  if (!key) return undefined;
  // An empty PAIDFOR_PROJECT is the same as none; anything else must be a tag the server takes.
  const rawProject = env?.PAIDFOR_PROJECT;
  const project = rawProject === undefined || !rawProject.trim() ? undefined : projectTag(rawProject, "PAIDFOR_PROJECT");
  return { team: { key }, fromEnv: true, project };
}

/** Refusals the client makes by itself before the team is asked; the team is told about them (POST /v1/team/refusals). */
const LOCAL_REFUSALS: ReadonlySet<string> = new Set<TeamRefusalReason>(["refused_verdict", "refused_ratio", "refused_max_per_call"]);
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

function teamReceipt(origin: string, d: TeamDecision): TeamReceipt {
  return {
    origin,
    decision: d.kind,
    auth_ref: d.kind === "approve" ? d.auth_ref : null,
    reason: d.kind === "decline" ? d.reason : null,
    message: d.kind === "approve" ? null : d.message || null,
    approve_url: d.kind === "needs_approval" ? d.approve_url : null,
    expires_at: d.kind === "needs_approval" ? d.expires_at : null,
    ledger_id: d.ledger_id ?? null,
    warnings: d.warnings,
    usage: d.usage ?? null,
    outcome_report: null,
  };
}

/** An ISO time for Unix seconds, or the bare number; never throws. */
function unixTime(s: number): string {
  const d = new Date(s * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : `Unix time ${String(s)}`;
}

/** The refusal text for a decision that is not an approval. */
function teamMessage(d: Exclude<TeamDecision, { kind: "approve" }>, intentId: string): string {
  switch (d.kind) {
    case "decline":
      return `declined by your team's rules (${d.reason}): ${d.message}${d.retry_after !== undefined ? ` Ask again after ${unixTime(d.retry_after)}.` : ""}`;
    case "needs_approval":
      return `a person has to approve this payment first: ${d.approve_url} (the request waits until ${d.expires_at}). After they approve it, call again with intentId "${intentId}".${d.message ? ` ${d.message}` : ""}`;
    case "already_settled":
      return `this purchase was already paid (settlement ${d.settlement_ref}, outcome ${d.outcome}); nothing was paid again. For a new purchase use a new intentId.`;
    case "failed":
      return `the team's rules could not be checked: ${d.message} Calling again with intentId "${intentId}" is safe.`;
  }
}

/** Verified rows carry the payer and nonce, so they only go over https, or to this machine. */
function isSecureOrLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function safeFetch(wallet: WalletLike, options: SafeFetchOptions): SafeFetch {
  if (!options || typeof options.maxPerCallUsd !== "number" || !(options.maxPerCallUsd > 0)) {
    throw new TypeError("safeFetch: options.maxPerCallUsd must be a positive number");
  }
  const maxRatio = options.maxOverListedRatio ?? DEFAULT_MAX_RATIO;
  if (!(Number.isFinite(maxRatio) && maxRatio > 0)) throw new TypeError("safeFetch: maxOverListedRatio must be a positive number");
  const network: SafeNetwork = options.network ?? "eip155:8453";
  const usdc = USDC_BY_NETWORK[network];
  if (!usdc) throw new TypeError(`safeFetch: unsupported network ${network}`);
  const signer = toSigner(wallet);
  const indexUrl = options.indexUrl === false ? undefined : (options.indexUrl ?? "https://paidfor.dev/v1").replace(/\/$/, "");
  const refuseVerdicts = new Set<Verdict>(options.refuseVerdicts ?? ["avoid"]);
  const validators = validatorsByName(options.validators ?? [...ALL_VALIDATORS]);
  if (options.telemetry === "verified" && indexUrl !== undefined && !isSecureOrLoopback(indexUrl)) {
    throw new TypeError(`safeFetch: telemetry "verified" needs an https indexUrl (or a loopback one for local testing), got ${indexUrl}`);
  }
  const telemetry = indexUrl !== undefined && (options.telemetry === "anonymous" || options.telemetry === "verified") ? options.telemetry : "off";
  const receiptsDir = resolve(options.receiptsDir ?? "./.x402-receipts");
  const baseFetch = options.fetch ?? globalThis.fetch;
  const indexTimeoutMs = options.indexTimeoutMs ?? 2000;
  const logger = options.logger ?? console;
  const maxAtomic = usdToAtomic(options.maxPerCallUsd);
  const intents = new IntentStore(receiptsDir);
  const prices = new PriceBook(receiptsDir);
  const teamConf = resolveTeam(options);

  const warn = (msg: string) => {
    try {
      logger.warn(`x402-safe-fetch: ${msg}`);
    } catch {
      /* ignore */
    }
  };

  const noticeOpt = options.telemetryNotice ?? true;
  if (telemetry === "verified" && noticeOpt !== false) void verifiedNotice();

  const team = teamConf
    ? new TeamClient({
        origin: teamConf.team.origin ?? TEAM_ORIGIN,
        key: teamConf.team.key,
        queueDir: join(receiptsDir, "team-outcomes"),
        fetch: baseFetch,
        warn,
        ...(teamConf.team.authorizeTimeoutMs !== undefined ? { authorizeTimeoutMs: teamConf.team.authorizeTimeoutMs } : {}),
        ...(teamConf.team.reportTimeoutMs !== undefined ? { reportTimeoutMs: teamConf.team.reportTimeoutMs } : {}),
      })
    : undefined;
  if (team && teamConf?.fromEnv && !envNoticeShown) {
    envNoticeShown = true;
    warn(`team mode is on from PAIDFOR_TEAM_KEY: every payment asks ${team.origin} first. Pass team: false to turn it off.`);
  }

  /** Once per receipts directory: say what verified telemetry sends and where it is documented. */
  async function verifiedNotice() {
    const marker = join(receiptsDir, ".verified-telemetry-notice");
    try {
      await access(marker);
      return;
    } catch {
      /* first run */
    }
    const text =
      'telemetry: "verified" sends each purchase outcome with its proof of payment (payer address, nonce, pay-to, tx hash) ' +
      `to ${indexUrl}/telemetry so the index can check it on Base. No bodies, request parameters, IP or identity. ` +
      'See "What verified telemetry sends and why": https://www.npmjs.com/package/@paidfor/x402-safe-fetch#what-verified-telemetry-sends-and-why ' +
      '(set telemetry: "anonymous" or "off" to change it). Shown once.';
    if (typeof noticeOpt === "function") {
      try {
        noticeOpt(`x402-safe-fetch: ${text}`);
      } catch {
        /* ignore */
      }
    } else warn(text);
    try {
      await mkdir(receiptsDir, { recursive: true });
      await writeFile(marker, `${new Date().toISOString()}\n`);
    } catch {
      /* shown again next run; harmless */
    }
  }

  /** Write the receipt; a local disk failure after paying must not hide the response from the caller. */
  async function persistReceipt(r: Receipt): Promise<string | null> {
    try {
      return await writeReceipt(receiptsDir, r);
    } catch (e) {
      warn(`could not write receipt for intent ${r.intent_id}: ${errMsg(e)}`);
      return null;
    }
  }

  function emitTelemetry(r: Receipt) {
    if (telemetry === "off" || !indexUrl) return;
    // Nothing was paid and the seller is not at fault for a wallet that cannot pay; the contract has no outcome for it.
    if (r.outcome === "payment_rejected") return;
    try {
      const payload =
        telemetry === "verified"
          ? buildPayloadV2({
              url: r.url,
              outcome: r.reported_outcome ?? "error",
              amountUsdc: r.amount_usdc,
              latencyMs: r.latency_ms,
              validatorFailures: failureLabels(r.validator_failures, r.response?.status),
              proof: r.proof,
              unknownSeller: r.index_note === UNKNOWN_SELLER_NOTE,
            })
          : buildPayload({ url: r.url, outcome: r.outcome, amountUsdc: r.amount_usdc, latencyMs: r.latency_ms, validatorFailures: r.validator_failures });
      void sendTelemetry(indexUrl, payload, { receiptsDir, fetchImpl: baseFetch });
    } catch {
      /* never on the purchase path */
    }
  }

  /**
   * Fill proof, reported_outcome and verification_url once the outcome is final. Proof only for a sent
   * authorization; a refused outcome never carries one.
   */
  function attachProof(r: Receipt, settledAt: number | undefined, settlement: ReturnType<typeof decodeSettlementHeader>) {
    const refAtomic = r.reference ? usdcStringToAtomic(r.reference.amount_usdc) : undefined;
    r.reported_outcome = harnessOutcome({
      outcome: r.outcome,
      ...(r.response ? { status: r.response.status } : {}),
      validatorFailures: r.validator_failures,
      settlementSuccess: settlement.parsed ? settlement.parsed.success : null,
      ...(r.quote ? { amountAtomic: BigInt(r.quote.amount_atomic) } : {}),
      ...(refAtomic !== undefined ? { referenceAtomic: refAtomic } : {}),
    });
    if (!r.paid || REFUSED_OUTCOMES.has(r.reported_outcome) || !r.quote || !r.payer || !r.nonce || settledAt === undefined) return;
    r.proof = buildProof({
      network,
      scheme: r.quote.scheme,
      asset: r.quote.asset,
      payTo: r.quote.pay_to,
      payer: r.payer,
      nonce: r.nonce,
      settlement,
      settledAt,
      responseSha256: r.response?.sha256 ?? null,
      declaredTimeoutS: r.quote.max_timeout_seconds,
    });
    if (r.proof && telemetry === "verified" && indexUrl) {
      r.verification_url = `${indexUrl}/telemetry/${r.proof.payer}/${r.proof.nonce}`;
    }
  }

  function baseReceipt(req: NormalizedRequest, intentId: string, requestHash: string, t0: number): Receipt {
    let host: string | null = null;
    try {
      host = new URL(req.url).hostname.toLowerCase();
    } catch {
      /* ignore */
    }
    return {
      v: 1,
      client: CLIENT_ID,
      intent_id: intentId,
      request_hash: requestHash,
      url: req.url,
      method: req.method,
      started_at: new Date(t0).toISOString(),
      finished_at: "",
      latency_ms: 0,
      outcome: "error",
      paid: false,
      replayed: false,
      replay_of: null,
      original: null,
      quote: null,
      amount_usdc: atomicToUsdc(0n),
      reference: null,
      seller: { host, verdict: "unknown", verdict_text: null, seller_url: null, evidence_url: null },
      index: indexUrl ? "unavailable" : "off",
      index_note: null,
      validators: {},
      validator_failures: [],
      settlement: { header: null, version: null, parsed: null, parse_error: null },
      tx_hash: null,
      nonce: null,
      payer: null,
      valid_before: null,
      proof: null,
      reported_outcome: null,
      verification_url: null,
      response: null,
      error: null,
    };
  }

  const finish = (r: Receipt, t0: number, outcome: Outcome) => {
    r.outcome = outcome;
    r.finished_at = new Date().toISOString();
    r.latency_ms = Date.now() - t0;
  };

  async function replay(lease: IntentLease, req: NormalizedRequest, r: Receipt, t0: number): Promise<SafeResponse> {
    const rec = lease.record;
    const stored = rec.response;
    if (!stored) {
      throw new IntentIndeterminateError("intent_indeterminate", `intent ${rec.intent_id} is marked completed but has no stored response; not signing again`);
    }
    let original: Receipt | null = null;
    if (rec.receipt_file) {
      try {
        original = JSON.parse(await readFile(join(receiptsDir, rec.receipt_file), "utf8")) as Receipt;
      } catch {
        /* receipt file gone: the stored response is still authoritative */
      }
    }
    r.replayed = true;
    r.replay_of = rec.receipt_file ?? null;
    r.original = original;
    if (original) {
      r.quote = original.quote;
      r.seller = original.seller;
      r.validators = original.validators;
      r.validator_failures = original.validator_failures;
      r.tx_hash = original.tx_hash;
      r.nonce = original.nonce;
      r.payer = original.payer ?? null;
      r.valid_before = original.valid_before ?? null;
      r.proof = original.proof ?? null;
      r.reported_outcome = original.reported_outcome ?? null;
      r.verification_url = original.verification_url ?? null;
      r.settlement = original.settlement;
      r.response = original.response;
    }
    finish(r, t0, "replayed");
    await persistReceipt(r);
    const body = Buffer.from(stored.body_base64, "base64");
    return wrapResponse(stored.status, stored.statusText, stored.headers, body, stored.url || req.url, r);
  }

  async function live(lease: IntentLease, req: NormalizedRequest, r: Receipt, t0: number, authorize: SafeFetchOptions["authorize"]): Promise<SafeResponse> {
    let quoteResult: QuoteResult | undefined;
    let indexP: Promise<IndexCheck> | undefined;
    let idx: IndexCheck | undefined;
    let quote: NormalizedRequirements | undefined;
    let approved: bigint | undefined;
    let refusal: { code: "refused_verdict" | "refused_ratio" | "refused_max_per_call" | "refused_authorize"; message: string; sellerUrl: string | null } | undefined;
    // The nonce (and, from an approval, the deadline) to sign instead of the SDK's own.
    let auth: { nonce: `0x${string}`; validBefore?: bigint } | undefined;
    // An earlier attempt of this intent was signed and rejected; that authorization may still be settled until its deadline.
    const priorRejected = lease.record.rejected;
    let authSigned = false;
    let failure: { code: SafeFetchErrorCode; message: string } | undefined;
    let signingStarted = false;
    let signedRecorded = false;
    let sent = false;
    let unpaidCount = 0;
    let paidCount = 0;
    let paidStart: number | undefined;
    let paidHeadersAt: number | undefined;

    const applyIndex = (i: IndexCheck) => {
      idx = i;
      r.index = i.available ? "ok" : "unavailable";
      r.index_note = i.note ?? null;
      r.seller = { host: i.host, verdict: i.verdict, verdict_text: i.verdict_text, seller_url: i.seller_url, evidence_url: i.evidence_url };
    };

    const client = new x402Client();
    client.setSpendControls(false); // this wrapper enforces its own caps
    const policy: PaymentPolicy = (version, reqs) =>
      reqs.filter(
        (q) =>
          q.scheme === "exact" &&
          caip2Network({ x402Version: version === 1 ? 1 : 2, network: q.network }) === network &&
          typeof q.asset === "string" &&
          q.asset.toLowerCase() === usdc &&
          ((q.extra?.assetTransferMethod as string | undefined) ?? "eip3009") === "eip3009",
      );
    // With `authorize` the approval decides the nonce and deadline; after a rejected payment the old nonce is signed
    // again. The SDK has no way to take either, so they are set here at signing and on the signed payload in
    // onAfterPaymentCreation.
    const schemeSigner: ClientEvmSigner =
      !authorize && !priorRejected
        ? signer
        : {
            address: signer.address,
            signTypedData: async (m) => {
              if (!auth || m.primaryType !== "TransferWithAuthorization") throw new Error("x402-safe-fetch: refusing to sign without an approval");
              const message = { ...m.message, nonce: auth.nonce, ...(auth.validBefore !== undefined ? { validBefore: auth.validBefore } : {}) };
              const signature = await signer.signTypedData({ ...m, message });
              authSigned = true;
              return signature;
            },
          };
    registerExactEvmScheme(client, { signer: schemeSigner, networks: [network], policies: [policy] });

    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      signingStarted = true;
      let norm: NormalizedRequirements | undefined;
      if (paymentRequired.x402Version === 2) {
        const p = PaymentRequirementsSchema.safeParse(selectedRequirements);
        const res = ResourceInfoSchema.safeParse(paymentRequired.resource);
        if (p.success) norm = { ...normalizeV2(p.data, { resource: res.success ? res.data : undefined }), raw: selectedRequirements };
      } else if (paymentRequired.x402Version === 1) {
        const p = PaymentRequirementsV1Schema.safeParse(selectedRequirements);
        if (p.success) norm = { ...normalizeV1(p.data), raw: selectedRequirements };
      }
      if (!norm || !/^\d+$/.test(norm.amountAtomic)) {
        failure = { code: "no_acceptable_quote", message: "selected payment requirements failed schema validation" };
        return { abort: true, reason: failure.message };
      }
      if (norm.scheme !== "exact" || caip2Network(norm) !== network || norm.asset.toLowerCase() !== usdc) {
        failure = { code: "sdk", message: `SDK selected ${norm.scheme}/${norm.network}/${norm.asset}, expected exact/${network}/USDC` };
        return { abort: true, reason: failure.message };
      }
      quote = norm;
      const amount = BigInt(norm.amountAtomic);
      r.quote = {
        x402_version: norm.x402Version,
        scheme: norm.scheme,
        network: norm.network,
        asset: norm.asset,
        pay_to: norm.payTo,
        amount_atomic: amount.toString(),
        amount_usdc: atomicToUsdc(amount),
        max_timeout_seconds: norm.maxTimeoutSeconds,
        resource_url: norm.resourceUrl ?? null,
      };
      const usd = `${atomicToUsdc(amount)} USDC`;
      const host = r.seller.host ?? "the seller";

      applyIndex(indexP ? await indexP : { available: false, note: "index not queried", host: r.seller.host, verdict: "unknown", verdict_text: null, seller_url: null, evidence_url: null, listed_price_usdc: null });
      const i = idx!;
      const sellerLink = i.seller_url ? ` See ${i.seller_url}` : "";

      // 1. Seller verdict (advisory index; only a reachable index with a known verdict can refuse).
      if (i.available && refuseVerdicts.has(i.verdict)) {
        refusal = {
          code: "refused_verdict",
          message: `refused to pay ${usd} to ${host}: paidfor.dev rates this seller "${i.verdict}"${i.verdict_text ? ` (${i.verdict_text})` : ""}.${sellerLink}`,
          sellerUrl: i.seller_url,
        };
        return { abort: true, reason: refusal.message };
      }
      if (i.available && i.verdict === "caution") {
        warn(`paying ${host}, which paidfor.dev rates "caution": ${i.verdict_text ?? ""}${sellerLink}`);
      }

      // 2. Quote vs reference: index listed price, else the last price this client paid for the resource.
      let ref: { amount: bigint; source: ReferenceSource } | undefined;
      const listed = i.available ? usdcStringToAtomic(i.listed_price_usdc) : undefined;
      if (listed !== undefined) ref = { amount: listed, source: "index_listed" };
      else {
        const last = await prices.get(resourceKey(req.method, req.url)).catch(() => undefined);
        if (last !== undefined) ref = { amount: last, source: "local_last_paid" };
      }
      if (ref) {
        const ratio = quoteRatio(amount, ref.amount);
        r.reference = { amount_usdc: atomicToUsdc(ref.amount), source: ref.source, ratio, max_ratio: maxRatio };
        if (exceedsRatio(amount, ref.amount, maxRatio)) {
          const what = ref.source === "index_listed" ? "the listed price on paidfor.dev" : "the last price this client paid";
          refusal = {
            code: "refused_ratio",
            message: `refused to pay ${usd} for ${req.url}: that is ${ratio.toFixed(2)}x ${what} (${atomicToUsdc(ref.amount)} USDC), above the ${maxRatio}x limit.${sellerLink}`,
            sellerUrl: i.seller_url,
          };
          return { abort: true, reason: refusal.message };
        }
      }

      // 3. Per-call cap.
      if (amount > maxAtomic) {
        refusal = {
          code: "refused_max_per_call",
          message: `refused to pay ${usd} for ${req.url}: above maxPerCallUsd ${atomicToUsdc(maxAtomic)} USDC.${sellerLink}`,
          sellerUrl: i.seller_url,
        };
        return { abort: true, reason: refusal.message };
      }

      // 4. A rejected authorization of this intent is reused only by the same payer, on the same network, for the same
      // asset. EIP-3009 nonces are per payer and per token contract: the same nonce signed by another wallet, on another
      // chain or for another token is a separate authorization, and both could settle. A changed pay-to or amount does
      // not break this (one payer, one token, one nonce: only one of the two can ever be used), so it is allowed.
      // Checked before the approval is asked for, so a refused retry holds no reservation.
      if (priorRejected) {
        const differs: string[] = [];
        if (!priorRejected.payer) differs.push("the payer was not recorded (an intent file from before 0.6.0)");
        else {
          if (priorRejected.payer.toLowerCase() !== signer.address.toLowerCase()) differs.push(`payer ${priorRejected.payer} vs this wallet ${signer.address.toLowerCase()}`);
          if (priorRejected.network !== caip2Network(norm)) differs.push(`network ${priorRejected.network ?? "unknown"} vs ${caip2Network(norm)}`);
          if ((priorRejected.asset ?? "").toLowerCase() !== norm.asset.toLowerCase()) differs.push(`asset ${priorRejected.asset ?? "unknown"} vs ${norm.asset.toLowerCase()}`);
        }
        if (differs.length) {
          failure = {
            code: "intent_conflict",
            message:
              `intent ${r.intent_id} has a rejected authorization (nonce ${priorRejected.nonce}) that cannot be reused here: ${differs.join("; ")}. ` +
              "Nothing was signed. Check on chain that the old authorization was not used (authorizationState(payer, nonce) on the USDC contract is false; " +
              "true means used or cancelled, and only its AuthorizationUsed event and USDC Transfer show a payment), then use a new intentId.",
          };
          return { abort: true, reason: failure.message };
        }
      }

      // 5. Last, so a payment refused above never takes up a reservation with whoever approves it.
      if (authorize) {
        let answer: AuthorizeAnswer;
        try {
          answer = await authorize({ intentId: r.intent_id, url: req.url, payer: signer.address, payTo: norm.payTo, amountAtomic: amount.toString(), network: caip2Network(norm), asset: norm.asset, scheme: norm.scheme });
        } catch (e) {
          answer = { approve: false, message: `could not get an approval: ${errMsg(e)}` };
        }
        if (answer?.approve === true && !(/^0x[0-9a-fA-F]{64}$/.test(answer.nonce) && Number.isSafeInteger(answer.validBefore) && answer.validBefore - Date.now() / 1000 >= MIN_AUTH_SECONDS_LEFT)) {
          answer = { approve: false, message: "the approval was malformed or about to lapse" };
        }
        if (answer?.approve !== true) {
          refusal = { code: "refused_authorize", message: `refused to pay ${usd} for ${req.url}: ${answer?.message ?? "no approval"}`, sellerUrl: i.seller_url };
          return { abort: true, reason: refusal.message };
        }
        auth = { nonce: answer.nonce, validBefore: BigInt(answer.validBefore) };
      }

      // 6. A rejected authorization of this intent can still be used until its deadline. Signing its nonce again (same
      // payer, network and asset, checked above) means at most one of the two can ever move money. An approval with
      // another nonce waits for that deadline; the deadline only stops later use of the old signature and does not show
      // that it was never used. authorizationState(payer, nonce) false on chain shows that; true means used or cancelled,
      // and only the AuthorizationUsed event with its USDC Transfer shows a payment (see the README).
      if (priorRejected) {
        if (!NONCE_RE.test(priorRejected.nonce)) {
          failure = { code: "sdk", message: `intent ${r.intent_id} has a rejected authorization with an unreadable nonce; not signing again. Use a new intentId after checking the chain.` };
          return { abort: true, reason: failure.message };
        }
        if (!auth) auth = { nonce: priorRejected.nonce as `0x${string}` };
        else if (auth.nonce.toLowerCase() !== priorRejected.nonce.toLowerCase() && (priorRejected.valid_before === null || priorRejected.valid_before > Date.now() / 1000)) {
          const until = priorRejected.valid_before === null ? "an unknown deadline" : unixTime(priorRejected.valid_before);
          refusal = {
            code: "refused_authorize",
            message: `refused to pay ${usd} for ${req.url}: an earlier payment for intent ${r.intent_id} (nonce ${priorRejected.nonce}) was rejected by the seller but can still be settled until ${until}, and the approval names a different nonce. Call again after that time, once authorizationState(payer, nonce) on the USDC contract is false (never used): the deadline alone does not show that.`,
            sellerUrl: i.seller_url,
          };
          return { abort: true, reason: refusal.message };
        }
      }

      approved = amount;
      try {
        await lease.update({ phase: "signing", amount_atomic: amount.toString(), pay_to: norm.payTo });
      } catch (e) {
        failure = { code: "sdk", message: `could not record intent before signing: ${errMsg(e)}` };
        return { abort: true, reason: failure.message };
      }
      return undefined;
    });

    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      const p = paymentPayload.payload as { signature?: unknown; authorization?: Record<string, unknown> };
      const a = p.authorization;
      if (!a || typeof p.signature !== "string") {
        failure = { code: "sdk", message: "signed payload has no EIP-3009 authorization/signature" };
        throw new Error(failure.message);
      }
      const value = String(a.value);
      const to = String(a.to);
      // Hard assertions before anything leaves the process.
      if (approved === undefined || !/^\d+$/.test(value) || BigInt(value) > approved) {
        failure = { code: "sdk", message: `signed value ${value} exceeds the approved amount ${approved}` };
        throw new Error(failure.message);
      }
      if (!quote || to.toLowerCase() !== quote.payTo.toLowerCase()) {
        failure = { code: "sdk", message: `signed to ${to} does not match requirements.payTo ${quote?.payTo}` };
        throw new Error(failure.message);
      }
      if (auth) {
        if (!authSigned) {
          failure = { code: "sdk", message: "the payment was not signed with the approval's nonce" };
          throw new Error(failure.message);
        }
        a.nonce = auth.nonce;
        if (auth.validBefore !== undefined) a.validBefore = auth.validBefore.toString();
      }
      r.nonce = String(a.nonce);
      const vb = Number(a.validBefore);
      r.valid_before = Number.isSafeInteger(vb) ? vb : null;
      r.payer = String(a.from).toLowerCase();
      r.amount_usdc = atomicToUsdc(BigInt(value));
      try {
        await lease.update({ phase: "signed", nonce: r.nonce, amount_atomic: value, pay_to: to });
      } catch (e) {
        failure = { code: "sdk", message: `could not record signed intent; not sending payment: ${errMsg(e)}` };
        throw e;
      }
      signedRecorded = true;
    });

    const innerFetch = async (input: string | URL | Request, rinit?: RequestInit): Promise<Response> => {
      const rq = input instanceof Request ? input : new Request(input, rinit);
      const isPaid = rq.headers.has(HEADERS.V2_SIGNATURE) || rq.headers.has(HEADERS.V1_PAYMENT);
      const fInit: RequestInit = { method: rq.method, headers: headersToRecord(rq.headers) };
      if (rq.method !== "GET" && rq.method !== "HEAD") {
        const b = new Uint8Array(await rq.arrayBuffer());
        if (b.byteLength) fInit.body = b as BodyInit;
      }
      if (req.signal) fInit.signal = req.signal;

      if (!isPaid) {
        if (++unpaidCount > 1) throw new Error("x402-safe-fetch: refusing a second unpaid request");
        fInit.redirect = "follow";
        const start = Date.now();
        const res = await baseFetch(rq.url, fInit);
        if (res.status !== 402) return res;
        quoteResult = await quoteFromResponse(rq.url, res, start);
        if (indexUrl) indexP = checkIndex(indexUrl, req.url, { timeoutMs: indexTimeoutMs, fetchImpl: baseFetch });
        // Hand the wrapper an equivalent 402 (we consumed the original body).
        return new Response(quoteResult.bodyText ?? "", { status: 402, headers: res.headers });
      }

      if (++paidCount > 1) throw new Error("x402-safe-fetch: refusing a second paid request (automatic retry is disabled)");
      if (!signedRecorded) throw new Error("x402-safe-fetch: refusing to send a payment that was not recorded");
      // Do not follow redirects: a redirect would re-send PAYMENT-SIGNATURE to another URL.
      fInit.redirect = "manual";
      paidStart = Date.now();
      sent = true;
      const res = await baseFetch(rq.url, fInit);
      paidHeadersAt = Date.now();
      return res;
    };

    const fetchWithPayment = wrapFetchWithPayment(innerFetch as typeof globalThis.fetch, client);
    const reqInit: RequestInit = { method: req.method, headers: req.headers };
    if (req.body) reqInit.body = req.body as BodyInit;

    const settleIndex = async () => {
      if (!idx && indexP) applyIndex(await indexP);
    };

    let res: Response;
    try {
      res = await fetchWithPayment(req.url, reqInit);
    } catch (e) {
      await settleIndex();
      if (refusal) {
        finish(r, t0, refusal.code);
        r.error = { code: refusal.code, message: refusal.message };
        attachProof(r, undefined, {});
        await lease.update({ phase: "refused" }).catch(() => undefined);
        await persistReceipt(r);
        // A buyer's own rule says nothing about the seller, so it is not reported to the index.
        if (refusal.code !== "refused_authorize") emitTelemetry(r);
        throw new PaymentRefusedError(refusal.code, `x402-safe-fetch ${refusal.message}`, refusal.sellerUrl, r);
      }
      if (signedRecorded) {
        // The authorization exists and may be with the seller. The intent stays "signed": never re-signed.
        r.paid = sent;
        finish(r, t0, "paid_no_response");
        const message = `x402-safe-fetch: payment for ${req.url} was signed (nonce ${r.nonce})${sent ? " and sent" : ""}, but no response came back: ${errMsg(e)}. Retrying intent ${r.intent_id} will not sign again.`;
        r.error = { code: "paid_no_response", message };
        attachProof(r, paidStart, {});
        await persistReceipt(r);
        emitTelemetry(r);
        throw new SafeFetchError("paid_no_response", message, r, { cause: e });
      }
      let code: SafeFetchErrorCode;
      let message: string;
      if (failure) ({ code, message } = failure);
      else if (quoteResult && !signingStarted) {
        code = "no_acceptable_quote";
        const offered = (quoteResult.parsed?.accepts ?? []).map((a) => `${a.scheme}/${a.network}/${a.asset} ${a.amountAtomic}`).join(", ");
        message = `seller offered no exact USDC payment on ${network}${offered ? `: ${offered}` : ""}${quoteResult.parsed?.parseError ? ` (${quoteResult.parsed.parseError})` : ""}`;
      } else if (!quoteResult) {
        code = "network";
        message = errMsg(e instanceof Error && e.cause !== undefined ? e.cause : e);
      } else {
        code = "sdk";
        message = errMsg(e);
      }
      finish(r, t0, code === "no_acceptable_quote" ? "no_acceptable_quote" : "error");
      r.error = { code, message };
      attachProof(r, undefined, {});
      await lease.update({ phase: "failed_unpaid" }).catch(() => undefined);
      await persistReceipt(r);
      if (quoteResult) emitTelemetry(r);
      if (code === "intent_conflict") throw new IntentConflictError(code, `x402-safe-fetch: ${message}`, r, { cause: e });
      throw new SafeFetchError(code, `x402-safe-fetch: ${message}`, r, { cause: e });
    }

    // Response in hand. Read up to MAX_BODY_BYTES for the validators; the caller still gets the full body.
    const read = await readBodyTee(res, MAX_BODY_BYTES);
    const startedAt = paidCount > 0 ? (paidStart ?? t0) : t0;
    const record = buildResponseRecord(res, read, startedAt, paidCount > 0 ? (paidHeadersAt ?? Date.now()) : Date.now(), Date.now());
    const request: RequestRecord = { url: req.url, method: req.method, headers: req.headers, params: {}, sentAt: startedAt };
    if (req.body) request.body = Buffer.from(req.body).toString("utf8");
    const results = await runAllValidators(
      {
        request,
        response: record,
        requirements: {
          ...(quote?.mimeType !== undefined ? { mimeType: quote.mimeType } : {}),
          ...(quote?.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: quote.maxTimeoutSeconds } : {}),
        },
        now: Date.now(),
      },
      validators,
    );
    r.validators = results;
    r.validator_failures = (Object.entries(results) as [ValidatorName, { status: string }][]).filter(([, v]) => v.status === "fail").map(([k]) => k);
    r.response = {
      status: res.status,
      content_type: res.headers.get("content-type"),
      bytes_inspected: record.body.length,
      body_truncated_for_validation: read.truncatedByUs,
      sha256: read.truncatedByUs ? null : sha256(record.body),
    };

    if (paidCount === 0) {
      // Free resource: no 402, nothing signed.
      await settleIndex();
      finish(r, t0, "no_payment_required");
      await lease.update({ phase: "unpaid" }).catch(() => undefined);
      await persistReceipt(r);
      return wrapResponse(res.status, res.statusText, res.headers, read.callerBody, res.url || req.url, r);
    }

    const st = decodeSettlementHeader(record.headers);
    r.settlement = { header: st.raw ?? null, version: st.version ?? null, parsed: st.parsed ?? null, parse_error: st.parseError ?? null };

    // The seller answered the paid request with another 402 and settled nothing (no settlement header, or one saying
    // it failed): an empty wallet, an expired or refused authorization. Nothing was paid. An unreadable header is not
    // taken as a rejection, since it may name a settlement.
    if (res.status === 402 && (st.raw === undefined || st.parsed?.success === false)) {
      finish(r, t0, "payment_rejected");
      const why = st.parsed?.errorReason ? ` (${String(st.parsed.errorReason).slice(0, 200)})` : "";
      // The same nonce signed again keeps the LATER of the two deadlines: the seller may still hold the earlier
      // signature, and until it lapses no other nonce may be signed. Unknown (null) on either side never passes. A
      // different amount or pay-to on the earlier signature does not matter: one payer, one token, one nonce, so only
      // one of the signatures under it can ever settle; the deadline is the only thing that has to be carried over.
      const sameNonce = priorRejected !== undefined && r.nonce !== null && priorRejected.nonce.toLowerCase() === r.nonce.toLowerCase();
      const newVb = r.valid_before ?? null;
      const keptVb = !sameNonce ? newVb : priorRejected.valid_before === null || newVb === null ? null : Math.max(priorRejected.valid_before, newVb);
      const until = keptVb !== null ? unixTime(keptVb) : "an unknown deadline";
      r.error = {
        code: "payment_rejected",
        message:
          `the seller answered the paid request for ${req.url} with HTTP 402${why} and settled nothing, so nothing was paid. ` +
          `The signed authorization (payer ${r.payer}, nonce ${r.nonce}) can still be used until ${until}; that deadline only ` +
          "stops later use. authorizationState(payer, nonce) on the USDC contract is false while the nonce was never used; " +
          "true means used or cancelled, so look for its AuthorizationUsed event and USDC Transfer before counting it as paid. " +
          `Calling again with intent ${r.intent_id} from the same wallet signs that same nonce, so at most one of the two can settle.`,
      };
      attachProof(r, undefined, st);
      await persistReceipt(r);
      try {
        await lease.update({
          phase: "rejected",
          rejected: { nonce: r.nonce ?? "", valid_before: keptVb, payer: r.payer ?? "", network, asset: (r.quote?.asset ?? "").toLowerCase() },
        });
      } catch (e) {
        warn(`rejected payment for intent ${r.intent_id} could not be recorded (${errMsg(e)}); a retry with this intentId will refuse rather than sign again`);
      }
      return wrapResponse(res.status, res.statusText, res.headers, read.callerBody, res.url || req.url, r);
    }

    r.paid = true;
    const tx = st.parsed?.transaction;
    r.tx_hash = typeof tx === "string" && TX_HASH_RE.test(tx) ? tx : null;
    finish(r, t0, r.validator_failures.length ? "validator_failed" : "ok");
    attachProof(r, paidHeadersAt ?? Date.now(), st);

    const receiptFile = await persistReceipt(r);
    const stored: StoredResponse = {
      url: res.url || req.url,
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body_base64: Buffer.from(record.body).toString("base64"),
      body_truncated: read.truncatedByUs,
    };
    try {
      await lease.update({ phase: "completed", response: stored, ...(receiptFile ? { receipt_file: receiptFile } : {}) });
    } catch (e) {
      warn(`paid response for intent ${r.intent_id} could not be stored (${errMsg(e)}); a retry with this intentId will refuse rather than pay again`);
    }
    if (r.outcome === "ok" && approved !== undefined) {
      await prices.set(resourceKey(req.method, req.url), approved).catch((e: unknown) => warn(`price book not updated: ${errMsg(e)}`));
    }
    emitTelemetry(r);
    return wrapResponse(res.status, res.statusText, res.headers, read.callerBody, res.url || req.url, r);
  }

  return async function fetchWithPay(input, init = {}, call = {}) {
    const t0 = Date.now();
    const req = await normalizeRequest(input, init);
    const requestHash = hashRequest(req);
    const intentId = call.intentId ?? randomUUID();
    // Owed team reports go first: until the server has them it answers the same purchase with pending_settlement.
    if (team) await team.flush();
    const lease = await intents.acquire(intentId, requestHash);
    try {
      const r = baseReceipt(req, intentId, requestHash, t0);
      if (lease.replay) return await replay(lease, req, r, t0);
      if (!team) return await live(lease, req, r, t0, options.authorize);
      return await teamLive(team, lease, req, r, t0);
    } finally {
      await lease.release();
    }
  };

  /** live() with the team asked before signing, and every approval's outcome reported after. */
  async function teamLive(team: TeamClient, lease: IntentLease, req: NormalizedRequest, r: Receipt, t0: number): Promise<SafeResponse> {
    const project = teamConf?.project;
    let decision: TeamDecision | undefined;
    const authorize = async (q: AuthorizeRequest): Promise<AuthorizeAnswer> => {
      const d = await team.authorize({ wallet: q.payer, intent_id: q.intentId, resource_url: q.url, pay_to: q.payTo, amount_atomic: q.amountAtomic, network: q.network, asset: q.asset, scheme: q.scheme, protocol: "x402", ...(project ? { project } : {}) });
      decision = d;
      r.team = teamReceipt(team.origin, d);
      return d.kind === "approve" ? { approve: true, nonce: d.auth_ref as `0x${string}`, validBefore: d.valid_before } : { approve: false, message: teamMessage(d, q.intentId) };
    };
    /** Say what happened to an approved payment, paid or not. Nothing to say when nothing was approved. */
    const settle = async (rec: Receipt | undefined) => {
      if (decision?.kind !== "approve") return;
      if (!rec) {
        warn(`no receipt for approved intent ${r.intent_id}, so no team outcome was reported; the approval keeps counting against the budgets`);
        return;
      }
      const state = await team.report(outcomeFor(rec, signer.address, decision.auth_ref));
      if (rec.team) rec.team.outcome_report = state;
    };
    let res: SafeResponse;
    try {
      res = await live(lease, req, r, t0, authorize);
    } catch (e) {
      if (e instanceof PaymentRefusedError && LOCAL_REFUSALS.has(e.code) && e.receipt?.quote) {
        // Refused before the team was asked: tell it, so the ledger counts what was saved. Never awaited, never thrown.
        const q = e.receipt.quote;
        void team.reportRefusal({
          wallet: signer.address,
          intent_id: e.receipt.intent_id,
          resource_url: e.receipt.url,
          pay_to: q.pay_to,
          amount_atomic: q.amount_atomic,
          network,
          asset: q.asset,
          scheme: q.scheme,
          protocol: "x402",
          reason: e.code as TeamRefusalReason,
          verdict: e.receipt.seller.verdict,
          ...(project ? { project } : {}),
        });
      }
      await settle(e instanceof SafeFetchError ? e.receipt : undefined);
      if (decision && e instanceof PaymentRefusedError && e.code === "refused_authorize") {
        throw new TeamRefusedError(decision, e.message, e.sellerUrl, e.receipt);
      }
      throw e;
    }
    await settle(res.receipt);
    return res;
  }
}
