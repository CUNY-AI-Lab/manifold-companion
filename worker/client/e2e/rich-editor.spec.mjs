// The visual editor of PDF texts: allowlisted schema, TeX atoms with KaTeX, paste through the schema, source view as a toggle.
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
// Line start and end keys differ by platform (on macOS, End scrolls; Cmd+Arrow moves the caret).
const MAC = process.platform === 'darwin';
const END = MAC ? 'Meta+ArrowRight' : 'End';
const SHIFT_HOME = MAC ? 'Meta+Shift+ArrowLeft' : 'Shift+Home';
const DOC = '<section data-page="7"><h2>Identities</h2><p>The identity \\(\\sin^2 t + \\cos^2 t = 1\\) holds.</p><ol start="31"><li>\\(f(x) = 2x\\)</li><li>Second item</li></ol><table class="equation-table"><caption>Table 1</caption><tbody><tr><td>\\[x^2\\]</td><td>a</td></tr></tbody></table><figure class="needs-image"><figcaption>Figure: a unit circle</figcaption></figure><p>See <a href="https://example.org/">the notes</a>.</p></section>';

async function openText(page, html, name = 'Visual') {
  const api = apiOf(page);
  const project = (await api('/projects', 'POST', { name, project_type: 'pdf_to_html' })).project;
  const text = (await api(`/projects/${project.id}/texts`, 'POST', { name: 'Chapter' })).text;
  await api(`/texts/${text.id}/html`, 'PUT', { html_content: html });
  const stored = (await api(`/texts/${text.id}/html`)).html_content;
  await page.goto(`/manifold-companion/texts/${text.id}`);
  return { api, text, stored };
}

function watch(page) {
  const problems = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
  return problems;
}

test('opens real structure in the visual editor; unchanged until edited; an edit saves only what changed', async ({ page, context }) => {
  await as(context, 'carol');
  const problems = watch(page);
  await page.goto('/manifold-companion/');
  const { api, text, stored } = await openText(page, DOC);
  const editor = page.locator('.mc-editor');
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  await expect(editor.getByRole('heading', { name: 'Identities' })).toBeVisible();
  await expect(editor.locator('.mc-math .katex')).toHaveCount(3);
  await expect(editor.locator('.mc-math-display')).toHaveCount(1);
  await expect(editor.locator('ol')).toHaveAttribute('start', '31');
  await expect(editor.locator('caption')).toHaveText('Table 1');
  await expect(editor.locator('.mc-needs-image figcaption')).toHaveText('Figure: a unit circle');
  await expect(editor.locator('a[href="https://example.org/"]')).toHaveText('the notes');
  // The app's ids and classes are never taken from the document.
  expect(await editor.locator('[class*="equation-table"]').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  expect((await new AxeBuilder({ page }).withTags(TAGS).setLegacyMode(true).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

  // Type at the end of the first paragraph, then undo it: back to exactly the stored HTML (not dirty).
  await editor.getByText('holds.').click();
  await page.keyboard.press(END);
  await page.keyboard.type(' Always');
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeEnabled();
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('Backspace');
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();

  // Bold from the keyboard, then save.
  await page.keyboard.type(' Always');
  await editor.getByText('holds. Always').click({ clickCount: 3 }); // the whole paragraph
  await page.keyboard.press('ControlOrMeta+b');
  await page.getByRole('button', { name: 'Save HTML' }).click();
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  const saved = (await api(`/texts/${text.id}/html`)).html_content;
  expect(saved).toContain('<strong>The identity \\(\\sin^2 t + \\cos^2 t = 1\\) holds. Always</strong>');
  // Everything else is as stored: the TeX, the list start, the table caption, the placeholder, the link.
  for (const part of ['<ol start="31"><li>\\(f(x) = 2x\\)</li><li>Second item</li></ol>', '<caption>Table 1</caption>', '<td>\\[x^2\\]</td>', '<figure class="needs-image"><figcaption>Figure: a unit circle</figcaption></figure>', '<a href="https://example.org/" rel="noopener noreferrer nofollow">the notes</a>']) expect(saved).toContain(part);
  expect(stored).toContain('<ol start="31">');
  expect(problems).toEqual([]);
});

test('a formula opens its TeX with a live preview; a broken one is repaired; the toolbar works from the keyboard', async ({ page, context }) => {
  await as(context, 'carol');
  const problems = watch(page);
  await page.goto('/manifold-companion/');
  const { api, text } = await openText(page, '<p>Before \\(a+b\\) after.</p>', 'Formulas');
  const editor = page.locator('.mc-editor');
  await editor.locator('.mc-math').click();
  const dialog = page.getByRole('dialog', { name: 'Edit formula' });
  const tex = dialog.getByLabel('TeX');
  await expect(tex).toHaveValue('a+b');
  await tex.fill('\\frac{1}{');
  await expect(dialog.getByRole('status')).toContainText('KaTeX cannot read this');
  await dialog.getByRole('button', { name: 'Repair this formula' }).click();
  await expect(tex).toHaveValue('\\frac{1}{2}');
  await expect(dialog.getByRole('status')).toHaveText('KaTeX reads this formula.');
  await expect(dialog.locator('.mc-math-preview .katex .mfrac')).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator('.mc-math .mfrac')).toBeVisible();

  // Keyboard: Tab reaches the toolbar once; arrows move inside it; focus is visible.
  await page.getByRole('button', { name: 'HTML source', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  let tries = 0;
  while (!(await page.evaluate(() => document.activeElement?.closest('[role="toolbar"]') !== null)) && tries < 10) { await page.keyboard.press('Tab'); tries += 1; }
  const focused = () => page.evaluate(() => (document.activeElement?.tagName === 'SELECT' ? 'SELECT' : document.activeElement?.querySelector('.sr-only')?.textContent));
  expect(await focused()).toBe('SELECT');
  await page.keyboard.press('ArrowRight');
  expect(await focused()).toBe('Bold');
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, parseFloat(s.outlineWidth)]; });
  expect(ring[0]).not.toBe('none');
  expect(ring[1]).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('End'); // inside the toolbar, End is the last control (the toolbar's own key)
  expect(await focused()).toBe('Redo');
  // Insert a formula from the toolbar with the keyboard.
  await editor.getByText('after.').click();
  await page.keyboard.press(END);
  await page.keyboard.type('!');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  const insert = page.getByRole('dialog', { name: 'Insert a formula' });
  await insert.getByLabel('TeX').fill('\\pi r^2');
  await insert.getByRole('button', { name: 'Insert' }).click();
  await page.getByRole('button', { name: 'Save HTML' }).click();
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  expect((await api(`/texts/${text.id}/html`)).html_content).toBe('<p>Before \\(\\frac{1}{2}\\) after.!\\(\\pi r^2\\)</p>');
  expect(problems).toEqual([]);
});

test('paste goes through the schema: no script, no foreign image, no javascript: link; text, bold and TeX survive', async ({ page, context }) => {
  await as(context, 'carol');
  const problems = watch(page);
  await page.goto('/manifold-companion/');
  const { api, text } = await openText(page, '<p>Start.</p>', 'Paste');
  const editor = page.locator('.mc-editor');
  await editor.getByText('Start.').click();
  await page.keyboard.press('End');
  const pasted = '<script>window.__pwned = 1</script><img src="https://evil.example/x.png" onerror="window.__pwned = 2"><p>Safe <strong>bold</strong> \\(x^2\\) and <a href="javascript:window.__pwned=3">a bad link</a> <a href="https://example.org">a good one</a></p><iframe srcdoc="<script>parent.__pwned=4</script>"></iframe><p style="color:red" onclick="window.__pwned=5">styled</p>';
  await page.evaluate((html) => {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', 'fallback');
    document.querySelector('.mc-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, pasted);
  await expect(editor).toContainText('Safe bold');
  await expect(editor.locator('strong')).toHaveText('bold');
  await expect(editor.locator('.mc-math .katex')).toHaveCount(1);
  await expect(editor.locator('a[href="https://example.org"]')).toHaveText('a good one');
  expect(await editor.locator('script, iframe, img, a[href^="javascript"], [onclick], [style*="color"]').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await page.getByRole('button', { name: 'Save HTML' }).click();
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  const saved = (await api(`/texts/${text.id}/html`)).html_content;
  expect(saved).toContain('<strong>bold</strong> \\(x^2\\)');
  expect(saved).not.toMatch(/script|iframe|<img|javascript|onclick|onerror|style=/i);
  expect(problems).toEqual([]);
});

test('a document the editor cannot hold opens as source with a notice, and nothing is lost', async ({ page, context }) => {
  await as(context, 'carol');
  await page.goto('/manifold-companion/');
  const html = '<p>Defined terms:</p><dl><dt>Term</dt><dd>Meaning</dd></dl><p><math><mi>x</mi></math></p>';
  const { api, text, stored } = await openText(page, html, 'Unrepresentable');
  await expect(page.getByRole('status').filter({ hasText: 'that the visual editor cannot show' })).toContainText('MathML formulas, a definition list');
  await expect(page.getByLabel(/^HTML/)).toHaveValue(stored);
  await expect(page.getByRole('button', { name: 'HTML source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Fixing it in the source lets the visual editor open it.
  await page.getByLabel(/^HTML/).fill('<p>Defined terms: Term, Meaning.</p>');
  await page.getByRole('button', { name: 'Visual editor' }).click();
  await expect(page.locator('.mc-editor')).toContainText('Defined terms: Term, Meaning.');
  await page.getByRole('button', { name: 'Save HTML' }).click();
  await expect(page.getByRole('button', { name: 'Save HTML' })).toBeDisabled();
  expect((await api(`/texts/${text.id}/html`)).html_content).toBe('<p>Defined terms: Term, Meaning.</p>');
});
