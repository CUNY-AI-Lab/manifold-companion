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
