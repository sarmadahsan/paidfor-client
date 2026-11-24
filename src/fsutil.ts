import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Write JSON via temp file + fsync + rename, so a crash leaves either the old or the new file. */
export async function writeJsonDurable(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The content of a lock file: who holds it, and a token that names this acquisition. */
interface LockOwner {
  pid?: number;
  token?: string;
}

async function readOwner(file: string): Promise<LockOwner | undefined> {
  try {
    const o = JSON.parse(await readFile(file, "utf8")) as unknown;
    return o && typeof o === "object" ? (o as LockOwner) : undefined;
  } catch {
    return undefined; // gone, or not JSON
  }
}

const isLive = (o: LockOwner | undefined): o is LockOwner & { pid: number } => o?.pid !== undefined && o.pid !== process.pid && pidAlive(o.pid);

/**
 * Cross-process lock. `lockFile` names the pid that holds it and a token for this acquisition. It is created by hard
 * linking a file written beforehand, so it appears with its content complete or not at all: a half-written lock can
 * never be read as stale. A lock whose pid is dead, or is this pid (only possible after a crash), is stale: it is claimed
 * by renaming it (atomic, so of two processes finding the same stale lock only one removes it) and checked again before
 * it is deleted; a live lock that slipped in meanwhile is given back. Release removes the lock only while it still
 * carries this acquisition's token. `busy(owner)` makes the error thrown when another live process holds it (`owner`
 * undefined when the lock could not be taken after stale ones were cleared). Within one process the caller keeps its own
 * guard: this lock treats its own pid as stale. Returns the release function.
 */
export async function acquireLock(lockFile: string, busy: (owner: number | undefined) => Error): Promise<() => Promise<void>> {
  await mkdir(dirname(lockFile), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const tmp = `${lockFile}.${token}.tmp`;
  await writeFile(tmp, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, lockFile);
        return async () => {
          if ((await readOwner(lockFile))?.token !== token) return; // not ours any more (or already gone)
          await unlink(lockFile).catch(() => undefined);
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const seen = await readOwner(lockFile);
        if (isLive(seen)) throw busy(seen.pid);
        // Stale: a dead process, ourselves after a crash, or unreadable. Claim it before removing it.
        const claimed = `${lockFile}.stale.${token}`;
        try {
          await rename(lockFile, claimed);
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === "ENOENT") continue; // another process removed it first
          throw e2;
        }
        const now = await readOwner(claimed);
        if (isLive(now) && now.token !== seen?.token) {
          // Between the read and the rename another process took the lock: give it back and wait our turn.
          await link(claimed, lockFile).catch(() => undefined);
          await unlink(claimed).catch(() => undefined);
          throw busy(now.pid);
        }
        await unlink(claimed).catch(() => undefined);
      }
    }
    throw busy(undefined);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
