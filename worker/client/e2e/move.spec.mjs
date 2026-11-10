// Moving texts to another project, through the real Worker.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:8790';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const as = (context, who) => context.addCookies([{ name: 'e2e_as', value: who, url: ORIGIN }]);
const apiOf = (page) => async (path, method = 'GET', data) => {
  const r = await page.request.fetch(`/manifold-companion/api${path}`, { method, headers: { Origin: ORIGIN, 'content-type': 'application/json' }, ...(data === undefined ? {} : { data }) });
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
  return r.json();
};

test('move texts to another project: the dialog says what goes, what is deleted and whose storage it becomes', async ({ page, context, browser }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const api = apiOf(page);
  const source = (await api('/projects', 'POST', { name: 'Move from' })).project;
  const png = readFileSync('e2e/fixtures/page.png');
  const texts = [];
  for (const name of ['Letter one', 'Letter two', 'Letter three']) {
    const t = (await api(`/projects/${source.id}/texts`, 'POST', { name })).text;
    const up = await page.request.fetch(`/manifold-companion/api/texts/${t.id}/pages?filename=p.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
    expect(up.ok()).toBe(true);
    texts.push(t);
  }
  await api(`/texts/${texts[0].id}/annotations`, 'POST', { anchor_type: 'global', body: 'A comment for this project.' });
  // The destination belongs to bob, who made carol an editor: storage changes hands.
  const other = await browser.newContext();
  await other.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  const bobPage = await other.newPage();
  await bobPage.goto('/manifold-companion/');
  const bobApi = apiOf(bobPage);
  const dest = (await bobApi('/projects', 'POST', { name: "Bob's anthology" })).project;
  const inv = (await bobApi(`/projects/${dest.id}/invites`, 'POST', { role: 'editor' })).invite;
  await page.goto(`/manifold-companion/invite#t=${inv.token}`);
  await expect(page.getByText(/you are a editor/)).toBeVisible();
  // A PDF project is not offered (another kind), nor is a project carol only views.
  await api('/projects', 'POST', { name: 'Some PDFs', project_type: 'pdf_to_html' });

  await page.goto(`/manifold-companion/projects/${source.id}`);
  await page.getByLabel('Select Letter one').check();
  await page.getByLabel('Select Letter two').check();
  const bar = page.getByRole('region', { name: '2 texts selected' });
  const select = bar.getByLabel('Move to project');
  const options = await select.locator('option').allTextContents();
  expect(options).toContain("Bob's anthology");
  expect(options).not.toContain('Some PDFs');
  expect(options).not.toContain('Move from');
  await select.selectOption({ label: "Bob's anthology" });
  await bar.getByRole('button', { name: 'Move', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: "Move to “Bob's anthology”?" });
  await expect(dialog).toContainText('Move 2 texts (2 pages, 0 saved versions');
  await expect(dialog).toContainText('Their 1 comment will be deleted: comments stay with the project whose members they were written for.');
  await expect(dialog).toContainText("storage counts against the owner of “Bob's anthology”");
  const found = await new AxeBuilder({ page }).withTags(TAGS).setLegacyMode(true).analyze();
  expect(found.violations.map((v) => v.id)).toEqual([]);
  // Cancel keeps everything.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('ul.rowlist > li')).toHaveCount(3);
  await bar.getByRole('button', { name: 'Move', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: "Moved 2 texts to “Bob's anthology”." })).toBeVisible();
  await expect(page.locator('ul.rowlist > li')).toHaveCount(1);
  await expect(page.locator('ul.rowlist')).toContainText('Letter three');

  // They are in bob's project, with their pages; the old address is gone.
  await bobPage.goto(`/manifold-companion/projects/${dest.id}`);
  await expect(bobPage.getByRole('link', { name: 'Letter one' })).toBeVisible();
  await expect(bobPage.getByText('1 pages, pending').first()).toBeVisible();
  const moved = (await bobApi(`/projects/${dest.id}/texts`)).texts;
  expect(moved.map((t) => t.name)).toEqual(['Letter one', 'Letter two']);
  expect((await page.request.fetch(`/manifold-companion/api/texts/${texts[0].id}`)).status()).toBe(404);
  await other.close();
});
