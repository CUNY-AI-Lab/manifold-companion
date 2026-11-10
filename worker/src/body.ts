import { E } from "./errors";

/**
 * Read at most `maxBytes` of the body. Doorway strips content-length over the
 * service binding, so bytes are counted as they stream; the stream is cancelled
 * the moment the cap is passed.
 */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw E.tooLarge(`Request body exceeds ${maxBytes} bytes.`);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
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
