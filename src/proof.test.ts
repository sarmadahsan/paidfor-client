import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFUSED_OUTCOMES, buildProof, failureLabels, harnessOutcome, type OutcomeInput } from "./proof.js";
import { buildPayloadV2 } from "./telemetry.js";
import { decodeSettlementHeader } from "./x402/settlement.js";
import { caip2Network } from "./x402/types.js";

interface HarnessCase {
  name: string;
  x402_version: 1 | 2;
  header: Record<string, string>;
  url: string;
  ts: number;
  payer: string;
  amount_atomic: string;
  asset: string;
  network: string;
  pay_to: string;
  nonce: string;
  response_status: number;
  response_body_sha256: string | null;
  max_timeout_seconds: number;
  settlement_tx_hash: string | null;
  harness_outcome: string | null;
}

/** Real paid calls from the x402-audit database (see each case's `source`). */
const cases = JSON.parse(readFileSync(new URL("../test/fixtures/harness-settlements.json", import.meta.url), "utf8")) as HarnessCase[];
const byName = (n: string) => cases.find((c) => c.name === n)!;

function proofFor(c: HarnessCase) {
  return buildProof({
    network: caip2Network({ x402Version: c.x402_version, network: c.network }),
    scheme: "exact",
    asset: c.asset,
    payTo: c.pay_to,
    payer: c.payer,
    nonce: c.nonce,
    settlement: decodeSettlementHeader(c.header),
    settledAt: c.ts,
    responseSha256: c.response_body_sha256,
    declaredTimeoutS: c.max_timeout_seconds,
  });
}

describe("buildProof against harness settlement headers", () => {
  it.each(["v1_with_tx", "v2_with_tx"])("%s: takes the transaction hash the harness matched on-chain", (name) => {
    const c = byName(name);
    const d = decodeSettlementHeader(c.header);
    expect(d.version).toBe(c.x402_version);
    expect(d.parseError).toBeUndefined();
    const p = proofFor(c)!;
    expect(p).toEqual({
      network: "eip155:8453",
      scheme: "exact",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      pay_to: c.pay_to.toLowerCase(),
      payer: c.payer.toLowerCase(),
      nonce: c.nonce.toLowerCase(),
      tx_hash: c.settlement_tx_hash!.toLowerCase(),
      settled_at: new Date(c.ts).toISOString(),
      response_sha256: c.response_body_sha256,
      declared_timeout_s: c.max_timeout_seconds,
    });
  });

  it("v1: accepts the null errorReason real facilitators send on success", () => {
    const d = decodeSettlementHeader(byName("v1_with_tx").header);
    expect(d.parsed).toMatchObject({ success: true, errorReason: null });
  });

  it.each(["v1_without_tx", "v2_without_tx"])("%s: tx_hash is null, the rest of the proof stands", (name) => {
    const c = byName(name);
    const d = decodeSettlementHeader(c.header);
    expect(d.version).toBe(c.x402_version);
    expect(d.parsed).toMatchObject({ success: false, transaction: "" });
    const p = proofFor(c)!;
    expect(p.tx_hash).toBeNull();
    expect(p.payer).toBe(c.payer.toLowerCase());
    expect(p.nonce).toBe(c.nonce.toLowerCase());
  });

  it("tx_hash is null with no settlement header at all, and response_sha256 null when unknown", () => {
    const c = byName("v2_with_tx");
    const p = buildProof({ ...{ network: "eip155:8453", scheme: "exact", asset: c.asset, payTo: c.pay_to, payer: c.payer, nonce: c.nonce }, settlement: {}, settledAt: c.ts, responseSha256: null, declaredTimeoutS: 60 })!;
    expect(p.tx_hash).toBeNull();
    expect(p.response_sha256).toBeNull();
  });

  it("returns null rather than a malformed proof", () => {
    const c = byName("v2_with_tx");
    const base = { network: "eip155:8453", scheme: "exact", asset: c.asset, payTo: c.pay_to, payer: c.payer, nonce: c.nonce, settlement: {}, settledAt: c.ts, responseSha256: null, declaredTimeoutS: 60 };
    expect(buildProof(base)).not.toBeNull();
    expect(buildProof({ ...base, nonce: "0x1234" })).toBeNull();
    expect(buildProof({ ...base, payer: "not-an-address" })).toBeNull();
    expect(buildProof({ ...base, network: "base" })).toBeNull();
  });
});

describe("harnessOutcome", () => {
  const paid = (o: Partial<OutcomeInput>): OutcomeInput => ({ outcome: "ok", status: 200, validatorFailures: [], settlementSuccess: true, ...o });

  it("agrees with the harness on its own rows", () => {
    for (const c of cases.filter((x) => x.harness_outcome === "ok" || x.harness_outcome === "non_delivery")) {
      const failures = c.response_status >= 200 && c.response_status < 300 ? [] : ["http_status"];
      const d = decodeSettlementHeader(c.header);
      const got = harnessOutcome(paid({ outcome: failures.length ? "validator_failed" : "ok", status: c.response_status, validatorFailures: failures, settlementSuccess: d.parsed?.success ?? null }));
      expect(got, c.name).toBe(c.harness_outcome);
    }
  });

  it.each(["http_status", "non_empty", "content_type", "not_truncated"])("a %s failure after a settled payment is non_delivery", (v) => {
    expect(harnessOutcome(paid({ outcome: "validator_failed", status: v === "http_status" ? 500 : 200, validatorFailures: [v] }))).toBe("non_delivery");
  });

  it("a paid non-2xx is non_delivery even when http_status was not run", () => {
    expect(harnessOutcome(paid({ outcome: "ok", status: 500, validatorFailures: [] }))).toBe("non_delivery");
  });

  it("a paid 2xx with no settlement header is classified by validators (the index checks the chain)", () => {
    expect(harnessOutcome(paid({ settlementSuccess: null }))).toBe("ok");
    expect(harnessOutcome(paid({ outcome: "validator_failed", settlementSuccess: null, validatorFailures: ["non_empty"] }))).toBe("non_delivery");
  });

  it("settlement failed and a non-2xx answer: the seller rejected the payment, sent as error (harness not_paid)", () => {
    expect(harnessOutcome(paid({ outcome: "validator_failed", status: 402, validatorFailures: ["http_status"], settlementSuccess: false }))).toBe("error");
  });

  it("over the reference beyond 1.1x and paid anyway (caller raised the ratio) is overcharge", () => {
    expect(harnessOutcome(paid({ amountAtomic: 12_000n, referenceAtomic: 10_000n }))).toBe("overcharge");
    expect(harnessOutcome(paid({ amountAtomic: 11_000n, referenceAtomic: 10_000n }))).toBe("ok");
    expect(harnessOutcome(paid({ amountAtomic: 12_000n }))).toBe("ok");
  });

  it("precedence: duplicate > non_delivery > wrong_goods > overcharge", () => {
    const all = { outcome: "validator_failed" as const, status: 500, validatorFailures: ["http_status", "json_schema"], amountAtomic: 20_000n, referenceAtomic: 10_000n };
    expect(harnessOutcome(paid({ ...all, settlements: 2 }))).toBe("duplicate");
    expect(harnessOutcome(paid(all))).toBe("non_delivery");
    expect(harnessOutcome(paid({ ...all, status: 200, validatorFailures: ["json_schema"] }))).toBe("wrong_goods");
    expect(harnessOutcome(paid({ ...all, status: 200, validatorFailures: [] }))).toBe("overcharge");
  });

  it("wrong_goods only when a schema validator failed; the four delivery validators never produce it", () => {
    for (const v of ["http_status", "non_empty", "content_type", "not_truncated"]) {
      expect(harnessOutcome(paid({ outcome: "validator_failed", validatorFailures: [v] }))).not.toBe("wrong_goods");
    }
  });

  it("client-only outcomes pass through", () => {
    for (const o of ["refused_verdict", "refused_ratio", "refused_max_per_call", "no_acceptable_quote", "paid_no_response", "error"] as const) {
      expect(harnessOutcome({ outcome: o, validatorFailures: [], settlementSuccess: null })).toBe(o);
    }
  });
});

describe("refused outcomes carry no proof", () => {
  const c = byName("v2_with_tx");
  const proof = proofFor(c);
  it.each([...REFUSED_OUTCOMES])("%s: buildPayloadV2 drops a proof even if handed one", (outcome) => {
    const p = buildPayloadV2({ url: c.url, outcome: outcome as never, amountUsdc: "0.000000", latencyMs: 5, validatorFailures: [], proof });
    expect(p).not.toHaveProperty("proof");
    expect(p.v).toBe(2);
  });
  it("a paid outcome keeps it", () => {
    const p = buildPayloadV2({ url: c.url, outcome: "non_delivery", amountUsdc: "0.001000", latencyMs: 5, validatorFailures: ["http_status:400"], proof });
    expect(p.proof).toEqual(proof);
  });
});

describe("failureLabels", () => {
  it("puts the status on http_status only", () => {
    expect(failureLabels(["http_status", "non_empty"], 500)).toEqual(["http_status:500", "non_empty"]);
    expect(failureLabels(["content_type"], 200)).toEqual(["content_type"]);
  });
});
