/**
 * Subset of x402-audit src/taxonomy.ts: the four response validators this client ships, and the
 * body cap the validators assume. Names and values are unchanged so results stay comparable with the index.
 */
export const VALIDATORS = {
  HTTP_STATUS: "http_status",
  NON_EMPTY: "non_empty",
  CONTENT_TYPE: "content_type",
  NOT_TRUNCATED: "not_truncated",
} as const;
export type ValidatorName = (typeof VALIDATORS)[keyof typeof VALIDATORS];
export const ALL_VALIDATORS: readonly ValidatorName[] = Object.values(VALIDATORS);

/** Bytes of a paid response the validators inspect (and that a replay stores). The caller always gets the full body. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
