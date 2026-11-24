/**
 * Proof of payment and harness outcome names for the v2 ("verified") telemetry row. The contract is the
 * "Telemetry v2 payload" block (docs/telemetry.md). Everything here comes from what the client already has:
 * the authorization it signed, the seller's settlement header, the paid response body and the 402 quote.
 *
 * The outcome mapping follows x402-audit src/classify.ts precedence for a paid call:
 * duplicate > non_delivery > wrong_goods > overcharge > ok.
 */
import type { Outcome } from "./receipt.js";
import { exceedsRatio } from "./price.js";
import type { DecodedSettlement } from "./x402/settlement.js";

export interface TelemetryProof {
  network: string;
  scheme: string;
  asset: string;
  pay_to: string;
  payer: string;
  nonce: string;
  tx_hash: string | null;
  settled_at: string;
  response_sha256: string | null;
  declared_timeout_s: number;
}

export type TelemetryOutcome =
  | "ok"
  | "non_delivery"
  | "overcharge"
  | "wrong_goods"
  | "duplicate"
  | "refused_verdict"
  | "refused_ratio"
  | "refused_max_per_call"
  | "refused_authorize"
  | "no_acceptable_quote"
  | "paid_no_response"
  | "validator_failed"
  | "error";

/** Outcomes where nothing was paid. Their rows never carry proof and are counted as refusals, not failures. */
export const REFUSED_OUTCOMES: ReadonlySet<string> = new Set(["refused_verdict", "refused_ratio", "refused_max_per_call", "refused_authorize", "no_acceptable_quote"]);

/**
 * Refusals by the buyer's own rules (the 0.8.0 caps and switches). They say nothing about the seller: no row is sent,
 * and the receipt's `reported_outcome` is null.
 */
export const UNREPORTED_REFUSALS: ReadonlySet<string> = new Set(["refused_max_per_day", "refused_max_per_seller_per_day", "refused_max_first_payment", "refused_pay_to", "needs_approval", "frozen"]);

/** Client outcomes a v2 row names as they are. */
const PASS_THROUGH: ReadonlySet<string> = new Set<TelemetryOutcome>(["refused_verdict", "refused_ratio", "refused_max_per_call", "refused_authorize", "no_acceptable_quote", "paid_no_response", "error"]);

/** The ratio the harness and this client's default use for "over the reference". */
export const DEFAULT_MAX_RATIO = 1.1;

/** x402-audit DELIVERY_VALIDATORS and GOODS_VALIDATORS. This client ships only the delivery four. */
const DELIVERY_VALIDATORS = ["http_status", "non_empty", "content_type", "not_truncated"];
const GOODS_VALIDATORS = ["json_schema", "entity_matches", "freshness"];

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;

export interface ProofInput {
  /** CAIP-2 network of the signed authorization, e.g. "eip155:8453". */
  network: string;
  scheme: string;
  asset: string;
  payTo: string;
  /** authorization.from */
  payer: string;
  /** authorization.nonce */
  nonce: string;
  settlement: DecodedSettlement;
  /** When the paid response headers arrived, or when the paid request was sent if none did. */
  settledAt: number;
  responseSha256: string | null;
  declaredTimeoutS: number;
}

/** Returns null when a signed field is not in the contract's form, so a malformed row is never sent. */
export function buildProof(i: ProofInput): TelemetryProof | null {
  const asset = i.asset.toLowerCase();
  const payTo = i.payTo.toLowerCase();
  const payer = i.payer.toLowerCase();
  const nonce = i.nonce.toLowerCase();
  if (!ADDRESS_RE.test(asset) || !ADDRESS_RE.test(payTo) || !ADDRESS_RE.test(payer) || !BYTES32_RE.test(nonce)) return null;
  if (!/^eip155:\d+$/.test(i.network) || !Number.isInteger(i.declaredTimeoutS) || i.declaredTimeoutS < 0) return null;
  const tx = i.settlement.parsed?.transaction?.toLowerCase();
  const sha = i.responseSha256?.toLowerCase() ?? null;
  return {
    network: i.network,
    scheme: i.scheme,
    asset,
    pay_to: payTo,
    payer,
    nonce,
    tx_hash: tx !== undefined && BYTES32_RE.test(tx) ? tx : null,
    settled_at: new Date(i.settledAt).toISOString(),
    response_sha256: sha !== null && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    declared_timeout_s: i.declaredTimeoutS,
  };
}

export interface OutcomeInput {
  /** The client outcome on the receipt. */
  outcome: Outcome;
  /** HTTP status of the paid response, when one came back. */
  status?: number;
  /** Names of failed validators. */
  validatorFailures: readonly string[];
  /** `success` from the settlement header; null when there was no parseable header. */
  settlementSuccess: boolean | null;
  /**
   * Settlements observed for this intent. Defaults to 0 when the header says the settlement failed, else 1.
   * The client sends one paid request per intent, so it can only pass more than 1 if it ever sees a second.
   */
  settlements?: number;
  amountAtomic?: bigint;
  referenceAtomic?: bigint;
}

/**
 * Client outcome to the harness name for a v2 row. Refusals and client-only outcomes pass through unchanged.
 * A paid call with a response is classified like x402-audit: no settlement and a non-2xx answer is the seller
 * rejecting the payment (harness `not_paid`, sent as `error`); otherwise delivery validators, then goods
 * validators, then price. A header without `success: false` counts as settled: the index checks the chain.
 */
export function harnessOutcome(i: OutcomeInput): TelemetryOutcome {
  if (i.outcome !== "ok" && i.outcome !== "validator_failed") {
    // payment_rejected is the harness's not_paid, which a v2 row names `error`. The client sends no row for it, nor for
    // insufficient_funds (nothing was signed; a wallet that cannot pay says nothing about the seller), nor for the
    // buyer's own rules (UNREPORTED_REFUSALS), which have no name in the contract.
    return PASS_THROUGH.has(i.outcome) ? (i.outcome as TelemetryOutcome) : "error";
  }
  const failed = new Set(i.validatorFailures);
  const delivered = i.status !== undefined ? i.status >= 200 && i.status < 300 : !failed.has("http_status");
  const n = i.settlements ?? (i.settlementSuccess === false ? 0 : 1);
  if (n === 0 && !delivered) return "error";
  if (n > 1) return "duplicate";
  // A paid non-2xx is non-delivery even when the caller turned http_status off.
  if (!delivered || DELIVERY_VALIDATORS.some((v) => failed.has(v))) return "non_delivery";
  if (GOODS_VALIDATORS.some((v) => failed.has(v))) return "wrong_goods";
  if (i.amountAtomic !== undefined && i.referenceAtomic !== undefined && exceedsRatio(i.amountAtomic, i.referenceAtomic, DEFAULT_MAX_RATIO)) {
    return "overcharge";
  }
  return "ok";
}

/** v2 `validator_failures`: names, with the status on http_status ("http_status:500") as in the contract. */
export function failureLabels(names: readonly string[], status: number | undefined): string[] {
  return names.map((n) => (n === "http_status" && status !== undefined ? `${n}:${status}` : n));
}
