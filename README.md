# @paidfor/x402-safe-fetch

A drop-in wrapper around the official [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) client (2.28.x)
that protects the buyer before and after paying. It refuses overpriced quotes and sellers rated "avoid", never
pays twice for the same intent, and checks what it bought. No account, no key, nothing to sign up for: not to
install it, not to read the index, and not to contribute telemetry.

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
  telemetry: "verified",       // or "anonymous" (no proof of payment) or "off" (the default)
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
4. **Telemetry, when enabled.** One POST per call, fire-and-forget. See below.

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
  .verified-telemetry-notice             marks that the one-time "verified" notice was shown
```

Each receipt for a paid call has a `proof` (the same object a verified telemetry row carries) and, with
`telemetry: "verified"`, a `verification_url` of the form `{indexUrl}/telemetry/<payer>/<nonce>`, where you can
later see whether the index verified your row on-chain. **That route is not live yet: until the index ships it,
the URL answers 404.** `reported_outcome` is the outcome under the harness names, as the row reports it.

Keep this directory if you want the idempotency guarantee to survive restarts.

## Telemetry

Three settings. Every one is fire-and-forget: a 1-second timeout, never awaited, every failure swallowed and
only counted in `debug.log`. Nothing is sent for free resources (no 402) or for replays of a stored intent.

| `telemetry` | Sends |
| --- | --- |
| `"off"` (default) | Nothing. |
| `"anonymous"` | A v1 row: the outcome, amount, latency and validator names. No wallet address, no proof. |
| `"verified"` | A v2 row: the same fields with the outcome under the index's names, plus a proof of payment the index checks on Base. |

v1 row:

```json
{ "v": 1, "host": "api.example.com", "path_hash": "<sha256 hex of the path>", "outcome": "ok",
  "amount_usdc": "0.010000", "latency_ms": 412, "validator_failures": [], "client": "x402-safe-fetch/0.3.0" }
```

Both payloads and every field are documented in [docs/telemetry.md](docs/telemetry.md).

## What verified telemetry sends and why

paidfor.dev measures sellers with its own wallet, which cannot cover the whole market. With
`telemetry: "verified"`, each of your purchases becomes a data point the index can trust, because it can prove
on-chain that you actually paid: it looks up the `AuthorizationUsed(payer, nonce)` event and the matching USDC
`Transfer` on Base. Rows that do not verify are stored but never counted.

> **Status:** paidfor.dev verifies v2 rows on Base within about five minutes; `verification_url` shows the
> result for each row.

This is the whole message, for a paid call that got a 500:

```json
{
  "v": 2,
  "host": "api.example.com",
  "path_hash": "<sha256 hex of the URL path without trailing slash>",
  "outcome": "non_delivery",
  "amount_usdc": "0.002000",
  "latency_ms": 1840,
  "validator_failures": ["http_status:500"],
  "client": "x402-safe-fetch/0.3.0",
  "proof": {
    "network": "eip155:8453",
    "scheme": "exact",
    "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "pay_to": "<seller pay-to address, lowercase>",
    "payer": "<your wallet address, lowercase>",
    "nonce": "<32-byte EIP-3009 authorization nonce>",
    "tx_hash": "<settlement transaction hash, or null if the seller's header had none>",
    "settled_at": "2026-10-29T10:12:03.000Z",
    "response_sha256": "<sha256 hex of the response body, or null>",
    "declared_timeout_s": 60
  }
}
```

- **What the payer address adds.** Every settled x402 payment is already a public USDC transfer from your
  address to the seller's pay-to address, with this nonce, on Base; the address, the amount and the seller's
  pay-to are readable by anyone. What the row adds is the link from that payment to the seller host, the path
  hash, the outcome you observed, the validator failures and the response hash. Use `"verified"` only if you
  are comfortable with that association; `"anonymous"` sends the outcome without it.
- **The plain path, for unknown sellers only (0.2.1).** When the index answered `unknown` before paying (it has
  never measured that seller), the row also carries `"path": "/v1/quote"`: the URL path, never the query string
  or fragment. The index keeps the host and path of a verified payment to such a seller so it can buy that
  seller itself at its next scheduled run, and lists it at paidfor.dev/candidates. For every seller the index
  knows, only `path_hash` is sent, as before. `"anonymous"` never sends a path.
- **Keyless ingest, https only.** `POST {indexUrl}/telemetry` needs no account and no key, and the index stores
  no IP address or identity with the row. With `"verified"`, `safeFetch` refuses a plain-http `indexUrl`
  (loopback excepted, for local testing), and telemetry never follows a redirect.
- **Client header (0.2.2).** Every request to the index, the pre-pay check and the telemetry POST, carries
  `X-Paidfor-Client: x402-safe-fetch/<version>`: the package name and version, nothing else. The index uses it
  only to count calls per client.
- **Bodies and request parameters never leave your machine.** The path is hashed, the query string is dropped
  before hashing, and the response is represented only by its sha256. Headers, request bodies, the intent id and
  validator evidence are never sent.
- **Refusals carry no proof.** A refused or unpaid call sends the row without `proof`; it is counted as a
  refusal, never in a failure rate. A refusal by `authorize` sends no row at all: a buyer's own rule says nothing
  about the seller.
- **Outcomes use the index's names:** `ok`, `non_delivery` (a non-2xx answer or a failed delivery validator after paying),
  `overcharge` (paid more than 1.1x the reference, possible only if you raised `maxOverListedRatio`),
  `wrong_goods`, `duplicate`, plus the client-only `refused_*`, `no_acceptable_quote`, `paid_no_response` and
  `error`.
- **Turning it off.** `telemetry: "anonymous"` sends the v1 row without any address; `telemetry: "off"` (the
  default) sends nothing. `indexUrl: false` turns off the index lookup and all telemetry.

The first time a receipts directory is used with `"verified"`, the client prints a one-line notice pointing
here.

## With a team account

A free [paidfor team account](https://paidfor.dev/team) adds budgets per wallet, human approvals and a ledger. Add
the team key, nothing else:

```ts
const fetchWithPay = safeFetch(account, {
  maxPerCallUsd: 0.5,
  team: { key: process.env.PAIDFOR_TEAM_KEY! },
});
```

What you get:

- Before signing, every payment asks `https://paidfor.dev/v1/team/authorize` and signs only with the nonce and
  deadline the team minted. Anything but a clean approval pays nothing and throws `TeamRefusedError` (code
  `refused_authorize`): a decline (`decision.reason`, `decision.message`), a payment waiting for a person
  (`decision.approve_url` and `decision.expires_at`: show the link, then call again with the same `intentId`), an
  intent the team already saw paid (`already_settled`), or a team that could not be asked (timeout, 5xx, an answer
  it could not read). Your local caps still apply: a payment must pass both.
- Every approval's outcome, paid or not, is reported to the team's ledger. A report the server could not take is
  kept in `<receiptsDir>/team-outcomes` and sent before the next payment (in memory, until the process ends, if
  the disk cannot take it).
- `receipt.team` says what the team decided, carries any `warnings` the server sent, and `outcome_report` (`sent`,
  `queued` or `rejected`).

The wallet must be registered to the team: on [paidfor.dev/team](https://paidfor.dev/team), or with
`npx -y @paidfor/mcp@0.7.0 init --wallet --link` (add `--key-file <path>` for a key file of your own). The key goes
only to the team origin, never to a seller, and is never logged. `team` also takes `origin` (https only, or
http on localhost), `authorizeTimeoutMs` (default 10000) and `reportTimeoutMs` (default 5000).

When `team` is left out and `PAIDFOR_TEAM_KEY` is set in the environment, team mode turns on by itself (a
one-line notice says so); `team: false` turns it off. `team` and `authorize` together throw: `team` supplies its own
`authorize`, and with your own `authorize` the environment is not read.

## Ask before paying

`authorize` asks a service of yours (a budget, a person) about each payment, after the local checks and before anything
is signed. It fails closed: a throw, or anything but a well-formed approval, refuses with `refused_authorize`.

```ts
const fetchWithPay = safeFetch(account, {
  maxPerCallUsd: 0.5,
  authorize: async (q) => {
    const d = await askYourPolicyServer(q); // q: intentId, url, payer, payTo, amountAtomic, network, asset, scheme
    return d.ok ? { approve: true, nonce: d.ref, validBefore: d.deadline } : { approve: false, message: d.why };
  },
});
```

The payment is signed with that `nonce` (32 bytes of hex) and `validBefore` (Unix seconds), so the approval can be found
on chain. A refusal by `authorize` sends no telemetry.

## Report-only: keep your own x402 client, add one line

Already paying with Coinbase's `x402-fetch` / `@x402/fetch` or `x402-axios` / `@x402/axios`? Keep your wallet and your
setup; wrap the result and every paid call reports its outcome to the index. No pre-pay check, no guard, no key, no
account: report-only sends the [tx_only row](docs/telemetry.md#tx_only-report-only) after the payment you already made.

```ts
import { wrapFetchWithPayment } from "x402-fetch"; // or "@x402/fetch"
import { withPaidforReporting } from "@paidfor/x402-safe-fetch";

const fetchWithPay = withPaidforReporting(wrapFetchWithPayment(fetch, wallet)); // the one added line
```

```ts
import axios from "axios";
import { withPaymentInterceptor } from "x402-axios"; // or wrapAxiosWithPayment from "@x402/axios"
import { withPaidforReportingAxios } from "@paidfor/x402-safe-fetch";

const api = withPaidforReportingAxios(withPaymentInterceptor(axios.create({ baseURL }), wallet));
```

The wrapped fetch (or instance) behaves exactly as before. After each response that carries a settlement on Base
(`PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`), it posts the host, the plain path, `ok` for a 2xx or `non_delivery`
otherwise, the status, and the settlement transaction hash, without waiting and never throwing. The index reads the
payer and the amount from that transaction on Base and counts the report in the seller's reported series only once it
is verified. Pass `classify` to set the outcome yourself (or return `null` and call `reportOnly().report()` after your
own checks). Responses without a settlement (free calls, refusals) send nothing.

## Errors

| Error | `code` | Paid? |
| --- | --- | --- |
| `PaymentRefusedError` | `refused_verdict`, `refused_ratio`, `refused_max_per_call`, `refused_authorize` | No |
| `TeamRefusedError` (a `PaymentRefusedError`) | `refused_authorize`; `decision` says why | No |
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
