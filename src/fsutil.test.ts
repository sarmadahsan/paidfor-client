import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "./fsutil.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x402-lock-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const busy = (owner: number | undefined) => new Error(owner === undefined ? "could not lock" : `held by ${owner}`);

describe("acquireLock", () => {
  it("creates the lock with its content complete, and leaves nothing else behind once released", async () => {
    const lock = join(dir, "x.lock");
    const release = await acquireLock(lock, busy);
    const o = JSON.parse(await readFile(lock, "utf8")) as { pid: number; token: string; at: number };
    expect(o.pid).toBe(process.pid);
    expect(o.token).toMatch(/^[0-9a-f]{16}$/);
    expect(await readdir(dir)).toEqual(["x.lock"]);
    await release();
    expect(await readdir(dir)).toEqual([]);
  });

  it("a lock held by a live process is busy; a dead process's lock, or one with unreadable content, is taken over", async () => {
    const lock = join(dir, "x.lock");
    await writeFile(lock, JSON.stringify({ pid: 1, at: Date.now() })); // pid 1 is always alive
    await expect(acquireLock(lock, busy)).rejects.toThrow("held by 1");
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    await (await acquireLock(lock, busy))();
    await writeFile(lock, "");
    await (await acquireLock(lock, busy))();
    expect(await readdir(dir)).toEqual([]);
  });

  it("this pid's own lock is stale (a crash), and release removes only the lock it took", async () => {
    const lock = join(dir, "x.lock");
    const first = await acquireLock(lock, busy);
    const second = await acquireLock(lock, busy); // own pid: treated as left behind by a crash
    await first(); // the token is the second acquisition's: not ours any more, left in place
    expect(await readdir(dir)).toEqual(["x.lock"]);
    await second();
    expect(await readdir(dir)).toEqual([]);
  });
});
