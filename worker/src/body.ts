import { AppError, E } from "./errors";

/**
 * How long a body of `bytes` may take to arrive: a fixed grace plus the time
 * the bytes need at a slow but real connection (32 KiB/s, about 256 kbit/s),
 * capped well below the storage reservation's 1 h lifetime (src/storage.ts
 * RESERVATION_TTL_MS; a test holds the two apart). An upload holds quota while
 * it is read, so a client that stalls must not hold it, or the isolate, for
 * longer than the transfer could plausibly need. 10 MB: about 6 min; 25 MB:
 * about 14 min.
 */
export const READ_GRACE_MS = 30_000;
export const READ_MIN_BYTES_PER_SECOND = 32 * 1024;
export const READ_DEADLINE_CAP_MS = 20 * 60 * 1000;
export function readDeadlineMs(bytes: number, graceMs = READ_GRACE_MS, minBytesPerSecond = READ_MIN_BYTES_PER_SECOND): number {
  return Math.min(READ_DEADLINE_CAP_MS, graceMs + Math.ceil((Math.max(0, bytes) / minBytesPerSecond) * 1000));
}

const tooSlow = (): AppError =>
  new AppError({ code: "upload_too_slow", message: "The upload stopped arriving before its deadline. Check the connection and try again.", status: 408, retryable: true });

/**
 * Read at most `maxBytes` of the body, within `deadlineMs` (default: in
 * proportion to `maxBytes`, readDeadlineMs). A declared content-length over the
 * cap is refused at once (Doorway forwards the request's content-length), but
 * the header is never trusted as the size: bytes are counted as they stream and
 * the stream is cancelled the moment the cap is passed or the deadline expires
 * (`408 upload_too_slow`; the caller's error path gives back any reservation).
 */
export async function readBoundedBytes(request: Request, maxBytes: number, deadlineMs: number = readDeadlineMs(maxBytes)): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw E.tooLarge(`Request body exceeds ${maxBytes} bytes.`);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { done, value } = await readBefore(reader, deadline);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw E.tooLarge(`Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** One read, or `upload_too_slow` (with the stream cancelled) once the deadline passes. */
async function readBefore(reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  const left = deadline - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), Math.max(0, left));
  });
  try {
    const result = await Promise.race([reader.read(), expired]);
    if (result === "expired") {
      await reader.cancel().catch(() => undefined);
      throw tooSlow();
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export type JsonObject = Record<string, unknown>;

/** Bounded JSON object body. Anything that is not a plain object is a 400. */
export async function readJsonObject(request: Request, maxBytes: number): Promise<JsonObject> {
  const bytes = await readBoundedBytes(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw E.badRequest("Send a JSON object body.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw E.badRequest("Send a JSON object body.");
  return parsed as JsonObject;
}

export function optionalString(body: JsonObject, key: string, max: number): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw E.badRequest(`${key} must be a string.`);
  const t = v.trim();
  if (t.length > max) throw E.badRequest(`${key} must be at most ${max} characters.`);
  return t;
}

export function requiredString(body: JsonObject, key: string, max: number): string {
  const v = optionalString(body, key, max);
  if (v === undefined || v.length === 0) throw E.badRequest(`${key} is required.`);
  return v;
}
