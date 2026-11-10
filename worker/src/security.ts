import { BASE_PATH } from "./env";

/**
 * Doorway sets no policy on a tool response it proxies, so the page policy is
 * ours. The tools origin is shared by every CAIL tool, so:
 *  - script-src 'self' only: no inline script, no remote script. A sandboxed
 *    srcdoc preview inherits this policy, which is why previews cannot run script
 *    even if the sanitizer were bypassed.
 *  - connect-src 'self': nothing here may talk to a provider or another origin.
 *  - style 'unsafe-inline' is needed by the editor and KaTeX; inline *styles* are
 *    not the injection risk inline scripts are, and the sanitizer strips `style`.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const isHtml = (contentType: string | null): boolean => contentType?.toLowerCase().startsWith("text/html") === true;

export function cacheControlFor(path: string, status: number, contentType: string | null): string {
  if (status >= 400) return "no-store";
  if (path.startsWith(`${BASE_PATH}/api/`) || path === `${BASE_PATH}/api` || path.startsWith("/health/")) return "no-store";
  return isHtml(contentType) ? "private, max-age=300" : "public, max-age=300";
}

/** Applied to every response, including errors and binding-returned responses. */
export function withSecurityHeaders(response: Response, requestId: string, path: string): Response {
  // Responses from bindings can have immutable headers in workerd: copy first.
  const out = new Response(response.body, response);
  const contentType = out.headers.get("content-type");
  out.headers.set("x-cail-request-id", requestId);
  if (!out.headers.has("cache-control") || out.status >= 400) out.headers.set("cache-control", cacheControlFor(path, out.status, contentType));
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "same-origin");
  out.headers.set("cross-origin-opener-policy", "same-origin");
  out.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  out.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (isHtml(contentType) && !out.headers.has("content-security-policy")) out.headers.set("content-security-policy", PAGE_CSP);
  return out;
}
