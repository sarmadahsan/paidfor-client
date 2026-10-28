# Telemetry

Telemetry is **off by default**. Turn it on with `telemetry: "anonymous"`.

When it is on, each call that received an HTTP 402 sends one JSON object to `POST {indexUrl}/telemetry`
(by default `https://paidfor.dev/v1/telemetry`). That object is the whole message. Nothing else is sent.

## The exact payload

```json
{
  "v": 1,
  "host": "api.example.com",
  "path_hash": "3f0a...64 hex chars",
  "outcome": "ok",
  "amount_usdc": "0.010000",
  "latency_ms": 412,
  "validator_failures": [],
  "client": "x402-safe-fetch/0.1.0"
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
| `client` | Always `x402-safe-fetch/0.1.0` for this version. |

## What is never sent

- Request or response bodies, headers, or any part of them.
- Query strings, request parameters, or the unhashed path.
- Wallet addresses, payer, `payTo`, nonces, signatures, or transaction hashes.
- The `intentId`, the request hash, or anything that links two calls together.
- Validator evidence, error messages, or seller response text.

Calls to free resources (no 402) and replays of a stored intent send nothing.

## How it is sent

- Fire-and-forget. The purchase never waits for it.
- 1-second timeout.
- Any failure is swallowed, including a 404 while the route does not exist yet. Failures are only counted in
  `<receiptsDir>/debug.log`, which never leaves your machine.

## The promise

This client sends paidfor.dev the outcome of a purchase and nothing that identifies the buyer, the wallet,
or what was bought beyond the seller host and a path hash. If a future version needs to send more, it will
bump `v`, list the new fields here, and stay opt-in.

## The other request: the index lookup

Separately from telemetry, when `indexUrl` is set the client asks `GET {indexUrl}/check?url=` before paying.
That request carries the seller URL with the query string and fragment removed (origin plus path). It is
needed to get the seller verdict and listed price. Set `indexUrl: false` to skip it.
