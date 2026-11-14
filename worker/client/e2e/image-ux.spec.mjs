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

test('summary: written by the model, corrected by hand and saved; replacing it asks first; a long text says it was only partly read', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text } = await imageText(page, api, ['A letter from Naples, 1921.']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const summary = page.getByLabel(`Summary of Letter`);
  await expect(summary).toHaveValue('');
  await page.getByRole('button', { name: 'Write a summary' }).click();
  await expect(summary).toHaveValue('A stub summary.');
  await expect(page.getByText(/covers only the first part/)).toHaveCount(0);
  await summary.fill('A letter from Naples, 1921, about the crossing.');
  await page.getByRole('button', { name: 'Save summary' }).click();
  await expect(page.getByText('Summary saved.')).toBeVisible();
  expect((await api(`/texts/${text.id}/summary`)).summary).toBe('A letter from Naples, 1921, about the crossing.');
  expect(await axe(page, 'summary')).toEqual([]);

  // The model never replaces a summary without asking.
  await page.getByRole('button', { name: 'Write a new summary' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(summary).toHaveValue('A letter from Naples, 1921, about the crossing.');

  // A text longer than the model is sent: the reply says so, and the page shows it.
  await api(`/texts/${text.id}/save`, 'POST', { text: 'word '.repeat(21000) });
  await page.reload();
  await page.getByRole('button', { name: 'Write a new summary' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Write a new summary' }).click();
  await expect(page.getByText(/covers only the first part of the text/)).toBeVisible();
});

test('translation: translated, checked beside the original, corrected and saved; a viewer reads it', async ({ page, context, browser }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { project, text } = await imageText(page, api, ['Cara mamma, siamo arrivati.']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  // Languages by name; Ancient Greek and Yiddish are offered again.
  await expect(page.getByLabel('Translate from').locator('option', { hasText: 'Ancient Greek' })).toHaveCount(1);
  await page.getByLabel('Translate from').selectOption({ label: 'Italian' });
  await page.getByLabel('Translate to').selectOption({ label: 'Yiddish' });
  const sent = [];
  page.on('request', (r) => { if (r.url().endsWith('/translate-chunk')) sent.push(r.postDataJSON()); });
  await page.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ source_language: 'it', target_language: 'yi' });
  const box = page.getByRole('textbox', { name: 'Translation' });
  await expect(box).toHaveValue('A stub summary.');
  await page.getByLabel('Show beside the original').check();
  await expect(page.getByRole('region', { name: 'Original (the text the export uses)' })).toContainText('Cara mamma, siamo arrivati.');
  await box.fill('Dear mother, we have arrived.');
  await page.getByRole('button', { name: 'Save translation' }).click();
  await expect(page.getByText('Translation saved.')).toBeVisible();
  expect((await api(`/texts/${text.id}/translation`)).translation).toBe('Dear mother, we have arrived.');
  expect(await axe(page, 'translation beside the original')).toEqual([]);
  await page.getByRole('button', { name: 'Translate again' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('replaces the current translation');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(box).toHaveValue('Dear mother, we have arrived.');

  const inv = (await api(`/projects/${project.id}/invites`, 'POST', { role: 'viewer' })).invite;
  const other = await browser.newContext();
  await other.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  const viewer = await other.newPage();
  await viewer.goto(`/manifold-companion/invite#t=${inv.token}`);
  await expect(viewer.getByText(/you are a viewer/)).toBeVisible();
  await viewer.goto(`/manifold-companion/texts/${text.id}`);
  await expect(viewer.getByRole('region', { name: 'Translation of Letter' })).toContainText('Dear mother, we have arrived.');
  await expect(viewer.getByRole('button', { name: 'Save translation' })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Save summary' })).toHaveCount(0);
  await other.close();
});

test('a PDF text has a summary section too', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name: 'Book', project_type: 'pdf_to_html' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter' })).text;
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<p>Chapter one begins.</p>' });
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByRole('button', { name: 'Write a summary' }).click();
  await expect(page.getByLabel('Summary of Chapter')).toHaveValue('A stub summary.');
  await page.getByLabel('Summary of Chapter').fill('Chapter one, corrected.');
  await page.getByRole('button', { name: 'Save summary' }).click();
  await expect(page.getByText('Summary saved.')).toBeVisible();
  expect((await api(`/texts/${text.id}/summary`)).summary).toBe('Chapter one, corrected.');
});

test('the scan zooms and moves (buttons, keys, wheel, drag) and opens full screen with previous and next page', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text } = await imageText(page, api, ['first', 'second', 'third']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const scan = page.getByRole('group', { name: /^Scan of page 1, zoom/ });
  const level = page.getByLabel('Zoom level').first();
  await expect(level).toHaveText('100%');
  await expect(scan).toHaveAccessibleDescription(/arrow keys/);
  await page.getByRole('button', { name: 'Zoom in' }).first().click();
  await expect(level).toHaveText('125%');
  await scan.focus();
  await page.keyboard.press('+');
  await expect(level).toHaveText('156%');
  const img = scan.locator('img');
  const before = await img.evaluate((el) => el.style.transform);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => img.evaluate((el) => el.style.transform)).not.toBe(before);
  // Drag moves it too.
  const b = await scan.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 40, b.y + b.height / 2 - 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('0');
  await expect(level).toHaveText('100%');
  await expect.poll(() => img.evaluate((el) => el.style.transform)).toBe('translate(0px, 0px) scale(1)');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -200);
  await expect(level).not.toHaveText('100%');
  // The zoom keys never reach a text field: typing "+" in the page text types it.
  await page.getByLabel(/^Text of page 1/).press('End');
  await page.getByLabel(/^Text of page 1/).type('+');
  await expect(page.getByLabel(/^Text of page 1/)).toHaveValue('first+');
  expect(await axe(page, 'scan viewer')).toEqual([]);

  await page.getByRole('button', { name: 'Full screen' }).click();
  const box = page.getByRole('dialog', { name: /Page 1 of 3/ });
  await expect(box).toBeVisible();
  expect(await axe(page, 'lightbox')).toEqual([]);
  await box.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('dialog', { name: /Page 2 of 3/ })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: /Page 3 of 3/ })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: /Page 2 of 3/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeFocused();
});

test('the page editor has a Markdown toolbar (and Ctrl/Cmd+B, I); the visual editor has underline and strikethrough', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text } = await imageText(page, api, ['Cara mamma\nsiamo arrivati']);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const box = page.getByLabel(/^Text of page 1/);
  const bar = page.getByRole('toolbar', { name: 'Format the page text (Markdown)' });
  await expect(bar).toBeVisible();
  const select = (from, to) => box.evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); }, [from, to]);
  await select(0, 4);
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(box).toHaveValue('**Cara** mamma\nsiamo arrivati');
  // The browser's own undo takes it back.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(box).toHaveValue('Cara mamma\nsiamo arrivati');
  await select(5, 10);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+i' : 'Control+i');
  await expect(box).toHaveValue('Cara *mamma*\nsiamo arrivati');
  await select(0, 0);
  await bar.getByRole('button', { name: 'Heading 2' }).click();
  await expect(box).toHaveValue('## Cara *mamma*\nsiamo arrivati');
  await select(17, 17);
  await bar.getByRole('button', { name: 'Quotation' }).click();
  await expect(box).toHaveValue('## Cara *mamma*\n> siamo arrivati');
  // One tab stop; arrows move along the toolbar.
  await bar.getByRole('button', { name: 'Bold' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', { name: 'Italic' })).toBeFocused();
  expect(await axe(page, 'markdown toolbar')).toEqual([]);
  await page.getByRole('button', { name: 'Save page' }).click();
  expect((await api(`/texts/${text.id}`)).pages[0].ocr_text).toBe('## Cara *mamma*\n> siamo arrivati');

  // Visual editor: underline and strikethrough.
  const project = (await api('/projects', 'POST', { name: 'Book', project_type: 'pdf_to_html' })).project;
  const pdf = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter' })).text;
  await api(`/texts/${pdf.id}/html`, 'PUT', { html_content: '<p>alpha beta</p>' });
  await page.goto(`/manifold-companion/texts/${pdf.id}`);
  const editor = page.locator('.mc-editor');
  await editor.getByText('alpha beta').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowLeft' : 'Shift+Home');
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Underline' }).click();
  await expect(editor.locator('u')).toHaveCount(1);
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Strikethrough' }).click();
  await expect(editor.locator('s')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save HTML' }).click();
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  const saved = (await api(`/texts/${pdf.id}/html`)).html_content;
  expect(saved).toMatch(/<u>/);
  expect(saved).toMatch(/<s>/);
});

test('an unsaved page edit is never replaced without asking: Go to page N from a comment, Read all pages again, Read pages without text', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text, pages } = await imageText(page, api, ['first page', 'second page', null]);
  // A comment anchored on page 2, so page 1 offers "Go to page 2".
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByRole('button', { name: /^2\. p2\.png/ }).click();
  const box = page.getByLabel(/^Text of page 2/);
  await box.evaluate((el) => { el.focus(); el.setSelectionRange(0, 6); });
  await page.getByRole('button', { name: 'Comment on the selected text' }).click();
  await page.getByLabel('New comment').fill('Check this word.');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByText('Check this word.')).toBeVisible();
  await page.getByRole('button', { name: /^1\. p1\.png/ }).click();
  await page.getByLabel(/^Text of page 1/).fill('first page, being corrected');
  await page.getByRole('button', { name: 'Go to page 2' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('Discard the changes to this page?');
  await dlg.getByRole('button', { name: 'Stay on this page' }).click();
  await expect(page.getByLabel(/^Text of page 1/)).toHaveValue('first page, being corrected');

  await page.getByRole('button', { name: 'Read all pages again' }).click();
  await expect(dlg).toContainText('Page 1 has changes that are not saved; they are lost too.');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel(/^Text of page 1/)).toHaveValue('first page, being corrected');

  // Page 3 has no text: an edit there would be replaced by "Read pages without text".
  await page.getByRole('button', { name: /^Save page/ }).click();
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
  await expect(page.getByText('Page 1 saved.')).toBeVisible();
  await page.getByRole('button', { name: /^3\. p3\.png/ }).click();
  await page.getByLabel(/^Text of page 3/).fill('typed by hand');
  await page.getByRole('button', { name: 'Read pages without text' }).click();
  await expect(dlg).toContainText('Discard the changes to this page?');
  await dlg.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel(/^Text of page 3/)).toHaveValue('typed by hand');
  expect((await api(`/texts/${text.id}`)).pages[2].ocr_text).toBeNull();
  void pages;
});

test('the page list shows a thumbnail of each page; the buttons still name the page', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const { text, pages } = await imageText(page, api, ['one', null]);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const nav = page.getByRole('navigation', { name: 'Pages' });
  const thumbs = nav.locator('img[data-thumb]');
  await expect(thumbs).toHaveCount(2);
  for (const t of await thumbs.all()) {
    await expect(t).toHaveAttribute('src', /^blob:/);
    await expect(t).toHaveAttribute('alt', '');
    expect(await t.evaluate((el) => el.naturalWidth > 0 && el.naturalWidth <= 192)).toBe(true);
  }
  await expect(nav.locator(`img[data-thumb="${pages[0].id}"]`)).toBeVisible();
  await expect(nav.getByRole('button', { name: '1. p1.png', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '2. p2.png (no text)', exact: true })).toBeVisible();
  expect(await axe(page, 'page thumbnails')).toEqual([]);
});
