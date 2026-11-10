// Transport for the Worker API. Pure (no DOM globals) so it is unit-tested.
//
// Session expiry (Browser Sign-In contract): a 401 whose code is
// authentication_required OR session_invalid means the Doorway session is
// gone. Do ONE full-page navigation: to the same-origin /launch/<tool> path
// Doorway's 401 body names, else to the app root. No retry, no fetch of a login
// URL, and fetch never follows a redirect (redirect: "error"). A 401
// invalid_credential is a deployment fault: it is shown, never navigated.

export const LOST_SESSION = new Set(['authentication_required', 'session_invalid']);
const LAUNCH = /^\/launch\/[a-z0-9][a-z0-9-]{0,63}$/;

export class ApiError extends Error {
  constructor({ status, code, message, retryable = false, retryAfter = null, requestId = null, result = null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.requestId = requestId;
    this.result = result;
  }
}

/** The navigation target for a lost session, or null when the response is not one. */
export function lostSessionTarget(status, envelope, base) {
  if (status !== 401) return null;
  const code = envelope?.error?.code;
  if (!LOST_SESSION.has(code)) return null;
  const launch = envelope?.error?.launch;
  return typeof launch === 'string' && LAUNCH.test(launch) ? launch : `${base}/`;
}

export function createApi({ base, fetchImpl, navigate }) {
  let navigating = false;

  async function fail(res) {
    let envelope = null;
    try { envelope = await res.json(); } catch { envelope = null; }
    const target = lostSessionTarget(res.status, envelope, base);
    if (target && !navigating) {
      navigating = true;
      navigate(target);
    }
    const e = envelope?.error ?? {};
    const retryAfter = res.headers.get('retry-after');
    return new ApiError({
      status: res.status,
      code: typeof e.code === 'string' ? e.code : `http_${res.status}`,
      message: typeof e.message === 'string' ? e.message : `Request failed (${res.status}).`,
      retryable: res.headers.get('x-should-retry') === 'true' || e.retryable === true,
      retryAfter: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null,
      // From the body only: Doorway strips every x-cail-* response header.
      requestId: typeof e.requestId === 'string' ? e.requestId : null,
      result: envelope?.result ?? null,
    });
  }

  async function send(path, { method = 'GET', body, headers = {}, signal, raw = false } = {}) {
    if (navigating) throw new ApiError({ status: 401, code: 'authentication_required', message: 'Signing in again.' });
    const init = { method, credentials: 'same-origin', redirect: 'error', signal, headers: { ...headers } };
    if (body !== undefined) {
      if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) throw await fail(res);
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  return {
    get: (path, opts) => send(path, opts),
    post: (path, body, opts) => send(path, { ...opts, method: 'POST', body: body ?? {} }),
    put: (path, body, opts) => send(path, { ...opts, method: 'PUT', body: body ?? {} }),
    del: (path, body, opts) => send(path, { ...opts, method: 'DELETE', ...(body ? { body } : {}) }),
    /** Raw upload: the Worker reserves quota for the declared exact size before reading, and needs a file name. */
    upload: (path, blob, { filename, method = 'POST', query = {}, signal } = {}) => {
      const q = new URLSearchParams({ size: String(blob.size), filename, ...query });
      return send(`${path}${path.includes('?') ? '&' : '?'}${q}`, { method, body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' }, signal });
    },
    raw: (path, opts) => send(path, { ...opts, raw: true }),
    get navigating() { return navigating; },
  };
}
