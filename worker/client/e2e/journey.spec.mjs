// One journey against `wrangler dev` (real workerd, local D1 and R2) through
// the Doorway double, with ONLY the Gateway replaced by a stub Worker:
// create project -> upload image -> OCR a page -> edit -> invite -> export.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const ORIGIN = 'http://127.0.0.1:8790';
const as = (context, who) => context.addCookies([{ name: 'e2e_as', value: who, url: ORIGIN }]);
/**
 * KaTeX really drew with its own fonts inside the sandboxed frame: the
 * italic x is set in KaTeX_Math, that face is loaded in the frame's document,
 * and the glyph is the KaTeX width (the fallback serif italic x is narrower).
 */
async function expectKatexFonts(frame) {
  const glyph = frame.locator('.katex .katex-html .mathnormal').first();
  await expect(glyph).toBeVisible();
  const facts = await glyph.evaluate(async (el) => {
    await document.fonts.ready;
    const style = getComputedStyle(el);
    return {
      family: style.fontFamily,
      loaded: document.fonts.check(`italic ${style.fontSize} KaTeX_Math`) && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'KaTeX_Math' && f.status === 'loaded'),
      mainLoaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'KaTeX_Main' && f.status === 'loaded'),
      // The same letter in the fallback (what a missing font would show) has a different advance.
      ...(() => {
        const probe = document.createElement('span');
        probe.textContent = el.textContent;
        probe.style.cssText = `font: italic ${style.fontSize} serif; position: absolute; visibility: hidden`;
        document.body.appendChild(probe);
        const fallback = probe.getBoundingClientRect().width;
        probe.style.fontFamily = 'KaTeX_Math';
        const katexWidth = probe.getBoundingClientRect().width;
        probe.remove();
        return { width: el.getBoundingClientRect().width, fallback, katexWidth };
      })(),
    };
  });
  expect(facts.family).toContain('KaTeX_Math');
  expect(facts.loaded).toBe(true);
  expect(facts.mainLoaded).toBe(true);
  expect(Math.abs(facts.width - facts.katexWidth)).toBeLessThan(0.5);
  expect(Math.abs(facts.katexWidth - facts.fallback)).toBeGreaterThan(0.2);
}

function watchCsp(page) {
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|apply|connect|frame)/i.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
  return violations;
}

test('create project, upload, OCR, edit, invite, export', async ({ page, context, browser }) => {
  await as(context, 'alice');
  const violations = watchCsp(page);
  await page.goto('/manifold-companion/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByText(/not approved for it/).first()).toBeVisible();
  await page.getByLabel('Display name').fill('Alice A');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByLabel('Display name')).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Journey');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Journey' })).toBeVisible();
  const projectUrl = page.url();

  await page.getByLabel('New text name').fill('Chapter one');
  await page.getByRole('button', { name: 'Add text' }).click();
  await expect(page.getByRole('heading', { name: 'Chapter one' })).toBeVisible();

  await page.locator('input[type=file]').setInputFiles('e2e/fixtures/page.png');
  await expect(page.getByRole('button', { name: /page\.jpg \(no text\)/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('img', { name: 'Scan of page 1' })).toBeVisible();

  await page.getByRole('button', { name: 'Read pages without text' }).click();
  await expect(page.getByLabel(/Text of page 1/)).toHaveValue(/Transcribed by the stub model\./, { timeout: 30_000 });
  await expect(page.getByLabel(/Text of page 1/)).toBeVisible();
  await expect(page.getByText('read by stub-vision')).toBeVisible();

  await page.getByLabel(/Text of page 1/).fill('Edited by Alice.\n\n\\(x^2\\)');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();

  // The preview is a sandboxed srcdoc frame with no powers; maths is KaTeX, as in the legacy app.
  const frame = page.locator('iframe[title="Preview of page 1"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  const preview = page.frameLocator('iframe[title="Preview of page 1"]');
  await expect(preview.getByText('Edited by Alice.')).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(1);
  await expectKatexFonts(preview);

  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByLabel('Role').selectOption('editor');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const inviteUrl = await page.getByLabel('Invite link').inputValue();
  expect(inviteUrl).toMatch(/^http:\/\/127\.0\.0\.1:8790\/manifold-companion\/invite#t=[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: 'Close' }).click();

  // Bob, in his own browser session, redeems the link.
  const bobContext = await browser.newContext();
  await as(bobContext, 'bob');
  const bob = await bobContext.newPage();
  const bobViolations = watchCsp(bob);
  await bob.goto(inviteUrl);
  await expect(bob.getByRole('heading', { name: 'Journey' })).toBeVisible();
  await expect(bob.getByText('you are a editor')).toBeVisible();
  expect(new URL(bob.url()).hash).toBe('');
  await bobContext.close();

  await page.reload();
  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download ZIP' }).click()]);
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  expect(Object.keys(files)).toEqual(['text-01-chapter-one.md', 'manifest.yml']);
  expect(strFromU8(files['text-01-chapter-one.md'])).toContain('Edited by Alice.');
  expect(strFromU8(files['manifest.yml'])).toContain('title: "Journey"');

  expect(violations).toEqual([]);
  expect(bobViolations).toEqual([]);
});

test('a lost session makes exactly one full-page navigation to the launch path', async ({ page, context, request }) => {
  const before = (await (await request.get('/__e2e/launches')).json()).launches;
  await as(context, 'none');
  await page.goto('/manifold-companion/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  const after = (await (await request.get('/__e2e/launches')).json()).launches;
  expect(after - before).toBe(1);
});

test('PDF to HTML: pdf.js renders pages in the browser, math pages go to the math model, preview is sandboxed', async ({ page, context }) => {
  await as(context, 'alice');
  const violations = watchCsp(page);
  const parsed = [];
  page.on('request', (r) => { if (r.url().endsWith('/parse-page')) parsed.push(JSON.parse(r.postData())); });
  await page.goto('/manifold-companion/');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Math book');
  await page.getByLabel('Workflow').selectOption('pdf_to_html');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('New text name').fill('Lecture');
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByLabel('PDF file').setInputFiles('e2e/fixtures/two-pages.pdf');
  await page.getByLabel('Math or table pages').fill('2');
  await page.getByRole('button', { name: 'Convert PDF' }).click();
  await expect(page.getByLabel(/^HTML/)).toHaveValue(/Transcribed by the stub model/, { timeout: 60_000 });
  expect(parsed.map((p) => [p.page_number, p.math, p.image.slice(0, 23)])).toEqual([[1, false, 'data:image/jpeg;base64,'], [2, true, 'data:image/jpeg;base64,']]);
  expect(parsed[0].text_hint).toContain('Theorem one');
  await expect(page.locator('iframe[title="Preview of the HTML"]')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title="Preview of the HTML"]').getByText('Transcribed by the stub model.').first()).toBeVisible();
  const htmlPreview = page.frameLocator('iframe[title="Preview of the HTML"]');
  await expect(htmlPreview.locator('.katex-display')).toHaveCount(2); // one display formula per page
  await expect(htmlPreview.locator('.katex .katex-error')).toHaveCount(0);
  await expectKatexFonts(htmlPreview);
  expect(violations).toEqual([]);
});
