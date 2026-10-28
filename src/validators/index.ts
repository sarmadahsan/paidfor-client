import type { ValidatorName } from "../taxonomy.js";
import { contentType } from "./content_type.js";
import { httpStatus } from "./http_status.js";
import { nonEmpty } from "./non_empty.js";
import { notTruncated } from "./not_truncated.js";
import type { ValidationContext, Validator, ValidatorResult } from "./types.js";
import { errorMessage } from "./util.js";

/** Ported from x402-audit in contract order. json_schema, entity_matches, freshness and injection_scan need per-seller config and are not shipped. */
export const ALL: readonly Validator[] = [httpStatus, nonEmpty, contentType, notTruncated];

export function validatorsByName(names: readonly ValidatorName[]): Validator[] {
  return names.map((n) => {
    const v = ALL.find((x) => x.name === n);
    if (!v) throw new TypeError(`unknown validator "${n}"; available: ${ALL.map((x) => x.name).join(", ")}`);
    return v;
  });
}

/**
 * Run every validator against ctx. Never throws: an exception inside a validator
 * becomes a `fail` with reason `validator_threw`. Later validators always run.
 */
export async function runAllValidators(
  ctx: ValidationContext,
  validators: readonly Validator[] = ALL,
): Promise<Partial<Record<ValidatorName, ValidatorResult>>> {
  const out: Partial<Record<ValidatorName, ValidatorResult>> = {};
  for (const v of validators) {
    try {
      out[v.name] = await v.run(ctx);
    } catch (e) {
      out[v.name] = { status: "fail", reason: "validator_threw", evidence: { error: errorMessage(e) } };
    }
  }
  return out;
}

export type { ValidationContext, Validator, ValidatorResult } from "./types.js";
