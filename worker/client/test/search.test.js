import { describe, expect, it } from 'vitest';
import { groupByProject } from '../src/pages/SearchPage.jsx';

describe('search results by project', () => {
  it('projects in the order of their best hit, texts in rank order', () => {
    const hits = [
      { text_id: 'a', project_id: 'P2', project_name: 'Two' },
      { text_id: 'b', project_id: 'P1', project_name: 'One' },
      { text_id: 'c', project_id: 'P2', project_name: 'Two' },
    ];
    expect(groupByProject(hits).map((g) => [g.project_name, g.hits.map((h) => h.text_id)])).toEqual([['Two', ['a', 'c']], ['One', ['b']]]);
    expect(groupByProject([])).toEqual([]);
  });
});
