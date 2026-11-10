import { describe, expect, it } from 'vitest';
import { chunkText, stopsRun } from '../src/lib/tasks.js';
import { fitWithin, rotatedSize } from '../src/lib/image.js';
import { previewDocument } from '../src/lib/preview.js';

describe('client helpers', () => {
  it('chunks text under the per-request cap on paragraph boundaries', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(60)).join('\n\n');
    const chunks = chunkText(text, 3000);
    expect(chunks.every((c) => c.length <= 3000)).toBe(true);
    expect(chunks.join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
    expect(chunkText('x'.repeat(25000), 10000).every((c) => c.length <= 10000)).toBe(true);
  });
  it('a quota or availability error stops a run; a per-page model error does not', () => {
    expect(stopsRun({ code: 'quota_exceeded', status: 429 })).toBe(true);
    expect(stopsRun({ status: 503, code: 'upstream_unavailable' })).toBe(true);
    expect(stopsRun({ name: 'AbortError' })).toBe(true);
    expect(stopsRun({ status: 422, code: 'model_output_truncated' })).toBe(false);
  });
  it('resizes without upscaling and swaps sides for quarter turns', () => {
    expect(fitWithin(4096, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(rotatedSize(800, 600, 90)).toEqual({ width: 600, height: 800 });
  });
  it('previews carry their own restrictive CSP and no script', () => {
    const doc = previewDocument({ markdown: '# Title\n\n$$a+b$$', images: {} });
    expect(doc).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
    expect(doc).toContain('<h1>Title</h1>');
    expect(doc).toContain('class="katex-display"');
    expect(doc).not.toMatch(/<script/i);
    expect(previewDocument({ html: '<img src="f.png">', images: { 'f.png': 'data:image/png;base64,AA' } })).toContain('src="data:image/png;base64,AA"');
  });
});
