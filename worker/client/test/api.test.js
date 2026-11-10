import { describe, expect, it } from 'vitest';
import { createApi, lostSessionTarget } from '../src/api/core.js';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function harness(responses) {
  const calls = [];
  const navigations = [];
  const queue = [...responses];
  const api = createApi({ base: '/manifold-companion', fetchImpl: async (url, init) => { calls.push({ url, init }); return queue.shift(); }, navigate: (u) => navigations.push(u) });
  return { api, calls, navigations };
}

describe('session expiry navigation', () => {
  for (const code of ['authentication_required', 'session_invalid']) {
    it(`${code}: one full-page navigation to the launch path Doorway named, no retry`, async () => {
      const h = harness([json(401, { error: { code, message: 'Sign in', launch: '/launch/manifold-companion' } }), json(401, { error: { code } })]);
      await expect(h.api.get('/api/projects')).rejects.toMatchObject({ code, status: 401 });
      await expect(h.api.get('/api/projects')).rejects.toMatchObject({ code: 'authentication_required' });
      expect(h.navigations).toEqual(['/launch/manifold-companion']);
      expect(h.calls).toHaveLength(1);
    });
  }

  it('without a usable launch path it navigates to the app root', () => {
    for (const launch of [undefined, 'https://evil.example/launch/x', '//evil.example/launch/x', '/launch/../admin', '/elsewhere', 5]) {
      expect(lostSessionTarget(401, { error: { code: 'session_invalid', launch } }, '/manifold-companion'), String(launch)).toBe('/manifold-companion/');
    }
  });

  it('invalid_credential and other errors never navigate', async () => {
    const h = harness([json(401, { error: { code: 'invalid_credential', message: 'not accepted' } }), json(403, { error: { code: 'insufficient_role', message: 'no' } })]);
    await expect(h.api.get('/api/session')).rejects.toMatchObject({ code: 'invalid_credential' });
    await expect(h.api.get('/api/x')).rejects.toMatchObject({ code: 'insufficient_role', status: 403 });
    expect(h.navigations).toEqual([]);
  });

  it('never follows redirects and sends same-origin credentials only', async () => {
    const h = harness([json(200, { ok: true })]);
    await h.api.get('/api/session');
    expect(h.calls[0].init).toMatchObject({ redirect: 'error', credentials: 'same-origin' });
  });
});

describe('errors and uploads', () => {
  it('carries the safe code, message, retry advice and Retry-After; and the OCR conflict result', async () => {
    const h = harness([json(503, { error: { code: 'upstream_unavailable', message: 'Busy.', retryable: true } }, { 'x-should-retry': 'true', 'retry-after': '7' }), json(409, { error: { code: 'edit_conflict', message: 'Edited' }, result: { text: 'model text' } })]);
    await expect(h.api.post('/api/x', {})).rejects.toMatchObject({ code: 'upstream_unavailable', retryable: true, retryAfter: 7, message: 'Busy.' });
    await expect(h.api.post('/api/y', {})).rejects.toMatchObject({ code: 'edit_conflict', result: { text: 'model text' } });
  });

  it('the support reference comes from the error body only (Doorway strips every x-cail-* response header)', async () => {
    const h = harness([
      json(500, { error: { code: 'internal_error', message: 'Internal server error.', requestId: 'body-id' } }, { 'x-cail-request-id': 'header-id' }),
      json(502, { error: { code: 'bad_gateway', message: 'Bad gateway.' } }, { 'x-cail-request-id': 'header-id' }),
    ]);
    await expect(h.api.get('/api/a')).rejects.toMatchObject({ requestId: 'body-id' });
    await expect(h.api.get('/api/b')).rejects.toMatchObject({ requestId: null });
  });
  it('uploads the raw bytes with the exact size and file name in the query', async () => {
    const h = harness([json(201, { page: {} })]);
    const blob = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });
    await h.api.upload('/api/texts/t/pages', blob, { filename: 'p 1.jpg' });
    expect(h.calls[0].url).toBe('/manifold-companion/api/texts/t/pages?size=10&filename=p+1.jpg');
    expect(h.calls[0].init.body).toBe(blob);
    expect(h.calls[0].init.headers['content-type']).toBe('image/jpeg');
  });
});
