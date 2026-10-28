import type { Receipt } from "./receipt.js";

export type SafeFetchErrorCode =
  | "refused_verdict"
  | "refused_ratio"
  | "refused_max_per_call"
  | "no_acceptable_quote"
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

/** Refused before any signature: seller verdict, price ratio, or per-call cap. Nothing was paid. */
export class PaymentRefusedError extends SafeFetchError {
  override name = "PaymentRefusedError";
  constructor(
    code: "refused_verdict" | "refused_ratio" | "refused_max_per_call",
    message: string,
    readonly sellerUrl: string | null,
    receipt?: Receipt,
  ) {
    super(code, message, receipt);
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
