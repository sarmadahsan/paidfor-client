import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
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

/**
 * Cross-process lock: `lockFile` is created exclusively and names this pid. A lock left by a dead process, or by this
 * pid (only possible after a crash), is stale and taken over. `busy(owner)` makes the error thrown when another live
 * process holds it (`owner` undefined when the lock could not be taken after a stale one was cleared). Within one
 * process the caller keeps its own guard: this lock treats its own pid as stale. Returns the release function.
 */
export async function acquireLock(lockFile: string, busy: (owner: number | undefined) => Error): Promise<() => Promise<void>> {
  await mkdir(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockFile, "wx");
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        await fh.close();
      }
      return async () => {
        await unlink(lockFile).catch(() => undefined);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: number | undefined;
      try {
        owner = (JSON.parse(await readFile(lockFile, "utf8")) as { pid?: number }).pid;
      } catch {
        /* half-written lock: treat as stale */
      }
      if (owner !== undefined && owner !== process.pid && pidAlive(owner)) throw busy(owner);
      await unlink(lockFile).catch(() => undefined); // stale lock from a dead process (or ourselves after a crash)
    }
  }
  throw busy(undefined);
}
