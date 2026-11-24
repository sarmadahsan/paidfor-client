/**
 * Local spend ledger (0.8.0): what this client paid per UTC day, in total and per seller, and which sellers it has paid
 * before. Behind `maxPerDayUsd`, `maxPerSellerPerDayUsd` and `maxFirstPaymentUsd`. One JSON file,
 * <receiptsDir>/spend.json, written under a lock like the intent files (fsutil acquireLock), since two processes may
 * share one wallet and one directory.
 *
 * A payment is reserved before anything is signed and settled once its outcome is known: a paid outcome (money moved,
 * or may have: a payment sent with no answer, or one the seller rejected but could still settle until its deadline) is
 * added to the day, anything else (a refusal, a free resource) is dropped. A reservation whose process died before
 * settling stays counted for the day: it may have signed. Replays never reach the ledger. Days before yesterday (UTC)
 * are pruned on every write; the seller history is kept.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireLock, writeJsonDurable } from "./fsutil.js";

export interface LedgerCaps {
  /** `maxPerDayUsd` in atomic USDC. */
  perDay?: bigint;
  /** `maxPerSellerPerDayUsd` in atomic USDC. */
  perSellerPerDay?: bigint;
  /** `maxFirstPaymentUsd` in atomic USDC. */
  firstPayment?: bigint;
}

export type LedgerRule = "per_day" | "per_seller_per_day" | "first_payment";

export interface LedgerRefusal {
  rule: LedgerRule;
  /** Already counted today (settled plus reserved) under the rule's key; 0 for `first_payment`. */
  spent: bigint;
  cap: bigint;
  amount: bigint;
  seller: string;
}

export interface Reservation {
  id: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  seller: string;
  host: string;
  amount: bigint;
}

interface PendingRow {
  amount_atomic: string;
  seller: string;
  pid: number;
  at: string;
}

interface DayRow {
  settled_atomic: string;
  by_seller: Record<string, string>;
  pending: Record<string, PendingRow>;
}

export interface SellerHistory {
  first_paid_at: string;
  last_paid_at: string;
  payments: number;
}

export interface LedgerFile {
  v: 1;
  days: Record<string, DayRow>;
  /** Keyed by pay-to address (lowercase) and by host, both, for every seller this client has paid. */
  sellers: Record<string, SellerHistory>;
}

const isAtomic = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const atomic = (v: unknown): bigint => (isAtomic(v) ? BigInt(v) : 0n);

/** The UTC day of `d` as YYYY-MM-DD. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emptyDay(): DayRow {
  return { settled_atomic: "0", by_seller: {}, pending: {} };
}

/** The spend-ledger key for a seller: its pay-to address, lowercase, or the host when the quote names no address. */
export function sellerKey(payTo: string | undefined, host: string): string {
  return typeof payTo === "string" && /^0x[0-9a-fA-F]{40}$/.test(payTo) ? payTo.toLowerCase() : host.toLowerCase();
}

/**
 * In-process queues, one per ledger file: the file lock treats this pid as stale, so every call in this process on one
 * file lines up here, whichever SpendLedger instance (whichever safeFetch client) made it.
 */
const queues = new Map<string, Promise<unknown>>();

export class SpendLedger {
  readonly file: string;
  private readonly lock: string;

  constructor(dir: string) {
    this.file = join(dir, "spend.json");
    this.lock = join(dir, "spend.lock");
  }

  /** The ledger as on disk, or an empty one. Not locked: for reading only. */
  async read(): Promise<LedgerFile> {
    try {
      const j = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j) && (j as LedgerFile).v === 1) {
        const f = j as LedgerFile;
        return { v: 1, days: f.days && typeof f.days === "object" ? f.days : {}, sellers: f.sellers && typeof f.sellers === "object" ? f.sellers : {} };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { v: 1, days: {}, sellers: {} };
  }

  /** Whether this client has paid `keys` (a host, a pay-to address) before, by the ledger's own history. */
  async hasPaid(...keys: string[]): Promise<boolean> {
    const f = await this.read();
    return keys.some((k) => f.sellers[k.toLowerCase()] !== undefined);
  }

  private async locked<T>(fn: (f: LedgerFile) => Promise<{ result: T; write: boolean }>): Promise<T> {
    const run = async () => {
      const release = await acquireLock(this.lock, (owner) => new Error(owner === undefined ? "could not lock the spend ledger" : `the spend ledger is locked by process ${owner}`));
      try {
        const f = await this.read();
        const { result, write } = await fn(f);
        if (write) await writeJsonDurable(this.file, f);
        return result;
      } finally {
        await release();
      }
    };
    const prev = queues.get(this.file) ?? Promise.resolve();
    const p = prev.then(run, run);
    queues.set(this.file, p.catch(() => undefined));
    return p;
  }

  /** The cap a quote of `amount` to `seller` would break on `row`'s day, or undefined when it fits. */
  private room(row: DayRow, seller: string, amount: bigint, caps: LedgerCaps): LedgerRefusal | undefined {
    const pending = Object.values(row.pending);
    if (caps.perSellerPerDay !== undefined) {
      const spent = atomic(row.by_seller[seller]) + pending.filter((p) => p.seller === seller).reduce((a, p) => a + atomic(p.amount_atomic), 0n);
      if (spent + amount > caps.perSellerPerDay) return { rule: "per_seller_per_day", spent, cap: caps.perSellerPerDay, amount, seller };
    }
    if (caps.perDay !== undefined) {
      const spent = atomic(row.settled_atomic) + pending.reduce((a, p) => a + atomic(p.amount_atomic), 0n);
      if (spent + amount > caps.perDay) return { rule: "per_day", spent, cap: caps.perDay, amount, seller };
    }
    return undefined;
  }

  /** Drop days before yesterday (UTC): a cap spans one day, and yesterday is kept for a clock near midnight. */
  private prune(f: LedgerFile, today: string): void {
    const yesterday = utcDay(new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000));
    for (const d of Object.keys(f.days)) if (d < yesterday) delete f.days[d];
  }

  /**
   * Check the caps and, when they allow it, count `amount` against today's totals before anything is signed. `unlisted`
   * says the index has no listing for this seller; with `caps.firstPayment`, a seller that is unlisted and has no local
   * history (`known` false) may not be paid more than that. Totals include other reservations not yet settled.
   */
  async reserve(i: { seller: string; host: string; amount: bigint; caps: LedgerCaps; unlisted: boolean; known: boolean; now?: Date }): Promise<{ ok: true; reservation: Reservation } | { ok: false; refusal: LedgerRefusal }> {
    const now = i.now ?? new Date();
    const day = utcDay(now);
    const seller = i.seller.toLowerCase();
    const host = i.host.toLowerCase();
    type Outcome = { ok: true; reservation: Reservation } | { ok: false; refusal: LedgerRefusal };
    return this.locked<Outcome>(async (f) => {
      this.prune(f, day);
      const row = (f.days[day] ??= emptyDay());
      const refuse = (refusal: LedgerRefusal): { result: Outcome; write: boolean } => ({ result: { ok: false, refusal }, write: false });
      if (i.caps.firstPayment !== undefined && i.unlisted && !i.known && f.sellers[seller] === undefined && f.sellers[host] === undefined && i.amount > i.caps.firstPayment) {
        return refuse({ rule: "first_payment", spent: 0n, cap: i.caps.firstPayment, amount: i.amount, seller });
      }
      const over = this.room(row, seller, i.amount, i.caps);
      if (over) return refuse(over);
      const id = randomBytes(8).toString("hex");
      row.pending[id] = { amount_atomic: i.amount.toString(), seller, pid: process.pid, at: now.toISOString() };
      return { result: { ok: true, reservation: { id, day, seller, host, amount: i.amount } }, write: true };
    });
  }

  /**
   * Move a reservation to the current UTC day when the day has changed since it was made (the checks before signing may
   * have waited across midnight), rechecking the day caps there. Unchanged when the day is the same. When the payment no
   * longer fits, the reservation is removed and the refusal returned: the caller holds nothing any more.
   */
  async rollover(res: Reservation, caps: LedgerCaps, now = new Date()): Promise<{ ok: true; reservation: Reservation } | { ok: false; refusal: LedgerRefusal }> {
    const day = utcDay(now);
    if (day === res.day) return { ok: true, reservation: res };
    type Outcome = { ok: true; reservation: Reservation } | { ok: false; refusal: LedgerRefusal };
    return this.locked<Outcome>(async (f) => {
      const old = f.days[res.day];
      if (old) delete old.pending[res.id];
      this.prune(f, day);
      const row = (f.days[day] ??= emptyDay());
      const over = this.room(row, res.seller, res.amount, caps);
      if (over) return { result: { ok: false, refusal: over }, write: true };
      row.pending[res.id] = { amount_atomic: res.amount.toString(), seller: res.seller, pid: process.pid, at: now.toISOString() };
      return { result: { ok: true, reservation: { ...res, day } }, write: true };
    });
  }

  /**
   * Close a reservation. `paid` true adds it to the day and to the seller history (the amount signed, when it differs
   * from the quote); false drops it. Safe to call for a reservation that is no longer on disk.
   */
  async settle(res: Reservation, paid: boolean, amount: bigint = res.amount, now = new Date()): Promise<void> {
    await this.locked(async (f) => {
      const row = (f.days[res.day] ??= emptyDay());
      delete row.pending[res.id];
      if (paid) {
        row.settled_atomic = (atomic(row.settled_atomic) + amount).toString();
        row.by_seller[res.seller] = (atomic(row.by_seller[res.seller]) + amount).toString();
        const at = now.toISOString();
        for (const k of new Set([res.seller, res.host])) {
          const h = f.sellers[k];
          f.sellers[k] = h ? { first_paid_at: h.first_paid_at, last_paid_at: at, payments: (h.payments ?? 0) + 1 } : { first_paid_at: at, last_paid_at: at, payments: 1 };
        }
      }
      this.prune(f, utcDay(now));
      return { result: undefined, write: true };
    });
  }
}
