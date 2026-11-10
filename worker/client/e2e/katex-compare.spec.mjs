// Renders every fixture formula twice and compares pixels:
//   legacy: the legacy client's KaTeX setup (repository root node_modules/katex,
//           katex.min.css with its font URLs, auto-render with the legacy
//           options {delimiters \[ \] and \( \), throwOnError false, trust true,
//           strict false}) inside the legacy .pdf-preview-pane rules verbatim
//           from client/src/index.css;
//   new:    the new client's sandboxed srcdoc preview, built by the same
//           functions the app uses (previewBody, facesNeeded, katexStylesheet,
//           wrapPreview) in an iframe with sandbox="" under the app's page CSP.
// Images and a report go to the scratchpad for the owner to look at.
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { previewBody, wrapPreview } from '../src/lib/preview.js';
import { facesNeeded, katexStylesheet } from '../src/lib/math.js';

const here = import.meta.dirname;
const repo = resolve(here, '../../..');
const fixture = JSON.parse(readFileSync(join(here, '../test/fixtures/formulas.json'), 'utf8'));
const OUT = process.env.KATEX_COMPARE_OUT ?? '/private/tmp/claude-501/-Users-veritas44/6baba7e7-4a09-49f3-9f44-2c71dcfbdb3f/scratchpad/katex-compare';
const LEGACY_KATEX = join(repo, 'node_modules/katex/dist');
const NEW_KATEX = join(here, '../node_modules/katex/dist');
const PAGE_CSP = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cell = (f, i) => `<p class="cell" id="f${i}">${esc(f.display ? `\\[${f.tex}\\]` : `\\(${f.tex}\\)`)}</p>`;
const cells = fixture.formulas.map(cell).join('\n');

function legacyPage() {
  const css = readFileSync(join(repo, 'client/src/index.css'), 'utf8').split('\n').slice(124, 505).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/katex/katex.min.css">
<style>html{font-size:16px}body{margin:0;background:#fff}.pdf-preview-pane{padding:1.5rem;background:#fff}${css}</style>
<script src="/katex/katex.min.js"></script><script src="/katex/contrib/auto-render.min.js"></script></head>
<body><div class="pdf-preview-pane">${cells}</div>
<script>renderMathInElement(document.body,{delimiters:[{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false}],throwOnError:false,trust:true,strict:false});document.fonts.ready.then(()=>{document.body.dataset.done='1'});</script></body></html>`;
}

async function newSrcdoc() {
  const cssText = readFileSync(join(NEW_KATEX, 'katex.min.css'), 'utf8');
  const { body } = previewBody({ html: cells });
  const faces = facesNeeded(cssText, body);
  const uri = (file) => `data:font/woff2;base64,${readFileSync(join(NEW_KATEX, 'fonts', file)).toString('base64')}`;
  return { doc: wrapPreview(body, katexStylesheet(cssText, faces, uri)), faces: faces.map((f) => f.file) };
}

/** Boxes of every leaf glyph and SVG of each formula, relative to its cell (CSS px). */
const layout = (root) => root.evaluate((cellEl) => {
  const origin = cellEl.getBoundingClientRect();
  return [...cellEl.querySelectorAll('.katex-html span, .katex-html svg')]
    .filter((n) => n.tagName === 'svg' || (n.children.length === 0 && n.textContent.trim()))
    .map((n) => { const r = n.getBoundingClientRect(); return [r.x - origin.x, r.y - origin.y, r.width, r.height]; });
});
const maxDelta = (a, b) => (a.length !== b.length ? Infinity : Math.max(0, ...a.flatMap((box, k) => box.map((v, j) => Math.abs(v - b[k][j])))));

async function serve(page) {
  await page.route('http://legacy.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: legacyPage() });
    const file = join(LEGACY_KATEX, path.replace(/^\/katex\//, ''));
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    return route.fulfill({ contentType: type, body: readFileSync(file) });
  });
}

/** Pixel difference of two PNGs, computed in the browser (no image library needed). */
async function diff(page, a, b) {
  return page.evaluate(async ([pa, pb]) => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [ia, ib] = await Promise.all([load(pa), load(pb)]);
    const w = Math.max(ia.width, ib.width);
    const h = Math.max(ia.height, ib.height);
    const draw = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = draw(ia);
    const db = draw(ib);
    const out = new OffscreenCanvas(w, h);
    const ox = out.getContext('2d');
    const od = ox.createImageData(w, h);
    // strict: any channel differs by more than 48 at the same pixel.
    // shifted: differs only if no pixel within one device pixel in the other image is within 48
    // (tolerates the sub-pixel layout shifts two documents can produce with identical fonts).
    const close = (d1, i, d2, j) => Math.max(Math.abs(d1[i] - d2[j]), Math.abs(d1[i + 1] - d2[j + 1]), Math.abs(d1[i + 2] - d2[j + 2])) <= 48;
    const nearMatch = (d1, d2, x, y) => {
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (close(d1, (y * w + x) * 4, d2, (yy * w + xx) * 4)) return true;
      }
      return false;
    };
    let differing = 0;
    let strict = 0;
    let inked = 0;
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (da[i] < 200 || db[i] < 200) inked += 1;
      if (!close(da, i, db, i)) strict += 1;
      const bad = !nearMatch(da, db, x, y) || !nearMatch(db, da, x, y);
      if (bad) { differing += 1; od.data[i] = 220; od.data[i + 1] = 0; od.data[i + 2] = 0; od.data[i + 3] = 255; }
      else { const g = 255 - (255 - Math.min(da[i], db[i])) * 0.25; od.data[i] = g; od.data[i + 1] = g; od.data[i + 2] = g; od.data[i + 3] = 255; }
    }
    ox.putImageData(od, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const png = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    return { width: w, height: h, sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], differing, strict, inked, ratioOfInk: inked ? differing / inked : 0, strictRatioOfInk: inked ? strict / inked : 0, png };
  }, [a, b]);
}

test('on-screen maths: legacy KaTeX vs the new sandboxed preview', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const problems = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused/i.test(m.text())) problems.push(m.text()); });
  await serve(page);
  await page.goto('http://legacy.test/');
  await expect(page.locator('body[data-done="1"]')).toHaveCount(1);
  const legacyErrors = await page.locator('.katex-error').count();

  const legacyShots = [];
  const legacyLayout = [];
  for (let i = 0; i < fixture.formulas.length; i += 1) {
    legacyShots.push(await page.locator(`#f${i}`).screenshot());
    legacyLayout.push(await layout(page.locator(`#f${i}`)));
  }

  const { doc, faces } = await newSrcdoc();
  await page.route('http://new.test/**', (route) => route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': PAGE_CSP }, body: '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{border:0;width:100%;height:30000px;display:block}</style></head><body><iframe id="p" sandbox="" title="preview"></iframe></body></html>' }));
  await page.goto('http://new.test/');
  await page.locator('#p').evaluate((el, d) => { el.srcdoc = d; }, doc);
  const frame = page.frameLocator('#p');
  await expect(frame.locator(`#f${fixture.formulas.length - 1} .katex`)).toHaveCount(1);
  await frame.locator('body').evaluate(() => document.fonts.ready);
  const sandbox = await page.locator('#p').getAttribute('sandbox');
  const newErrors = await frame.locator('.katex-error').count();
  const rows = [];
  for (let i = 0; i < fixture.formulas.length; i += 1) {
    const shot = await frame.locator(`#f${i}`).screenshot();
    const layoutDelta = maxDelta(legacyLayout[i], await layout(frame.locator(`#f${i}`)));
    const a = `data:image/png;base64,${legacyShots[i].toString('base64')}`;
    const b = `data:image/png;base64,${shot.toString('base64')}`;
    const d = await diff(page, a, b);
    const n = String(i).padStart(2, '0');
    writeFileSync(join(OUT, `${n}-legacy.png`), legacyShots[i]);
    writeFileSync(join(OUT, `${n}-new.png`), shot);
    writeFileSync(join(OUT, `${n}-diff.png`), Buffer.from(d.png.split(',')[1], 'base64'));
    rows.push({ i, tex: fixture.formulas[i].tex, display: fixture.formulas[i].display, from: fixture.formulas[i].from, sizeLegacy: d.sizeA, sizeNew: d.sizeB, differingPixels: d.differing, strictDifferingPixels: d.strict, inkPixels: d.inked, ratioOfInk: Number(d.ratioOfInk.toFixed(4)), strictRatioOfInk: Number(d.strictRatioOfInk.toFixed(4)), glyphBoxes: legacyLayout[i].length, maxLayoutDeltaPx: Number(layoutDelta.toFixed(3)) });
  }
  const worst = [...rows].sort((x, y) => y.ratioOfInk - x.ratioOfInk);
  const summary = { formulas: rows.length, maxLayoutDeltaPx: Math.max(...rows.map((r) => r.maxLayoutDeltaPx)), glyphBoxesCompared: rows.reduce((n, r) => n + r.glyphBoxes, 0), identicalWithinOnePixel: rows.filter((r) => r.differingPixels === 0).length, pixelIdentical: rows.filter((r) => r.strictDifferingPixels === 0).length, maxStrictRatioOfInk: Math.max(...rows.map((r) => r.strictRatioOfInk)), sameSize: rows.filter((r) => r.sizeLegacy.join() === r.sizeNew.join()).length, meanRatioOfInk: Number((rows.reduce((s, r) => s + r.ratioOfInk, 0) / rows.length).toFixed(4)), maxRatioOfInk: worst[0].ratioOfInk, legacyKatexErrors: legacyErrors, newKatexErrors: newErrors, iframeSandbox: sandbox, facesEmbedded: faces, cspViolations: problems };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, rows }, null, 2));
  const tr = rows.map((r) => `<tr><td>${r.i}</td><td><code>${esc(r.tex)}</code></td><td><img src="${String(r.i).padStart(2, '0')}-legacy.png"></td><td><img src="${String(r.i).padStart(2, '0')}-new.png"></td><td><img src="${String(r.i).padStart(2, '0')}-diff.png"></td><td>layout max ${r.maxLayoutDeltaPx} CSS px over ${r.glyphBoxes} boxes<br>${r.differingPixels} px beyond a 1 px shift (${(r.ratioOfInk * 100).toFixed(2)}% of ink); strict ${r.strictDifferingPixels} px</td></tr>`).join('');
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>KaTeX: legacy vs new</title><style>body{font:14px system-ui;margin:1rem}td{border:1px solid #ccc;padding:4px;vertical-align:top}img{max-width:420px}</style><h1>On-screen maths: legacy vs new preview</h1><pre>${esc(JSON.stringify(summary, null, 1))}</pre><table><tr><th>#</th><th>TeX</th><th>legacy</th><th>new</th><th>diff (red = differs beyond a one-pixel shift)</th><th>difference</th></tr>${tr}</table>`);
  console.log(JSON.stringify(summary));

  expect(sandbox).toBe('');
  expect(problems).toEqual([]);
  expect(newErrors).toBe(0);
  expect(legacyErrors).toBe(0);
  expect(summary.sameSize).toBe(rows.length);
  // Pass/fail is geometric: every glyph and radical box within a quarter CSS pixel of legacy.
  // The pixel figures are reported (Chromium rasterises a 1/32 px offset differently, notably SVG radicals).
  expect(summary.maxLayoutDeltaPx).toBeLessThan(0.25);
});
