import { describe, expect, it } from 'vitest';
import { SHORTCUTS, applies, isTypingTarget, keyLabel, matches } from '../src/lib/shortcuts.js';

const key = (k, mods = {}, target = { tagName: 'BODY' }) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, ...mods });
const by = (id) => SHORTCUTS.find((s) => s.id === id);

describe('keyboard shortcuts', () => {
  it('Mod is Ctrl or Cmd; Shift and Alt must match', () => {
    expect(matches(key('s', { ctrlKey: true }), 'Mod+S')).toBe(true);
    expect(matches(key('s', { metaKey: true }), 'Mod+S')).toBe(true);
    expect(matches(key('S', { metaKey: true, shiftKey: true }), 'Mod+S')).toBe(false);
    expect(matches(key('S', { metaKey: true, shiftKey: true }), 'Mod+Shift+S')).toBe(true);
    expect(matches(key('s'), 'Mod+S')).toBe(false);
    expect(matches(key('s', { ctrlKey: true, altKey: true }), 'Mod+S')).toBe(false);
    expect(matches(key('?', { shiftKey: true }), '?')).toBe(true);
    expect(matches(key('n'), 'N')).toBe(true);
    expect(matches(key('N', { shiftKey: true }), 'N')).toBe(false);
    expect(matches(key('Escape'), 'Escape')).toBe(true);
  });

  it('single-key shortcuts never fire while typing and can be turned off (WCAG 2.1.4); Mod ones work in fields', () => {
    const field = { tagName: 'TEXTAREA' };
    expect(applies(by('next-page'), key('n'), { singleKeysOn: true })).toBe(true);
    expect(applies(by('next-page'), key('n', {}, field), { singleKeysOn: true })).toBe(false);
    expect(applies(by('next-page'), key('n'), { singleKeysOn: false })).toBe(false);
    expect(applies(by('help'), key('?', {}, { tagName: 'INPUT', type: 'search' }), { singleKeysOn: true })).toBe(false);
    expect(applies(by('save'), key('s', { ctrlKey: true }, field), { singleKeysOn: false })).toBe(true);
    for (const s of SHORTCUTS) if (!s.keys.includes('Mod') && s.keys.length === 1) expect(s.single, s.id).toBe(true);
  });

  it('knows a text field, an editable region and a select from a checkbox or a button', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('labels keys for the platform', () => {
    expect(keyLabel('Mod+Shift+S', false)).toBe('Ctrl+Shift+S');
    expect(keyLabel('Mod+S', true)).toBe('⌘ S');
    expect(keyLabel('?', true)).toBe('?');
  });
});
