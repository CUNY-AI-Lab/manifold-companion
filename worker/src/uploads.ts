// Receiving uploaded bytes. Order is deliberate:
//   declared size -> cheap checks -> ATOMIC quota reservation -> read at most
//   that many bytes -> magic-byte sniff -> store. Bytes are never accepted
//   without a reservation, and every failure after it releases the reservation.
// The client declares the exact size (`size` query) before any bytes are read,
// so quota is reserved for exactly that size, and it is enforced as a hard read
// limit. Content-length (Doorway forwards it on requests) is not relied on: it
// can be absent on a streamed body, and the read limit holds either way.
import { readBoundedBytes } from "./body";
import { E } from "./errors";
import type { Env } from "./env";
import { releaseStorage, reserveStorage } from "./storage";

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === "RIFF" && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === "WEBP") return "image/webp";
  return null;
}

export function sniffPdf(b: Uint8Array): boolean {
  return b.length >= 5 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!) === "%PDF-";
}

export const imageKind = (t: string): "image-jpeg" | "image-png" | "image-webp" => (t === "image/png" ? "image-png" : t === "image/webp" ? "image-webp" : "image-jpeg");

/** Strip any path, control and shell-special characters; keep it short. Names live in D1 only, never in R2 keys. */
export function cleanFilename(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  let name = (raw ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  if (name === "") throw E.badRequest("A file name is required.", "filename_required");
  return name;
}

export function declaredSize(raw: string | undefined, max: number): number {
  if (raw === undefined || !/^\d{1,12}$/.test(raw)) throw E.badRequest("Declare the exact file size in bytes with ?size=.", "size_required");
  const n = Number(raw);
  if (n < 1) throw E.badRequest("The file is empty.", "file_empty");
  if (n > max) throw E.tooLarge(`Files can be at most ${max} bytes.`, "file_too_large");
  return n;
}

export interface Received<T> {
  bytes: Uint8Array;
  type: T;
  /** Call if anything after receipt fails: gives the reserved quota back. */
  release: () => Promise<void>;
}

export async function receive<T>(env: Env, request: Request, ownerSubject: string, size: number, sniff: (b: Uint8Array) => T | null): Promise<Received<T>> {
  await reserveStorage(env, ownerSubject, size); // before reading a single byte
  const release = () => releaseStorage(env.DB, ownerSubject, size);
  try {
    const bytes = await readBoundedBytes(request, size);
    if (bytes.byteLength !== size) throw E.badRequest("The uploaded size did not match the declared size.", "size_mismatch");
    const type = sniff(bytes);
    if (type === null) throw E.unsupported("That file type is not accepted.");
    return { bytes, type, release };
  } catch (error) {
    await release();
    throw error;
  }
}
