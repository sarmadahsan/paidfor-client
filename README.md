# @paidfor/x402-safe-fetch

A drop-in wrapper around the official [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) client (2.28.x)
that checks the seller and the quote before paying and the answer after. It refuses overpriced quotes and sellers
rated "avoid", keeps every payment under caps you set (per call, per day, per seller, and a lower one for a first
payment to a stranger), never pays twice for the same intent, and checks what it bought. No account, no key, nothing to
sign up for: not to install it, not to read the index, and not to contribute to it.

**It reports each purchase outcome to the index by default**, with its proof of payment (see
[Telemetry](#telemetry)). That is the deal that keeps paidfor free: the index is made from these reports. On the Free
plan, with or without an account, reporting is on and cannot be turned off. A Team plan with a switch for it is
[coming soon](https://paidfor.dev/pricing); nothing that turns it off is sold today.

This is the client-side half of the x402 seller index at [paidfor.dev](https://paidfor.dev). Paying from an agent
(Claude, Cursor, Codex) rather than from your own code? Set up the paidfor MCP server from https://paidfor.dev/install.

## Quickstart

Install the library and `viem`, which the example uses to load the wallet. `viem` is not a dependency or a peer
dependency of this package (you bring the wallet), so it has to be installed next to it; with pnpm, importing it
without that fails with `ERR_MODULE_NOT_FOUND`.

```bash
pnpm add @paidfor/x402-safe-fetch@0.8.0 viem
# or: npm install @paidfor/x402-safe-fetch@0.8.0 viem
```

Save this as `pay.mjs` and run `node pay.mjs <x402 URL>` (Node 20.3 or later) with `PRIVATE_KEY` set in the
environment to the 0x-prefixed key of a wallet holding USDC on Base. Load it from a secrets manager or an untracked
file, not from your repository or your shell history.

```js
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { safeFetch } from "@paidfor/x402-safe-fetch";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const fetchWithPay = safeFetch(account, {
  maxPerCallUsd: 0.5,
  maxPerDayUsd: 5,             // 0.8.0: the day's total across every seller; see "Caps and switches"
  maxOverListedRatio: 1.1,     // refuse quotes more than 10% above the listed/known price
  refuseVerdicts: ["avoid"],   // consult the index; "caution" is allowed, and logged when it is paid
  indexUrl: "https://paidfor.dev/v1",
  validators: ["http_status", "non_empty", "content_type", "not_truncated"],
  receiptsDir: "./.x402-receipts",
  // Reporting to the index is on by default and, on the Free plan, cannot be turned off (see Telemetry).
});

// One id per purchase, minted once with a random part. To retry the same purchase after an error or a timeout,
// pass the id it printed: node pay.mjs <x402 URL> <intent id>
const intentId = process.argv[3] ?? `report:${randomUUID()}`;
console.log("intent", intentId);
const res = await fetchWithPay(process.argv[2], {}, { intentId });
console.log(res.status, res.receipt.outcome, res.receipt.tx_hash);
```

Reuse an `intentId` only to retry the same purchase after an error or a timeout (it is what stops a second payment);
every new purchase needs a new one. Never build the id from the task and the date alone: a second real purchase on
the same day would get the first one's stored result back instead of being paid for.

`safeFetch` also takes a viem `WalletClient` with an account attached. Payments are exact-scheme USDC on Base mainnet
by default (`network: "eip155:84532"` for Base Sepolia). Before signing, it reads the wallet's USDC balance from a
public Base RPC, and an empty wallet stops there with an `InsufficientFundsError` (see
[An empty wallet](#an-empty-wallet)).

## What happens on every call

1. **Before paying.** The unpaid request gets the 402 quote. The client asks the index
   (`GET {indexUrl}/check?url=`, query string stripped) for the seller verdict and the resource's listed price,
   with a 2-second timeout. It compares the quote to the listed price, or, when the index has none, to the last
   price this client paid for the same resource. It refuses with a `PaymentRefusedError` when the seller verdict
   is in `refuseVerdicts`, the quote exceeds `maxOverListedRatio` times the reference, or the amount exceeds
   `maxPerCallUsd`. Since 0.8.0 it also refuses when payments are [frozen](#freeze-switch), when the quote would take
   the day over `maxPerDayUsd` or the seller over `maxPerSellerPerDayUsd`, when a first payment to a stranger is
   above `maxFirstPaymentUsd`, or when the amount is above `approveAbove` and no person has approved it; and it
   warns (or, with `refuseUnknownPayTo`, refuses) when the quote's pay-to address is not one the index has seen the
   seller use ([Caps and switches](#caps-and-switches-080)). The error says why and links the seller page. The index
   is advisory: if it is down, slow or answers `unknown`, the call proceeds on the local checks and the receipt says
   `index: "unavailable"`. Last, it reads the wallet's balance of the quoted asset and throws `InsufficientFundsError`
   when it is below the quote (0.7.2, [below](#an-empty-wallet)).
2. **Idempotency.** Every call has an `intentId`, yours or a generated one. The request hash is written to the
   receipts directory before signing, and the signed nonce is written before the payment is sent. Since 0.8.0 the
   nonce itself is derived from the intent ([below](#the-nonce-comes-from-the-intent)), so even a client whose
   receipts directory is gone signs the same nonce for the same purchase, and the USDC contract settles only one. A retry with
   the same `intentId` and request returns the stored response and never signs again. A retry with the same
   `intentId` and a different request throws `IntentConflictError`. If a payment was signed but no response was
   stored, a retry throws `IntentIndeterminateError` instead of paying again. A payment the seller rejected
   (`payment_rejected`, below) may be retried with the same `intentId` from the same wallet: it signs the same
   nonce again, so at most one of the two authorizations can ever settle.
3. **After the response.** The configured validators run on the paid response. `res.receipt` carries the intent
   id, quote, amount, reference price and its source, seller verdict, validator results, the settlement header,
   and the on-chain tx hash when the header carries it. The same receipt is written to the receipts directory as
   one JSON file per call.
4. **Telemetry.** One POST per call to the index, fire-and-forget, on by default. See below.

## What it blocks and what it does not

| Blocks | Does not block |
| --- | --- |
| Paying a seller the index rates `avoid` (or any verdict you list) | A bad seller the index has not rated yet, or any seller while the index is unreachable |
| A quote more than `maxOverListedRatio` above the index listed price | An overpriced first purchase from a resource with no listed price and no local history |
| A quote more than `maxOverListedRatio` above the last price this client paid | Slow price creep, if you keep accepting each step |
| Any single payment above `maxPerCallUsd`; the day's total above `maxPerDayUsd`; a seller's day above `maxPerSellerPerDayUsd`; a first payment to a stranger above `maxFirstPaymentUsd`; any amount above `approveAbove` until a person says yes; everything while frozen (0.8.0) | Spend by another wallet, or by a client with another receipts directory: the ledger is per directory |
| Paying a pay-to address the index has not seen the seller use, when `refuseUnknownPayTo` is on (0.8.0; a warning by default) | A rotated address at a seller the index does not know, or knows without an address on record |
| Signing for a wallet that holds less USDC than the quote (0.7.2) | A wallet emptied between the balance read and the payment, or any payment when the RPC cannot be read |
| Paying twice for the same `intentId`, across restarts and concurrent processes | Duplicates when each retry uses a new `intentId` (pass a stable one) |
| Re-signing after a timeout or crash once a payment was signed; and since 0.8.0 a second settlement for the same purchase even from a client whose receipts directory is gone (same nonce, so the chain rejects the second) | Recovering that money: the call fails with the nonce so you can check the chain |
| Non-USDC assets, other networks, non-`exact` schemes, and redirects of the paid request | A seller that settles and then serves wrong or stale content that still passes the four validators |
| Silent non-delivery: a paid 4xx/5xx, empty or truncated body, or an HTML page in place of the declared type, is flagged in the receipt | Getting the money back: validators report failures, they do not refund or dispute |

## Outcomes

`res.receipt.outcome` (and `err.receipt.outcome` on a thrown error):

| `outcome` | What happened | `paid` | Returned or thrown |
| --- | --- | --- | --- |
| `ok` | Paid, and every validator passed. A usable answer in another format than the seller declared is `ok` with a warning in `warnings` (0.7.0). | `true` | Returned |
| `validator_failed` | Paid, and a validator failed (a non-2xx answer, an empty or truncated body, an HTML or error page in place of the declared type, JSON that does not parse). | `true` | Returned |
| `payment_rejected` (0.6.0) | The signed payment was sent and the seller answered HTTP 402 again, with no settlement header or one saying it failed: usually a wallet without enough USDC whose balance could not be read before signing. Nothing settled. | `false` | Returned (status 402) |
| `insufficient_funds` (0.7.2) | The wallet holds less of the quoted asset than the quote. Nothing was signed or sent. | `false` | Thrown (`InsufficientFundsError`) |
| `paid_no_response` | Signed and maybe sent, and no response came back. | `true` if sent | Thrown |
| `refused_verdict`, `refused_ratio`, `refused_max_per_call`, `refused_authorize` | Refused before signing. | `false` | Thrown |
| `refused_max_per_day`, `refused_max_per_seller_per_day`, `refused_max_first_payment`, `refused_pay_to`, `needs_approval`, `frozen` (0.8.0) | Refused before signing by one of the [caps and switches](#caps-and-switches-080). No row is sent to the index; `reported_outcome` is null. | `false` | Thrown (`PaymentRefusedError`) |
| `no_acceptable_quote` | No exact USDC quote on the configured network. | `false` | Thrown |
| `no_payment_required` | The resource answered without a 402. | `false` | Returned |
| `replayed` | The stored result of an earlier call with this `intentId`. | `false` | Returned |
| `error` | Anything else before signing (network, SDK). | `false` | Thrown |

### Format warnings (0.7.0)

A paid answer whose content is usable but whose format differs from what the seller declared in its 402 (the seller
declares `application/json` and sends the article as `text/markdown`, or JSON labelled `text/plain`), or that has no
`Content-Type` header, is not a failed delivery. The receipt's outcome is `ok`, the `content_type` validator says
`pass` with `reason` `content_type_mismatch` (or `missing_content_type`) and `evidence.warning: true`, and
`receipt.warnings` says it in words:

```json
[{ "code": "content_type_mismatch", "validator": "content_type", "declared": "application/json", "received": "text/markdown",
   "message": "the seller declared application/json and the response is text/markdown; the content is returned as sent and the call is not counted as a failure" }]
```

It stays a failure (`validator_failed`) when the answer has the shape of an error rather than of content: an HTML page
(by its `Content-Type` or its first bytes) where HTML was not declared (an HTML label over a body that parses as JSON is
JSON mislabelled, so a warning), an undeclared `application/problem+json`
document, or a body that should be JSON and does not parse. A different `+json` type or parameters (`; charset=utf-8`)
are the same format and raise no warning. A seller that declares no type is judged against `application/json`.
Empty, truncated and non-2xx answers fail as before.

## Caps and switches (0.8.0)

Everything here runs before the signature, after the seller verdict and the price check, so a payment that is allowed
behaves exactly as before. Each refusal is a `PaymentRefusedError` whose `code` (and the receipt's `outcome`) names the
rule; nothing is signed, no row goes to the index, and the receipt carries the quote. None of these options is required.

| Option | Default | Refuses with | What it does |
| --- | --- | --- | --- |
| `maxPerCallUsd` | required | `refused_max_per_call` | Any single payment above it. |
| `maxPerDayUsd` | none | `refused_max_per_day` | The day's total (UTC), across every seller, from the spend ledger. |
| `maxPerSellerPerDayUsd` | none | `refused_max_per_seller_per_day` | One seller's total for the day, keyed by pay-to address. |
| `maxFirstPaymentUsd` | none | `refused_max_first_payment` | A first payment to a seller with no index listing and no local history. |
| `approveAbove` | none | `needs_approval` | Above it, a person has to say yes: call again with `{ approved: true }`. |
| `frozen` (or a `frozen` file) | `false` | `frozen` | Every payment, until cleared. |
| `refuseUnknownPayTo` | `false` | `refused_pay_to` | A pay-to address the index has not seen the seller use. Default: a warning. |

### Per-day cap

```ts
safeFetch(account, { maxPerCallUsd: 0.5, maxPerDayUsd: 5 });
```

`maxPerDayUsd` (USD, default none) caps what this client pays per UTC day across every seller. The quote that would
take the day over it is refused with `refused_max_per_day`; the message says what was already paid today and the cap.
The day's totals live in `<receiptsDir>/spend.json`, the spend ledger, written under a lock like the intent files, so
every process that shares the directory (and the wallet) shares the cap. Before signing, the amount is reserved in the
ledger; once the outcome is known, a paid call stays counted (with the amount signed) and anything else gives the
reservation back. So replays, refusals and free resources never count. Three things do count although nothing may have
moved, because the signed authorization could still settle: a payment signed and sent with no answer, a payment the
seller rejected (`payment_rejected`; its authorization stays usable until `valid_before`, and a retry of it counts
again, so the day may run ahead of what was paid by that amount), and a reservation whose process died before
settling, for the rest of the day. The checks before signing can wait on the index, the balance and an approval; the
caps are checked again right before the signature when that wait crossed UTC midnight, and a reservation is moved to
the day it signs on. Days before yesterday are pruned. The ledger is only written when one of `maxPerDayUsd`,
`maxPerSellerPerDayUsd` or `maxFirstPaymentUsd` is set. A ledger that cannot be read or written stops the payment (`sdk`
error, nothing signed).

In team mode the local caps apply as well, before the team is asked: a payment must pass both, as with
`maxPerCallUsd`. The team's own budgets are not changed by them.

### Per-seller cap

`maxPerSellerPerDayUsd` (USD, default none) caps one seller's total per UTC day, in the same ledger, keyed by the
quote's pay-to address in lowercase (the host, when the quote names no address). A seller that rotates its pay-to
starts a new key. Refuses with `refused_max_per_seller_per_day`.

### Stranger cap

`maxFirstPaymentUsd` (USD, default none) is a lower cap for the first payment to a stranger: a seller the index has no
listing for (it answered `unknown`, could not be reached, or `indexUrl` is `false`) and this client has never paid
(nothing under its host or pay-to in the spend ledger, and no price for its origin in `prices.json`). Refuses with
`refused_max_first_payment`. Once one payment to that seller has settled, `maxPerCallUsd` applies as for anyone else.
A seller the index lists is never a stranger, whatever its verdict.

### Approval threshold

`approveAbove` (USD, default none): a quote above it is refused with `needs_approval` instead of being paid, and the
message names the intent id. The receipt carries the quote (amount, pay-to, seller verdict) to show a person. When they
agree, call again with the same `intentId` and `{ approved: true }` as the third argument: that lifts `approveAbove`
for that call only, every other check still applies. For callers without team mode: `approveAbove` together with `team`
(or `PAIDFOR_TEAM_KEY` in the environment) throws when the client is made, because the team's account holds the
approval rules there (`TeamRefusedError` with `decision.approve_url`).

```ts
const f = safeFetch(account, { maxPerCallUsd: 5, approveAbove: 1 });
try {
  await f(url, {}, { intentId });
} catch (e) {
  if (e instanceof PaymentRefusedError && e.code === "needs_approval") {
    // show e.receipt.quote to a person, then:
    await f(url, {}, { intentId, approved: true });
  }
}
```

### Freeze switch

Two ways, both refuse every payment with `frozen` until cleared:

- `frozen: true` in the options (default `false`). Clear it by making the client again without it.
- A file named `frozen` in the receipts directory (`touch .x402-receipts/frozen`), whatever its content. Checked
  before every payment and again right before the signature (the checks in between can wait on an approval), so it
  stops a client that is already running; remove the file to clear it.

Free resources (no 402) and replays of a stored intent are not payments and still go through. A frozen client does not
wait for the index before refusing.

### Pay-to check

The index's answer to `/check` can carry the pay-to addresses it has seen the seller settle to (`pay_to_addresses`,
as `/v1/sellers` and `/v1/seller/{domain}` carry them). When it does and the quote's `pay_to` is not among them, the
receipt gets a warning:

```json
[{ "code": "unknown_pay_to", "pay_to": "0x…", "known_pay_to": ["0x…"], "message": "the quote pays 0x…, which is not among the address paidfor.dev has seen api.example.com settle to (0x…)" }]
```

The call still pays (outcome `ok`), and the v2 row carries `"warnings": ["unknown_pay_to"]`. Sellers rotate addresses
legitimately, so this is a warning by default. `refuseUnknownPayTo: true` (default `false`) refuses instead with
`refused_pay_to`, before signing; the warning stays on the refused receipt. A seller the index does not know, or knows
without an address on record, gets neither the warning nor the refusal. The price book keys prices by method, origin
and path, so a seller that keeps its price and changes its pay-to would otherwise pass without a word.

### The nonce comes from the intent

Since 0.8.0 the EIP-3009 nonce is not random. It is derived from the purchase:

```
nonce = HMAC-SHA256(key, JSON.stringify([intentId, payer, payTo, amountAtomic]))
key   = "x402-safe-fetch:eip3009-nonce:v1"
```

with `payer` and `payTo` as lowercase hex and `amountAtomic` the decimal string of the quote's atomic amount; the result
is 32 bytes as 0x-hex (`deriveNonce` is exported, so a receipt can be checked). The key is public: a nonce is only a
uniqueness tag per payer and token contract, and nobody but the payer can sign under it. What it buys: the intent store
already refuses to sign twice for one intent, but it lives in the receipts directory; if that directory is lost, a retry
of the same purchase from a fresh one would have signed a second, random nonce that could also settle. Now it signs the
same nonce, and USDC's `transferWithAuthorization` rejects the second with `AuthorizationUsed`. An approval's nonce
(`authorize`, team mode) and a rejected payment's nonce signed again both take precedence, as before. Because pay-to
and amount are in the derivation, the same intent id used for another seller or another price gets another nonce; the
intent store's request hash still refuses that reuse while it exists.

### An empty wallet

Since 0.7.2, after the seller, price and cap checks and before anything is signed (and before a team is asked), the
client reads the wallet's balance of the asset the quote asks for (USDC on the configured network) with one `eth_call`
of `balanceOf` to `rpcUrl`: https://mainnet.base.org on Base, https://sepolia.base.org on Base Sepolia by default. That
request carries the wallet address and the USDC contract address, nothing else. When the balance is below the quoted
amount, nothing is signed or sent and `InsufficientFundsError` (code `insufficient_funds`) is thrown; it carries
`address`, `balanceUsdc` and `amountUsdc`, and its message names all three. No row is sent to the index (a wallet that
cannot pay says nothing about the seller). Fund the wallet and call again with the same `intentId`: this call signed
nothing. If that intent had an earlier payment the seller rejected, the rules in
[When the seller rejects the payment](#when-the-seller-rejects-the-payment) still apply to the retry (in team mode, a
new nonce after the old deadline needs the `authorizationState` check first).

When the read fails (an RPC error, an answer it cannot read, or no answer within `balanceTimeoutMs`, default 4000), the
payment is not blocked on it: one line says so and the call goes ahead as before 0.7.2. `rpcUrl` takes your own
endpoint; `rpcUrl: false` skips the read.

### When the seller rejects the payment

A `payment_rejected` receipt has `paid: false`, no `tx_hash`, no `proof`, and `error.code` `payment_rejected`.
No price is learnt from it, no telemetry row is sent (it says nothing about the seller), and in team mode the
approval is reported as not paid, so the team releases it.

The one real risk: the signed EIP-3009 authorization can still be used until its deadline, so whoever holds it (the
seller or its facilitator) could settle it later, for example once the wallet is funded, even though the seller
answered 402. The receipt keeps what you need to check: `payer`, `nonce` and `valid_before` (Unix seconds).

**The deadline is not a settlement check.** Once `valid_before` has passed, the old signature can no longer be used,
but that says nothing about whether it was used before then. Read `authorizationState(payer, nonce)` on the USDC
contract on Base: `false` after the deadline shows nothing moved and nothing ever can. `true` only says the nonce
can no longer be used: it was used **or cancelled** (USDC's `cancelAuthorization` sets it too). To count it as a
payment, find the `AuthorizationUsed(payer, nonce)` event and the USDC `Transfer` in the same transaction. When the
same nonce is signed again with a shorter deadline and rejected again, the receipt's `valid_before` is that newer
signature's; the intent file keeps the latest deadline of every signature under the nonce, and that is the one to
wait for. This client does not read
the chain, so that check is yours.

- Retrying with the same `intentId` from the same wallet, network and asset is allowed, because nothing was paid.
  Without `team` or `authorize` the retry signs the same nonce, so at most one of the two authorizations can ever
  move money. With `team` or `authorize` the approval names the nonce: the retry signs if it names the same nonce,
  or, with a different nonce, only once the old deadline has passed (otherwise it refuses with `refused_authorize`
  and says until when; the team server answers `released_not_expired` until then in any case). A different nonce
  after the deadline is not covered by the one-nonce guarantee: check `authorizationState` first (`false`).
- A retry of that `intentId` from another wallet, on another network or for another asset throws
  `IntentConflictError` and signs nothing: the same nonce there would be a separate authorization that could also
  settle. So does a retry of an intent rejected by an earlier build, which did not record the payer.
- A new `intentId` is a new purchase with a new nonce. Only start one after the old deadline has passed and
  `authorizationState(payer, nonce)` is `false` (both: before the deadline it could still be used; `true` needs the
  `AuthorizationUsed` and `Transfer` check above to tell a payment from a cancellation).

## Receipts directory

```
.x402-receipts/
  2026-10-28T12-00-00-000Z-a1b2c3.json   one receipt per call
  intents/<sha256(intentId)>.json        idempotency state and the stored response
  prices.json                            last price paid per resource (method + origin + path)
  debug.log                              telemetry failures, local only
  .verified-telemetry-notice             marks that the one-time reporting notice was shown
  spend.json                             0.8.0: the spend ledger, with maxPerDayUsd, maxPerSellerPerDayUsd or maxFirstPaymentUsd
  frozen                                 0.8.0: create this file to refuse every payment; remove it to clear
```

Since 0.8.0, with a cap that needs it, the same directory holds `spend.json` (the spend ledger: the day's totals, per
seller, and which sellers this client has paid; `spend.lock` while it is written) and, when you create it, `frozen`
(the freeze marker). Each receipt for a paid call has a `proof` (the same object a verified telemetry row carries) and, when the row was
sent, a `verification_url` of the form `{indexUrl}/telemetry/<payer>/<nonce>`, which shows
whether the index has verified your row on-chain (usually within about five minutes of the payment).
`reported_outcome` is the outcome under the harness names, as the row reports it.

Keep this directory if you want the idempotency guarantee to survive restarts. The intent and spend-ledger locks are
files created by hard link and freed by pid: the directory needs a filesystem with hard links (not FAT or exFAT), and
must be shared only by processes on one host, in one pid namespace (not across containers or machines), since a pid
that is absent here is taken for a dead holder and its lock is reclaimed.

## Telemetry

**On by default.** Every priced call sends one v2 row to the index: the outcome under the index's names, the
seller host, a sha256 of the path, the amount, latency and validator names, and for a paid call a proof of payment
the index checks on Base (below). Fire-and-forget: a 1-second timeout, never awaited, every failure swallowed and
only counted in `debug.log`. Nothing is sent for free resources (no 402) or for replays of a stored intent.

**Who can turn it off.** paidfor is free because these reports are what the index is made from. So the account
decides, not a local flag:

| You use the library | Reporting |
| --- | --- |
| With no account | On. It cannot be turned off. |
| With a team key on the Free plan | On. It cannot be turned off. |

The Team plan, [coming soon](https://paidfor.dev/pricing), is to add a switch for it on the account page. It cannot
be bought yet. The client already follows the account's answer: in team mode the server says what applies in every
`/v1/team/authorize` answer (`telemetry.report`), which the client asks before each payment anyway, so there is no
extra request. When it cannot tell (an older server, an answer without the field, a refusal before the team was first
asked), it reports.

`telemetry: "anonymous"` and `telemetry: "off"` still type-check, but are requests the client cannot grant on its
own: on the Free plan, verified rows are still sent and one line says so, once per process. From this release on, the v1 ("anonymous") row is no longer sent; the index still accepts it from older versions.

**Plainly:** this is open source. You can edit your copy, point `indexUrl` at another index, or set
`indexUrl: false`, which sends nothing and also turns off the seller check before paying. Opting out through the
account is to be a Team plan feature (coming soon), not the only way out. It is the way that keeps the checks.

Every field is documented in [docs/telemetry.md](docs/telemetry.md).

## What verified telemetry sends and why

paidfor.dev measures sellers with its own wallet, which cannot cover the whole market. With reporting on, each of
your purchases becomes a data point the index can trust, because it can prove
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
  "client": "x402-safe-fetch/<version>",
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
  hash, the outcome you observed, the validator failures and the response hash. If you are not comfortable with
  that association, `indexUrl: false` (above) sends nothing; on the Free plan there is no other switch.
- **The plain path, for unknown sellers only (0.2.1).** When the index answered `unknown` before paying (it has
  never measured that seller), the row also carries `"path": "/v1/quote"`: the URL path, never the query string
  or fragment. The index keeps the host and path of a verified payment to such a seller so it can buy that
  seller itself at its next scheduled run, and lists it at paidfor.dev/candidates. For every seller the index
  knows, only `path_hash` is sent, as before.
- **Keyless ingest, https only.** `POST {indexUrl}/telemetry` needs no account and no key, and the index stores
  no IP address or identity with the row. A row goes only to an https `indexUrl` (loopback excepted, for local
  testing): with a plain-http one, nothing is sent and one line says so (an explicit `telemetry: "verified"` makes
  it throw instead), and telemetry never follows a redirect.
- **Client header (0.2.2).** Every request to the index, the pre-pay check and the telemetry POST, carries
  `X-Paidfor-Client: x402-safe-fetch/<version>`: the package name and version, nothing else. The index uses it
  only to count calls per client.
- **Bodies and request parameters never leave your machine.** The path is hashed, the query string is dropped
  before hashing, and the response is represented only by its sha256. Headers, request bodies, the intent id and
  validator evidence are never sent.
- **Refusals carry no proof.** A refused or unpaid call sends the row without `proof`; it is counted as a
  refusal, never in a failure rate. A refusal by `authorize`, or by one of the 0.8.0 caps and switches, sends no row
  at all: a buyer's own rule says nothing about the seller. Nor does a `payment_rejected` call (0.6.0): nothing was
  paid, and a wallet that cannot pay is not the seller's failure.
- **Outcomes use the index's names:** `ok`, `non_delivery` (a non-2xx answer or a failed delivery validator after paying),
  `overcharge` (paid more than 1.1x the reference, possible only if you raised `maxOverListedRatio`),
  `wrong_goods`, `duplicate`, plus the client-only `refused_*`, `no_acceptable_quote`, `paid_no_response` and
  `error`.
- **Turning it off.** See [who can turn it off](#telemetry): not on the Free plan; the Team plan's switch is coming
  soon. `indexUrl: false` turns off the index lookup and all telemetry.

The first time a payment is about to be signed with reporting on, in a receipts directory that has not shown it
before, the client prints a one-line notice pointing here (0.7.2: not before; a run that pays nothing, such as a
refusal, an empty wallet or a free resource, prints nothing about reporting), through `logger.warn` (stderr with the default console). `telemetryNotice: false` turns it off;
`telemetryNotice: (msg) => ...` sends it to your own function instead. Nothing else changes. The line that
`"anonymous"` or `"off"` was not honoured is never silenced: `telemetryNotice: false` does not hide it, and a
function receives it.

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
- `receipt.team` says what the team decided, carries any `warnings` the server sent (a plan quota, a wallet past
  what the plan covers; on a decline or a payment waiting for a person too, and on `TeamRefusedError`'s receipt), and
  `outcome_report` (`sent`, `queued` or `rejected`).
- A seller rated `caution` is logged (`paying <host>, which paidfor.dev rates "caution"`) only once the team has
  approved the payment and it is about to be signed; a caution seller the team declines logs nothing.

- A payment this client refuses by itself before asking the team (`refused_verdict`, `refused_ratio`,
  `refused_max_per_call`) is told to the team (`POST {origin}/v1/team/refusals`, with the quote, the reason and the
  verdict), so the ledger and the bill can show what was saved. That notice is fire-and-forget: a 2-second timeout,
  never awaited, every failure swallowed, and the error you get is the same either way. The 0.8.0 caps and switches
  also refuse before the team is asked, and are not reported to it.
- `project` (0.6.0) tags every payment, so the ledger and the bill can be read by project:
  `team: { key, project: "research-q4" }`. A tag is 1 to 64 letters, digits, spaces or `. _ -`; anything else throws
  when `safeFetch` is called.

The wallet must be registered to the team: on [paidfor.dev/team](https://paidfor.dev/team), or from the setup on
[paidfor.dev/install](https://paidfor.dev/install). The key goes
only to the team origin, never to a seller, and is never logged. `team` also takes `origin` (https only, or
http on localhost), `authorizeTimeoutMs` (default 10000), `reportTimeoutMs` (default 5000) and `project`.

When `team` is left out and `PAIDFOR_TEAM_KEY` is set in the environment, team mode turns on by itself (a
one-line notice says so), and `PAIDFOR_PROJECT`, when set, is the project tag; `team: false` turns it off. `team` and `authorize` together throw: `team` supplies its own
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
| `PaymentRefusedError` | `refused_verdict`, `refused_ratio`, `refused_max_per_call`, `refused_authorize` (also: a retry after `payment_rejected` whose approval names a new nonce before the old deadline) | No |
| `PaymentRefusedError` (0.8.0) | `refused_max_per_day`, `refused_max_per_seller_per_day`, `refused_max_first_payment`, `refused_pay_to`, `needs_approval`, `frozen`: the [caps and switches](#caps-and-switches-080) | No |
| `TeamRefusedError` (a `PaymentRefusedError`) | `refused_authorize`; `decision` says why | No |
| `IntentConflictError` | `intent_conflict` (also: a retry after `payment_rejected` from another wallet, network or asset) | No |
| `IntentIndeterminateError` | `intent_indeterminate` | Maybe, earlier; never again |
| `SafeFetchError` | `paid_no_response` | Signed and possibly settled; `receipt.nonce` identifies it |
| none: returned with status 402 | `receipt.outcome` `payment_rejected` | No; the authorization stays valid until `receipt.valid_before` (see "When the seller rejects the payment") |
| `InsufficientFundsError` (0.7.2) | `insufficient_funds`: the wallet holds less than the quote; `address`, `balanceUsdc`, `amountUsdc` | No, nothing signed |
| `SafeFetchError` | `no_acceptable_quote`, `intent_in_flight`, `network`, `sdk` | No |

## Example

[examples/conway-topup.ts](examples/conway-topup.ts) reproduces an auto-top-up that was paid, got a 500, and
retried every 60 seconds, and shows the idempotency guard and the `http_status` validator stopping it.

## Provenance

The 402 parsing, settlement decoding, pre-sign and post-sign checks, price ratio arithmetic and the four
validators are ported from the x402-audit measurement harness behind paidfor.dev, with their unit tests.

## License

MIT
