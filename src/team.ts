/**
 * Team mode: the two calls around a payment in paidfor's team API (https://paidfor.dev/docs/team-api.md, `/v1/team`).
 * `authorize` asks before signing and turns anything but a clean decision into "failed", which pays nothing. `report`
 * says what happened afterwards; a report the server could not take is kept and sent again before the next payment,
 * because an approval nobody reports keeps counting against the budgets.
 *
 * Ported from @paidfor/mcp src/team.ts (the security-reviewed copy pay_x402 uses). Differences: the origin is checked
 * when the client is made, the queue entry names the origin and a hash of the key it belongs to (so two clients sharing
 * a directory never send each other's reports with the wrong key), a report that cannot be written to disk is kept in
 * memory, and decisions carry the optional `warnings` and `usage` newer servers send.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt } from "./receipt.js";

export const TEAM_ORIGIN = "https://paidfor.dev";
export const AUTHORIZE_TIMEOUT_MS = 10_000;
export const REPORT_TIMEOUT_MS = 5_000;
/** The words the server takes for a paid outcome. */
const PAID_OUTCOMES = ["ok", "non_delivery", "wrong_goods", "overcharge", "duplicate", "paid_no_response"];
/** Shown when the team does not know the wallet. */
const MCP_INIT = "npx -y @paidfor/mcp@0.7.0 init --wallet --link";

/** `team` in SafeFetchOptions. */
export interface TeamOptions {
  /** The team key, `pft_...`. Sent only to `origin`, as `Authorization: Bearer`, never to a seller and never logged. */
  key: string;
  /** Where the team API lives. Default "https://paidfor.dev". https only, except localhost / 127.0.0.1 / [::1]. */
  origin?: string;
  /** How long to wait for a decision before refusing. Default 10000 ms. */
  authorizeTimeoutMs?: number;
  /** How long each outcome report may take. Default 5000 ms. */
  reportTimeoutMs?: number;
}

/** A notice a newer server may attach to a decision, such as a budget nearly used up. */
export interface TeamWarning {
  code: string;
  message: string;
  upgrade_url?: string;
}

/** Optional fields any decision may carry. Older servers send none. */
export interface TeamDecisionExtras {
  /** Always an array; empty when the server sent none. */
  warnings: TeamWarning[];
  /** The server's spend summary, passed through as sent, when there is one. */
  usage?: Record<string, unknown>;
  /** The ledger row for this decision, when the server named one. */
  ledger_id?: string;
}

/** The server's answer, read strictly. Only `approve` lets a payment be signed. */
export type TeamDecision = (
  | { kind: "approve"; auth_ref: string; valid_before: number }
  | { kind: "decline"; reason: string; message: string; retry_after?: number }
  | { kind: "needs_approval"; approve_url: string; expires_at: string; message: string }
  | { kind: "already_settled"; settlement_ref: string; outcome: string; message: string }
  | { kind: "failed"; message: string }
) &
  TeamDecisionExtras;

export type TeamAuthorizeBody = { wallet: string; intent_id: string; resource_url: string; pay_to: string; amount_atomic: string; network: string; asset: string; scheme: string; protocol: "x402" };

export type TeamOutcomeBody = { wallet: string; intent_id: string; auth_ref: string; paid: boolean; settlement_ref?: string; outcome?: string; http_status?: number; response_sha256?: string };

/**
 * sent: the server has it. queued: kept (on disk, or in memory when the disk write failed) and sent again before the
 * next payment. rejected: the server refused it for good (a 4xx other than 408 / 429).
 */
export type TeamReportState = "sent" | "queued" | "rejected";

/** `receipt.team`: set on every call that asked the team. */
export interface TeamReceipt {
  origin: string;
  decision: TeamDecision["kind"];
  /** The approval's reference (the signed EIP-3009 nonce), for `approve`. */
  auth_ref: string | null;
  reason: string | null;
  message: string | null;
  approve_url: string | null;
  expires_at: string | null;
  ledger_id: string | null;
  warnings: TeamWarning[];
  usage: Record<string, unknown> | null;
  /** What happened to the outcome report. Null when nothing was approved, so there was nothing to report. */
  outcome_report: TeamReportState | null;
}

/** What to report for a payment that was approved, from its receipt. */
export function outcomeFor(r: Receipt, wallet: string, authRef: string): TeamOutcomeBody {
  const base = { wallet, intent_id: r.intent_id, auth_ref: authRef };
  // Nothing left this machine, or the seller says its settlement failed: the money did not move.
  if (!r.paid || r.settlement.parsed?.success === false) return { ...base, paid: false };
  return {
    ...base,
    paid: true,
    // With no transaction hash the signed nonce is what finds the settlement on chain.
    settlement_ref: r.tx_hash ?? r.nonce ?? authRef,
    outcome: r.reported_outcome && PAID_OUTCOMES.includes(r.reported_outcome) ? r.reported_outcome : "non_delivery",
    ...(r.response ? { http_status: r.response.status } : {}),
    ...(r.response?.sha256 ? { response_sha256: r.response.sha256 } : {}),
  };
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function extras(d: Record<string, unknown>): TeamDecisionExtras {
  const warnings = Array.isArray(d.warnings)
    ? d.warnings.flatMap((w): TeamWarning[] => {
        if (!w || typeof w !== "object") return [];
        const o = w as Record<string, unknown>;
        if (!str(o.code) || !str(o.message)) return [];
        return [{ code: o.code.slice(0, 100), message: o.message.slice(0, 500), ...(str(o.upgrade_url) ? { upgrade_url: o.upgrade_url } : {}) }];
      })
    : [];
  const usage = d.usage && typeof d.usage === "object" && !Array.isArray(d.usage) ? (d.usage as Record<string, unknown>) : undefined;
  return { warnings, ...(usage ? { usage } : {}), ...(str(d.ledger_id) ? { ledger_id: d.ledger_id } : {}) };
}

function failedStatus(status: number, body: unknown, wallet: string, origin: string): TeamDecision {
  const said = body && typeof body === "object" && str((body as { error?: unknown }).error) ? ` ${(body as { error: string }).error.slice(0, 300)}` : "";
  const ex: TeamDecisionExtras = { warnings: [] };
  if (status === 401) return { kind: "failed", message: `paidfor refused the team key; check team.key (or PAIDFOR_TEAM_KEY).${said}`, ...ex };
  if (status === 404) {
    return {
      kind: "failed",
      message: `wallet ${wallet} is not registered to this team. Register it on ${origin}/team, or run: ${MCP_INIT} (add --key-file <path> when the key is in a file of your own).${said}`,
      ...ex,
    };
  }
  return { kind: "failed", message: `paidfor answered HTTP ${status}.${said}`, ...ex };
}

/** A 200's body as a decision. Anything not exactly one of the contract's answers is "failed". Unknown fields are ignored. */
export function readDecision(b: unknown): TeamDecision {
  const bad: TeamDecision = { kind: "failed", message: "paidfor's answer could not be read.", warnings: [] };
  if (!b || typeof b !== "object") return bad;
  const d = b as Record<string, unknown>;
  const message = str(d.message) ? d.message : "";
  const ex = extras(d);
  switch (d.decision) {
    case "approve":
      return str(d.auth_ref) && typeof d.valid_before === "number" ? { kind: "approve", auth_ref: d.auth_ref, valid_before: d.valid_before, ...ex } : bad;
    case "decline":
      return str(d.reason) ? { kind: "decline", reason: d.reason, message: message || d.reason, ...(typeof d.retry_after === "number" ? { retry_after: d.retry_after } : {}), ...ex } : bad;
    case "needs_approval":
      return str(d.approve_url) && str(d.expires_at) ? { kind: "needs_approval", approve_url: d.approve_url, expires_at: d.expires_at, message, ...ex } : bad;
    case "already_settled":
      return { kind: "already_settled", settlement_ref: str(d.settlement_ref) ? d.settlement_ref : "unknown", outcome: str(d.outcome) ? d.outcome : "unknown", message, ...ex };
    default:
      return bad;
  }
}

/** The key travels in a header. Plain http is for a server on this machine only. */
export function isKeySafeOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** One queued report, as kept on disk. `key_hash` keeps a report with the key it was made under. */
interface QueueEntry {
  v: 1;
  origin: string;
  key_hash: string;
  body: TeamOutcomeBody;
}

export interface TeamClientOptions {
  /** Team API origin, e.g. "https://paidfor.dev". Must pass isKeySafeOrigin, or the constructor throws. */
  origin: string;
  key: string;
  /** Where reports the server could not take are kept. Created on first use (mode 700, files 600). */
  queueDir: string;
  fetch?: typeof globalThis.fetch;
  warn?: (m: string) => void;
  authorizeTimeoutMs?: number;
  reportTimeoutMs?: number;
  /** Wait before the second try of a report. Default 250 ms. */
  retryDelayMs?: number;
}

/** The two team calls and the report queue. safeFetch's `team` option makes one; exported for callers wiring `authorize` themselves. */
export class TeamClient {
  readonly origin: string;
  private readonly key: string;
  private readonly keyHash: string;
  private readonly queueDir: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly warn: (m: string) => void;
  private readonly authorizeTimeoutMs: number;
  private readonly reportTimeoutMs: number;
  private readonly retryDelayMs: number;
  /** Reports that could not be written to disk; sent again like the disk queue, lost if the process ends. */
  private readonly memory = new Map<string, TeamOutcomeBody>();
  private flushing: Promise<void> | null = null;

  constructor(o: TeamClientOptions) {
    if (typeof o.key !== "string" || !o.key.trim() || /\s/.test(o.key.trim())) throw new TypeError("team: key must be a non-empty team key with no spaces");
    const origin = o.origin.replace(/\/+$/, "");
    if (!isKeySafeOrigin(origin)) throw new TypeError(`team: refusing to send the team key to ${origin}; the origin must be https (or http on localhost)`);
    this.origin = new URL(origin).origin;
    this.key = o.key.trim();
    this.keyHash = createHash("sha256").update(this.key).digest("hex").slice(0, 16);
    this.queueDir = o.queueDir;
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.warn = o.warn ?? (() => undefined);
    this.authorizeTimeoutMs = o.authorizeTimeoutMs ?? AUTHORIZE_TIMEOUT_MS;
    this.reportTimeoutMs = o.reportTimeoutMs ?? REPORT_TIMEOUT_MS;
    this.retryDelayMs = o.retryDelayMs ?? 250;
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    return this.fetchFn(`${this.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body),
      redirect: "error", // the key goes to the configured origin and nowhere else
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Never throws: anything but a 200 with a readable decision is { kind: "failed" }. */
  async authorize(body: TeamAuthorizeBody): Promise<TeamDecision> {
    let res: Response;
    try {
      res = await this.post("/v1/team/authorize", body, this.authorizeTimeoutMs);
    } catch {
      return { kind: "failed", message: "paidfor could not be reached.", warnings: [] };
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* an unreadable body is handled below */
    }
    return res.status === 200 ? readDecision(parsed) : failedStatus(res.status, parsed, body.wallet, this.origin);
  }

  /** One try. "retry" means the server could not take it now; a 4xx will never be taken, so it is not kept. */
  private async send(body: TeamOutcomeBody): Promise<"sent" | "rejected" | "retry"> {
    try {
      const res = await this.post("/v1/team/outcome", body, this.reportTimeoutMs);
      void res.body?.cancel().catch(() => undefined);
      if (res.ok) return "sent";
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        this.warn(`team: the outcome for intent ${body.intent_id} was refused with HTTP ${res.status}`);
        return "rejected";
      }
      return "retry";
    } catch {
      return "retry";
    }
  }

  private queueName(body: TeamOutcomeBody): string {
    return `${createHash("sha256").update(`${body.intent_id}\n${body.auth_ref}`).digest("hex").slice(0, 40)}.json`;
  }

  /** Send the outcome of an approved payment, try once more, and keep it if the server still cannot take it. */
  async report(body: TeamOutcomeBody): Promise<TeamReportState> {
    let r = await this.send(body);
    if (r === "retry") {
      await new Promise((d) => setTimeout(d, this.retryDelayMs));
      r = await this.send(body);
    }
    if (r !== "retry") return r;
    const name = this.queueName(body);
    try {
      await mkdir(this.queueDir, { recursive: true, mode: 0o700 });
      const file = join(this.queueDir, name);
      const entry: QueueEntry = { v: 1, origin: this.origin, key_hash: this.keyHash, body };
      await writeFile(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch (e) {
      this.memory.set(name, body);
      this.warn(`team: could not write the outcome for intent ${body.intent_id} to disk (${e instanceof Error ? e.message : String(e)}); kept in memory until it is sent`);
    }
    return "queued";
  }

  /** Reports still owed: on disk for this origin and key, plus those kept in memory. */
  async pending(): Promise<TeamOutcomeBody[]> {
    const out = [...this.memory.values()];
    for (const { body } of await this.diskEntries()) out.push(body);
    return out;
  }

  private async diskEntries(): Promise<{ file: string; body: TeamOutcomeBody }[]> {
    let names: string[];
    try {
      names = (await readdir(this.queueDir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return []; // nothing queued yet
    }
    const out: { file: string; body: TeamOutcomeBody }[] = [];
    for (const name of names) {
      const file = join(this.queueDir, name);
      try {
        const e = JSON.parse(await readFile(file, "utf8")) as Partial<QueueEntry> & Partial<TeamOutcomeBody>;
        if (e.v === 1 && e.body) {
          if (e.origin === this.origin && e.key_hash === this.keyHash) out.push({ file, body: e.body });
        } else if (str(e.intent_id) && str(e.auth_ref) && str(e.wallet)) {
          // A bare outcome body, as @paidfor/mcp's queue keeps them: it names no key, so it is this client's.
          out.push({ file, body: e as TeamOutcomeBody });
        }
      } catch (err) {
        this.warn(`team: could not read the queued outcome ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /** Send what earlier reports left behind. Stops at the first one the server cannot take now. Never throws. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    for (const [name, body] of [...this.memory]) {
      const r = await this.send(body);
      if (r === "retry") return;
      this.memory.delete(name);
    }
    for (const { file, body } of await this.diskEntries()) {
      const r = await this.send(body);
      if (r === "retry") return;
      await unlink(file).catch((e: unknown) => this.warn(`team: could not remove the sent outcome ${file}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}
