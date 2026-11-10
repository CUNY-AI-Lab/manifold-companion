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
  body?: unknown;
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
  if (opts.body !== undefined) {
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
