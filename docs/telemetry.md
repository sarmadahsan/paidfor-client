# Telemetry

Telemetry is **off by default**. `telemetry: "anonymous"` sends a v1 row (below). `telemetry: "verified"` sends a
v2 row: the v1 fields plus a proof of payment (see "Version 2"). The report-only adapters send the tx_only row (see
"tx_only (report-only)").

When it is on, each call that received an HTTP 402 sends one JSON object to `POST {indexUrl}/telemetry`
(by default `https://paidfor.dev/v1/telemetry`). That object is the whole message. Nothing else is sent.
No account and no key are needed to send it.

## The exact payload (v1, `"anonymous"`)

```json
{
  "v": 1,
  "host": "api.example.com",
  "path_hash": "3f0a...64 hex chars",
  "outcome": "ok",
  "amount_usdc": "0.010000",
  "latency_ms": 412,
  "validator_failures": [],
  "client": "x402-safe-fetch/0.3.0"
}
```

| Field | Meaning |
| --- | --- |
| `v` | Payload version, always `1`. |
| `host` | Hostname of the seller URL, lowercased. No scheme, port, path or query. |
| `path_hash` | SHA-256 hex of the URL path with a trailing slash removed (`/v1/data/` and `/v1/data` hash the same). The query string and fragment never enter the hash. |
| `outcome` | One of `ok`, `validator_failed`, `refused_verdict`, `refused_ratio`, `refused_max_per_call`, `no_acceptable_quote`, `paid_no_response`, `error`. |
| `amount_usdc` | Amount of the signed authorization as a 6-decimal string. `"0.000000"` when nothing was signed. |
| `latency_ms` | Wall time of the call in milliseconds, rounded. |
| `validator_failures` | Names of the validators that failed, for example `["http_status"]`. Names only, no evidence. |
| `client` | `x402-safe-fetch/<version>`, `x402-safe-fetch/0.3.0` for this version. |

## What is never sent (v1)

- Request or response bodies, headers, or any part of them.
- Query strings, request parameters, or the unhashed path.
- Wallet addresses, payer, `payTo`, nonces, signatures, or transaction hashes.
- The `intentId`, the request hash, or anything that links two calls together.
- Validator evidence, error messages, or seller response text.

Calls to free resources (no 402) and replays of a stored intent send nothing.

## How it is sent

- Fire-and-forget. The purchase never waits for it.
- With the header `X-Paidfor-Client: x402-safe-fetch/<version>` (from 0.2.2): the package name and version,
  nothing else. The pre-pay `GET {indexUrl}/check` sends the same header, also when telemetry is off.
- 1-second timeout.
- Any failure is swallowed, including a 404 while the route does not exist yet. Failures are only counted in
  `<receiptsDir>/debug.log`, which never leaves your machine.

## The promise

This client sends paidfor.dev the outcome of a purchase and nothing that identifies the buyer, the wallet,
or what was bought beyond the seller host and a path hash. The exceptions are opt-in and listed here: v2
(`"verified"`) adds the proof of payment, and from 0.2.1 the plain path for a seller the index has never
measured. If a future version needs to send more, it will list the new fields here and stay opt-in.

## Version 2 (`"verified"`)

Additive over v1. `v` is `2`, `outcome` uses the harness names, `validator_failures` carries the status on
`http_status` (`"http_status:500"`), and a paid call adds `proof`:

```json
{
  "v": 2,
  "host": "api.vapinetwork.ai",
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
    "pay_to": "0x<seller pay-to, lowercase>",
    "payer": "0x<client wallet, lowercase>",
    "nonce": "0x<32-byte EIP-3009 authorization nonce>",
    "tx_hash": "0x<settlement transaction hash, or null if the settlement header had none>",
    "settled_at": "2026-10-29T10:12:03.000Z",
    "response_sha256": "<hex of the paid response body, or null>",
    "declared_timeout_s": 60
  }
}
```

| Field | Source in the client |
| --- | --- |
| `proof.network`, `scheme`, `asset`, `pay_to` | The payment requirements the client signed against (CAIP-2 network, lowercase addresses). |
| `proof.payer`, `proof.nonce` | `from` and `nonce` of the EIP-3009 authorization the client signed. |
| `proof.tx_hash` | `transaction` from the seller's `PAYMENT-RESPONSE` (x402 v2) or `X-PAYMENT-RESPONSE` (v1) header, when it is a 32-byte hash; otherwise `null`. |
| `proof.settled_at` | When the paid response's headers arrived; when none did, when the paid request was sent. |
| `proof.response_sha256` | sha256 of the paid response body; `null` when there was none or it was longer than the 2 MB validator cap. |
| `proof.declared_timeout_s` | `maxTimeoutSeconds` from the seller's 402. |

Outcomes (`outcome`), mapped like the harness classifier, first match wins:

| v2 outcome | When |
| --- | --- |
| `duplicate` | More than one settlement observed for one intent. The client sends one paid request per intent, so in practice it never sees this. |
| `error` | The settlement header says `success: false` and the answer was not 2xx: the seller rejected the payment (the harness's `not_paid`). Proof is still sent, so the index can confirm nothing moved. |
| `non_delivery` | A non-2xx answer after the payment (even with `http_status` turned off), or `non_empty`, `content_type` or `not_truncated` failed. |
| `wrong_goods` | A schema, entity or freshness validator failed. This client ships none of them, so it does not send this today. |
| `overcharge` | Paid more than 1.1x the reference (index listed price, else the last price paid). Only possible if `maxOverListedRatio` was raised. |
| `ok` | None of the above. |
| `refused_verdict`, `refused_ratio`, `refused_max_per_call`, `no_acceptable_quote` | Refused; nothing was signed. **No `proof`.** A refusal by the `authorize` option (`refused_authorize` on the receipt) sends no row at all. |
| `paid_no_response`, `error` | Signed and sent with no response (with `proof`, `tx_hash` null), or failed before signing (no `proof`). |

### `path` (0.2.1): only for sellers the index has never measured

When the pre-pay `GET {indexUrl}/check` answered and its verdict was `unknown` (the index has no data on the
seller; not a timeout or an error), that call's v2 row adds one field:

```json
"path": "/v1/quote"
```

the URL path exactly as it was hashed for `path_hash` (no query string, no fragment; left out when longer than
512 characters). For any seller the index knows, `path` is absent and `path_hash` is unchanged. The index keeps
the host and path of a verified payment to such a seller on its candidate list (`GET {indexUrl}/candidates`) so
it can buy the seller itself at its next scheduled run, and drops the path from the stored row once the payment
is checked. These are public API endpoints; the index already saw the same origin and path in the pre-pay
lookup. `"anonymous"` (v1) never sends it.

`validator_failed` stays a v1-only outcome. The payer address, amount and pay-to are public on-chain for every
settled payment; the v2 row adds the link from that payment to the seller host, path hash, outcome, validator
failures and response hash. Bodies, request parameters, headers, the intent id and validator evidence are never
sent in either version. `"verified"` requires an https `indexUrl` (loopback excepted), and no telemetry request
follows a redirect. Each receipt stores the same `proof` and, in `"verified"` mode,
`verification_url` = `{indexUrl}/telemetry/<payer>/<nonce>` (404 until the index serves that route).

## tx_only (report-only)

From 0.3.0, `withPaidforReporting`, `withPaidforReportingAxios` and `reportOnly()` report payments made by another
x402 client with the caller's own wallet. Nothing is signed or checked before paying; after a response that carries a
Base settlement header, one object goes to `POST {indexUrl}/telemetry` (default `https://paidfor.dev/v1`):

```json
{
  "v": 2,
  "proof_level": "tx_only",
  "host": "api.example.com",
  "path": "/v1/quote",
  "path_hash": "<sha256 hex of the URL path without trailing slash>",
  "outcome": "ok",
  "latency_ms": 412,
  "validator_failures": [],
  "client": "x402-safe-fetch/0.3.0",
  "proof": { "network": "eip155:8453", "tx_hash": "0x<settlement transaction hash>" }
}
```

| Field | Source |
| --- | --- |
| `host`, `path`, `path_hash` | The response URL: hostname lowercased; the plain path (no query string or fragment; left out past 512 characters) and its hash as in v1. |
| `outcome` | `ok` for a 2xx, `non_delivery` otherwise; or what your `classify` returns (`ok`, `non_delivery`, `wrong_goods`, `overcharge`, `duplicate`). |
| `amount_usdc` | Only when you pass `quotedUsdc` to `report()`: the quote, so the index can check the amount moved is plausible. |
| `latency_ms` | Wall time of the wrapped call. |
| `validator_failures` | `["http_status:<status>"]` for a non-2xx, else empty. |
| `proof.tx_hash` | `transaction` from `PAYMENT-RESPONSE` (x402 v2) or `X-PAYMENT-RESPONSE` (v1), only with `success` not false and network `eip155:8453` or `base`. |

No payer, pay-to, nonce, amount or signature is sent: the index reads the payer, the recipient and the amount from the
transaction on Base, and the report counts only once that transaction is a USDC transfer to the seller. The index
answers `verified`, `pending` or a 422 with the reason; one transaction is one row across every channel. The request
carries `X-Paidfor-Client: x402-safe-fetch/0.3.0`, waits up to 10 seconds (the index checks the chain before
answering), never follows a redirect, and needs an https `indexUrl` (loopback excepted). Failures are counted in
`<receiptsDir>/debug.log` when you pass a `receiptsDir`, otherwise nowhere. The same row is what the paidfor MCP tool
`report_x402_payment` and the paidfor skill send.

## The other request: the index lookup

Separately from telemetry, when `indexUrl` is set the client asks `GET {indexUrl}/check?url=` before paying.
That request carries the seller URL with the query string and fragment removed (origin plus path). It is
needed to get the seller verdict and listed price. Set `indexUrl: false` to skip it.
