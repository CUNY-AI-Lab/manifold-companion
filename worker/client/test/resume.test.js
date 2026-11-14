import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pdfFingerprint } from '../src/lib/tasks.js';

describe('resume fingerprint', () => {
  it('is a SHA-256 of the bytes, in the form the server accepts, and differs between PDFs', async () => {
    const a = new Blob([new Uint8Array([37, 80, 68, 70, 1, 2, 3])]);
    const b = new Blob([new Uint8Array([37, 80, 68, 70, 1, 2, 4])]);
    const fa = await pdfFingerprint(a);
    expect(fa).toBe(`sha256-${createHash('sha256').update(Buffer.from([37, 80, 68, 70, 1, 2, 3])).digest('hex').slice(0, 40)}`);
    expect(fa).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
    expect(await pdfFingerprint(b)).not.toBe(fa);
  });
});
