/**
 * The Conway auto-top-up failure, and how @paidfor/x402-safe-fetch stops it.
 *
 * What happened: an agent's auto-top-up paid the x402 seller, the seller settled the USDC and then answered
 * HTTP 500. The agent treated the 500 as "not paid" and retried every 60 seconds. Each retry signed a fresh
 * authorization, and each one settled. One top-up, many payments.
 *
 * What changes with safeFetch:
 *   1. Every top-up carries one intentId, minted once (with a random part) and kept across its retries. The first call stores the request hash
 *      and, before sending, the signed nonce. A retry with the same intentId and request returns the stored
 *      response and never signs again.
 *   2. The http_status validator marks the paid 500 as a failure in res.receipt, with the settlement tx hash,
 *      so the agent can stop and escalate instead of retrying.
 *
 * Run it (no real money: a local seller on Base Sepolia that verifies the signature and never settles):
 *   pnpm build && npx tsx examples/conway-topup.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { safeFetch } from "@paidfor/x402-safe-fetch";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** A seller that behaves like the one in the Conway issue: takes the payment, then returns 500. */
async function startConwayLikeSeller() {
  let payments = 0;
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const server = createServer((req, res) => {
    req.resume();
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, {
        "PAYMENT-REQUIRED": b64({
          x402Version: 2,
          resource: { url: `http://localhost${req.url}`, mimeType: "application/json" },
          accepts: [{ scheme: "exact", network: "eip155:84532", amount: "5000000", asset: USDC_BASE_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
        }),
      });
      return res.end("{}");
    }
    payments++;
    res.writeHead(500, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "c0".repeat(32), network: "eip155:84532" }),
    });
    res.end(JSON.stringify({ error: "internal error" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/credits/topup`, payments: () => payments, close: () => server.close() };
}

const seller = await startConwayLikeSeller();
const wallet = privateKeyToAccount(generatePrivateKey()); // in production: your viem account or WalletClient

const fetchWithPay = safeFetch(wallet, {
  maxPerCallUsd: 10,
  validators: ["http_status", "non_empty", "content_type", "not_truncated"],
  indexUrl: false, // the example runs offline; leave the default (https://paidfor.dev/v1) in production
  // Report each outcome with its proof of payment, so paidfor.dev can verify on Base that this paid 500 really
  // happened and count it against the seller. Sends no bodies or request parameters; the payer address is already
  // public on-chain. On by default; needs indexUrl (sends nothing here, offline).
  telemetry: "verified",
  network: "eip155:84532",
  // The wallet here is a throwaway key holding nothing, and the local seller never settles, so the balance read before
  // signing is skipped. Leave it out in production: an empty wallet then stops before anything is signed.
  rpcUrl: false,
  receiptsDir: await mkdtemp(join(tmpdir(), "conway-receipts-")),
});

// One intent per top-up, minted once with a random part and kept for every retry of that top-up. A new top-up gets a
// new id: an id made only of the account and the date would replay the first top-up instead of paying for the second.
const intentId = `conway-topup:acct_42:${randomUUID()}`;
const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "acct_42", amount_usd: 5 }) };

// The auto-top-up loop. In the incident this ran every 60 seconds; here every 100 ms, five times.
for (let tick = 1; tick <= 5; tick++) {
  const res = await fetchWithPay(seller.url, init, { intentId });
  const r = res.receipt;
  console.log(
    `tick ${tick}: HTTP ${res.status}  ${r.replayed ? "replayed stored result, nothing signed" : `paid ${r.amount_usdc} USDC, tx ${r.tx_hash}`}` +
      `  validator failures: ${r.validator_failures.join(", ") || "none"}  reported as: ${r.reported_outcome}`,
  );
  if (r.validator_failures.includes("http_status")) {
    // Paid but not delivered: stop retrying the payment and escalate with the receipt (it has the tx hash).
    console.log(`  -> paid and failed; escalate to the seller with tx ${r.tx_hash}, do not pay again`);
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`\nseller received ${seller.payments()} payment(s) for 5 attempts`);
seller.close();
