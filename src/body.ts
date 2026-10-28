/**
 * Like x402-audit readBodyCapped (src/x402/http.ts), but the caller still gets the whole body: the first
 * `maxBytes` are buffered for the validators and the replay store, and anything past that is streamed
 * through untouched.
 */
import type { BodyReadResult } from "./x402/http.js";

export interface TeeResult extends BodyReadResult {
  /** What to hand back to the caller: the bytes, or a stream of buffered prefix + rest. */
  callerBody: Uint8Array | ReadableStream<Uint8Array> | null;
}

export async function readBodyTee(res: Response, maxBytes: number): Promise<TeeResult> {
  const cl = res.headers.get("content-length");
  const declared = cl !== null && /^\d+$/.test(cl.trim()) ? Number(cl.trim()) : undefined;
  const encoding = (res.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncatedByUs = false;
  let incomplete = false;
  let streamError: unknown;
  let overflow: Uint8Array | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  if (res.body) {
    reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (total + value.byteLength > maxBytes) {
          const keep = maxBytes - total;
          if (keep > 0) chunks.push(value.subarray(0, keep));
          overflow = value.subarray(Math.max(keep, 0));
          total += Math.max(keep, 0);
          truncatedByUs = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (e) {
      incomplete = true;
      streamError = e;
    }
  }
  if (!truncatedByUs && !incomplete && declared !== undefined && (encoding === "identity" || encoding === "") && total < declared) {
    incomplete = true;
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }

  let callerBody: TeeResult["callerBody"] = res.body ? body : null;
  if (truncatedByUs && reader) {
    const r = reader;
    const head = [body, overflow ?? new Uint8Array(0)];
    callerBody = new ReadableStream<Uint8Array>({
      start(c) {
        for (const h of head) if (h.byteLength) c.enqueue(h);
      },
      async pull(c) {
        try {
          const { done, value } = await r.read();
          if (done) c.close();
          else c.enqueue(value);
        } catch (e) {
          c.error(e);
        }
      },
      cancel(reason) {
        return r.cancel(reason);
      },
    });
  } else if (reader && !incomplete) {
    reader.releaseLock();
  }

  const out: TeeResult = { body, truncatedByUs, incomplete, callerBody };
  if (declared !== undefined) out.declaredLength = declared;
  if (streamError !== undefined) out.streamError = streamError;
  return out;
}
