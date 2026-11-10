import { describe, expect, it } from 'vitest';
import { replaceWarning, versionLabel } from '../src/lib/versions.js';

describe('version wording', () => {
  it('names the action that replaced the content and who took it', () => {
    expect(versionLabel({ reason: 'ocr', created_by: 'me' }, 'me')).toBe('Before an OCR run by you');
    expect(versionLabel({ reason: 'save', created_by: 'b', author_name: 'Bob' }, 'me')).toBe('Before a manual save by Bob');
    expect(versionLabel({ reason: 'conversion', created_by: 'b', author_name: null }, 'me')).toBe('Before a PDF conversion by a collaborator');
    expect(versionLabel({ reason: 'restore', created_by: null }, 'me')).toBe('Before a restore by a former member');
    expect(versionLabel({ reason: null, created_by: 'me' }, 'me')).toBe('Earlier version by you');
  });
  it('every replacing action says the current text is kept as a version', () => {
    expect(replaceWarning('Convert this PDF and replace the current HTML?')).toMatch(/^Convert this PDF and replace the current HTML\? The current text will be saved as a version first; you can restore it from Version history\.$/);
  });
});
