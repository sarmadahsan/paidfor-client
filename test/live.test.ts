/** Opt-in: LIVE_INDEX=1 pnpm test. Checks the client parses the real https://paidfor.dev/v1/check once it answers. */
import { describe, expect, it } from "vitest";
import { checkIndex } from "../src/index-client.js";

const live = process.env.LIVE_INDEX === "1";
const INDEX = process.env.LIVE_INDEX_URL ?? "https://paidfor.dev/v1";

describe.skipIf(!live)("live index", () => {
  it("answers /check within 2 s with a parseable verdict", async () => {
    const c = await checkIndex(INDEX, "https://api.vapinetwork.ai/shim/o1/token");
    expect(c.note ?? "").not.toMatch(/timeout|http|error/);
    expect(["avoid", "caution", "ok", "unknown"]).toContain(c.verdict);
    expect(c.seller_url).toMatch(/^https:\/\//);
  });
});
