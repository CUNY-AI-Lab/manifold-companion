import { env as testEnv } from "cloudflare:workers";
import { createTestIdentityIssuer, TEST_SUBJECTS, type TestIdentityIssuer } from "@cuny-ai-lab/cail-identity/testing";
import app from "../src/app";
import type { Env } from "../src/env";
import { APP_AUDIENCE } from "../src/identity";

export const ORIGIN = "https://tools.ailab.gc.cuny.edu";
export const BASE = "/manifold-companion";
export const ALICE = TEST_SUBJECTS.alice;
export const BOB = TEST_SUBJECTS.bob;
export const CAROL = TEST_SUBJECTS.carol;

let issuerPromise: Promise<TestIdentityIssuer> | undefined;
// Real signing key, real CAIL Identity verification: nothing about the identity
// boundary is mocked.
export const issuer = (): Promise<TestIdentityIssuer> => (issuerPromise ??= createTestIdentityIssuer());

export interface FakeFetcher extends Fetcher {
  calls: Request[];
}
export function fakeFetcher(handler: (r: Request) => Response | Promise<Response>): FakeFetcher {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      return handler(request);
    },
  } as unknown as FakeFetcher;
}

export async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const iss = await issuer();
  return {
    ASSETS: fakeFetcher((r) => {
      const path = new URL(r.url).pathname;
      if (path === "/index.html" || path === "/") return new Response("<!doctype html><title>spa</title>", { headers: { "content-type": "text/html" } });
      if (path === "/assets/app.js") return new Response("console.log(1)", { headers: { "content-type": "text/javascript" } });
      return new Response("not found", { status: 404 });
    }),
    GATEWAY: fakeFetcher(() => new Response("unexpected gateway call", { status: 500 })),
    DB: testEnv.DB,
    FILES: testEnv.FILES,
    CAIL_IDENTITY_JWKS: iss.jwksJson,
    CAIL_IDENTITY_ISSUER: iss.issuer,
    CAIL_CANONICAL_ORIGIN: ORIGIN,
    ...overrides,
  };
}

export async function legs(subject: string = ALICE, gatewaySubject: string = subject): Promise<Record<string, string>> {
  const iss = await issuer();
  return {
    "x-cail-identity-jwt": await iss.mintIdentityJwt({ audience: APP_AUDIENCE, subject }),
    "x-cail-gateway-identity-jwt": await iss.mintIdentityJwt({ audience: "cail:gateway", subject: gatewaySubject }),
  };
}

export interface CallOptions {
  method?: string;
  body?: unknown | Uint8Array | ReadableStream;
  /** Subject to sign in as; null sends no credentials. Default ALICE. */
  as?: string | null;
  headers?: Record<string, string>;
  /** Send an Origin header on mutations. Default: canonical origin. */
  origin?: string | null;
  env?: Env;
}

export async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...(opts.as === null ? {} : await legs(opts.as ?? ALICE)), ...opts.headers };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null && method !== "GET") headers.origin = origin;
  let body: BodyInit | undefined;
  if (opts.body instanceof Uint8Array) {
    headers["content-type"] = "application/octet-stream";
    body = opts.body as unknown as BodyInit;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const request = new Request(`${ORIGIN}${path}`, { method, headers, body });
  return app.fetch(request, opts.env ?? (await makeEnv()));
}

export const api = (path: string): string => `${BASE}/api${path}`;

export async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function createProject(as: string, name = "Project", extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(api("/projects"), { method: "POST", as, body: { name, ...extra } });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
  return (await json(res)).project.id as string;
}

export async function invite(owner: string, projectId: string, role: "editor" | "viewer", days?: number): Promise<{ id: string; token: string }> {
  const res = await call(api(`/projects/${projectId}/invites`), { method: "POST", as: owner, body: { role, ...(days ? { expires_in_days: days } : {}) } });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
  return (await json(res)).invite;
}

export async function redeem(as: string, token: string): Promise<Response> {
  return call(api("/invites/redeem"), { method: "POST", as, body: { token } });
}

/** Join `project` as `role` through the real invite flow. */
export async function addMember(owner: string, projectId: string, subject: string, role: "editor" | "viewer"): Promise<void> {
  const inv = await invite(owner, projectId, role);
  const res = await redeem(subject, inv.token);
  if (res.status !== 201) throw new Error(`redeem failed: ${res.status} ${await res.text()}`);
}

export async function createText(as: string, projectId: string, name = "Text"): Promise<string> {
  const res = await call(api(`/projects/${projectId}/texts`), { method: "POST", as, body: { name } });
  if (res.status !== 201) throw new Error(`createText failed: ${res.status} ${await res.text()}`);
  return (await json(res)).text.id as string;
}

/** Insert a page row (and optionally its image object) the way the upload route will. */
export async function seedPage(textId: string, opts: { filename?: string; ocr?: string | null; imageBytes?: number; pageNumber?: number } = {}): Promise<string> {
  const { env: e } = await import("cloudflare:workers");
  const id = crypto.randomUUID();
  const t = await e.DB.prepare("SELECT project_id FROM texts WHERE id = ?").bind(textId).first<{ project_id: string }>();
  const owner = await e.DB.prepare("SELECT owner_subject FROM projects WHERE id = ?").bind(t!.project_id).first<{ owner_subject: string }>();
  let key: string | null = null;
  const bytes = opts.imageBytes ?? 0;
  if (bytes > 0) {
    key = `p/${t!.project_id}/t/${textId}/page/${id}`;
    await e.FILES.put(key, new Uint8Array(bytes).fill(7), { httpMetadata: { contentType: "image/jpeg" } });
    await e.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + ? WHERE subject = ?").bind(bytes, owner!.owner_subject).run();
  }
  await e.DB.prepare("INSERT INTO pages (id, text_id, filename, page_number, ocr_text, image_key, image_bytes) VALUES (?,?,?,?,?,?,?)")
    .bind(id, textId, opts.filename ?? `p${id.slice(0, 4)}.jpg`, opts.pageNumber ?? 1, opts.ocr ?? null, key, bytes).run();
  return id;
}

export async function storageOf(subject: string): Promise<number> {
  const { env: e } = await import("cloudflare:workers");
  return (await e.DB.prepare("SELECT storage_bytes FROM profiles WHERE subject = ?").bind(subject).first<{ storage_bytes: number }>())!.storage_bytes;
}

/** DB wrapper that fails any statement mentioning FTS MATCH, to exercise the LIKE fallback. */
export function dbWithoutFts(real: D1Database): D1Database {
  return {
    prepare: (sql: string) => {
      if (/MATCH|text_fts/.test(sql)) throw new Error("no such module: fts5");
      return real.prepare(sql);
    },
    batch: (s: D1PreparedStatement[]) => real.batch(s),
    exec: (s: string) => real.exec(s),
  } as unknown as D1Database;
}

export const JPEG = (n = 64): Uint8Array => { const b = new Uint8Array(n).fill(1); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
export const PNG = (n = 64): Uint8Array => { const b = new Uint8Array(n).fill(2); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
export const WEBP = (n = 64): Uint8Array => { const b = new Uint8Array(n).fill(3); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); return b; };
export const PDF = (n = 64): Uint8Array => { const b = new Uint8Array(n).fill(32); b.set(new TextEncoder().encode("%PDF-1.7\n")); return b; };

export function upload(path: string, bytes: Uint8Array, as: string = ALICE, opts: { method?: string; query?: Record<string, string>; env?: Env } = {}): Promise<Response> {
  const q = new URLSearchParams({ size: String(bytes.byteLength), ...(opts.query ?? {}) });
  return call(`${path}${path.includes("?") ? "&" : "?"}${q}`, { method: opts.method ?? "POST", as, body: bytes, ...(opts.env ? { env: opts.env } : {}) });
}
