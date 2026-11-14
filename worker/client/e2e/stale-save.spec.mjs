// A save from a copy loaded before someone else's save asks before replacing it.
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

test('a page saved elsewhere after it was opened: keep editing, or replace with mine', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Stale' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letter' })).text;
  const png = readFileSync('e2e/fixtures/page.png');
  const up = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/pages?filename=p1.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
  const pageId = (await up.json()).page.id;
  await api(`/texts/${text.id}/pages/${pageId}`, 'POST', { text: 'First reading.' });

  await page.goto(`/manifold-companion/texts/${text.id}`);
  const editor = page.getByLabel(/^Text of page 1/);
  await expect(editor).toHaveValue('First reading.');
  // Someone else saves the page (another tab, another editor) while this copy is open.
  await api(`/texts/${text.id}/pages/${pageId}`, 'POST', { text: 'Their correction.' });
  await editor.fill('My correction.');
  await page.getByRole('button', { name: 'Save page' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Page 1 was saved by someone else');
  expect((await new AxeBuilder({ page }).withTags(TAGS).setLegacyMode(true).analyze()).violations).toEqual([]);
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('alert')).toContainText('Not saved');
  await expect(editor).toHaveValue('My correction.');
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('Their correction.');

  await page.getByRole('button', { name: 'Save page' }).click();
  await ask.getByRole('button', { name: 'Replace with mine' }).click();
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('My correction.');
  // Saving again right away is based on this save, not refused against it.
  await editor.fill('My correction, again.');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
  await expect(ask).toHaveCount(0);
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('My correction, again.');
});

test('a summary or translation saved elsewhere after it was opened is not replaced unasked', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Stale notes' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letter' })).text;
  await api(`/texts/${text.id}/summary`, 'PUT', { summary: 'First summary.' });
  await api(`/texts/${text.id}/translation`, 'PUT', { translation: 'First translation.', source_language: 'it', target_language: 'en' });

  await page.goto(`/manifold-companion/texts/${text.id}`);
  const summary = page.getByLabel('Summary of Letter');
  await expect(summary).toHaveValue('First summary.');
  const translation = page.getByRole('textbox', { name: 'Translation', exact: true });
  await expect(translation).toHaveValue('First translation.');
  // Someone else saves both while this copy is open.
  await api(`/texts/${text.id}/summary`, 'PUT', { summary: 'Their summary.' });
  await api(`/texts/${text.id}/translation`, 'PUT', { translation: 'Their translation.', source_language: 'it', target_language: 'en' });

  const ask = page.getByRole('alertdialog');
  await summary.fill('My summary.');
  await page.getByRole('button', { name: 'Save summary' }).click();
  await expect(ask).toContainText('The summary was saved by someone else');
  await expect(ask).toContainText('Theirs is not kept anywhere');
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(summary).toHaveValue('My summary.');
  expect((await api(`/texts/${text.id}/summary`)).summary).toBe('Their summary.');
  await page.getByRole('button', { name: 'Save summary' }).click();
  await ask.getByRole('button', { name: 'Replace with mine' }).click();
  await expect(page.getByText('Summary saved.')).toBeVisible();
  expect((await api(`/texts/${text.id}/summary`)).summary).toBe('My summary.');

  await translation.fill('My translation.');
  await page.getByRole('button', { name: 'Save translation' }).click();
  await expect(ask).toContainText('The translation was saved by someone else');
  await ask.getByRole('button', { name: 'Replace with mine' }).click();
  await expect(page.getByText('Translation saved.')).toBeVisible();
  expect((await api(`/texts/${text.id}/translation`)).translation).toBe('My translation.');
  // A second save right away is based on this one, not refused against it.
  await translation.fill('My translation, again.');
  await page.getByRole('button', { name: 'Save translation' }).click();
  await expect(page.getByText('Translation saved.')).toBeVisible();
  await expect(ask).toHaveCount(0);
  expect((await api(`/texts/${text.id}/translation`)).translation).toBe('My translation, again.');
});
