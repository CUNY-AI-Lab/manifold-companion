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

const draftKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('manifold-companion:draft:')));

async function imageTextWithPages(page, api, names) {
  const project = (await api('/projects', 'POST', { name: 'Drafts' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letter' })).text;
  const png = readFileSync('e2e/fixtures/page.png');
  for (const [i, words] of names.entries()) {
    const up = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/pages?filename=p${i + 1}.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
    expect(up.ok()).toBe(true);
    await api(`/texts/${text.id}/pages/${(await up.json()).page.id}`, 'POST', { text: words });
  }
  return { project, text };
}

test('unsaved changes: leaving asks first, the edit is kept in this browser, restored, and gone once saved', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { project, text } = await imageTextWithPages(page, api, ['Saved page one.', 'Saved page two.']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const editor = page.getByLabel(/^Text of page 1/);
  await expect(editor).toHaveValue('Saved page one.');
  await editor.fill('Saved page one, corrected by hand.');

  // Another page of the same text: asks, and Stay keeps the edit.
  await page.getByRole('button', { name: /^2\. p2\.png/ }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Discard the changes to this page?');
  await ask.getByRole('button', { name: 'Stay on this page' }).click();
  await expect(editor).toHaveValue('Saved page one, corrected by hand.');

  // An in-app link: asks in the app; Stay, then Leave.
  await page.getByRole('link', { name: 'Back to project' }).click();
  await expect(ask).toContainText('Leave without saving?');
  expect(await axe(page, 'leave confirmation')).toEqual([]);
  await ask.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(new RegExp(`/texts/${text.id}$`));
  await page.getByRole('link', { name: 'Back to project' }).click();
  await ask.getByRole('button', { name: 'Leave this page' }).click();
  await expect(page.getByRole('heading', { name: 'Drafts' })).toBeVisible();

  // Kept: one key, naming no one; the value holds the edit only.
  const keys = await draftKeys(page);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^manifold-companion:draft:v1:[0-9a-f]{32}:/);
  expect(keys[0]).not.toContain('cail-');
  const stored = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), keys[0]));
  expect(stored).toMatchObject({ v: 1, target: { kind: 'page' }, content: 'Saved page one, corrected by hand.' });
  expect(JSON.stringify(stored)).not.toContain('Saved page two');

  // Back: offered, restored, saved, gone.
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const banner = page.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toContainText('Changes to page 1 (p1.png)');
  expect(await axe(page, 'draft recovery banner')).toEqual([]);
  await banner.getByRole('button', { name: 'Restore my changes' }).click();
  await expect(editor).toHaveValue('Saved page one, corrected by hand.');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
  await expect.poll(() => draftKeys(page)).toEqual([]);
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('Saved page one, corrected by hand.');
  // After a save, leaving does not ask.
  await page.getByRole('link', { name: 'Back to project' }).click();
  await expect(page.getByRole('heading', { name: 'Drafts' })).toBeVisible();
  void project;
});

test('closing the tab asks first; the next visit offers the edit; discard removes it; someone else signing in removes it', async ({ page, context, browser }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Drafts HTML', project_type: 'pdf_to_html' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter' })).text;
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<p>Saved.</p>' });
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByRole('button', { name: 'HTML source', exact: true }).click();
  const source = page.getByLabel(/^HTML/);
  await expect(source).toHaveValue('<p>Saved.</p>');
  await source.fill('<p>Saved, then edited.</p>');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  const asked = [];
  page.on('dialog', async (d) => { asked.push(d.type()); await (asked.length === 1 ? d.dismiss() : d.accept()); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);

  const again = await context.newPage();
  await again.goto(`/manifold-companion/texts/${text.id}`);
  const banner = again.getByRole('region', { name: 'Unsaved changes found' });
  await expect(banner).toContainText('Changes to the HTML');
  await banner.getByRole('button', { name: 'Discard them' }).click();
  await expect(banner).toHaveCount(0);
  await expect(again.getByLabel(/^HTML/)).toHaveValue('<p>Saved.</p>');
  expect(await draftKeys(again)).toEqual([]);

  // Leave an edit behind, then someone else signs in on this browser: it is removed before anything shows.
  await again.getByLabel(/^HTML/).fill('<p>Carol was here.</p>');
  await expect.poll(() => draftKeys(again)).toHaveLength(1);
  await again.evaluate(() => { window.onbeforeunload = null; });
  await context.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  again.on('dialog', (d) => d.accept());
  await again.goto('/manifold-companion/');
  await expect(again.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect.poll(() => draftKeys(again)).toEqual([]);
  void browser;
});

test('Settings counts the edits kept in this browser and deletes them', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text } = await imageTextWithPages(page, api, ['One.']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByLabel(/^Text of page 1/).fill('One, edited.');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  await page.locator('header a[href$="/settings"]').click(); // named after the person's display name, if set
  await page.getByRole('alertdialog').getByRole('button', { name: 'Leave this page' }).click();
  await expect(page.getByText('1 text has unsaved changes kept here.')).toBeVisible();
  expect(await axe(page, 'settings with a kept draft')).toEqual([]);
  await page.getByRole('button', { name: 'Delete them from this browser' }).click();
  await expect(page.getByText('None are kept now.')).toBeVisible();
  expect(await draftKeys(page)).toEqual([]);
});

test('keyboard shortcuts: a visible list, ? and /, N and P outside fields, Mod+S in an editor, single keys can be turned off', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('table', { name: 'Keyboard shortcuts' }).getByRole('row')).toHaveCount(14);
  expect(await axe(page, 'shortcuts dialog')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search your texts')).toBeFocused();
  await page.keyboard.type('?'); // typed into the search box, not a shortcut
  await expect(page.getByLabel('Search your texts')).toHaveValue('?');
  await expect(dialog).toHaveCount(0);

  const api = apiOf(page);
  const { text } = await imageTextWithPages(page, api, ['First page.', 'Second page.', 'Third page.']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const editor = page.getByLabel(/^Text of page/);
  await expect(editor).toHaveValue('First page.');
  await page.locator('h1').click(); // focus outside any field
  await page.keyboard.press('n');
  await expect(page.getByLabel(/^Text of page 2/)).toHaveValue('Second page.');
  await page.keyboard.press('p');
  await expect(page.getByLabel(/^Text of page 1/)).toHaveValue('First page.');

  // In the editor, N is a letter; Mod+S saves; Mod+Shift+S saves and opens the next page.
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' nnn');
  await expect(editor).toHaveValue('First page. nnn');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('First page. nnn');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' again');
  await page.keyboard.press('ControlOrMeta+Shift+S');
  await expect(page.getByLabel(/^Text of page 2/)).toHaveValue('Second page.');
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('First page. nnn again');

  // Turned off: N does nothing, and that is remembered in this browser.
  await page.locator('h1').click();
  await page.keyboard.press('?');
  await dialog.getByLabel(/Single-key shortcuts/).uncheck();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('h1').click();
  await page.keyboard.press('n');
  await page.keyboard.press('?');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel(/^Text of page 1/)).toBeVisible();
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await dialog.getByLabel(/Single-key shortcuts/).check();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.locator('h1').click();
  await page.keyboard.press('n');
  await expect(page.getByLabel(/^Text of page 2/)).toBeVisible();
});

test('Mod+S saves the HTML of a PDF text', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Keys HTML', project_type: 'pdf_to_html' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter' })).text;
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<p>One.</p>' });
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByRole('button', { name: 'HTML source', exact: true }).click();
  const source = page.getByLabel(/^HTML/);
  await expect(source).toHaveValue('<p>One.</p>');
  await source.fill('<p>One, saved from the keyboard.</p>');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  expect((await api(`/texts/${text.id}/html`)).html_content).toBe('<p>One, saved from the keyboard.</p>');
});
