import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ImageDecodeError, heicMessage, isHeic, prepareImage } from '../src/lib/image.js';
import { sortDropped } from '../src/hooks/useFileDrop.jsx';
import { takesAsPage } from '../src/pages/ImageTextPage.jsx';

const file = (name, type = '') => ({ name, type, size: 1 });

describe('dropped files', () => {
  it('a page upload takes images (by type or extension, HEIC included) and PDFs, nothing else', () => {
    const files = [file('a.jpg', 'image/jpeg'), file('scan.PDF'), file('IMG_1.HEIC'), file('b.webp'), file('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), file('x.zip', 'application/zip'), file('photo', 'image/png')];
    const { taken, refused } = sortDropped(files, takesAsPage);
    expect(taken.map((f) => f.name)).toEqual(['a.jpg', 'scan.PDF', 'IMG_1.HEIC', 'b.webp', 'photo']);
    expect(refused).toEqual(['notes.docx', 'x.zip']);
  });
});

describe('HEIC under the page CSP', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the HEIC converter library is gone: it needs eval, which the page policy refuses', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies.heic2any).toBeUndefined();
    expect(readFileSync(new URL('../src/lib/image.js', import.meta.url), 'utf8')).not.toMatch(/import\(['"]heic2any/);
  });

  it('a HEIC photo the browser cannot open is refused with a message that says what to do', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); }));
    const heic = file('IMG_0042.HEIC', 'image/heic');
    expect(isHeic(heic)).toBe(true);
    await expect(prepareImage(heic)).rejects.toMatchObject({ name: 'ImageDecodeError', code: 'heic_unsupported', message: heicMessage('IMG_0042.HEIC') });
    expect(heicMessage('x.heic')).toMatch(/cannot open.*JPEG.*Safari/s);
  });

  it('any other unreadable image gets its own message', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('bad'); }));
    const err = await prepareImage(file('broken.png', 'image/png')).catch((e) => e);
    expect(err).toBeInstanceOf(ImageDecodeError);
    expect(err.code).toBe('image_unreadable');
    expect(err.message).toMatch(/“broken\.png” could not be opened/);
  });

  it('a HEIC the browser does open (Safari) goes through the normal path', async () => {
    const bitmap = { width: 4000, height: 3000, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const ctx = { fillRect: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), set fillStyle(_) {} };
    const canvas = { getContext: () => ctx, toBlob: (cb) => cb({ size: 1000 }), width: 0, height: 0 };
    vi.stubGlobal('document', { createElement: () => canvas });
    const out = await prepareImage(file('IMG_1.HEIC', 'image/heic'));
    expect(out).toMatchObject({ width: 2048, height: 1536 });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' });
  });
});
