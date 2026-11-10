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
