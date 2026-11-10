import { afterEach, describe, expect, it, vi } from 'vitest';
import { katexStylesheetFor } from '../src/lib/katex-assets.js';
import { previewBody } from '../src/lib/preview.js';

// Doorway sends `cache-control: private, no-store` on every signed-in response,
// so the browser cache never holds the fonts: the page must keep them itself.
afterEach(() => vi.restoreAllMocks());

describe('KaTeX font inlining', () => {
  it('fetches each face once per page lifetime, however many previews render', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([119, 79, 70, 50]), { headers: { 'cache-control': 'private, no-store' } }));
    const { body } = previewBody({ html: '<p>\\(x^2 + \\mathbb{R}\\)</p>' });
    const first = await katexStylesheetFor(body);
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(first).toContain('data:font/woff2;base64,');
    for (let i = 0; i < 5; i += 1) expect(await katexStylesheetFor(body)).toBe(first);
    expect(fetchMock.mock.calls.length).toBe(calls);
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin' });
  });
  it('a failed font fetch is retried on the next render, not cached', async () => {
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (fail ? new Response('no', { status: 503 }) : new Response(new Uint8Array([1]))));
    const { body } = previewBody({ html: '<p>\\(\\mathscr{L}\\)</p>' });
    await expect(katexStylesheetFor(body)).rejects.toThrow('font_unavailable');
    fail = false;
    await expect(katexStylesheetFor(body)).resolves.toContain('data:font/woff2;base64,');
  });
});
