import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { writeJsonDurable } from "./fsutil.js";
import type { Verdict } from "./index-client.js";
import type { ReferenceSource } from "./price.js";
import type { TelemetryOutcome, TelemetryProof } from "./proof.js";
import type { ValidatorName } from "./taxonomy.js";
import type { TeamReceipt } from "./team.js";
import type { SettlementResponse } from "./x402/types.js";
import { isFormatWarning } from "./validators/content_type.js";
import type { ValidatorResult } from "./validators/types.js";

export type Outcome =
  | "ok"
  | "validator_failed"
  | "refused_verdict"
  | "refused_ratio"
  | "refused_max_per_call"
  | "refused_authorize"
  | "no_acceptable_quote"
  | "no_payment_required"
  | "paid_no_response"
  | "payment_rejected"
  | "insufficient_funds"
  | "replayed"
  | "error";

/**
 * Something the caller should know about a call that did not fail it (0.7.0). Today only the format rule: the paid
 * answer is usable but in another format than the seller declared (`content_type_mismatch`), or carried no
 * Content-Type header (`missing_content_type`). The outcome stays `ok`.
 */
export interface ReceiptWarning {
  code: "content_type_mismatch" | "missing_content_type";
  validator: ValidatorName;
  /** The media type the seller declared in its 402; null when it declared none (application/json was expected). */
  declared: string | null;
  /** The media type of the response; null when it had no Content-Type header. */
  received: string | null;
  message: string;
}

export interface Receipt {
  v: 1;
  client: string;
  intent_id: string;
  request_hash: string;
  url: string;
  method: string;
  started_at: string;
  finished_at: string;
  latency_ms: number;
  outcome: Outcome;
  /**
   * True when a payment authorization was sent to the seller and the seller did not reject it. False for
   * `payment_rejected` (sent, but answered HTTP 402 with no settlement): see `nonce` and `valid_before`.
   */
  paid: boolean;
  /** True when this result was served from the intent store without contacting the seller. */
  replayed: boolean;
  /** For a replay: the receipt file of the call that actually paid. */
  replay_of: string | null;
  /** For a replay: the full receipt of the call that actually paid, when its file is still there. */
  original: Receipt | null;
  quote: {
    x402_version: 1 | 2;
    scheme: string;
    network: string;
    asset: string;
    pay_to: string;
    amount_atomic: string;
    amount_usdc: string;
    max_timeout_seconds: number;
    resource_url: string | null;
  } | null;
  /** Amount of the signed authorization, USDC. "0.000000" when nothing was signed. */
  amount_usdc: string;
  reference: { amount_usdc: string; source: ReferenceSource; ratio: number; max_ratio: number } | null;
  seller: { host: string | null; verdict: Verdict; verdict_text: string | null; seller_url: string | null; evidence_url: string | null };
  index: "ok" | "unavailable" | "off";
  index_note: string | null;
  validators: Partial<Record<ValidatorName, ValidatorResult>>;
  validator_failures: ValidatorName[];
  /** Warnings that did not fail the call (0.7.0; absent on older receipts). See ReceiptWarning. */
  warnings?: ReceiptWarning[];
  settlement: { header: string | null; version: 1 | 2 | null; parsed: SettlementResponse | null; parse_error: string | null };
  tx_hash: string | null;
  nonce: string | null;
  /** authorization.from of the signed payment, lowercase. */
  payer: string | null;
  /**
   * authorization.validBefore of the signed payment, Unix seconds: until then the authorization could still be
   * settled by whoever holds it. Null when nothing was signed. (0.6.0; absent on older receipts.)
   */
  valid_before?: number | null;
  /** Proof of payment for a sent authorization (the `proof` of a v2 telemetry row). Null when nothing was sent. */
  proof: TelemetryProof | null;
  /** The outcome under the harness names, as a v2 telemetry row reports it. */
  reported_outcome: TelemetryOutcome | null;
  /**
   * {indexUrl}/telemetry/<payer>/<nonce>: whether the index verified this purchase on-chain. Set only when
   * telemetry is "verified" and a proof was sent.
   */
  verification_url: string | null;
  response: {
    status: number;
    content_type: string | null;
    bytes_inspected: number;
    body_truncated_for_validation: boolean;
    /** sha256 hex of the response body; null when it was longer than the validator cap and not fully read. */
    sha256: string | null;
  } | null;
  error: { code: string; message: string } | null;
  /**
   * Team mode only (the `team` option): what the team decided, its `warnings`, and what became of the outcome report.
   * `outcome_report` is filled in after the receipt file is written, so it is on the returned receipt only.
   */
  team?: TeamReceipt;
}

/** The receipt's `warnings` from the validator results: a content_type pass with a format warning. */
export function receiptWarnings(results: Partial<Record<ValidatorName, ValidatorResult>>): ReceiptWarning[] {
  const out: ReceiptWarning[] = [];
  const ct = results.content_type;
  if (isFormatWarning(ct)) {
    const declared = ct.evidence.expected_source === "requirements" && typeof ct.evidence.expected === "string" ? ct.evidence.expected : null;
    const received = typeof ct.evidence.actual === "string" ? ct.evidence.actual : null;
    const want = declared ? `the seller declared ${declared}` : "the seller declared no type (application/json was expected)";
    const got = received ? `the response is ${received}` : "the response has no Content-Type header";
    out.push({
      code: ct.reason,
      validator: "content_type",
      declared,
      received,
      message: `${want} and ${got}; the content is returned as sent and the call is not counted as a failure`,
    });
  }
  return out;
}

/** One JSON file per call: <receiptsDir>/<timestamp>-<random>.json. Returns the file name. */
export async function writeReceipt(dir: string, r: Receipt): Promise<string> {
  const name = `${r.started_at.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.json`;
  await writeJsonDurable(join(dir, name), r);
  return name;
}
