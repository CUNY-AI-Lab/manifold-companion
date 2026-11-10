import {
  CAIL_GATEWAY_AUDIENCE,
  createCailAuthError,
  loadIdentityVerifierConfig,
  readIdentityKeyring,
  serializeCailAuthError,
  verifyIdentityJwt,
  verifyKeyringGatewayJwt,
  type CailAuthErrorCode,
  type IdentityVerifierConfig,
  type LoadIdentityVerifierConfigResult,
} from "@cuny-ai-lab/cail-identity";
import type { Env } from "./env";

export const APP_AUDIENCE = "cail:manifold-companion";
export const APP_SLUG = "manifold-companion";
export const LAUNCH_PATH = "/launch/manifold-companion";
export const IDENTITY_HEADER = "x-cail-identity-jwt";

export interface Principal {
  /** Opaque, stable CAIL subject. The only identity the app keys data on. */
  subject: string;
  /** The verified Gateway leg. The only credential ever forwarded upstream. */
  credential: { kind: "jwt"; token: string };
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; response: Response };

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function authError(status: number, code: CailAuthErrorCode, message: string, launch?: string, extra: Record<string, string> = {}): Response {
  return new Response(serializeCailAuthError(createCailAuthError(code, message, launch)), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export const authRequiredResponse = (): Response =>
  authError(401, "authentication_required", "Sign in to continue.", LAUNCH_PATH, { "www-authenticate": 'Bearer realm="CAIL"' });
export const invalidCredentialResponse = (): Response => authError(401, "invalid_credential", "The sign-in credential was not accepted.");
export const identityUnavailableResponse = (): Response =>
  authError(503, "identity_unavailable", "Sign-in verification is temporarily unavailable.", undefined, { "x-should-retry": "true", "retry-after": "5" });

const configCache = new Map<string, IdentityVerifierConfig>();

/**
 * Load a verifier config for `audience`, reusing a per-isolate cache so repeat
 * calls do not re-import the JWKS. A pinned `now` bypasses the cache, and
 * failures are never cached, so a corrected secret takes effect immediately.
 */
export async function loadCachedVerifierConfig(env: Env, audience: string, now?: number): Promise<LoadIdentityVerifierConfigResult> {
  const key = `${audience}\n${env.CAIL_IDENTITY_JWKS ?? ""}\n${env.CAIL_IDENTITY_ISSUER ?? ""}`;
  if (now === undefined) {
    const cached = configCache.get(key);
    if (cached) return { ok: true, config: cached };
  }
  const loaded = await loadIdentityVerifierConfig({
    jwks: env.CAIL_IDENTITY_JWKS,
    issuer: env.CAIL_IDENTITY_ISSUER,
    expectedAudience: audience,
    ...(now === undefined ? {} : { now }),
  });
  if (loaded.ok && now === undefined) configCache.set(key, loaded.config);
  return loaded;
}

/**
 * Verify Doorway's two legs. Order matters and is part of the contract:
 *  1. load BOTH pinned verifier configs; any failure is 503 identity_unavailable;
 *  2. no credential presented at all -> 401 authentication_required;
 *  3. a credential that does not verify (bad signature, expired, wrong
 *     audience, malformed, a Gateway leg for another subject, or a verified
 *     app leg with no Gateway leg at all) -> 401 invalid_credential.
 * Caller-supplied identity is never authority until verified here. Only the
 * Gateway leg is kept for forwarding upstream; the app assertion is dropped.
 */
export async function authenticate(request: Request, env: Env, now?: number): Promise<AuthResult> {
  const [appLoaded, gatewayLoaded] = await Promise.all([
    loadCachedVerifierConfig(env, APP_AUDIENCE, now),
    loadCachedVerifierConfig(env, CAIL_GATEWAY_AUDIENCE, now),
  ]);
  if (!appLoaded.ok || !gatewayLoaded.ok) return { ok: false, response: identityUnavailableResponse() };

  const appToken = request.headers.get(IDENTITY_HEADER);
  if (appToken === null || appToken === "") return { ok: false, response: authRequiredResponse() };

  const identity = await verifyIdentityJwt(appToken, appLoaded.config);
  if (identity === null) return { ok: false, response: invalidCredentialResponse() };

  const keyring = readIdentityKeyring(request.headers);
  if (keyring === null) return { ok: false, response: invalidCredentialResponse() };
  // A verified app leg WITHOUT its Gateway leg is a Doorway route-policy fault (the route lost
  // gatewayIdentity), not a lost session: authentication_required would send the browser to the
  // launch path, Doorway would return it here with the same headers, and it would loop.
  if (keyring.gatewayJwt === undefined) return { ok: false, response: invalidCredentialResponse() };
  const gatewayIdentity = await verifyKeyringGatewayJwt(keyring, gatewayLoaded.config, identity.subject);
  if (gatewayIdentity === null) return { ok: false, response: invalidCredentialResponse() };

  return { ok: true, principal: { subject: identity.subject, credential: { kind: "jwt", token: keyring.gatewayJwt } } };
}
