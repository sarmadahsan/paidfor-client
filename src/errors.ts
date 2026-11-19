import type { Receipt } from "./receipt.js";
import type { TeamDecision } from "./team.js";

export type SafeFetchErrorCode =
  | "refused_verdict"
  | "refused_ratio"
  | "refused_max_per_call"
  | "refused_authorize"
  | "no_acceptable_quote"
  | "insufficient_funds"
  | "intent_conflict"
  | "intent_indeterminate"
  | "intent_in_flight"
  | "paid_no_response"
  | "network"
  | "sdk";

/** Every error this package throws. `receipt` is set whenever a call got far enough to write one. */
export class SafeFetchError extends Error {
  override name = "SafeFetchError";
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly receipt?: Receipt,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Refused before any signature: seller verdict, price ratio, per-call cap, or `authorize`. Nothing was paid. */
export class PaymentRefusedError extends SafeFetchError {
  override name = "PaymentRefusedError";
  constructor(
    code: "refused_verdict" | "refused_ratio" | "refused_max_per_call" | "refused_authorize",
    message: string,
    readonly sellerUrl: string | null,
    receipt?: Receipt,
  ) {
    super(code, message, receipt);
  }
}

/**
 * The team (the `team` option) did not approve this payment, or could not be asked. Nothing was paid. `decision` says
 * why: `needs_approval` carries the `approve_url` to show a person (then call again with the same intentId),
 * `already_settled` means this intent was paid before, `decline` carries the server's `reason`, `failed` means the
 * team could not be asked. An `approve` here was unusable (malformed, or about to lapse) and is reported as not paid.
 * Always code `refused_authorize`.
 */
export class TeamRefusedError extends PaymentRefusedError {
  override name = "TeamRefusedError";
  constructor(
    readonly decision: TeamDecision,
    message: string,
    sellerUrl: string | null,
    receipt?: Receipt,
  ) {
    super("refused_authorize", message, sellerUrl, receipt);
  }
}

/**
 * The wallet holds less of the quoted asset than the quote asks for, read on chain before signing. Nothing was signed
 * or sent; a retry with the same intentId once the wallet is funded pays normally. Code `insufficient_funds`.
 */
export class InsufficientFundsError extends SafeFetchError {
  override name = "InsufficientFundsError";
  constructor(
    message: string,
    /** The wallet that would have paid (checksummed, as the signer gives it). */
    readonly address: string,
    /** Its balance of the quoted asset, in USDC ("0.000000"). */
    readonly balanceUsdc: string,
    /** What the quote asks for, in USDC. */
    readonly amountUsdc: string,
    receipt?: Receipt,
  ) {
    super("insufficient_funds", message, receipt);
  }
}

/** Same intentId, different request. Nothing was sent. */
export class IntentConflictError extends SafeFetchError {
  override name = "IntentConflictError";
}

/** A payment for this intent was signed (and may have been sent) but no result was stored. Never re-signed. */
export class IntentIndeterminateError extends SafeFetchError {
  override name = "IntentIndeterminateError";
}
