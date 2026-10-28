import { describe, expect, it } from "vitest";
import { ALL_VALIDATORS } from "../taxonomy.js";
import { ALL, runAllValidators, validatorsByName } from "./index.js";
import { makeCtx } from "./test-helpers.js";
import type { Validator } from "./types.js";

describe("runAllValidators", () => {
  it("ALL is in the contract order", () => {
    expect(ALL.map((v) => v.name)).toEqual(["http_status", "non_empty", "content_type", "not_truncated"]);
    expect([...ALL.map((v) => v.name)].sort()).toEqual([...ALL_VALIDATORS].sort());
  });
  it("runs every validator on a default context", async () => {
    const out = await runAllValidators(makeCtx());
    expect(Object.keys(out)).toEqual(ALL.map((v) => v.name));
    expect(out.http_status?.status).toBe("pass");
  });
  it("keeps going when a validator throws or an early one fails", async () => {
    const vs: Validator[] = [...ALL];
    vs[1] = { name: "non_empty", run: () => { throw new Error("boom"); } };
    vs[2] = { name: "content_type", run: async () => { throw new Error("async boom"); } };
    const out = await runAllValidators(makeCtx({ response: { status: 500 } }), vs);
    expect(out.http_status).toMatchObject({ status: "fail", reason: "non_2xx_status" });
    expect(out.non_empty).toEqual({ status: "fail", reason: "validator_threw", evidence: { error: "Error: boom" } });
    expect(out.content_type).toMatchObject({ status: "fail", reason: "validator_threw" });
    expect(out.not_truncated?.status).toBe("pass");
  });
  it("validatorsByName rejects unknown names", () => {
    expect(validatorsByName(["http_status"]).map((v) => v.name)).toEqual(["http_status"]);
    expect(() => validatorsByName(["json_schema" as never])).toThrow(/unknown validator/);
  });
});
