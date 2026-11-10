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
  const confirmDialog = page.getByRole('alertdialog', { name: 'Transfer ownership?' });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmDialog).toHaveCount(0);
  await expect(makeOwner).toBeFocused();
  await expect(page.getByRole('heading', { name: /Shared project/ })).toBeVisible();

  await makeOwner.click();
  await confirmDialog.getByRole('button', { name: 'Make Bob the owner' }).click();
  await expect(share).toHaveCount(0);
  await expect(page.getByText('you are a editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);

  await bob.page.goto(projectUrl);
  await expect(bob.page.getByText('you are the owner')).toBeVisible();
  await expect(bob.page.getByRole('button', { name: 'Share' })).toBeVisible();
  await carol.page.goto(projectUrl);
  await expect(carol.page.getByText('you are a editor')).toBeVisible();
  await bob.context.close();
  await carol.context.close();
});
