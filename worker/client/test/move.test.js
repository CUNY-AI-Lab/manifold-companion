import { describe, expect, it } from 'vitest';
import { moveMessage } from '../src/pages/ProjectPage.jsx';

describe('the move confirmation', () => {
  it('says what goes, that comments are deleted and why, and whose storage it becomes', () => {
    const msg = moveMessage({ totals: { texts: 2, pages: 7, versions: 3, comments: 4, bytes: 3 * 1048576 }, destination: { name: 'Thesis', same_owner: false } });
    expect(msg).toContain('Move 2 texts (7 pages, 3 saved versions, 3.0 MB) to “Thesis”?');
    expect(msg).toContain('version history, metadata and model settings go with them');
    expect(msg).toContain('links to them stop working');
    expect(msg).toContain('Their 4 comments will be deleted: comments stay with the project whose members they were written for.');
    expect(msg).toContain('storage counts against the owner of “Thesis”');
  });
  it('one text, no comments, same owner', () => {
    const msg = moveMessage({ totals: { texts: 1, pages: 1, versions: 0, comments: 0, bytes: 2048 }, destination: { name: 'B', same_owner: true } });
    expect(msg).toContain('Move 1 text (1 page, 0 saved versions, 2 KB) to “B”?');
    expect(msg).toContain('They have no comments.');
    expect(msg).not.toContain('storage counts');
  });
});
