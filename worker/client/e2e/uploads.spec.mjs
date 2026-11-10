// Uploads through the real Worker (wrangler dev) behind the Doorway double.
import { expect, test } from '@playwright/test';
import { request as httpRequest } from 'node:http';

const ORIGIN = 'http://127.0.0.1:8790';
const as = (context, who) => context.addCookies([{ name: 'e2e_as', value: who, url: ORIGIN }]);

/** POST a body that sends `sent` bytes and then stops (the connection stays open), and resolve with the response. */
function stalledUpload(path, declared, sent, who) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, cookie: `e2e_as=${who}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, body: JSON.parse(body) }); });
    });
    req.on('error', reject);
    const head = new Uint8Array(sent).fill(1);
    head.set([0xff, 0xd8, 0xff, 0xe0]);
    req.write(head); // ...and nothing more
  });
}

test('a stalled upload is answered at its deadline and its storage reservation is given back', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = (path, init = {}) => page.request.fetch(`/manifold-companion/api${path}`, { ...init, headers: { Origin: ORIGIN, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const project = (await (await api('/projects', { method: 'POST', data: { name: 'Stall' } })).json()).project;
  const text = (await (await api(`/projects/${project.id}/texts`, { method: 'POST', data: { name: 'Slow' } })).json()).text;
  const before = (await (await api('/session')).json()).storage.used_bytes;

  const started = Date.now();
  const pending = stalledUpload(`/manifold-companion/api/texts/${text.id}/pages?filename=slow.jpg&size=200000`, 200000, 1000, 'carol');
  // While the body is awaited the declared size is held on the owner's counter...
  await expect.poll(async () => (await (await api('/session')).json()).storage.used_bytes, { timeout: 3000 }).toBe(before + 200000);
  const res = await pending;
  // ...and the Worker gives up at grace (4 s here) + 200000 B at 32 KiB/s (about 6 s), not after the reservation's hour.
  expect(res.status).toBe(408);
  expect(res.body.error.code).toBe('upload_too_slow');
  expect(Date.now() - started).toBeLessThan(30_000);
  expect((await (await api('/session')).json()).storage.used_bytes).toBe(before);
  expect((await (await api(`/texts/${text.id}/pages`)).json()).pages).toEqual([]);

  // The person sees the Worker's explanation if it happens in the app.
  await page.route('**/api/texts/*/pages?*', (route) => route.fulfill({ status: 408, contentType: 'application/json', headers: { 'x-should-retry': 'true' }, body: JSON.stringify({ error: { code: 'upload_too_slow', message: 'The upload stopped arriving before its deadline. Check the connection and try again.', retryable: true, requestId: 'r-1' } }) }));
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/page.png');
  await expect(page.getByRole('alert')).toContainText('stopped arriving before its deadline');
});
