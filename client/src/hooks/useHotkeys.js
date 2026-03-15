import { useEffect, useRef } from 'react';

// Global registry for KeyboardShortcuts modal to read
const registry = new Map();
let registryId = 0;

export function getRegisteredShortcuts() {
  const sections = {};
  for (const entry of registry.values()) {
    for (const shortcut of entry) {
      const section = shortcut.section || 'General';
      if (!sections[section]) sections[section] = [];
      sections[section].push({ combo: shortcut.combo, label: shortcut.label });
    }
  }
  return sections;
}

const isMac = () => {
  try {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return /mac/i.test(platform);
  } catch {
    return false;
  }
};

function parseCombo(combo) {
  const parts = combo.toLowerCase().split('+').map(s => s.trim());
  const result = { key: '', meta: false, ctrl: false, shift: false, alt: false };
  for (const part of parts) {
    if (part === 'cmd' || part === 'meta') {
      if (isMac()) result.meta = true; else result.ctrl = true;
    } else if (part === 'ctrl') { result.ctrl = true; }
    else if (part === 'shift') { result.shift = true; }
    else if (part === 'alt' || part === 'option') { result.alt = true; }
    else { result.key = part; }
  }
  return result;
}

function matchesEvent(parsed, e) {
  const eventKey = e.key.toLowerCase();
  const keyMap = {
    'arrowleft': 'arrowleft', '\u2190': 'arrowleft',
    'arrowright': 'arrowright', '\u2192': 'arrowright',
    'escape': 'escape', 'esc': 'escape',
    'enter': 'enter',
  };
  const normalizedParsed = keyMap[parsed.key] || parsed.key;
  const normalizedEvent = keyMap[eventKey] || eventKey;

  if (/^\d$/.test(parsed.key)) {
    const codeMatch = e.code === `Digit${parsed.key}` || e.code === `Numpad${parsed.key}`;
    if (!codeMatch && normalizedEvent !== parsed.key) return false;
  } else if (normalizedParsed !== normalizedEvent) {
    return false;
  }

  return parsed.meta === e.metaKey && parsed.ctrl === e.ctrlKey
    && parsed.shift === e.shiftKey && parsed.alt === e.altKey;
}

function isEditableTarget(e) {
  const tag = e.target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
}

/**
 * @param {Object} shortcuts - { 'Combo': { handler, label, section, allowInEditable } }
 * @param {Object} options - { when: boolean }
 */
export default function useHotkeys(shortcuts, options = {}) {
  const { when = true } = options;
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!when) return;
    const id = ++registryId;
    const entries = Object.entries(shortcuts).map(([combo, config]) => ({
      combo, label: config.label || combo, section: config.section || 'General',
    }));
    registry.set(id, entries);
    return () => { registry.delete(id); };
  }, [when, Object.keys(shortcuts).join(',')]);

  useEffect(() => {
    if (!when) return;
    // Pre-parse combos for matching, but read handlers from ref at event time
    const comboKeys = Object.keys(shortcutsRef.current);
    const parsedCombos = comboKeys.map(combo => ({ combo, parsed: parseCombo(combo) }));

    function handler(e) {
      const current = shortcutsRef.current;
      for (const { combo, parsed: p } of parsedCombos) {
        const config = current[combo];
        if (!config) continue;
        if (matchesEvent(p, e)) {
          if (isEditableTarget(e) && !config.allowInEditable) continue;
          e.preventDefault();
          config.handler(e);
          return;
        }
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [when]);
}
