export const nowIso = (ms = Date.now()): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const newId = (): string => crypto.randomUUID();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: string): boolean => UUID.test(v);
const SUBJECT = /^cail-[0-9a-f]{32}$/;
export const isSubject = (v: string): boolean => SUBJECT.test(v);

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url, no padding: 43 characters. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const addDays = (iso: string, days: number): string => nowIso(Date.parse(iso) + days * 86_400_000);
