/// <reference types="vite/client" />
// Every Gateway call (catalog, quota, chat, and the readiness probe) goes
// through the GATEWAY service binding, never global fetch. A same-zone Worker
// that fetches the Gateway's public URL gets the zone origin's 404 in
// production (the Bibliography Converter's bug), which no local test with a
// stubbed network would show; so global fetch is made to fail here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { readinessResult, resetPublicHealth } from "../src/readiness";
import { ALICE, JPEG, ORIGIN, api, call, createProject, createText, fakeFetcher, json, upload } from "./helpers";
import { gatewayEnv, gatewayOf } from "./gateway-stub";

let globalFetch: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("global fetch used: the zone origin would answer 404", { status: 404 }));
});
afterEach(() => globalFetch.mockRestore());

const paths = (e: Awaited<ReturnType<typeof gatewayEnv>>) => gatewayOf(e).calls.map((r) => new URL(r.url).pathname);

describe("the GATEWAY binding carries every Gateway call", () => {
  it("catalog, quota, OCR, page HTML, summary, translation, formula repair: all through the binding, none through global fetch", async () => {
    const e = await gatewayEnv({ chat: (body) => ({ text: JSON.stringify(body.messages?.[1]?.content ?? "").includes("[") ? '["x"]' : '<section data-page="1"><p>ok text here, long enough to count</p></section>' }) });
    expect((await call(api("/models"), { env: e })).status).toBe(200);
    expect((await call(api("/quota"), { env: e })).status).toBe(200);
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    const page = (await json(await upload(api(`/texts/${tid}/pages`), JPEG(256), ALICE, { query: { filename: "p.jpg" }, env: e }))).page;
    expect((await call(api(`/texts/${tid}/pages/${page.id}/ocr`), { method: "POST", body: {}, env: e })).status).toBe(200);
    expect((await call(api(`/texts/${tid}/summary`), { method: "POST", body: {}, env: e })).status).toBe(200);
    expect((await call(api(`/texts/${tid}/translate-chunk`), { method: "POST", body: { text: "Bonjour", source_language: "fr", target_language: "en" }, env: e })).status).toBe(200);
    const hp = await createProject(ALICE, "PDF", { project_type: "pdf_to_html" });
    const ht = await createText(ALICE, hp);
    expect((await call(api(`/texts/${ht}/parse-page`), { method: "POST", body: { image: "data:image/png;base64,iVBORw0KGgo=", page_number: 1 }, env: e })).status).toBe(200);
    expect((await call(api(`/texts/${ht}/formula-repair`), { method: "POST", body: { formulas: ["\\frac{1}{"] }, env: e })).status).toBe(200);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(new Set(paths(e))).toEqual(new Set(["/v1/catalog", "/v1/quota", "/v1/chat/completions"]));
    expect(paths(e).filter((p) => p === "/v1/chat/completions")).toHaveLength(5);
  });

  it("readiness reads the public catalog through the binding, with no credential", async () => {
    const e = await gatewayEnv({}, { CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "now" } });
    expect(await readinessResult(e)).toMatchObject({ ok: true });
    const res = await app.fetch(new Request(`${ORIGIN}/health/ready`), e);
    expect(res.status).toBe(200);
    const probes = gatewayOf(e).calls.filter((r) => new URL(r.url).pathname === "/v1/catalog");
    expect(probes.length).toBeGreaterThanOrEqual(2);
    for (const r of probes) {
      expect(r.headers.get("authorization")).toBeNull();
      expect(r.headers.get("x-cail-identity-jwt")).toBeNull();
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("a binding that answers like the zone origin (404 page) or with an empty catalog makes the Worker not ready", async () => {
    const zone404 = await gatewayEnv({ catalog: () => new Response("<html>404 Not Found</html>", { status: 404, headers: { "content-type": "text/html" } }) });
    expect((await readinessResult(zone404)).errors).toContain("gateway_catalog_unreachable");
    expect((await app.fetch(new Request(`${ORIGIN}/health/ready`), zone404)).status).toBe(503);
    const empty = await gatewayEnv({ catalog: () => Response.json({ object: "list", data: [] }) });
    expect((await readinessResult(empty)).errors).toContain("gateway_catalog_empty");
    const hanging = await gatewayEnv({}, { GATEWAY: fakeFetcher(() => { throw new Error("binding down"); }) });
    expect((await readinessResult(hanging)).errors).toContain("gateway_catalog_unreachable");
  });
});

describe("the public canary route", () => {
  it("answers without any credential, through the binding, with no reasons; cached for 30 s", async () => {
    resetPublicHealth();
    const e = await gatewayEnv({}, { CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "now" } });
    const res = await app.fetch(new Request(`${ORIGIN}/manifold-companion/api/health`), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, status: "ready", version: "v1" });
    const reads = gatewayOf(e).calls.length;
    await app.fetch(new Request(`${ORIGIN}/manifold-companion/api/health`), e);
    expect(gatewayOf(e).calls.length).toBe(reads);
    expect(globalFetch).not.toHaveBeenCalled();
  });
  it("is 503 with no reasons when the Gateway path is broken; other API routes still require sign-in", async () => {
    resetPublicHealth();
    const e = await gatewayEnv({ catalog: () => new Response("<html>404</html>", { status: 404 }) }, { CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "now" } });
    const res = await app.fetch(new Request(`${ORIGIN}/manifold-companion/api/health`), e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, status: "not_ready", version: "v1" });
    resetPublicHealth();
    expect((await app.fetch(new Request(`${ORIGIN}/manifold-companion/api/session`), e)).status).toBe(401);
    expect((await app.fetch(new Request(`https://example.workers.dev/manifold-companion/api/health`), e)).status).toBe(404);
  });
});

describe("no source file reaches the network except through a binding", () => {
  // Source text of every module the Worker bundles (Vite raw import; no file system in workerd).
  const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(Object.keys(sources)).toContain("../src/gateway.ts");
  });
  const allowed = /\b(?:binding|ASSETS|app)\.fetch\(/;
  const offendersIn = (file: string, text: string): string[] => {
    const offenders: string[] = [];
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const m of code.matchAll(/[\w.$]*\bfetch\s*\(/g)) if (!allowed.test(m[0])) offenders.push(`${file}: ${m[0]}`);
    if (/createCailClient\(/.test(code) && !/fetchImpl/.test(code)) offenders.push(`${file}: createCailClient without fetchImpl (it would default to global fetch)`);
    return offenders;
  };
  it("the scan catches a global fetch and a client without the binding adapter", () => {
    expect(offendersIn("x.ts", 'await fetch("https://tools.ailab.gc.cuny.edu/v1/catalog")')).toHaveLength(1);
    expect(offendersIn("x.ts", "globalThis.fetch(u)")).toHaveLength(1);
    expect(offendersIn("x.ts", 'createCailClient({ app: "a", baseUrl })')).toHaveLength(1);
    expect(offendersIn("x.ts", "env.GATEWAY.fetch(r)")).toHaveLength(1); // only through gateway.ts's adapter
    expect(offendersIn("x.ts", "binding.fetch(input, init) // fetch(x) in a comment")).toEqual([]);
  });
  it("every fetch( is a binding's (GATEWAY via the client adapter, ASSETS) or the app's own entry point", () => {
    expect(Object.entries(sources).flatMap(([file, text]) => offendersIn(file, text))).toEqual([]);
  });
});
