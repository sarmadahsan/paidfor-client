# @paidfor/x402-safe-fetch

A drop-in wrapper around the official [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) client (2.28.x)
that protects the buyer before and after paying. It refuses overpriced quotes and sellers rated "avoid", never
pays twice for the same intent, and checks what it bought.

This is the client-side half of the x402 seller index at [paidfor.dev](https://paidfor.dev).

```bash
npm install @paidfor/x402-safe-fetch
```

```ts
import { safeFetch } from "@paidfor/x402-safe-fetch";

const fetchWithPay = safeFetch(walletClient, {
  maxPerCallUsd: 0.50,
  maxOverListedRatio: 1.1,     // refuse quotes more than 10% above the listed/known price
  refuseVerdicts: ["avoid"],   // consult the index; "caution" is allowed but logged
  indexUrl: "https://paidfor.dev/v1",
  validators: ["http_status", "non_empty", "content_type", "not_truncated"],
  telemetry: "anonymous",      // or "off" (the default)
  receiptsDir: "./.x402-receipts",
});

const res = await fetchWithPay(url, init, { intentId: "topup:acct_42:2026-10" });
console.log(res.status, res.receipt.outcome, res.receipt.tx_hash);
```

`walletClient` is a viem account (`privateKeyToAccount(...)`) or a viem `WalletClient` with an account attached.
Payments are exact-scheme USDC on Base mainnet by default (`network: "eip155:84532"` for Base Sepolia).

## What happens on every call

1. **Before paying.** The unpaid request gets the 402 quote. The client asks the index
   (`GET {indexUrl}/check?url=`, query string stripped) for the seller verdict and the resource's listed price,
   with a 2-second timeout. It compares the quote to the listed price, or, when the index has none, to the last
   price this client paid for the same resource. It refuses with a `PaymentRefusedError` when the seller verdict
   is in `refuseVerdicts`, the quote exceeds `maxOverListedRatio` times the reference, or the amount exceeds
   `maxPerCallUsd`. The error says why and links the seller page. The index is advisory: if it is down, slow or
   answers `unknown`, the call proceeds on the local checks and the receipt says `index: "unavailable"`.
2. **Idempotency.** Every call has an `intentId`, yours or a generated one. The request hash is written to the
   receipts directory before signing, and the signed nonce is written before the payment is sent. A retry with
   the same `intentId` and request returns the stored response and never signs again. A retry with the same
   `intentId` and a different request throws `IntentConflictError`. If a payment was signed but no response was
   stored, a retry throws `IntentIndeterminateError` instead of paying again.
3. **After the response.** The configured validators run on the paid response. `res.receipt` carries the intent
   id, quote, amount, reference price and its source, seller verdict, validator results, the settlement header,
   and the on-chain tx hash when the header carries it. The same receipt is written to the receipts directory as
   one JSON file per call.
4. **Telemetry, when enabled.** One outcome-only POST, fire-and-forget. See below.

## What it blocks and what it does not

| Blocks | Does not block |
| --- | --- |
| Paying a seller the index rates `avoid` (or any verdict you list) | A bad seller the index has not rated yet, or any seller while the index is unreachable |
| A quote more than `maxOverListedRatio` above the index listed price | An overpriced first purchase from a resource with no listed price and no local history |
| A quote more than `maxOverListedRatio` above the last price this client paid | Slow price creep, if you keep accepting each step |
| Any single payment above `maxPerCallUsd` | Total spend across many calls: there is no daily or per-seller budget |
| Paying twice for the same `intentId`, across restarts and concurrent processes | Duplicates when each retry uses a new `intentId` (pass a stable one) |
| Re-signing after a timeout or crash once a payment was signed | Recovering that money: the call fails with the nonce so you can check the chain |
| Non-USDC assets, other networks, non-`exact` schemes, and redirects of the paid request | A seller that settles and then serves wrong or stale content that still passes the four validators |
| Silent non-delivery: a paid 4xx/5xx, empty, wrong content type or truncated body is flagged in the receipt | Getting the money back: validators report failures, they do not refund or dispute |

## Receipts directory

```
.x402-receipts/
  2026-10-28T12-00-00-000Z-a1b2c3.json   one receipt per call
  intents/<sha256(intentId)>.json        idempotency state and the stored response
  prices.json                            last price paid per resource (method + origin + path)
  debug.log                              telemetry failures, local only
```

Keep this directory if you want the idempotency guarantee to survive restarts.

## Telemetry

Off by default. With `telemetry: "anonymous"`, each call that got a 402 posts exactly this to
`{indexUrl}/telemetry`, with a 1-second timeout, never awaited, every failure swallowed:

```json
{ "v": 1, "host": "api.example.com", "path_hash": "<sha256 hex of the path>", "outcome": "ok",
  "amount_usdc": "0.010000", "latency_ms": 412, "validator_failures": [], "client": "x402-safe-fetch/0.1.0" }
```

No bodies, no wallet address, no request parameters, no intent id. The field list and the privacy promise are in
[docs/telemetry.md](docs/telemetry.md).

## Errors

| Error | `code` | Paid? |
| --- | --- | --- |
| `PaymentRefusedError` | `refused_verdict`, `refused_ratio`, `refused_max_per_call` | No |
| `IntentConflictError` | `intent_conflict` | No |
| `IntentIndeterminateError` | `intent_indeterminate` | Maybe, earlier; never again |
| `SafeFetchError` | `paid_no_response` | Signed and possibly settled; `receipt.nonce` identifies it |
| `SafeFetchError` | `no_acceptable_quote`, `intent_in_flight`, `network`, `sdk` | No |

## Example

[examples/conway-topup.ts](examples/conway-topup.ts) reproduces an auto-top-up that was paid, got a 500, and
retried every 60 seconds, and shows the idempotency guard and the `http_status` validator stopping it.

## Provenance

The 402 parsing, settlement decoding, pre-sign and post-sign checks, price ratio arithmetic and the four
validators are ported from the x402-audit measurement harness behind paidfor.dev, with their unit tests.

## License

MIT
