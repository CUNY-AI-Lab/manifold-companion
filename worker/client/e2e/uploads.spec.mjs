// Uploads through the real Worker (wrangler dev) behind the Doorway double.
import { expect, test } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';

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

/** Drop files on the page the way a file manager does: a DataTransfer carrying File objects. */
async function dropFiles(page, files) {
  const dt = await page.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const f of list) transfer.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    return transfer;
  }, files.map((f) => ({ name: f.name, type: f.type, b64: readFileSync(f.path).toString('base64') })));
  await page.dispatchEvent('main', 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent('main', 'dragover', { dataTransfer: dt });
  return dt;
}

async function seedTexts(page, type = 'image_to_markdown') {
  const api = (path, init = {}) => page.request.fetch(`/manifold-companion/api${path}`, { ...init, headers: { Origin: ORIGIN, 'content-type': 'application/json' } });
  const project = (await (await api('/projects', { method: 'POST', data: { name: `Drop ${type}`, project_type: type } })).json()).project;
  const text = (await (await api(`/projects/${project.id}/texts`, { method: 'POST', data: { name: 'Dropped' } })).json()).text;
  return { project, text, api };
}

test('drag and drop: images and a PDF dropped on an image text become pages; other files are named and refused', async ({ page, context }) => {
  await as(context, 'carol');
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.goto('/manifold-companion/');
  const { text } = await seedTexts(page);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await expect(page.getByText('or drop images or a PDF anywhere on this page')).toBeVisible();
  const dt = await dropFiles(page, [
    { name: 'page.png', type: 'image/png', path: 'e2e/fixtures/page.png' },
    { name: 'two-pages.pdf', type: 'application/pdf', path: 'e2e/fixtures/two-pages.pdf' },
    { name: 'notes.txt', type: 'text/plain', path: 'e2e/fixtures/page.png' },
  ]);
  await expect(page.getByText('Drop to add pages to “Dropped”')).toBeVisible();
  await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
  await expect(page.getByText('Drop to add pages to “Dropped”')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Pages' });
  await expect(nav.getByRole('button', { name: /^\d+\. page\.jpg/ })).toBeVisible({ timeout: 30_000 });
  await expect(nav.getByRole('button', { name: /^\d+\. two-pages-p001\.jpg/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /^\d+\. two-pages-p002\.jpg/ })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Not uploaded, not an image or a PDF: notes.txt.');
  expect(page.url()).toContain(`/texts/${text.id}`); // the browser did not open a dropped file
  expect(violations).toEqual([]);
});

test('drag and drop on a PDF text: the PDF is chosen for conversion, an image becomes a figure', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const { text, api } = await seedTexts(page, 'pdf_to_html');
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await expect(page.getByText('Or drop a PDF anywhere on this page (images dropped become figures).')).toBeVisible();
  const dt = await dropFiles(page, [
    { name: 'two-pages.pdf', type: 'application/pdf', path: 'e2e/fixtures/two-pages.pdf' },
    { name: 'figure.png', type: 'image/png', path: 'e2e/fixtures/page.png' },
  ]);
  await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
  await expect(page.getByText('Chosen: two-pages.pdf')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convert PDF' })).toBeEnabled();
  await expect(page.getByText(/Figures \(reference with/)).toContainText('figure.jpg');
  expect((await (await api(`/texts/${text.id}/figures`)).json()).figures.map((f) => f.filename)).toEqual(['figure.jpg']);
});

test('a file dropped on a page that takes none does not replace the app', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  const dt = await dropFiles(page, [{ name: 'page.png', type: 'image/png', path: 'e2e/fixtures/page.png' }]);
  const prevented = await page.evaluate((transfer) => { const e = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }); document.querySelector('main').dispatchEvent(e); return e.defaultPrevented; }, dt);
  expect(prevented).toBe(true);
});

test('HEIC under the page CSP: a browser that cannot open it says so (no eval, no silent hang)', async ({ page, context }) => {
  await as(context, 'carol');
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to|unsafe-eval/i.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
  await page.goto('/manifold-companion/');
  const { text, api } = await seedTexts(page);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/page.heic');
  // Chromium does not decode HEIC; Safari does, and there the photo would upload like a JPEG.
  await expect(page.getByRole('alert')).toContainText('“page.heic” is a HEIC photo, which this browser cannot open. Convert it to JPEG first');
  expect((await (await api(`/texts/${text.id}/pages`)).json()).pages).toEqual([]);
  expect(violations).toEqual([]);
});
