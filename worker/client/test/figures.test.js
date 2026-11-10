import { describe, expect, it } from 'vitest';
import { parseFragment } from 'parse5';
import { sanitizeHtml } from '../../src/sanitize/html.ts';

/** Every element's attribute names, as a browser's parser sees them. */
const attrsOf = (html) => {
  const out = [];
  const walk = (n) => { if (n.attrs) out.push(...n.attrs.map((a) => `${n.tagName}.${a.name}`)); (n.childNodes ?? []).forEach(walk); };
  walk(parseFragment(html));
  return out;
};
import { altFromCaption, attachImage, cropPixels, figureName, findPlaceholders, toRgba } from '../src/lib/figures.js';

const DOC = `<section data-page="34"><p>Intro</p></section>
<section data-page="35">
    <figure class="needs-image">
        <figcaption>Figure: Graph of piecewise function for exercise 25</figcaption>
    </figure>
    <p>25.</p>
    <figure><img src="kept.png" alt="already there"><figcaption>Figure 2</figcaption></figure>
    <figure class="wide needs-image"><figcaption>Figure: &lt;b&gt;bold&lt;/b&gt; &amp; "quoted"</figcaption></figure>
</section>`;

describe('figure placeholders', () => {
  it('finds each placeholder with its page and plain-text caption, skipping figures that have an image', () => {
    const found = findPlaceholders(DOC);
    expect(found.map((p) => [p.n, p.page, p.caption])).toEqual([[0, 35, 'Figure: Graph of piecewise function for exercise 25'], [1, 35, 'Figure: <b>bold</b> & "quoted"']]);
    expect(findPlaceholders('<p>none</p>')).toEqual([]);
    expect(findPlaceholders('<figure class="needs-image"><figcaption>x</figcaption>')).toEqual([]); // unclosed
    expect(findPlaceholders('<figure class="needs-image"><figcaption>no page</figcaption></figure>')[0].page).toBeNull();
  });

  it('attaches an image to exactly that placeholder, escaped, and the result survives the sanitizer unchanged', () => {
    const one = attachImage(DOC, 1, { filename: 'p35-fig1.png', alt: altFromCaption('Figure: <b>bold</b> & "quoted"'), width: 640, height: 480 });
    expect(one).toContain('<figure class="wide"><img src="p35-fig1.png" alt="&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;" width="640" height="480"><figcaption>');
    expect(findPlaceholders(one)).toHaveLength(1);
    expect(findPlaceholders(one)[0].caption).toMatch(/exercise 25/);
    const both = attachImage(one, 0, { filename: 'p35-fig2.png', alt: 'Graph' });
    expect(findPlaceholders(both)).toEqual([]);
    expect(both).toContain('<figure><img src="p35-fig2.png" alt="Graph">');
    expect(sanitizeHtml(both)).toBe(sanitizeHtml(sanitizeHtml(both)));
    expect(sanitizeHtml(both)).toContain('<img src="p35-fig2.png" alt="Graph">');
    expect(attachImage(both, 0, { filename: 'x.png', alt: 'x' })).toBeNull();
  });

  it('a hostile file name or caption cannot break out of the attribute', () => {
    const html = attachImage('<figure class="needs-image"><figcaption>c</figcaption></figure>', 0, { filename: '" onerror="alert(1)', alt: '"><script>alert(1)</script>' });
    expect(attrsOf(html)).toEqual(['img.src', 'img.alt']);
    expect(attrsOf(sanitizeHtml(html))).toEqual(['img.src', 'img.alt']);
    expect(html).not.toMatch(/<script/);
  });

  it('names figures uniquely per text and crops in page fractions', () => {
    expect(figureName([], 7)).toBe('p7-fig1.png');
    expect(figureName(['p7-fig1.png', { filename: 'P7-FIG2.png' }], 7)).toBe('p7-fig3.png');
    expect(figureName([], null, 'jpg')).toBe('fig1.jpg');
    expect(cropPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1000, 2000)).toEqual({ x: 250, y: 1000, width: 500, height: 500 });
    expect(cropPixels({ x: 0.75, y: 0.75, w: -0.5, h: -0.5 }, 100, 100)).toEqual({ x: 25, y: 25, width: 50, height: 50 });
    expect(cropPixels({ x: -1, y: 2, w: 0, h: 0 }, 10, 10)).toEqual({ x: 0, y: 10, width: 1, height: 1 });
  });

  it('converts pdf.js image data to RGBA', () => {
    expect([...toRgba({ width: 1, height: 1, kind: 2, data: new Uint8Array([1, 2, 3]) })]).toEqual([1, 2, 3, 255]);
    expect([...toRgba({ width: 1, height: 1, kind: 3, data: new Uint8Array([1, 2, 3, 4]) })]).toEqual([1, 2, 3, 4]);
    // 1 bit per pixel, row padded to a byte: 10xxxxxx -> white, black
    expect([...toRgba({ width: 2, height: 1, kind: 1, data: new Uint8Array([0b10000000]) })]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(() => toRgba({ width: 1, height: 1, kind: 9, data: new Uint8Array(4) })).toThrow();
  });
});
