# Changelog

## Unreleased

- **Usable content in another format than declared is a warning, not a failed delivery** (paidfor-index issue 40).
  When the seller declares one type and answers with usable content in another (`application/json` declared, the
  article sent as `text/markdown`; JSON labelled `text/plain`), or with no `Content-Type` header, the receipt's
  outcome is now `ok` (it was `validator_failed`), `reported_outcome` is `ok` (it was `non_delivery`), and the
  `content_type` validator says `pass` with `reason` `content_type_mismatch` or `missing_content_type` and
  `evidence.warning: true`. New receipt field `warnings` says it in words, with the declared and received types. The
  v2 telemetry row adds `warnings: ["content_type_mismatch"]` only when there is one (see docs/telemetry.md); rows
  without warnings are unchanged. The price is recorded in `prices.json` as for any `ok` call.
- It stays a failure when the answer has the shape of an error rather than of content: an HTML page, by its
  `Content-Type` or its first bytes (new reason `html_body`), where HTML was not declared (an HTML label over a body that parses as JSON is JSON mislabelled: a warning); an undeclared
  `application/problem+json` document; a body that should be JSON and does not parse (`body_not_json`, now also for
  broken JSON labelled as another type or sent with no header). The JSON family (`application/json`, `text/json`, any
  `+json` type) is one format: a declared `application/vnd.api+json` answered with `application/json` passes without
  a warning (it failed before). Empty, truncated and non-2xx answers fail as before.
- New exports: `WARNING_REASONS` and `isFormatWarning` (validators), `ReceiptWarning` and `receiptWarnings` (receipt).
  All additive; older receipts have no `warnings` field.

## 0.6.0

- **A payment the seller rejects is no longer recorded as paid.** When the paid request is answered with HTTP 402
  again and nothing settled (no settlement header, or one with `success: false`), as happens with a wallet that has
  no USDC, the receipt now says `outcome: "payment_rejected"` and `paid: false` (it said `validator_failed` and
  `paid: true`). The response is still returned, with status 402. No price is recorded in `prices.json`, no telemetry
  row is sent in either version (before, a verified row reported `non_delivery` against the seller), and in team mode
  the approval is reported as not paid (`paid: false`), so the team releases it instead of recording a settlement.
  `reported_outcome` is `error`, the harness name for "not paid"; `proof` is null. A 402 whose settlement header
  cannot be read is still treated as paid, since it may name a settlement.
- **Retrying a rejected payment.** The intent is kept in the new phase `rejected` with the signed nonce, deadline,
  payer, network and asset, and a retry with the same `intentId` is allowed (before, it replayed the 402). Without
  `team` or `authorize` the retry signs the same nonce again, so at most one of the two authorizations can ever
  settle. A retry from another wallet, network or asset throws `IntentConflictError` and signs nothing (the same
  nonce there would be a second authorization that could also settle). With an approval naming a different nonce,
  the retry refuses with `refused_authorize` until the rejected authorization's deadline has passed. The deadline
  only stops later use of the old signature; it does not show the old one was never used. `authorizationState(payer,
  nonce)` on the USDC contract being `false` does; `true` means used or cancelled, and only the `AuthorizationUsed`
  event with its USDC `Transfer` shows a payment. When the same nonce is signed again and rejected again, the intent
  keeps the later of the two deadlines (an unknown one never passes). A new `intentId` signs a new nonce as before. See
  "When the seller rejects the payment" in the README.
- New receipt field `valid_before`: the signed authorization's deadline, Unix seconds (null when nothing was signed).
  `Outcome` gains `payment_rejected`. Both are additive; older receipts lack the field.
- **Team mode tells the team about local refusals.** A payment refused before the team is asked (`refused_verdict`,
  `refused_ratio`, `refused_max_per_call`) is posted to `{origin}/v1/team/refusals` with the quote, the reason and
  the verdict, so the ledger and the bill can count what was saved. Fire-and-forget: 2-second timeout, never awaited,
  every failure (including a 404 from a server without the route) swallowed and never logged; the thrown error is
  unchanged. The key goes only to the team origin.
- **`team.project`**, and `PAIDFOR_PROJECT` when team mode comes from `PAIDFOR_TEAM_KEY`: a project tag sent as
  `project` on every authorize and refusal notice. A tag the server would refuse (it must be 1 to 64 letters, digits,
  spaces or `. _ -` after trimming) throws when `safeFetch` is called. An empty `PAIDFOR_PROJECT` is ignored.
- **`telemetryNotice`**: `false` turns off the one-time notice about verified telemetry; a function receives it
  instead of `logger.warn`. The default is unchanged.
- README: `verification_url` is live (the "not live yet" note is gone); the team section says
  `npx -y @paidfor/mcp@latest`, as does the "wallet not registered" message; sample rows show
  `x402-safe-fetch/<version>`. New outcome table.
- Exported: `cleanProject` and the types `TeamRefusalBody`, `TeamRefusalReason`.
- `client` in telemetry rows and the `X-Paidfor-Client` header is `x402-safe-fetch/0.6.0`.

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
