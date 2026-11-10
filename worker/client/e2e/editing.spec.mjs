// The smaller legacy features: text pagination, per-text settings, the full-text
// editor of image texts, unsaved-draft protection, keyboard shortcuts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
