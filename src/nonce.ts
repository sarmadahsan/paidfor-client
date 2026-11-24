/**
 * The EIP-3009 nonce derived from the purchase (0.8.0), instead of 32 random bytes from the SDK. Two signatures for
 * the same purchase then carry the same nonce, and the USDC contract settles at most one of them (the second fails
 * with AuthorizationUsed), even when the intent store that would have stopped the second signature is gone.
 *
 * Derivation, so that anyone holding a receipt can check it:
 *
 *   nonce = HMAC-SHA256(key, JSON.stringify([intentId, payer, payTo, amountAtomic]))
 *   key   = "x402-safe-fetch:eip3009-nonce:v1"   (domain separation, not a secret)
 *   payer and payTo lowercase 0x-hex, amountAtomic the decimal string of the quote's atomic amount.
 *
 * The result is 32 bytes as 0x-hex. The key is public: a nonce is only a uniqueness tag per payer and token
 * contract, and nobody but the payer can sign under it. Including pay-to and amount means the same intent id used for
 * another purchase (another seller, another price) gets another nonce and is not blocked on chain; the intent store's
 * request hash still refuses that reuse while it exists.
 */
import { createHmac } from "node:crypto";

export const NONCE_KEY = "x402-safe-fetch:eip3009-nonce:v1";

export interface NonceInput {
  intentId: string;
  /** authorization.from */
  payer: string;
  /** requirements.payTo */
  payTo: string;
  /** Decimal string of atomic units. */
  amountAtomic: string;
}

export function deriveNonce(i: NonceInput): `0x${string}` {
  const message = JSON.stringify([i.intentId, i.payer.toLowerCase(), i.payTo.toLowerCase(), i.amountAtomic]);
  return `0x${createHmac("sha256", NONCE_KEY).update(message).digest("hex")}`;
}
