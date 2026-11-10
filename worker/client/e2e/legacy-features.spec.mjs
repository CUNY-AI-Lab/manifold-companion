// Journeys for the features carried over from the legacy app after launch.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';

const ORIGIN = 'http://127.0.0.1:8790';
const as = (context, who) => context.addCookies([{ name: 'e2e_as', value: who, url: ORIGIN }]);
const headers = { Origin: ORIGIN, 'content-type': 'application/json' };

async function newImageText(page, projectName, textName) {
  await page.goto('/manifold-companion/');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  const projectUrl = page.url();
  await page.getByLabel('New text name').fill(textName);
  await page.getByRole('button', { name: 'Add text' }).click();
  await expect(page.getByRole('heading', { name: textName })).toBeVisible();
  return { projectUrl, projectId: projectUrl.split('/').pop(), textUrl: page.url() };
}

async function inviteAs(page, browser, projectId, role, who) {
  const r = await page.request.fetch(`/manifold-companion/api/projects/${projectId}/invites`, { method: 'POST', headers, data: { role } });
  expect(r.ok()).toBe(true);
  const { invite: { token } } = await r.json();
  const context = await browser.newContext();
  await as(context, who);
  const other = await context.newPage();
  await other.goto('/manifold-companion/');
  const named = await other.request.fetch('/manifold-companion/api/profile', { method: 'PUT', headers, data: { display_name: who[0].toUpperCase() + who.slice(1) } });
  expect(named.ok()).toBe(true);
  await other.goto(`/manifold-companion/invite#t=${token}`);
  await expect(other.getByText(`you are a ${role}`)).toBeVisible();
  return { context, page: other };
}

test('Dublin Core metadata: the editor saves it, the export carries it, a viewer reads it', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const { projectUrl, projectId, textUrl } = await newImageText(page, 'Metadata project', 'Letter A');
  await page.locator('input[type=file]').setInputFiles({ name: 'm.png', mimeType: 'image/png', buffer: readFileSync('e2e/fixtures/page.png') });
  await expect(page.getByRole('button', { name: /m\.jpg/ })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/Text of page 1/).fill('Dear reader.');
  await page.getByRole('button', { name: 'Save page' }).click();

  await page.getByRole('button', { name: 'Dublin Core metadata' }).click();
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Save metadata' }) });
  await form.getByLabel('Title', { exact: true }).fill('Carta A');
  await form.getByLabel('Creator', { exact: true }).fill('Ana Pérez');
  await form.getByLabel('Language', { exact: true }).fill('es');
  await form.getByLabel('Subject', { exact: true }).fill('Correspondence');
  await page.getByRole('button', { name: 'Save metadata' }).click();
  await expect(page.getByText('Metadata saved.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Dublin Core metadata' }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Correspondence');

  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Project details' }).click();
  await page.getByLabel('Description').fill('Letters from 1890');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Project details saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download ZIP' }).click()]);
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const md = strFromU8(files['text-01-letter-a.md']);
  expect(md).toMatch(/^---\ntitle: "Carta A"\nlanguage: "es"\ncreator: "Ana Pérez"\n---\n/);
  expect(strFromU8(files['manifest.yml'])).toContain('label: "Carta A"');

  const viewer = await inviteAs(page, browser, projectId, 'viewer', 'bob');
  await viewer.page.goto(textUrl);
  await viewer.page.getByRole('button', { name: 'Dublin Core metadata' }).click();
  const title = viewer.page.getByLabel('Title', { exact: true });
  await expect(title).toHaveValue('Carta A');
  await expect(title).toHaveAttribute('readonly', '');
  await expect(viewer.page.getByRole('button', { name: 'Save metadata' })).toHaveCount(0);
  await viewer.page.goto(projectUrl);
  await expect(viewer.page.getByRole('button', { name: 'Project details' })).toHaveCount(0);
  await viewer.context.close();
});

test('export sections: build a nested table of contents, save it, export it; a viewer cannot change it', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const { projectUrl, projectId } = await newImageText(page, 'Sections project', 'Alpha');
  for (const name of ['Beta', 'Gamma']) {
    const r = await page.request.fetch(`/manifold-companion/api/projects/${projectId}/texts`, { method: 'POST', headers, data: { name } });
    expect(r.ok()).toBe(true);
  }
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export for Manifold' });
  const items = dialog.getByRole('list', { name: 'Table of contents items' }).getByRole('listitem');
  await expect(items).toHaveCount(3);
  await dialog.getByLabel('New section').fill('Part One');
  await dialog.getByRole('button', { name: 'Add section' }).click();
  for (let i = 0; i < 3; i += 1) await dialog.getByRole('button', { name: 'Move Part One up' }).click();
  await dialog.getByRole('button', { name: 'Indent Alpha' }).click();
  await dialog.getByRole('button', { name: 'Indent Beta' }).click();
  await dialog.getByRole('button', { name: 'Remove Gamma from the export' }).click();
  await expect(items).toHaveCount(3);
  await dialog.getByLabel('Title').fill('Collected letters');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog.getByText('Export settings saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(items.first()).toContainText('Section');
  await expect(dialog.getByLabel('Section label, item 1')).toHaveValue('Part One');
  await expect(dialog.getByLabel('Title')).toHaveValue('Collected letters');
  await expect(dialog.getByRole('combobox', { name: 'Text not in the export' })).toBeVisible(); // Gamma can be added back
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download ZIP' }).click()]);
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  expect(Object.keys(files)).toEqual(['section-01-part-one.md', 'text-02-alpha.md', 'text-03-beta.md', 'manifest.yml']);
  const manifest = strFromU8(files['manifest.yml']);
  expect(manifest).toMatch(/- label: "Part One"\n\s+source_path: "section-01-part-one\.md"\n\s+start_section: true\n\s+children:\n\s+- label: "Alpha"/);
  expect(manifest).toContain('title: "Collected letters"');

  const viewer = await inviteAs(page, browser, projectId, 'viewer', 'bob');
  await viewer.page.goto(projectUrl);
  await viewer.page.getByRole('button', { name: 'Export' }).click();
  const vd = viewer.page.getByRole('dialog', { name: 'Export for Manifold' });
  await expect(vd.getByLabel('Section label, item 1')).toHaveValue('Part One');
  await expect(vd.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expect(vd.getByText('your changes here are not saved')).toBeVisible();
  await viewer.context.close();
});

test('member roles and ownership transfer, with an accessible confirmation', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const { projectUrl, projectId } = await newImageText(page, 'Shared project', 'Notes');
  const bob = await inviteAs(page, browser, projectId, 'editor', 'bob');
  const carol = await inviteAs(page, browser, projectId, 'viewer', 'carol');
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('dialog', { name: 'Share this project' });
  await share.getByLabel('Role of Carol').selectOption('editor');
  await expect(share.getByRole('listitem').filter({ hasText: 'Carol (editor' })).toHaveCount(1);

  const bobRow = share.getByRole('listitem').filter({ hasText: 'Bob (editor' });
  const makeOwner = bobRow.getByRole('button', { name: 'Make owner' });
  await makeOwner.click();
  const confirmDialog = page.getByRole('alertdialog', { name: 'Offer ownership?' });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('Nothing changes unless they accept');
  await expect(confirmDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmDialog).toHaveCount(0);
  await expect(makeOwner).toBeFocused();

  await makeOwner.click();
  await confirmDialog.getByRole('button', { name: 'Offer to Bob' }).click();
  await expect(share.getByText(/Ownership offered to\s*Bob, waiting for them to accept/)).toBeVisible();
  await expect(makeOwner).toBeDisabled(); // one pending offer per project
  await share.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('you are the owner')).toBeVisible(); // nothing moved yet

  await bob.page.goto('/manifold-companion/');
  await expect(bob.page.getByRole('region', { name: 'Ownership offered to you' }).getByRole('link', { name: 'Shared project' })).toBeVisible();
  await bob.page.goto(projectUrl);
  await expect(bob.page.getByText('you are a editor')).toBeVisible();
  await bob.page.getByRole('button', { name: 'Accept ownership' }).click();
  await bob.page.getByRole('alertdialog', { name: 'Become the owner?' }).getByRole('button', { name: 'Accept ownership' }).click();
  await expect(bob.page.getByText('you are the owner')).toBeVisible();
  await expect(bob.page.getByRole('button', { name: 'Share' })).toBeVisible();

  await page.reload();
  await expect(page.getByText('you are a editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await carol.page.goto(projectUrl);
  await expect(carol.page.getByText('you are a editor')).toBeVisible();
  await bob.context.close();
  await carol.context.close();
});

test('destructive actions ask in an in-app dialog: Cancel keeps, Escape keeps, the danger button deletes', async ({ page, context }) => {
  await as(context, 'alice');
  let nativeDialogs = 0;
  page.on('dialog', (d) => { nativeDialogs += 1; d.dismiss(); });
  const { projectUrl } = await newImageText(page, 'Dialogs project', 'Doomed');
  await page.goto(projectUrl);
  const del = page.getByRole('listitem').filter({ hasText: 'Doomed' }).getByRole('button', { name: 'Delete' });
  await del.click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this text?' });
  await expect(dialog).toContainText('cannot be undone');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(del).toBeFocused();
  await del.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Doomed' })).toBeVisible();
  await del.click();
  await dialog.getByRole('button', { name: 'Delete text' }).click();
  await expect(page.getByRole('link', { name: 'Doomed' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete project' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this project?' }).getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  expect(nativeDialogs).toBe(0);
});

test('comments on a stretch of text: anchor, find after edits, detach, edit, resolve; the notification menu', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const { projectId, textUrl } = await newImageText(page, 'Comments project', 'Letter');
  await page.locator('input[type=file]').setInputFiles({ name: 'c.png', mimeType: 'image/png', buffer: readFileSync('e2e/fixtures/page.png') });
  await expect(page.getByRole('button', { name: /c\.jpg/ })).toBeVisible({ timeout: 30_000 });
  const text = page.getByLabel(/Text of page 1/);
  const save = async (value) => { await text.fill(value); await page.getByRole('button', { name: 'Save page' }).click(); await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled(); };
  await save('Alpha beta gamma <b>bold</b> delta.');
  const select = async (word) => text.evaluate((el, w) => { const i = el.value.indexOf(w); el.focus(); el.setSelectionRange(i, i + w.length); }, word);
  const selected = () => text.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));

  await select('beta');
  await page.getByRole('button', { name: 'Comment on the selected text' }).click();
  await expect(page.getByText('On “beta”')).toBeVisible();
  await page.getByLabel('New comment').fill('Check this word');
  await page.getByRole('button', { name: 'Post comment' }).click();
  const comments = page.getByRole('region', { name: 'Comments' }).or(page.locator('section[aria-labelledby="comments-title"]'));
  const item = comments.getByRole('listitem').filter({ hasText: 'Check this word' });
  await expect(item.locator('blockquote')).toContainText('“beta”');

  // The quote shows as text, never as markup.
  await select('<b>bold</b>');
  await page.getByRole('button', { name: 'Comment on the selected text' }).click();
  await page.getByLabel('New comment').fill('Markup in the quote');
  await page.getByRole('button', { name: 'Post comment' }).click();
  const markup = comments.getByRole('listitem').filter({ hasText: 'Markup in the quote' });
  await expect(markup.locator('blockquote')).toContainText('<b>bold</b>');
  await expect(markup.locator('blockquote b')).toHaveCount(0);

  await select('gamma');
  await item.getByRole('button', { name: 'Show in text' }).click();
  expect(await selected()).toBe('beta');
  await save('Intro. Alpha beta gamma <b>bold</b> delta.');
  await item.getByRole('button', { name: 'Show in text' }).click();
  expect(await selected()).toBe('beta');
  await save('Intro. Alpha BETA gamma <b>bold</b> delta.');
  await expect(item).toContainText('Detached: the commented text was changed or removed.');
  await expect(item.getByRole('button', { name: 'Show in text' })).toHaveCount(0);

  await item.getByRole('button', { name: 'Edit' }).click();
  await item.getByLabel('Edit your comment').fill('Check this word, again');
  await item.getByRole('button', { name: 'Save comment' }).click();
  const edited = comments.getByRole('listitem').filter({ hasText: 'Check this word, again' });
  await expect(edited).toBeVisible();
  await edited.getByRole('button', { name: 'Resolve' }).click();
  await expect(edited).toHaveCount(0);
  await page.getByLabel('Show resolved comments').check();
  await expect(edited).toContainText('Resolved');
  await edited.getByRole('button', { name: 'Reopen' }).click();
  await expect(edited.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // Bob replies; Alice sees it in the notification menu.
  const bob = await inviteAs(page, browser, projectId, 'editor', 'bob');
  await bob.page.goto(textUrl);
  const bobItem = bob.page.locator('section[aria-labelledby="comments-title"]').getByRole('listitem').filter({ hasText: 'Markup in the quote' });
  await bobItem.getByRole('button', { name: /^Replies/ }).click();
  await bob.page.getByLabel('Reply').fill('Seen it');
  await bob.page.getByRole('button', { name: 'Post reply' }).click();
  await expect(bobItem).toContainText('Seen it');
  await bob.context.close();

  await page.goto('/manifold-companion/');
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(/Notifications \d+ unread/);
  await bell.click();
  await expect(bell).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('region', { name: 'Recent notifications' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(bell).toBeFocused();
  await bell.click();
  await menu.getByRole('button', { name: /Bob replied to your comment/ }).click();
  await expect(page).toHaveURL(/\/texts\//);
  await expect(page.getByRole('heading', { name: 'Letter' })).toBeVisible();
  await expect(bell).toHaveAccessibleName(/^Notifications( \d+ unread)?$/);
});

test('split a text, merge texts, set status and delete in bulk (with confirmation)', async ({ page, context }) => {
  await as(context, 'alice');
  const { projectUrl } = await newImageText(page, 'Bulk project', 'Book');
  const png = readFileSync('e2e/fixtures/page.png');
  await page.locator('input[type=file]').setInputFiles(['p1', 'p2', 'p3'].map((n) => ({ name: `${n}.png`, mimeType: 'image/png', buffer: png })));
  await expect(page.getByRole('button', { name: /^3\. p3\.jpg/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Split into several texts' }).click();
  await page.getByLabel('New texts start at pages').fill('3');
  await expect(page.getByText('Makes 2 new texts: part 1 (pages 1–2), part 2 (pages 3)')).toBeVisible();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Created' })).toContainText('Book, part 1, Book, part 2');

  await page.goto(projectUrl);
  await expect(page.locator('a.doc-title')).toHaveText(['Book', 'Book, part 1', 'Book, part 2']);
  await expect(page.getByRole('listitem').filter({ hasText: 'Book, part 1' })).toContainText('2 pages');
  await page.getByLabel('Select Book, part 1').check();
  await page.getByLabel('Select Book, part 2').check();
  const bar = page.getByRole('region', { name: '2 texts selected' });
  await bar.getByLabel('Name of the merged text').fill('Rejoined');
  await bar.getByRole('button', { name: 'Merge into a new text' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Rejoined' })).toContainText('3 pages');

  await page.getByLabel('Select Book', { exact: true }).check();
  await page.getByLabel('Select Rejoined').check();
  const bar2 = page.getByRole('region', { name: '2 texts selected' });
  await bar2.getByLabel('Status').selectOption('reviewed');
  await bar2.getByRole('button', { name: 'Set status' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Rejoined' })).toContainText('reviewed');
  await expect(page.getByRole('listitem').filter({ hasText: /^Book3 pages/ }).or(page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Book', exact: true }) }))).toContainText('reviewed');

  await page.getByLabel('Select Book, part 1').check();
  await page.getByLabel('Select Book, part 2').check();
  await page.getByRole('region', { name: '2 texts selected' }).getByRole('button', { name: 'Delete selected' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete 2 texts?' });
  await expect(dialog).toContainText('“Book, part 1”, “Book, part 2”');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('a.doc-title')).toHaveCount(4);
  await page.getByRole('region', { name: '2 texts selected' }).getByRole('button', { name: 'Delete selected' }).click();
  await dialog.getByRole('button', { name: 'Delete selected' }).click();
  await expect(page.locator('a.doc-title')).toHaveText(['Book', 'Rejoined']);
});
