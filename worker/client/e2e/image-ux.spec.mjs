// Image-text editing: the full-text notice, editable summary and translation,
// scan zoom and lightbox, language names, the Markdown toolbar, page thumbnails
// and the review of uncertain readings.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT ?? 8790}`;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const as = (context, who) => context.addCookies([{ name: 'e2e_as', value: who, url: ORIGIN }]);
const apiOf = (page) => async (path, method = 'GET', data) => {
  const r = await page.request.fetch(`/manifold-companion/api${path}`, { method, headers: { Origin: ORIGIN, 'content-type': 'application/json' }, ...(data === undefined ? {} : { data }) });
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
  return r.json();
};
async function axe(page, label) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).setLegacyMode(true).analyze();
  return r.violations.map((v) => ({ where: label, id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}
async function imageText(page, api, texts, name = 'Letters') {
  const project = (await api('/projects', 'POST', { name })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letter' })).text;
  const png = readFileSync('e2e/fixtures/page.png');
  const pages = [];
  for (const [i, words] of texts.entries()) {
    const up = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/pages?filename=p${i + 1}.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
    expect(up.ok()).toBe(true);
    const p = (await up.json()).page;
    if (words !== null) await api(`/texts/${text.id}/pages/${p.id}`, 'POST', { text: words });
    pages.push(p);
  }
  return { project, text, pages };
}

test('with an edited full text, the page editor says page edits do not reach the export, and Translate uses the full text', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text } = await imageText(page, api, ['page one words', 'page two words']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await expect(page.getByText(/changes saved here do not reach the export/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit as one text' }).click();
  await page.getByLabel('Full text (Markdown)').fill('THE EDITED WHOLE TEXT');
  await page.getByRole('button', { name: 'Save full text' }).click();
  await expect(page.getByText('Full text saved. The export uses it.')).toBeVisible();
  // The page editor now says so, without opening anything.
  const note = page.getByText(/changes saved here do not reach the export/);
  await expect(note).toBeVisible();
  await expect(page.getByLabel(/^Text of page 1/)).toHaveAccessibleDescription(/do not reach the export/);
  await page.getByLabel(/^Text of page 1/).fill('page one, corrected');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByText(/Page 1 saved\. The export still uses the edited full text/)).toBeVisible();
  expect(await axe(page, 'full-text notice')).toEqual([]);

  // Translate sends the full text (the stub echoes the chunk it was given).
  const sent = [];
  page.on('request', (r) => { if (r.url().endsWith('/translate-chunk')) sent.push(r.postDataJSON().text); });
  await page.getByRole('button', { name: 'Translate' }).click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent.join('')).toContain('THE EDITED WHOLE TEXT');
  expect(sent.join('')).not.toContain('page two words');

  await page.getByRole('button', { name: 'Use the pages again' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Use the pages again' }).click();
  await expect(note).toHaveCount(0);
});
