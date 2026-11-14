import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/components/CommentsPanel.jsx';

describe('comment times', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const ago = (s) => new Date(now - s * 1000).toISOString();
  it('read as a conversation, then as a date after a week', () => {
    expect(relativeTime(ago(10), now)).toBe('just now');
    expect(relativeTime(ago(60), now)).toBe('1 minute ago');
    expect(relativeTime(ago(60 * 25), now)).toBe('25 minutes ago');
    expect(relativeTime(ago(3600 * 3), now)).toBe('3 hours ago');
    expect(relativeTime(ago(86400), now)).toBe('yesterday');
    expect(relativeTime(ago(86400 * 4), now)).toBe('4 days ago');
    expect(relativeTime(ago(86400 * 30), now)).not.toMatch(/ago/);
    expect(relativeTime('not a date', now)).toBe('not a date');
  });
});
