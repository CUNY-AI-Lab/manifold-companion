import { describe, expect, it } from "vitest";
import { ALICE, BOB, BASE, api, call, issuer, json, legs, makeEnv, ORIGIN } from "./helpers";
import app from "../src/app";
import { APP_AUDIENCE } from "../src/identity";

const session = api("/session");

describe("identity matrix", () => {
  it("accepts a valid app assertion and matching gateway leg", async () => {
    const res = await call(session);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.subject).toBe(ALICE);
    expect(body.profile).toEqual({ display_name: null, theme_preference: "system", onboarded: false });
    expect(body.storage.quota_bytes).toBe(500 * 1024 * 1024);
  });

  it("no credential at all -> 401 authentication_required with the launch path", async () => {
    const res = await call(session, { as: null });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toEqual({ code: "authentication_required", message: expect.any(String), launch: "/launch/manifold-companion" });
  });

  // A verified app leg with no Gateway leg means the Doorway route lost gatewayIdentity.
  // authentication_required would make the client navigate to the launch path, which
  // returns it here with the same headers: a navigation loop. It is a credential fault.
  it("app assertion without a gateway leg -> 401 invalid_credential, no launch path", async () => {
    const { "x-cail-gateway-identity-jwt": _drop, ...appOnly } = await legs();
    const res = await call(session, { as: null, headers: appOnly });
    expect(res.status).toBe(401);
    const { error } = await json(res);
    expect(error.code).toBe("invalid_credential");
    expect(error.launch).toBeUndefined();
  });

  it("malformed JWKS secret -> 503 identity_unavailable (config is checked before the token)", async () => {
    const env = await makeEnv({ CAIL_IDENTITY_JWKS: "not json" });
    const res = await call(session, { env });
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("identity_unavailable");
    expect(res.headers.get("x-should-retry")).toBe("true");
  });

  it("missing JWKS or issuer -> 503 even with NO token (config before credentials)", async () => {
    for (const bad of [{ CAIL_IDENTITY_JWKS: undefined }, { CAIL_IDENTITY_ISSUER: undefined }, { CAIL_IDENTITY_ISSUER: "https://evil.example/cail-sso" }]) {
      const res = await call(session, { as: null, env: await makeEnv(bad) });
      expect(res.status, JSON.stringify(bad)).toBe(503);
      expect((await json(res)).error.code).toBe("identity_unavailable");
    }
  });

  it("wrong audience on the app leg -> 401 invalid_credential", async () => {
    const iss = await issuer();
    const headers = await legs();
    headers["x-cail-identity-jwt"] = await iss.mintIdentityJwt({ audience: "cail:media-tools", subject: ALICE });
    const res = await call(session, { as: null, headers });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("invalid_credential");
  });

  it("wrong audience on the gateway leg -> 401 invalid_credential", async () => {
    const iss = await issuer();
    const headers = await legs();
    headers["x-cail-gateway-identity-jwt"] = await iss.mintIdentityJwt({ audience: APP_AUDIENCE, subject: ALICE });
    const res = await call(session, { as: null, headers });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("invalid_credential");
  });

  it("gateway leg for a different person -> 401 invalid_credential", async () => {
    const res = await call(session, { as: null, headers: await legs(ALICE, BOB) });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("invalid_credential");
  });

  it("expired assertion -> 401 invalid_credential", async () => {
    const iss = await issuer();
    const headers = await legs();
    headers["x-cail-identity-jwt"] = await iss.mintIdentityJwt({ audience: APP_AUDIENCE, subject: ALICE, now: Math.floor(Date.now() / 1000) - 7200, expiresInSeconds: 60 });
    const res = await call(session, { as: null, headers });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("invalid_credential");
  });

  it("garbage and tampered tokens -> 401 invalid_credential", async () => {
    const good = await legs();
    for (const token of ["garbage", good["x-cail-identity-jwt"]!.slice(0, -4) + "AAAA"]) {
      const res = await call(session, { as: null, headers: { ...good, "x-cail-identity-jwt": token } });
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("invalid_credential");
    }
  });

  it("a token signed by another issuer's key -> 401 invalid_credential", async () => {
    const { createTestIdentityIssuer } = await import("@cuny-ai-lab/cail-identity/testing");
    const rogue = await createTestIdentityIssuer();
    const headers = {
      "x-cail-identity-jwt": await rogue.mintIdentityJwt({ audience: APP_AUDIENCE, subject: ALICE }),
      "x-cail-gateway-identity-jwt": await rogue.mintIdentityJwt({ audience: "cail:gateway", subject: ALICE }),
    };
    const res = await call(session, { as: null, headers });
    expect(res.status).toBe(401);
  });

  it("forwards only the gateway leg upstream and never the app assertion", async () => {
    const { authenticate } = await import("../src/identity");
    const headers = await legs();
    const result = await authenticate(new Request(`${ORIGIN}${BASE}/api/session`, { headers }), await makeEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.credential.token).toBe(headers["x-cail-gateway-identity-jwt"]);
      expect(JSON.stringify(result.principal)).not.toContain(headers["x-cail-identity-jwt"]!);
    }
  });

  it("every /api route is behind identity", async () => {
    for (const [method, path] of [["GET", "/projects"], ["POST", "/projects"], ["GET", "/projects/x/members"], ["POST", "/invites/redeem"], ["PUT", "/profile"], ["DELETE", "/me/data"], ["GET", "/nonexistent"]] as const) {
      const res = await call(api(path), { method, as: null });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
