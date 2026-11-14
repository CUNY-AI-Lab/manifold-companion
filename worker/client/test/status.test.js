import { describe, expect, it } from 'vitest';
import { SETTABLE_STATUSES, STATUS_LABELS, plural, statusLabel } from '../src/lib/status.js';

describe('status labels', () => {
  it('every stored status has a label and none shows the stored word', () => {
    for (const s of ['pending', 'processing', 'ocrd', 'reviewed']) {
      expect(STATUS_LABELS[s]).toBeTruthy();
      expect(statusLabel(s)).not.toBe(s);
    }
    expect(statusLabel('ocrd')).toBe('OCR complete');
    expect(statusLabel('weird')).toBe('Unknown status');
    expect(SETTABLE_STATUSES).not.toContain('processing');
    expect([plural(1, 'page'), plural(3, 'page')]).toEqual(['1 page', '3 pages']);
  });
});
