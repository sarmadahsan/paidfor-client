/**
 * Idempotency. Follows the ledger rule of x402-audit src/pipeline/paidCall.ts ("ledger row BEFORE signing; if we
 * crash after this, the row says money may have moved"), with the SQLite attempts table replaced by one JSON file
 * per intent under <receiptsDir>/intents/.
 *
 * Phases, in order:
 *   reserved   request hash stored; nothing signed           -> a retry may proceed
 *   signing    all checks passed; signature about to be made -> a retry may proceed (nothing left the process:
 *              `signed` is written before the paid request is sent, and a failed write aborts the send)
 *   signed     authorization signed; paid request about to go -> a retry throws IntentIndeterminateError, never re-signs
 *   completed  paid response stored                           -> a retry returns the stored response, never re-signs
 *   rejected   signed and sent, and the seller answered 402 with no settlement -> a retry may proceed, but the
 *              signed nonce, payer, network and asset are kept in `rejected` (carried over every later attempt): a
 *              retry by the same payer on the same network and asset signs that same nonce, or, with an approval
 *              naming another nonce, only once the old one's deadline has passed; any other payer, network or
 *              asset is refused
 *   unpaid / refused / failed_unpaid                          -> a retry may proceed (nothing was signed)
 */
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { IntentConflictError, IntentIndeterminateError, SafeFetchError } from "./errors.js";
import { acquireLock, writeJsonDurable } from "./fsutil.js";

export type IntentPhase = "reserved" | "signing" | "signed" | "completed" | "unpaid" | "refused" | "failed_unpaid" | "rejected";

/**
 * A signed authorization the seller rejected. It can be used until `valid_before` (Unix seconds; null if unknown). Its
 * nonce is reused only by the same payer, network and asset: an EIP-3009 nonce is spent once per payer per token
 * contract, so the same nonce from another wallet, chain or token would be a second authorization that could also
 * settle. Records from before 0.6.0's fix have no payer and are never reused.
 */
export interface RejectedAuthorization {
  nonce: string;
  valid_before: number | null;
  /** authorization.from, lowercase. */
  payer?: string;
  /** CAIP-2. */
  network?: string;
  /** Token contract, lowercase. */
  asset?: string;
}

export interface StoredResponse {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body_base64: string;
  /** True when the body was larger than the stored cap; a replay then returns only the stored prefix. */
  body_truncated: boolean;
}

export interface IntentRecord {
  v: 1;
  intent_id: string;
  request_hash: string;
  phase: IntentPhase;
  attempts: number;
  created_at: string;
  updated_at: string;
  nonce?: string;
  amount_atomic?: string;
  pay_to?: string;
  receipt_file?: string;
  response?: StoredResponse;
  /** The last authorization for this intent the seller rejected, kept across attempts. */
  rejected?: RejectedAuthorization;
}

export interface IntentLease {
  record: IntentRecord;
  /** Set when the intent already completed: return this, do not contact the seller. */
  replay: boolean;
  update(patch: Partial<IntentRecord>): Promise<IntentRecord>;
  release(): Promise<void>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class IntentStore {
  private readonly dir: string;
  private readonly held = new Set<string>();
  constructor(receiptsDir: string) {
    this.dir = join(receiptsDir, "intents");
  }

  private paths(intentId: string) {
    const base = join(this.dir, sha256(intentId).slice(0, 40));
    return { file: `${base}.json`, lock: `${base}.lock` };
  }

  private async lock(intentId: string, lockFile: string): Promise<void> {
    // Claim in-process synchronously, before any await, so two concurrent calls here cannot both get past this line.
    if (this.held.has(intentId)) throw new SafeFetchError("intent_in_flight", `intent ${intentId} is already in flight in this process`);
    this.held.add(intentId);
    try {
      await this.lockFile(intentId, lockFile);
    } catch (e) {
      this.held.delete(intentId);
      throw e;
    }
  }

  /** Cross-process lock (fsutil acquireLock): a lock file left by a dead process, or by this pid after a crash, is stale. */
  private async lockFile(intentId: string, lockFile: string): Promise<void> {
    await acquireLock(lockFile, (owner) =>
      owner === undefined
        ? new SafeFetchError("intent_in_flight", `could not lock intent ${intentId}`)
        : new SafeFetchError("intent_in_flight", `intent ${intentId} is in flight in process ${owner}`),
    );
  }

  async read(intentId: string): Promise<IntentRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.paths(intentId).file, "utf8")) as IntentRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /**
   * Lock the intent and decide what this call may do. Writes the request hash durably before returning,
   * so it is on disk before any signature. Throws on conflict, indeterminate, or in-flight.
   */
  async acquire(intentId: string, requestHash: string, now = () => new Date()): Promise<IntentLease> {
    if (typeof intentId !== "string" || intentId.length === 0 || intentId.length > 256) {
      throw new TypeError("intentId must be a non-empty string of at most 256 characters");
    }
    const { file, lock } = this.paths(intentId);
    await this.lock(intentId, lock);
    const release = async () => {
      this.held.delete(intentId);
      await unlink(lock).catch(() => undefined);
    };
    try {
      const prior = await this.read(intentId);
      if (prior && prior.request_hash !== requestHash) {
        throw new IntentConflictError(
          "intent_conflict",
          `intent ${intentId} was already used for a different request (stored hash ${prior.request_hash.slice(0, 12)}, this request ${requestHash.slice(0, 12)}); use a new intentId`,
        );
      }
      if (prior?.phase === "signed") {
        throw new IntentIndeterminateError(
          "intent_indeterminate",
          `intent ${intentId}: a payment was signed${prior.nonce ? ` (nonce ${prior.nonce})` : ""} but no response was stored, so it may have settled. Not signing again; check the chain or the seller before using a new intentId.`,
        );
      }
      let record: IntentRecord;
      if (prior?.phase === "completed") {
        record = prior;
      } else {
        const ts = now().toISOString();
        record = {
          v: 1,
          intent_id: intentId,
          request_hash: requestHash,
          phase: "reserved",
          attempts: (prior?.attempts ?? 0) + 1,
          created_at: prior?.created_at ?? ts,
          updated_at: ts,
          // A rejected authorization may still be settled until its deadline: every later attempt must know its nonce.
          ...(prior?.rejected ? { rejected: prior.rejected } : {}),
        };
        await writeJsonDurable(file, record);
      }
      let current = record;
      return {
        record,
        replay: record.phase === "completed",
        async update(patch) {
          current = { ...current, ...patch, updated_at: now().toISOString() };
          await writeJsonDurable(file, current);
          return current;
        },
        release,
      };
    } catch (e) {
      await release();
      throw e;
    }
  }
}
