import { describe, expect, it } from "vitest";
import { ALICE, api, call, json, legs, makeEnv, ORIGIN, BASE } from "./helpers";
import app from "../src/app";

describe("CSRF: exact Origin on every mutation", () => {
  const mutations: [string, string, unknown][] = [
    ["POST", "/projects", { name: "x" }],
    ["PUT", "/profile", { display_name: "x" }],
    ["DELETE", "/me/data", { confirm: "delete my data" }],
    ["POST", "/invites/redeem", { token: "x" }],
    ["PUT", "/projects/00000000-0000-4000-8000-000000000000", { name: "x" }],
    ["DELETE", "/projects/00000000-0000-4000-8000-000000000000", undefined],
  ];

  it("rejects an absent Origin even with valid credentials", async () => {
    for (const [method, path, body] of mutations) {
      const res = await call(api(path), { method, body, origin: null });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await json(res)).error.code).toBe("origin_mismatch");
    }
  });

  it("does not accept Referer in place of Origin", async () => {
    const res = await call(api("/projects"), { method: "POST", body: { name: "x" }, origin: null, headers: { referer: `${ORIGIN}${BASE}/` } });
    expect(res.status).toBe(403);
  });

  it("rejects foreign, near-miss and null origins", async () => {
    for (const origin of ["https://evil.example", "http://tools.ailab.gc.cuny.edu", "https://tools.ailab.gc.cuny.edu.evil.example", "https://tools.ailab.gc.cuny.edu:8443", `${ORIGIN}/`, "null"]) {
      const res = await call(api("/projects"), { method: "POST", body: { name: "x" }, origin });
      expect(res.status, origin).toBe(403);
    }
  });

  it("accepts the exact canonical origin", async () => {
    const res = await call(api("/projects"), { method: "POST", body: { name: "x" } });
    expect(res.status).toBe(201);
  });

  it("runs before authentication: a cross-origin write learns nothing about sign-in", async () => {
    const res = await call(api("/projects"), { method: "POST", body: { name: "x" }, as: null, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("does not demand Origin on reads", async () => {
    expect((await call(api("/projects"))).status).toBe(200);
  });

  it("local development can set its own exact origin", async () => {
    const env = await makeEnv({ CAIL_CANONICAL_ORIGIN: "http://localhost:8787" });
    const request = new Request("http://localhost:8787/manifold-companion/api/projects", {
      method: "POST",
      headers: { ...(await legs(ALICE)), origin: "http://localhost:8787", "content-type": "application/json" },
      body: JSON.stringify({ name: "dev" }),
    });
    expect((await app.fetch(request, env)).status).toBe(201);
  });
});
