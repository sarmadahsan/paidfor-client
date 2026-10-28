import { randomBytes } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
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
