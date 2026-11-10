import { describe, expect, it } from "vitest";
import { ALICE, BASE, ORIGIN, api, call, fakeFetcher, json, legs, makeEnv } from "./helpers";
import app from "../src/app";
import { readinessResult } from "../src/readiness";
import { gatewayEnv } from "./gateway-stub";
import { validateConfig } from "../src/env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("request ids", () => {
  it("generates a lowercase UUID when none is sent", async () => {
    const res = await call(api("/session"));
    expect(res.headers.get("x-cail-request-id")).toMatch(UUID);
  });
  it("preserves a canonical lowercase UUIDv4 and v7", async () => {
    for (const id of ["3f1c8a52-7e0b-4d6a-9c11-2b5d7f0e8a41", "01890a5d-ac96-774b-bcce-b302099a8057"]) {
      const res = await call(api("/session"), { headers: { "x-cail-request-id": id } });
      expect(res.headers.get("x-cail-request-id")).toBe(id);
    }
  });
  it("replaces uppercase, malformed and wrong-version ids", async () => {
    for (const id of ["3F1C8A52-7E0B-4D6A-9C11-2B5D7F0E8A41", "not-a-uuid", "3f1c8a52-7e0b-1d6a-9c11-2b5d7f0e8a41", "x".repeat(500)]) {
      const res = await call(api("/session"), { headers: { "x-cail-request-id": id } });
      const got = res.headers.get("x-cail-request-id");
      expect(got).toMatch(UUID);
      expect(got).not.toBe(id);
    }
  });
  it("the id is in the error envelope", async () => {
    const res = await call(api("/projects/nope"));
    const body = await json(res);
    expect(body.error.requestId).toBe(res.headers.get("x-cail-request-id"));
  });
});

describe("error envelope", () => {
  it("unknown API route is a JSON 404 with stable code", async () => {
    const res = await call(api("/does-not-exist"));
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatchObject({ code: "not_found", retryable: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("an unexpected exception is a safe 500 that does not quote the exception", async () => {
    const env = await makeEnv({ DB: { prepare: () => { throw new Error("secret-db-detail SELECT * FROM profiles"); } } as unknown as D1Database });
    const res = await call(api("/session"), { env });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret-db-detail");
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });
  it("bodies are bounded: oversized JSON -> 413 payload_too_large", async () => {
    const res = await call(api("/projects"), { method: "POST", body: JSON.stringify({ name: "x", description: "y".repeat(3 * 1024 * 1024) }) });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("payload_too_large");
  });
  it("oversized streamed body without content-length is cut off", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(97);
    const stream = new ReadableStream({ pull(c) { c.enqueue(chunk); } });
    const request = new Request(`${ORIGIN}${api("/projects")}`, {
      method: "POST",
      headers: { ...(await legs(ALICE)), origin: ORIGIN, "content-type": "application/json" },
      body: stream,
      // @ts-expect-error workerd requires duplex for streaming bodies
      duplex: "half",
    });
    const res = await app.fetch(request, await makeEnv());
    expect(res.status).toBe(413);
  });
  it("non-JSON and non-object bodies are 400", async () => {
    for (const body of ["{", "[]", "null", '"str"']) {
      const res = await call(api("/projects"), { method: "POST", body });
      expect(res.status, body).toBe(400);
    }
  });
});

describe("canonical origin", () => {
  it("returns 404 on any other origin, for pages, health and API alike", async () => {
    const env = await makeEnv();
    for (const origin of ["https://cail-manifold-companion.ailab-452.workers.dev", "https://preview.example.com", "http://tools.ailab.gc.cuny.edu"]) {
      for (const path of [`${BASE}/`, `${BASE}/api/session`, "/health/live"]) {
        const res = await app.fetch(new Request(`${origin}${path}`, { headers: await legs(ALICE) }), env);
        expect(res.status, `${origin}${path}`).toBe(404);
      }
    }
  });
});

describe("security headers and static serving", () => {
  it("serves the SPA shell under the mount with CSP", async () => {
    const res = await call(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });
  it("is reachable without credentials: the page shell is Doorway-gated, the API is not public", async () => {
    // Doorway authenticates the page navigation; this Worker serves static assets only.
    expect((await call(`${BASE}/`, { as: null })).status).toBe(200);
  });
  it("falls back to index.html for client-side routes but not for missing files", async () => {
    const route = await call(`${BASE}/projects/abc`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>spa</title>");
    const file = await call(`${BASE}/assets/missing.js`);
    expect(file.status).toBe(404);
  });
  it("redirects the bare mount to the trailing slash and 404s outside the mount", async () => {
    expect((await call(BASE)).status).toBe(301);
    expect((await call("/other")).status).toBe(404);
  });
  it("never caches API responses and never lets a page cache an error", async () => {
    expect((await call(api("/session"))).headers.get("cache-control")).toBe("no-store");
    expect((await call(`${BASE}/assets/missing.js`)).headers.get("cache-control")).toBe("no-store");
  });
  it("does not serve mutations on pages", async () => {
    expect((await call(`${BASE}/`, { method: "POST", body: {} })).status).toBe(405);
  });
  it("passes the asset binding only accept, accept-encoding, conditional and range headers: never the JWTs or cookies", async () => {
    const seen: Headers[] = [];
    const env = await makeEnv({ ASSETS: fakeFetcher((r) => { seen.push(new Headers(r.headers)); return new Response("x", { status: new URL(r.url).pathname === "/index.html" ? 200 : 404 }); }) });
    const res = await call(`${BASE}/projects/abc`, {
      env,
      headers: { cookie: "doorway_session=secret", accept: "text/html", "accept-encoding": "br, gzip", "if-none-match": '"etag-1"', "if-modified-since": "Tue, 10 Nov 2026 00:00:00 GMT", range: "bytes=0-10", "x-forwarded-for": "203.0.113.9", "user-agent": "probe" },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2); // the miss, then index.html
    for (const h of seen) {
      expect([...h.keys()].sort()).toEqual(["accept", "accept-encoding", "if-modified-since", "if-none-match", "range"]);
      expect(h.get("if-none-match")).toBe('"etag-1"');
    }
  });
  it("the page path reads no identity: it is served with no legs, with the app leg only, and with a forged leg alike", async () => {
    const allLegs = await legs();
    const appOnly = Object.fromEntries(Object.entries(allLegs).filter(([k]) => k !== "x-cail-gateway-identity-jwt"));
    const forged = { "x-cail-identity-jwt": "not-a-jwt" };
    const bodies: string[] = [];
    for (const headers of [{}, appOnly, forged]) {
      const res = await call(`${BASE}/projects/abc`, { as: null, headers });
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    // The app leg alone is not enough for the API (it needs the Gateway leg too).
    expect((await call(api("/session"), { as: null, headers: appOnly })).status).toBe(401);
  });
});

describe("readiness", () => {
  it("is ready with a complete configuration and migrated schema", async () => {
    const env = await gatewayEnv({}, { CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "now" } });
    expect(await readinessResult(env)).toMatchObject({ ok: true, configuration: "ready", service: "manifold-companion" });
    const res = await app.fetch(new Request(`${ORIGIN}/health/ready`), env);
    expect(res.status).toBe(200);
  });
  it("reports reasons over RPC but only a verdict over HTTP", async () => {
    const env = await makeEnv({ CAIL_IDENTITY_JWKS: undefined, GATEWAY: undefined });
    const result = await readinessResult(env);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["identity_jwks_missing", "gateway_binding_missing", "identity_app_verifier_jwks_missing"]));
    const res = await app.fetch(new Request(`${ORIGIN}/health/ready`), env);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("jwks");
  });
  it("flags an unmigrated database", async () => {
    const empty = { prepare: () => ({ first: async () => ({ n: 0 }) }) } as unknown as D1Database;
    const result = await readinessResult(await makeEnv({ DB: empty }));
    expect(result.errors).toContain("d1_schema_missing");
  });
  it("validates numeric limits", () => {
    expect(validateConfig({ ...({} as any), STORAGE_QUOTA_BYTES: "abc" }).ok).toBe(false);
  });
  it("live probe works", async () => {
    expect((await app.fetch(new Request(`${ORIGIN}/health/live`), await makeEnv())).status).toBe(200);
  });
});

describe("the Worker entry module", () => {
  // workerd refuses to start when the main module exports anything other than handlers
  // ("Incorrect type for map entry"); the test pool does not catch it, wrangler dev does.
  it("exports only the default handler and WorkerEntrypoint classes", async () => {
    const mod = await import("../src/index");
    const { WorkerEntrypoint } = await import("cloudflare:workers");
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default") continue;
      expect(typeof value === "function" && (value as { prototype: unknown }).prototype instanceof WorkerEntrypoint, `export ${name}`).toBe(true);
    }
  });
});
