import { describe, expect, it } from 'vitest';
import { nextZoom, pageAtOffset } from '../src/components/SourcePdfPane.jsx';

describe('source PDF pane', () => {
  const html = '<section data-page="1"><p>One</p></section>\n<section class="x" data-page="2"><p>Two</p></section>';
  it('the page at a cursor offset is the last section opened before it', () => {
    expect(pageAtOffset(html, 0)).toBeNull();
    expect(pageAtOffset(html, html.indexOf('One'))).toBe(1);
    expect(pageAtOffset(html, html.indexOf('Two'))).toBe(2);
    expect(pageAtOffset('<p>no pages</p>', 10)).toBeNull();
    expect(pageAtOffset(null, 3)).toBeNull();
  });
  it('zoom steps through fixed levels and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(0.5, -1)).toBe(0.5);
    expect(nextZoom(4, 1)).toBe(4);
    expect(nextZoom(1.1, 1)).toBe(1.25); // an unknown level steps from fit-width
  });
});
