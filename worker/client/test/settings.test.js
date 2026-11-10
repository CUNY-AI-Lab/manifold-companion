import { describe, expect, it } from 'vitest';
import { savedRunNote, settingsBody } from '../src/components/TextSettingsPanel.jsx';

describe('per-text settings form', () => {
  it('empty fields mean the defaults (null), numbers are numbers, the prompt only for image texts', () => {
    expect(settingsBody({ model: null, math_model: null, temperature: '', max_tokens: '', prompt: '  ' }, 'image')).toEqual([{ model: null, temperature: null, max_tokens: null, prompt: null }, null]);
    expect(settingsBody({ model: 'm', math_model: 'x', temperature: '0.4', max_tokens: '1500', prompt: 'Transcribe.' }, 'image')).toEqual([{ model: 'm', temperature: 0.4, max_tokens: 1500, prompt: 'Transcribe.' }, null]);
    expect(settingsBody({ model: 'm', math_model: 'x', temperature: '0', max_tokens: '8192', prompt: 'ignored' }, 'pdf')).toEqual([{ model: 'm', math_model: 'x', temperature: 0, max_tokens: 8192 }, null]);
  });
  it('refuses what the Worker would refuse, with a message', () => {
    for (const temperature of ['1.5', '-0.1', 'warm']) expect(settingsBody({ model: null, temperature, max_tokens: '', prompt: '' }, 'image')[1]).toMatch(/Temperature/);
    for (const max_tokens of ['0', '9000', '12.5']) expect(settingsBody({ model: null, temperature: '', max_tokens, prompt: '' }, 'image')[1]).toMatch(/Maximum length/);
  });
  it('a saved prompt, temperature or length is said next to the run controls', () => {
    expect(savedRunNote(null, 'image')).toBe('');
    expect(savedRunNote({ model: 'm' }, 'image')).toBe('');
    expect(savedRunNote({ prompt: 'Ignore the image.' }, 'image')).toMatch(/own transcription prompt/);
    expect(savedRunNote({ prompt: 'x' }, 'pdf')).toBe('');
    expect(savedRunNote({ temperature: 0.9, max_tokens: 1 }, 'pdf')).toMatch(/temperature 0\.9, at most 1 tokens/);
  });
});
