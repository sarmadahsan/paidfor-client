# Changelog

## 0.5.0

- **Team mode: `team: { key }`.** Budgets per wallet, human approvals and a ledger from a paidfor team account, with
  one option. Every payment asks `{origin}/v1/team/authorize` (default origin `https://paidfor.dev`) before signing
  and signs the minted nonce and deadline; anything but a clean approval throws `TeamRefusedError` (code
  `refused_authorize`, with `decision`: `decline`, `needs_approval` with `approve_url` and `expires_at`,
  `already_settled`, or `failed`) and signs nothing. Every approval's outcome is reported to `/v1/team/outcome`; a
  report the server could not take is kept in `<receiptsDir>/team-outcomes` (in memory if the disk cannot take it)
  and sent before the next payment. `receipt.team` carries the decision, the server's `warnings` and the report's
  state. The key goes only to the team origin; a plain-http origin off this machine is refused.
- **`PAIDFOR_TEAM_KEY` turns team mode on** when `team` and `authorize` are both left out. If that variable is in
  the environment of a program upgrading from 0.4.x, its payments now ask the team first; pass `team: false` to keep
  the old behaviour. `team` and `authorize` together throw.
- Exported: `TeamRefusedError`, `TeamClient`, `outcomeFor`, `readDecision`, `isKeySafeOrigin`, `TEAM_ORIGIN` and the
  types `TeamOptions`, `TeamDecision`, `TeamDecisionExtras`, `TeamWarning`, `TeamReceipt`, `TeamReportState`,
  `TeamAuthorizeBody`, `TeamOutcomeBody`, `TeamClientOptions`.
  `TeamClient` leaves bare queue entries (the `@paidfor/mcp` format, which names no key) untouched unless it is made
  with `adoptBareEntries: true`; the `team` option never adopts them.
- `client` in telemetry rows and the `X-Paidfor-Client` header is `x402-safe-fetch/0.5.0`.

## 0.4.0

- **`authorize`.** A new option: a callback asked after every local check and before anything is signed. An approval
  names the EIP-3009 nonce and `validBefore` to sign. Anything else, including a throw or an approval with under ten
  seconds left, refuses with `refused_authorize` and signs nothing. Without the option nothing changes.
- `client` in telemetry rows and the `X-Paidfor-Client` header is `x402-safe-fetch/0.4.0`.

## 0.3.0

- **Report-only mode.** `reportOnly()`, `withPaidforReporting(fetchWithPayment)` for `x402-fetch` 1.x and
  `@x402/fetch` 2.x, and `withPaidforReportingAxios(instance)` for `x402-axios` 1.x and `@x402/axios` 2.x: keep your
  own x402 client and wallet, add one line, and every paid call sends the tx_only row (docs/telemetry.md) with the
  settlement transaction hash. No pre-pay check, no guard; the index reads the payer and amount from Base.
- `client` in telemetry rows and the `X-Paidfor-Client` header is `x402-safe-fetch/0.3.0`.

## 0.2.2

- **Client header.** Every request to the index (`GET {indexUrl}/check` and `POST {indexUrl}/telemetry`) sends
  `X-Paidfor-Client: x402-safe-fetch/0.2.2`, so paidfor.dev can count checks per client instead of filing them
  under `api`. The header carries only the package name and version, the same string as the telemetry `client`
  field. It is sent with telemetry `"off"` too, on the index check; `indexUrl: false` sends no index request.
- `client` in telemetry rows is `x402-safe-fetch/0.2.2`.

## 0.2.1

- **Path for sellers the index has never measured.** With `telemetry: "verified"`, when the pre-pay index check
  answered `unknown`, that call's v2 row adds `path`: the plain URL path (no query string or fragment, at most
  512 characters), so the index can put the seller on its candidate list and buy it itself. For known sellers
  `path` is absent and `path_hash` is unchanged; `"anonymous"` never sends it. See docs/telemetry.md.
- `client` in telemetry rows is `x402-safe-fetch/0.2.1`.

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
- `"verified"` requires an https `indexUrl` (loopback allowed for local testing); telemetry POSTs never follow
  redirects.
- `client` in telemetry rows is `x402-safe-fetch/0.2.0`.
- `examples/conway-topup.ts` uses `telemetry: "verified"`.

No breaking changes: `safeFetch(wallet, options)` and the returned function keep their signatures.

## 0.1.0

First release.
