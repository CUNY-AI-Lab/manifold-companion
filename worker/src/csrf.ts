import { canonicalOrigin, type Env } from "./env";

/**
 * Exact-Origin check for every mutation. A missing Origin is rejected: browsers
 * send Origin on every cross-site and same-site POST/PUT/PATCH/DELETE, so an
 * absent one is not a browser the app serves. Referer is deliberately not a
 * fallback. Local development sets CAIL_CANONICAL_ORIGIN to its own origin.
 */
export function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === canonicalOrigin(env);
}

export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}
