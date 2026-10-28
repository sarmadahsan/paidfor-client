import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { writeJsonDurable } from "./fsutil.js";
import type { Verdict } from "./index-client.js";
import type { ReferenceSource } from "./price.js";
import type { ValidatorName } from "./taxonomy.js";
import type { SettlementResponse } from "./x402/types.js";
import type { ValidatorResult } from "./validators/types.js";

export type Outcome =
  | "ok"
  | "validator_failed"
  | "refused_verdict"
  | "refused_ratio"
  | "refused_max_per_call"
  | "no_acceptable_quote"
  | "no_payment_required"
  | "paid_no_response"
  | "replayed"
  | "error";

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
  /** True when a payment authorization was sent to the seller. */
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
  settlement: { header: string | null; version: 1 | 2 | null; parsed: SettlementResponse | null; parse_error: string | null };
  tx_hash: string | null;
  nonce: string | null;
  response: { status: number; content_type: string | null; bytes_inspected: number; body_truncated_for_validation: boolean } | null;
  error: { code: string; message: string } | null;
}

/** One JSON file per call: <receiptsDir>/<timestamp>-<random>.json. Returns the file name. */
export async function writeReceipt(dir: string, r: Receipt): Promise<string> {
  const name = `${r.started_at.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.json`;
  await writeJsonDurable(join(dir, name), r);
  return name;
}
