// The smaller legacy features: text pagination, per-text settings, the full-text
// editor of image texts, unsaved-draft protection, keyboard shortcuts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';

const ORIGIN = 'http://127.0.0.1:8790';
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

test('more than 50 texts: pages of 50, moves across a page boundary, the export lists every text', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Fifty-five' })).project;
  for (let i = 1; i <= 55; i += 1) await api(`/projects/${project.id}/texts`, 'POST', { name: `Text ${String(i).padStart(2, '0')}` });
  await page.goto(`/manifold-companion/projects/${project.id}`);
  await expect(page.getByText('Texts 1–50 of 55')).toBeVisible();
  const list = page.locator('ul.rowlist > li');
  await expect(list).toHaveCount(50);
  const pager = page.getByRole('navigation', { name: 'Pages of texts' });
  await expect(pager.getByText('Page 1 of 2')).toBeVisible();
  await expect(pager.getByRole('button', { name: 'Previous 50' })).toBeDisabled();
  await pager.getByRole('button', { name: 'Next 50' }).click();
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.getByText('Texts 51–55 of 55')).toBeVisible();
  await expect(list).toHaveCount(5);
  await expect(list.first()).toContainText('Text 51');
  expect(await axe(page, 'project, second page of texts')).toEqual([]);

  // The first text of page 2 moves up to position 50, onto page 1.
  await page.getByRole('button', { name: 'Move Text 51 up' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Text 51 moved to position 50 of 55.' })).toBeAttached();
  await expect(list.first()).toContainText('Text 50');
  await page.goBack();
  await expect(page.getByText('Texts 1–50 of 55')).toBeVisible();
  await expect(list.nth(49)).toContainText('Text 51');

  // Reloading a page link keeps the page; the export sees all 55 texts.
  await page.goto(`/manifold-companion/projects/${project.id}?page=2`);
  await expect(list).toHaveCount(5);
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export for Manifold' });
  await expect(dialog.getByRole('list', { name: 'Table of contents items' }).getByRole('listitem')).toHaveCount(55);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('per-text model settings: saved, shown as the run default, used by the next run, reset; read-only for a viewer', async ({ page, context, browser }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Settings' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letters' })).text;
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/page.png');
  await expect(page.getByRole('button', { name: /^1\. page\.jpg/ })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Model settings for this text' }).click();
  const panel = page.locator('section', { has: page.getByRole('button', { name: 'Model settings for this text' }) });
  await panel.getByLabel('Model for reading pages').selectOption('stub-vision-reasoning');
  await panel.getByLabel('Temperature (0 to 1)').fill('1.7');
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.getByRole('alert')).toContainText('Temperature must be a number from 0 to 1.');
  await panel.getByLabel('Temperature (0 to 1)').fill('0.4');
  await panel.getByLabel('Maximum length (tokens)').fill('1500');
  await panel.getByLabel('Transcription prompt').fill('Transcribe this letter exactly.');
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.getByText('Settings saved for this text.')).toBeVisible();
  expect((await api(`/texts/${text.id}/settings`)).settings).toMatchObject({ model: 'stub-vision-reasoning', temperature: 0.4, max_tokens: 1500, prompt: 'Transcribe this letter exactly.' });
  expect(await axe(page, 'text settings open')).toEqual([]);

  // The run picker says what an unchosen run uses; the run uses it (the stub echoes the model).
  await expect(page.getByLabel('OCR model').locator('option').first()).toHaveText('Saved for this text (stub-vision-reasoning)');
  await page.getByRole('button', { name: 'Read pages without text' }).click();
  await expect(page.getByText('read by stub-vision-reasoning')).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.getByRole('button', { name: 'Model settings for this text' }).click();
  await expect(panel.getByLabel('Maximum length (tokens)')).toHaveValue('1500');

  // A viewer sees them and cannot change them.
  const inv = (await api(`/projects/${project.id}/invites`, 'POST', { role: 'viewer' })).invite;
  const other = await browser.newContext();
  await other.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  const viewer = await other.newPage();
  await viewer.goto(`/manifold-companion/invite#t=${inv.token}`);
  await expect(viewer.getByText(/you are a viewer/)).toBeVisible();
  await viewer.goto(`/manifold-companion/texts/${text.id}`);
  await viewer.getByRole('button', { name: 'Model settings for this text' }).click();
  await expect(viewer.getByLabel('Transcription prompt')).toBeDisabled();
  await expect(viewer.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await other.close();

  await panel.getByRole('button', { name: 'Use the defaults' }).click();
  await expect(panel.getByText('Back to the defaults.')).toBeVisible();
  await expect(panel.getByLabel('Maximum length (tokens)')).toHaveValue('');
  await expect(page.getByLabel('OCR model').locator('option').first()).toHaveText('Default (stub-vision)');
});

/** The Markdown file the export writes for the one text of an image project. */
async function exportedMarkdown(page, projectId, textId) {
  const r = await page.request.fetch(`/manifold-companion/api/projects/${projectId}/export`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, data: { toc: [{ type: 'text', label: 'Letter', textId }] } });
  expect(r.ok()).toBe(true);
  const files = unzipSync(new Uint8Array(await r.body()));
  const name = Object.keys(files).find((n) => n.endsWith('.md'));
  return strFromU8(files[name]);
}

test('full text of an image text: edit as one text, the export uses it, use the pages again, restore', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Full text' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letter' })).text;
  const png = readFileSync('e2e/fixtures/page.png');
  for (const [i, words] of [[1, 'The first page ends in the middle of a sen-'], [2, 'tence that the second page finishes.']]) {
    const up = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/pages?filename=p${i}.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
    expect(up.ok()).toBe(true);
    await api(`/texts/${text.id}/pages/${(await up.json()).page.id}`, 'POST', { text: words });
  }
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  const joined = page.getByLabel('The page texts as the export joins them');
  await expect(joined).toContainText('sen-');
  await expect(joined).toContainText('---');
  await page.getByRole('button', { name: 'Edit as one text' }).click();
  const editor = page.getByLabel('Full text (Markdown)');
  await editor.fill('The first page ends in the middle of a sentence that the second page finishes.');
  expect(await axe(page, 'full text editor')).toEqual([]);
  await page.getByRole('button', { name: 'Save full text' }).click();
  await expect(page.getByText('Full text saved. The export uses it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full text (edited, used by the export)' })).toBeVisible();
  expect(await exportedMarkdown(page, project.id, text.id)).toContain('middle of a sentence that the second');

  await page.getByRole('button', { name: 'Use the pages again' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Use the pages again' }).click();
  await expect(page.getByText('The export uses the page texts again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Full text', exact: true })).toBeVisible();
  expect(await exportedMarkdown(page, project.id, text.id)).toContain('sen-');

  await page.getByRole('button', { name: 'Version history of the full text' }).click();
  await page.getByRole('button', { name: /^Restore/ }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('button', { name: 'Full text (edited, used by the export)' })).toBeVisible();
  await expect(editor).toHaveValue(/middle of a sentence/);
});
