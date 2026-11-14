// PDF proofreading and shared UX: the source PDF beside the text, and related project/text screens.
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
const axe = async (page) => (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);

/** A PDF text with the two-page fixture stored as its source and two converted page sections. */
export async function pdfText(page, name = 'Proofread') {
  const api = apiOf(page);
  await page.goto('/manifold-companion/');
  const project = (await api('/projects', 'POST', { name, project_type: 'pdf_to_html' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter' })).text;
  const pdf = readFileSync('e2e/fixtures/two-pages.pdf');
  const up = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/source-pdf?filename=two-pages.pdf&size=${pdf.length}`, { method: 'PUT', headers: { Origin: ORIGIN, 'content-type': 'application/pdf' }, data: pdf });
  expect(up.ok(), `source pdf: ${up.status()}`).toBe(true);
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<section data-page="1"><p>First page text.</p></section><section data-page="2"><p>Second page text.</p></section>' });
  return { api, project, text };
}

test('the source PDF sits beside the text: pages, zoom, follow the cursor, the export preview a toggle away', async ({ page, context }) => {
  await as(context, 'alice');
  const { text } = await pdfText(page);
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const pane = page.getByRole('toolbar', { name: 'Source PDF' });
  await expect(pane.getByText('of 2')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Page 1 of the source PDF, two-pages.pdf' })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(1);
  await pane.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('region', { name: /^Page 2 of the source PDF/ })).toBeVisible();
  await pane.getByRole('button', { name: 'Zoom in' }).click();
  await expect(pane.getByText('Zoom 125%')).toBeVisible();
  await pane.getByRole('button', { name: 'Fit width' }).click();
  await expect(pane.getByText('Zoom fits the width')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // Follow the text: the cursor in page 1's section in the HTML source turns the PDF back to page 1.
  await pane.getByLabel('Follow the text').check();
  await page.getByRole('button', { name: 'HTML source', exact: true }).click();
  const source = page.getByLabel(/^HTML/);
  await source.click();
  await source.evaluate((el) => { el.focus(); el.setSelectionRange(40, 40); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await source.press('ArrowRight');
  await expect(page.getByRole('region', { name: /^Page 1 of the source PDF/ })).toBeVisible();

  // The export preview is the other side; the choice is remembered.
  await page.getByRole('button', { name: 'As exported' }).click();
  await expect(page.frameLocator('iframe[title="Preview of the HTML"]').getByText('Second page text.')).toBeVisible();
  await page.reload();
  await expect(page.locator('iframe[title="Preview of the HTML"]')).toBeVisible();
  await page.getByRole('button', { name: 'Source PDF', exact: true }).click();
  await expect(page.getByRole('region', { name: /^Page 1 of the source PDF/ })).toBeVisible();
});

test('convert the stored PDF again: no re-pick and no re-upload, after the replace warning', async ({ page, context }) => {
  await as(context, 'alice');
  const { text } = await pdfText(page, 'Reprocess');
  const puts = [];
  const parsed = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/source-pdf')) puts.push(r.url());
    if (r.url().endsWith('/parse-page')) parsed.push(JSON.parse(r.postData()).page_number);
  });
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const again = page.getByRole('button', { name: 'Convert the stored PDF again' });
  await expect(again).toBeEnabled();
  await expect(page.getByText(/Uses two-pages\.pdf, already saved with this text/)).toBeVisible();
  await again.click();
  await page.getByRole('button', { name: 'Convert and replace' }).click();
  await expect(page.locator('.mc-editor')).toContainText('Transcribed by the stub model', { timeout: 60_000 });
  expect(parsed).toEqual([1, 2]);
  expect(puts).toEqual([]);
});

test('version history shows what changed: each version against the next one, the newest against the text now', async ({ page, context }) => {
  await as(context, 'alice');
  const { api, text } = await pdfText(page, 'Diff');
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<section data-page="1"><p>First page text.</p></section><section data-page="2"><p>Second page, corrected.</p></section>' });
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<section data-page="1"><p>First page text.</p></section><section data-page="2"><p>Second page, corrected.</p><p>A new paragraph.</p></section>' });
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await page.getByRole('button', { name: 'Version history' }).click();
  const list = page.getByRole('list', { name: 'Earlier versions, newest first' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  // Newest version: compared with the text as saved now.
  await list.getByRole('listitem').nth(0).getByRole('button', { name: /^Changes/ }).click();
  const now = page.getByRole('list', { name: /to the text as saved now$/ });
  await expect(now).toContainText('Added: <p>A new paragraph.</p>');
  await expect(now.getByText(/Removed:/)).toHaveCount(0);
  // The older one: compared with the newer version, a changed paragraph is one removed and one added line.
  await list.getByRole('listitem').nth(1).getByRole('button', { name: /^Changes/ }).click();
  const older = page.getByRole('list', { name: /^Changes from the version of .* to the version from / });
  await expect(older).toContainText('Removed: <p>Second page text.</p>');
  await expect(older).toContainText('Added: <p>Second page, corrected.</p>');
  await expect(older).toContainText('unchanged line');
  expect(await axe(page)).toEqual([]);
});

test('comments: when each was written, the owner can delete anyone’s, replies can be deleted, a jump link near the editor', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const { api, project, text } = await pdfText(page, 'Comments');
  const inv = (await api(`/projects/${project.id}/invites`, 'POST', { role: 'editor' })).invite;
  const other = await browser.newContext();
  await other.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  const bob = await other.newPage();
  await bob.goto(`/manifold-companion/invite#t=${inv.token}`);
  await expect(bob).toHaveURL(/\/projects\//);
  const bobApi = apiOf(bob);
  const note = (await bobApi(`/texts/${text.id}/annotations`, 'POST', { anchor_type: 'global', body: 'Check page two.' })).annotation;
  await bobApi(`/texts/${text.id}/annotations/${note.id}/replies`, 'POST', { body: 'Bob replies too.' });
  await api(`/texts/${text.id}/annotations/${note.id}/replies`, 'POST', { body: 'Alice replies.' });

  await page.goto(`/manifold-companion/texts/${text.id}`);
  const jump = page.getByRole('link', { name: 'Comments (1)' });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute('href', '#comments-title');
  const comments = page.locator('section[aria-labelledby="comments-title"]');
  await expect(comments.locator('time').first()).toHaveText('just now');
  await comments.getByRole('button', { name: 'Replies (2)' }).click();
  // The owner may delete Bob's reply; the confirmation names whose it is.
  await comments.getByRole('button', { name: /^Delete the reply by/ }).first().click();
  await expect(page.getByRole('alertdialog')).toContainText('Delete this reply by');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(comments.getByText('Bob replies too.')).toHaveCount(0);
  await expect(comments.getByText('Alice replies.')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  // Bob, an editor, can delete his own comment but not Alice's reply.
  await bob.goto(`/manifold-companion/texts/${text.id}`);
  const bobComments = bob.locator('section[aria-labelledby="comments-title"]');
  await bobComments.getByRole('button', { name: 'Replies (1)' }).click();
  await expect(bobComments.getByText('Alice replies.')).toBeVisible();
  await expect(bobComments.getByRole('button', { name: /^Delete the reply by/ })).toHaveCount(0);
  await other.close();
  // The owner deletes Bob's comment; the jump link count follows.
  await comments.getByRole('button', { name: /^Delete the comment by/ }).click();
  await expect(page.getByRole('alertdialog')).toContainText('its reply');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(comments.getByText('Check page two.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Comments (0)' })).toBeVisible();
});

test('a stopped conversion resumes after a reload: kept pages are not paid for again, and a different PDF never resumes', async ({ page, context }) => {
  await as(context, 'alice');
  const { createHash } = await import('node:crypto');
  const fp = `sha256-${createHash('sha256').update(readFileSync('e2e/fixtures/two-pages.pdf')).digest('hex').slice(0, 40)}`;
  const { api, text } = await pdfText(page, 'Resume');
  const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  // Page 1 of a run that then stopped (a reload, a closed tab).
  expect((await api(`/texts/${text.id}/parse-page`, 'POST', { image: IMG, page_number: 1, total_pages: 2, resume_source: fp })).kept).toBe(true);
  const parsed = [];
  page.on('request', (r) => { if (r.url().endsWith('/parse-page')) parsed.push(JSON.parse(r.postData())); });
  await page.goto(`/manifold-companion/texts/${text.id}`);
  await expect(page.getByText(/A conversion stopped after 1 of 2 pages/)).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue converting the stored PDF' }).click();
  await page.getByRole('button', { name: 'Convert and replace' }).click();
  await expect(page.locator('.mc-editor')).toContainText('Transcribed by the stub model', { timeout: 60_000 });
  expect(parsed.map((p) => [p.page_number, p.resume_source])).toEqual([[2, fp]]);
  await expect(page.getByText(/A conversion stopped after/)).toHaveCount(0);
  expect((await api(`/texts/${text.id}/conversion`)).run).toBeNull();
  const html = (await api(`/texts/${text.id}/html`)).html_content;
  expect(html).toMatch(/data-page="1"[\s\S]*data-page="2"/);

  // Kept pages of another PDF: "continue" stops and says why; nothing is converted.
  await api(`/texts/${text.id}/parse-page`, 'POST', { image: IMG, page_number: 1, total_pages: 2, resume_source: 'sha256-another' });
  parsed.length = 0;
  await page.reload();
  await page.getByRole('button', { name: 'Continue converting the stored PDF' }).click();
  await page.getByRole('button', { name: 'Convert and replace' }).click();
  await expect(page.getByRole('alert')).toContainText('The stored PDF is not the one the stopped conversion used');
  expect(parsed).toEqual([]);
  await page.getByRole('button', { name: 'Discard the kept pages' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText(/A conversion stopped after/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Convert the stored PDF again' })).toBeVisible();
});

test('Help states the page cap and the PDF size limit', async ({ page, context }) => {
  await as(context, 'alice');
  await page.goto('/manifold-companion/help');
  await expect(page.getByText(/a project holds at most 300 pages, and a source PDF can be at most/)).toBeVisible();
});

test('readable statuses, counts on the dashboard, shared projects apart, a description at creation, select all', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const api = apiOf(page);
  await page.goto('/manifold-companion/');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Letters of 1912');
  await page.getByLabel('Description (optional)').fill('Family letters, typewritten.');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByText('Family letters, typewritten.')).toBeVisible();
  const id = page.url().split('/projects/')[1].split(/[?#]/)[0];
  for (const n of ['One', 'Two', 'Three']) await api(`/projects/${id}/texts`, 'POST', { name: n });
  const { texts } = await api(`/projects/${id}/texts`);
  await page.request.fetch(`/manifold-companion/api/texts/${texts[0].id}/pages?filename=a.jpg&size=${readFileSync('e2e/fixtures/page.png').length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: readFileSync('e2e/fixtures/page.png') });
  await page.reload();
  // No raw status word: "pending" reads as "Not read yet".
  await expect(page.locator('ul.rowlist')).toContainText('1 page, Not read yet');
  await expect(page.locator('ul.rowlist')).not.toContainText('pending');
  const all = page.getByLabel('Select all 3 texts');
  await page.getByLabel('Select One').check();
  await expect(all).not.toBeChecked();
  expect(await all.evaluate((el) => el.indeterminate)).toBe(true);
  await all.check();
  await expect(page.getByRole('region', { name: '3 texts selected' })).toBeVisible();
  await page.getByRole('region', { name: '3 texts selected' }).getByLabel('Status').selectOption('ocrd');
  await expect(page.getByRole('region', { name: '3 texts selected' }).getByLabel('Status')).toContainText('OCR complete');
  await page.getByRole('region', { name: '3 texts selected' }).getByRole('button', { name: 'Set status' }).click();
  await expect(page.getByText('3 texts set to “OCR complete”.')).toBeVisible();
  await expect(page.locator('ul.rowlist')).toContainText('OCR complete');
  expect(await axe(page)).toEqual([]);
  await all.uncheck();
  await expect(page.getByRole('region', { name: /texts selected/ })).toHaveCount(0);

  // The dashboard: counts and the start of the description; projects shared with alice listed apart.
  await page.goto('/manifold-companion/');
  const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Letters of 1912' }) });
  await expect(row).toContainText('3 texts, 1 page');
  await expect(row).toContainText('Family letters, typewritten.');
  await expect(row).toContainText('you own it');
  const other = await browser.newContext();
  await other.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  const bob = await other.newPage();
  await bob.goto('/manifold-companion/');
  const bobProject = (await apiOf(bob)('/projects', 'POST', { name: 'Bob shares this' })).project;
  const inv = (await apiOf(bob)(`/projects/${bobProject.id}/invites`, 'POST', { role: 'viewer' })).invite;
  await other.close();
  await page.goto(`/manifold-companion/invite#t=${inv.token}`);
  await expect(page).toHaveURL(/\/projects\//);
  await page.goto('/manifold-companion/');
  const shared = page.locator('section', { has: page.getByRole('heading', { name: 'Shared with you' }) });
  await expect(shared.getByRole('link', { name: 'Bob shares this' })).toBeVisible();
  await expect(shared).toContainText('you are a viewer');
  await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Projects you own' }) }).getByRole('link', { name: 'Letters of 1912' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('PDF projects: import PDFs as new texts and upload or replace a text’s PDF from the project page', async ({ page, context }) => {
  await as(context, 'alice');
  const api = apiOf(page);
  await page.goto('/manifold-companion/');
  const project = (await api('/projects', 'POST', { name: 'Imports', project_type: 'pdf_to_html' })).project;
  await api(`/projects/${project.id}/texts`, 'POST', { name: 'Empty chapter' });
  await page.goto(`/manifold-companion/projects/${project.id}`);
  const empty = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Empty chapter' }) });
  await expect(empty).toContainText('No source PDF yet');
  // Upload from the row: the file chooser opens from the visible button.
  const chooser = page.waitForEvent('filechooser');
  await empty.getByRole('button', { name: 'Upload PDF for Empty chapter' }).click();
  await (await chooser).setFiles('e2e/fixtures/two-pages.pdf');
  await expect(page.getByText('two-pages.pdf stored for “Empty chapter”.')).toBeVisible();
  await expect(empty).toContainText('Source: two-pages.pdf');
  // Replacing asks first.
  const again = page.waitForEvent('filechooser');
  await empty.getByRole('button', { name: 'Replace PDF for Empty chapter' }).click();
  await (await again).setFiles('e2e/fixtures/figures.pdf');
  await expect(page.getByRole('alertdialog')).toContainText('Replace two-pages.pdf of “Empty chapter” with figures.pdf?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Replace the PDF' }).click();
  await expect(empty).toContainText('Source: figures.pdf');
  // Import: one text per PDF, named after the file, nothing converted.
  const imp = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import PDFs as new texts' }).click();
  await (await imp).setFiles('e2e/fixtures/two-pages.pdf');
  await expect(page.getByText('Imported “two-pages”. Open each text to convert it.')).toBeVisible();
  const imported = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'two-pages', exact: true }) });
  await expect(imported).toContainText('Not converted yet');
  await expect(imported).toContainText('Source: two-pages.pdf');
  expect(await axe(page)).toEqual([]);
  await imported.getByRole('link', { name: 'two-pages', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Convert the stored PDF', exact: true })).toBeVisible();
});

test('move a page or a text straight to a position, from the keyboard', async ({ page, context }) => {
  await as(context, 'alice');
  const api = apiOf(page);
  await page.goto('/manifold-companion/');
  const project = (await api('/projects', 'POST', { name: 'Positions' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Letters' })).text;
  const png = readFileSync('e2e/fixtures/page.png');
  for (const n of [1, 2, 3, 4]) {
    const r = await page.request.fetch(`/manifold-companion/api/texts/${text.id}/pages?filename=p${n}.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
    expect(r.ok()).toBe(true);
  }
  await page.goto(`/manifold-companion/texts/${text.id}`);
  const pages = page.getByRole('navigation', { name: 'Pages' });
  const names = async () => (await api(`/texts/${text.id}`)).pages.map((p) => p.filename);
  const before = await names();
  const last = before[3];
  await pages.getByRole('button', { name: new RegExp(`^Move page 4 \\(${last.replace('.', '\\.')}\\) to a position$`) }).click();
  await page.getByLabel(/^New position of page 4/).fill('1');
  await page.keyboard.press('Enter');
  await expect(page.getByText(`${last} moved to position 1 of 4.`)).toBeAttached();
  await expect.poll(names).toEqual([last, ...before.slice(0, 3)]);
  expect(await axe(page)).toEqual([]);

  for (const n of ['Second', 'Third']) await api(`/projects/${project.id}/texts`, 'POST', { name: n });
  await page.goto(`/manifold-companion/projects/${project.id}`);
  await page.getByRole('button', { name: 'Move Third to a position' }).click();
  const pos = page.getByLabel('New position of Third, 1 to 3');
  await pos.fill('3');
  await expect(page.getByRole('button', { name: 'Move', exact: true })).toBeDisabled(); // already there
  await pos.fill('1');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('Third moved to position 1 of 3.')).toBeVisible();
  await expect(page.locator('a.doc-title')).toHaveText(['Third', 'Letters', 'Second']);
});

test('Settings, Usage: which owned projects use the storage, largest first', async ({ page, context }) => {
  await as(context, 'carol');
  const api = apiOf(page);
  await page.goto('/manifold-companion/');
  const big = (await api('/projects', 'POST', { name: 'Carol big' })).project;
  await api('/projects', 'POST', { name: 'Carol empty' });
  const t = (await api(`/projects/${big.id}/texts`, 'POST', { name: 'T' })).text;
  const png = readFileSync('e2e/fixtures/page.png');
  await page.request.fetch(`/manifold-companion/api/texts/${t.id}/pages?filename=a.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
  await page.goto('/manifold-companion/settings');
  const table = page.getByRole('table', { name: 'Storage by project, largest first' });
  // Largest first: the project with a page comes before the empty one (other tests leave carol more projects).
  await expect(table).toContainText('Carol empty');
  const names = await table.locator('tbody tr td:first-child').allInnerTexts();
  expect(names.indexOf('Carol big')).toBeGreaterThan(-1);
  expect(names.indexOf('Carol big')).toBeLessThan(names.indexOf('Carol empty'));
  expect(await axe(page)).toEqual([]);
});

test('search: results grouped by project; a one-letter search says why nothing happened', async ({ page, context }) => {
  await as(context, 'alice');
  const { api, text } = await pdfText(page, 'Searchable');
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: '<p>The zebrafish appears here.</p>' });
  await page.goto('/manifold-companion/');
  await page.getByLabel('Search your texts').fill('z');
  await page.getByLabel('Search your texts').press('Enter');
  await expect(page.getByText('Type at least 2 characters to search.')).toBeVisible();
  await page.getByLabel('Search your texts').fill('zebrafish');
  await page.getByLabel('Search your texts').press('Enter');
  await expect(page.getByRole('heading', { name: /^Searchable/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Chapter' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
