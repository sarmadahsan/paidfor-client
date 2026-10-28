# Changelog

## 0.2.0

- **Verified telemetry.** `telemetry` takes a third value, `"verified"`, which sends a v2 row: the outcome under
  the index's harness names (`ok`, `non_delivery`, `overcharge`, `wrong_goods`, `duplicate`, plus the client-only
  refusals, `paid_no_response` and `error`) and, for a paid call, a `proof` (network, scheme, asset, pay-to,
  payer, nonce, tx hash, settled time, response sha256, the seller's declared timeout) that the index can check
  against Base. Refused calls send no proof. `"anonymous"` still sends the v1 row with no address; the default
  is still `"off"`. A one-time console notice on the first `"verified"` run points at the README section
  "What verified telemetry sends and why".
- **Receipts** gain `payer`, `proof`, `reported_outcome`, `verification_url`
  (`{indexUrl}/telemetry/<payer>/<nonce>`, `"verified"` only; 404 until the index serves it) and
  `response.sha256`.
- **Fix:** v1 settlement headers with `"errorReason": null` (what real v1 facilitators send on success) failed
  to parse, so the receipt lost the transaction hash. The optional settlement fields now accept null.
- `client` in telemetry rows is `x402-safe-fetch/0.2.0`.
- `examples/conway-topup.ts` uses `telemetry: "verified"`.

No breaking changes: `safeFetch(wallet, options)` and the returned function keep their signatures.

## 0.1.0

First release.
