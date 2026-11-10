// axe WCAG 2.2 A/AA on every screen of the client, at desktop and phone
// widths, in light and dark, plus the dialogs. The sandboxed preview frames
// run no script, so axe cannot enter them; their content is the person's own
// document and is checked by the sanitizer tests instead.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:8790';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };

async function violations(page, label) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => ({ where: label, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(0, 2).join(' ')}`) }));
}

/** Data to look at: an image project with a page and a version, a PDF project with HTML and mathematics. */
async function seed(request) {
  const headers = { Origin: ORIGIN, 'content-type': 'application/json' };
  const post = async (path, body, method = 'POST') => {
    const r = await request.fetch(`/manifold-companion/api${path}`, { method, headers, data: body });
    expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
    return r.json();
  };
  await post('/profile', { display_name: 'Alice A', onboarded: true }, 'PUT');
  const image = (await post('/projects', { name: 'Letters a11y', project_type: 'image_to_markdown' })).project;
  const text = (await post(`/projects/${image.id}/texts`, { name: 'Letter one' })).text;
  await post(`/projects/${image.id}/texts`, { name: 'Letter two' });
  const png = readFileSync('e2e/fixtures/page.png');
  const up = await request.fetch(`/manifold-companion/api/texts/${text.id}/pages?filename=page.png&size=${png.length}`, { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'image/png' }, data: png });
  expect(up.ok(), `upload ${up.status()}`).toBe(true);
  const pageId = (await up.json()).page.id;
  await post(`/texts/${text.id}/pages/${pageId}`, { text: 'Dear friend,\n\nThe value is \\(x^2\\).' });
  await post(`/texts/${text.id}/pages/${pageId}`, { text: 'Dear friend,\n\nThe value is \\(x^3\\).' });
  const pdf = (await post('/projects', { name: 'Maths a11y', project_type: 'pdf_to_html' })).project;
  const htext = (await post(`/projects/${pdf.id}/texts`, { name: 'Chapter 7' })).text;
  await post(`/texts/${htext.id}/html`, { html_content: '<section data-page="1"><h2>Identities</h2><p>\\(\\sin^2\\theta + \\cos^2\\theta = 1\\)</p></section>' }, 'PUT');
  return { image: image.id, text: text.id, pdf: pdf.id, htext: htext.id };
}

let ids;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'e2e_as', value: 'carol', url: ORIGIN }]);
  const page = await context.newPage();
  await page.goto('/manifold-companion/');
  ids = await seed(page.request);
  await context.close();
});

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark']) {
    test(`axe WCAG A/AA: every screen, ${size}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'e2e_as', value: 'carol', url: ORIGIN }]);
      const page = await context.newPage();
      const found = [];
      const screens = [
        ['dashboard', '/manifold-companion/', page.getByRole('heading', { name: 'Your projects' })],
        ['image project', `/manifold-companion/projects/${ids.image}`, page.getByRole('heading', { name: 'Letters a11y' })],
        ['image text', `/manifold-companion/texts/${ids.text}`, page.getByLabel(/Text of page 1/)],
        ['pdf project', `/manifold-companion/projects/${ids.pdf}`, page.getByRole('heading', { name: 'Maths a11y' })],
        ['html text', `/manifold-companion/texts/${ids.htext}`, page.getByLabel(/^HTML/)],
        ['settings', '/manifold-companion/settings', page.getByRole('heading', { level: 1 })],
        ['notifications', '/manifold-companion/notifications', page.getByRole('heading', { level: 1 })],
        ['search', '/manifold-companion/search?q=friend', page.getByRole('heading', { level: 1 })],
        ['invite without a token', '/manifold-companion/invite', page.getByRole('heading', { level: 1 })],
        ['not found', '/manifold-companion/nowhere', page.getByRole('heading', { level: 1 })],
        ['help', '/manifold-companion/help', page.getByRole('heading', { name: 'Help', level: 1 })],
      ];
      for (const [label, url, ready] of screens) {
        await page.goto(url);
        await expect(ready).toBeVisible();
        if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
        found.push(...(await violations(page, label)));
      }
      // Open states: version history with a version shown, the export and share dialogs.
      await page.goto(`/manifold-companion/texts/${ids.text}`);
      await page.getByRole('button', { name: 'Version history of this page' }).click();
      await page.getByRole('button', { name: /^View/ }).first().click();
      await expect(page.locator('iframe[title^="Version from"]')).toBeVisible();
      found.push(...(await violations(page, 'version history open')));
      await page.goto(`/manifold-companion/projects/${ids.image}`);
      await page.getByRole('button', { name: 'Export' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      found.push(...(await violations(page, 'export dialog')));
      await page.goto(`/manifold-companion/projects/${ids.image}`);
      await page.getByRole('button', { name: 'Share' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      found.push(...(await violations(page, 'share dialog')));
      await context.close();
      // First run: a person with no projects sees the welcome and the rules.
      const fresh = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
      await fresh.addCookies([{ name: 'e2e_as', value: 'dave', url: ORIGIN }]);
      const first = await fresh.newPage();
      await first.goto('/manifold-companion/');
      await expect(first.getByRole('heading', { name: 'Welcome to Manifold Companion' })).toBeVisible();
      found.push(...(await violations(first, 'first run')));
      await fresh.close();
      expect(found, JSON.stringify(found, null, 1)).toEqual([]);
    });
  }
}

/** Press Tab until `target` has focus (it must be reachable by Tab), and check the focus is visible. */
async function tabTo(page, target, max = 80) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      const ring = await target.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
      expect(ring.style, 'focus must be visible').not.toBe('none');
      expect(ring.width).toBeGreaterThanOrEqual(2);
      return;
    }
  }
  throw new Error(`not reachable with Tab: ${target}`);
}

test('keyboard only: create, upload, read, correct, history, export dialog', async ({ page, context }) => {
  await context.addCookies([{ name: 'e2e_as', value: 'bob', url: ORIGIN }]);
  await page.goto('/manifold-companion/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  // The skip link is the first stop and moves focus past the header.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  await tabTo(page, page.getByRole('textbox', { name: 'Name', exact: true }));
  await page.keyboard.type('Keyboard project');
  await tabTo(page, page.getByRole('button', { name: 'Create project' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard project' })).toBeVisible();

  await tabTo(page, page.getByLabel('New text name'));
  await page.keyboard.type('Typed text');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Typed text' })).toBeVisible();

  await tabTo(page, page.getByRole('button', { name: 'Upload pages' }));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles('e2e/fixtures/page.png');
  await expect(page.getByRole('button', { name: /page\.jpg \(no text\)/ })).toBeVisible({ timeout: 30_000 });
  await tabTo(page, page.getByRole('button', { name: 'Read pages without text' }));
  await page.keyboard.press('Enter');
  const text = page.getByLabel(/Text of page 1/);
  await expect(text).toHaveValue(/Transcribed by the stub model\./, { timeout: 30_000 });

  await tabTo(page, text);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Typed with the keyboard.');
  await tabTo(page, page.getByRole('button', { name: 'Save page' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();

  await tabTo(page, page.getByRole('button', { name: 'Version history of this page' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Version history of this page' })).toHaveAttribute('aria-expanded', 'true');
  await tabTo(page, page.getByRole('button', { name: /^View/ }).first());
  await page.keyboard.press('Enter');
  await expect(page.locator('iframe[title^="Version from"]')).toBeVisible();

  await page.keyboard.press('Shift+Tab'); // back up past the frame if focus moved on
  await page.getByRole('link', { name: 'Back to project' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard project' })).toBeVisible();
  const exportButton = page.getByRole('button', { name: 'Export' });
  await tabTo(page, exportButton);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Export for Manifold' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  // Focus stays in the dialog: Shift+Tab from the first control wraps to the last.
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(exportButton).toBeFocused();
});
