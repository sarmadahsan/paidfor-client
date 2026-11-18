/**
 * Local x402 seller (Base Sepolia, verifies real EIP-3009 signatures; adapted from x402-audit src/x402/pay.test.ts)
 * plus a local paidfor index serving the /v1/check contract from test/fixtures and recording /v1/telemetry posts.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HEADERS, decodeHeaderJson, encodeHeaderJson } from "../src/x402/types.js";

export const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const NETWORK = "eip155:84532" as const;
export const TX = "0x" + "ab".repeat(32);

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

export type SellerMode = "ok" | "conway_500" | "big" | "hang" | "offnet" | "free" | "settle_fail" | "reject_402" | "reject_garbled" | "markdown" | "html_200";
export type IndexMode = { kind: "json"; body: unknown } | { kind: "status"; status: number } | { kind: "hang" };

export interface MockState {
  mode: SellerMode;
  amount: string;
  unpaidCount: number;
  paidCount: number;
  verifyErrors: string[];
  /** The authorization nonce of every paid request, in order. */
  nonces: string[];
  index: IndexMode;
  indexCalls: string[];
  telemetryStatus: number | "hang";
  telemetry: unknown[];
}

export const payTo = privateKeyToAccount(generatePrivateKey()).address;

export function freshState(): MockState {
  return {
    mode: "ok",
    amount: "10000",
    unpaidCount: 0,
    paidCount: 0,
    verifyErrors: [],
    nonces: [],
    index: { kind: "status", status: 503 },
    indexCalls: [],
    telemetryStatus: 404,
    telemetry: [],
  };
}

function envelope(st: MockState, url: string) {
  return {
    x402Version: 2,
    resource: { url, description: "test", mimeType: "application/json" },
    accepts: [
      { scheme: "exact", network: "eip155:8453", amount: "1", asset: USDC_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } },
      ...(st.mode === "offnet"
        ? []
        : [{ scheme: "exact", network: NETWORK, amount: st.amount, asset: USDC_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }]),
    ],
  };
}

async function checkPayment(st: MockState, header: string): Promise<{ payer: string }> {
  const p = decodeHeaderJson(header) as {
    x402Version: number;
    accepted: { network: string };
    payload: { signature: `0x${string}`; authorization: { from: `0x${string}`; to: `0x${string}`; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` } };
  };
  const a = p.payload.authorization;
  const errs: string[] = [];
  if (p.x402Version !== 2) errs.push("version");
  if (p.accepted.network !== NETWORK) errs.push("network");
  if (getAddress(a.to) !== getAddress(payTo)) errs.push("to");
  if (a.value !== st.amount) errs.push("value");
  const valid = await verifyTypedData({
    address: a.from,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC_SEPOLIA) },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: p.payload.signature,
  });
  if (!valid) errs.push("signature");
  st.verifyErrors.push(...errs);
  st.nonces.push(a.nonce);
  return { payer: a.from };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handler(st: MockState, req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path === "/v1/check") {
    st.indexCalls.push(req.url ?? "");
    const ix = st.index;
    if (ix.kind === "hang") return;
    if (ix.kind === "status") {
      res.writeHead(ix.status);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ix.body));
    return;
  }
  if (path === "/v1/telemetry") {
    st.telemetry.push(JSON.parse(await readBody(req)));
    if (st.telemetryStatus === "hang") return;
    res.writeHead(st.telemetryStatus);
    res.end();
    return;
  }

  await readBody(req);
  if (st.mode === "free") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("free");
    return;
  }
  const sig = req.headers["payment-signature"];
  if (typeof sig !== "string") {
    st.unpaidCount++;
    res.writeHead(402, { [HEADERS.V2_REQUIRED]: encodeHeaderJson(envelope(st, `http://test${req.url}`)), "content-type": "application/json" });
    res.end("{}");
    return;
  }
  st.paidCount++;
  const { payer } = await checkPayment(st, sig);
  const settle = { success: true, transaction: TX, network: NETWORK, payer };
  switch (st.mode) {
    case "ok":
    case "offnet":
      res.writeHead(200, { "content-type": "application/json", [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      res.end(JSON.stringify({ ok: true, credits: 100 }));
      return;
    case "markdown":
      // Declares application/json in its 402 and answers with the article as markdown (aiact-api.com, issue 40).
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      res.end("# Article 5\n\nProhibited AI practices: the full text of the article.");
      return;
    case "html_200":
      res.writeHead(200, { "content-type": "text/html", [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      res.end("<!doctype html><html><body>Service temporarily unavailable</body></html>");
      return;
    case "conway_500":
      // Conway auto-top-up: the seller settles the payment, then fails the request.
      res.writeHead(500, { "content-type": "application/json", [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      res.end(JSON.stringify({ error: "internal error" }));
      return;
    case "settle_fail":
      res.writeHead(402, { [HEADERS.V2_RESPONSE]: encodeHeaderJson({ success: false, transaction: "", network: NETWORK, errorReason: "insufficient_funds" }) });
      res.end("{}");
      return;
    case "reject_402":
      // An empty wallet: the facilitator cannot settle, so the seller asks to be paid again and settles nothing.
      res.writeHead(402, { [HEADERS.V2_REQUIRED]: encodeHeaderJson(envelope(st, `http://test${req.url}`)), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "insufficient_funds" }));
      return;
    case "reject_garbled":
      // A 402 with a settlement header nobody can read: it might name a settlement, so it is not taken as a rejection.
      res.writeHead(402, { [HEADERS.V2_RESPONSE]: "%%%not-base64%%%", "content-type": "application/json" });
      res.end("{}");
      return;
    case "big": {
      const size = 3 * 1024 * 1024;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size), [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < size) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => undefined);
      pump();
      return;
    }
    case "hang":
      return;
  }
}

export interface Mock {
  base: string;
  st: MockState;
  reset(): void;
  close(): Promise<void>;
}

export async function startMock(): Promise<Mock> {
  const st = freshState();
  const server: Server = createServer((req, res) => {
    handler(st, req, res).catch((e) => {
      st.verifyErrors.push(String(e));
      res.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    st,
    reset: () => Object.assign(st, freshState()),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
