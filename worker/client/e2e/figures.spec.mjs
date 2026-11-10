// Figures from a PDF, extracted in the browser and attached to the conversion's placeholders.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:8790';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const as = (context, who) => context.addCookies([{ name: 'e2e_as', value: who, url: ORIGIN }]);
const apiOf = (page) => async (path, method = 'GET', data) => {
  const r = await page.request.fetch(`/manifold-companion/api${path}`, { method, headers: { Origin: ORIGIN, 'content-type': 'application/json' }, ...(data === undefined ? {} : { data }) });
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
  return r.json();
};
const PLACEHOLDERS = '<section data-page="1"><h2>Figures</h2><figure class="needs-image"><figcaption>Figure: 1. a photograph</figcaption></figure><p>Text between.</p><figure class="needs-image"><figcaption>Figure: 2. a line graph rising and falling</figcaption></figure></section>';

test('figures from the PDF: an embedded picture taken as it is, a vector graph cropped from the page, both attached and saved', async ({ page, context }) => {
  await as(context, 'carol');
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Figures', project_type: 'pdf_to_html' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter with figures' })).text;
  const pdf = readFileSync('e2e/fixtures/figures.pdf');
  const up = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/source-pdf?filename=figures.pdf&size=${pdf.length}`, { method: 'PUT', headers: { Origin: ORIGIN, 'content-type': 'application/pdf' }, data: pdf });
  expect(up.ok()).toBe(true);
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: PLACEHOLDERS });
  const before = (await api('/session')).storage.used_bytes;

  await page.goto(`/manifold-companion/texts/${text.id}`);
  const panel = page.getByRole('region', { name: 'Figures to add (2)' });
  await expect(panel).toContainText('Graphs and diagrams drawn with lines and text in the PDF are not pictures inside it: draw a crop around them');
  await panel.getByRole('button', { name: 'Add image for Figure: 1. a photograph' }).click();
  const dialog = page.getByRole('dialog', { name: /Image for: Figure: 1\. a photograph/ });
  const picture = dialog.getByRole('button', { name: 'Embedded picture 1, 64 by 48 pixels' });
  await expect(picture).toBeVisible({ timeout: 30_000 });
  await expect(picture).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByLabel('Alternative text (what the figure shows, for people who cannot see it)')).toHaveValue('1. a photograph');
  expect((await new AxeBuilder({ page }).withTags(TAGS).setLegacyMode(true).analyze()).violations.map((v) => v.id)).toEqual([]);
  await dialog.getByRole('button', { name: 'Attach to this figure' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Image p1-fig1.png attached. Save the HTML to keep it in the text.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Figures to add (1)' })).toBeVisible();
  // The visual editor shows the attached figure from the app; the source shows the markup.
  await expect(page.locator('.mc-editor img.mc-image[alt="1. a photograph"]')).toBeVisible();
  await page.getByRole('button', { name: 'HTML source', exact: true }).click();
  await expect(page.getByLabel(/^HTML/)).toHaveValue(/<figure><img src="p1-fig1\.png" alt="1\. a photograph" width="64" height="48"><figcaption>Figure: 1\. a photograph/);

  // The graph is vector: there is no picture of it, so crop it from the page with the keyboard-friendly fields.
  await page.getByRole('region', { name: 'Figures to add (1)' }).getByRole('button', { name: /^Add image for Figure: 2/ }).click();
  const second = page.getByRole('dialog', { name: /Image for: Figure: 2/ });
  await expect(second.getByRole('img', { name: 'Page 1 of the PDF' })).toBeVisible({ timeout: 30_000 });
  await second.getByLabel('Use the crop (drag on the page, or type the edges)').check();
  // Dragging on the page draws the crop...
  const box = await second.getByRole('img', { name: 'Page 1 of the PDF' }).boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round(Number(await second.getByLabel('Left edge (%)').inputValue()))).toBe(20);
  await expect.poll(async () => Math.round(Number(await second.getByLabel('Width (%)').inputValue()))).toBe(40);
  // ...and the fields set it exactly.
  await second.getByLabel('Left edge (%)').fill('10');
  await second.getByLabel('Top edge (%)').fill('44');
  await second.getByLabel('Width (%)').fill('80');
  await second.getByLabel('Height (%)').fill('25');
  await second.getByRole('button', { name: 'Attach to this figure' }).click();
  await expect(second).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Figures to add/ })).toHaveCount(0);
  const html = await page.getByLabel(/^HTML/).inputValue();
  const crop = /<img src="p1-fig2\.png" alt="2\. a line graph rising and falling" width="(\d+)" height="(\d+)">/.exec(html);
  expect(crop).not.toBeNull();
  expect(Number(crop[1])).toBeGreaterThan(Number(crop[2])); // a wide crop of the page

  await page.getByRole('button', { name: 'Save HTML' }).click();
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  const saved = (await api(`/texts/${text.id}/html`)).html_content;
  expect(saved).toContain('<img src="p1-fig1.png"');
  expect(saved).toContain('<img src="p1-fig2.png"');
  expect(saved).not.toContain('needs-image');
  const figures = (await api(`/texts/${text.id}/figures`)).figures;
  expect(figures.map((f) => [f.filename, f.image_type])).toEqual([['p1-fig1.png', 'image/png'], ['p1-fig2.png', 'image/png']]);
  // The figures were uploaded through the figure route: the owner's storage counts them.
  expect((await api('/session')).storage.used_bytes - before).toBeGreaterThanOrEqual(figures.reduce((n, f) => n + f.bytes, 0));
  // The preview shows them (inlined as data: URIs inside the sandboxed frame).
  await expect(page.locator('iframe[title="Preview of the HTML"]')).toHaveAttribute('srcdoc', /<img src="data:image\/png;base64,[^"]+" alt="1\. a photograph"/);
  expect(violations).toEqual([]);
});
