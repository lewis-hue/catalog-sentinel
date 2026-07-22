import { describe, expect, it } from 'vitest';
import { mergeHistoryRows } from './history-pagination';

describe('audit history page merging', () => {
  it('keeps newest-first order and removes records repeated at a page boundary or retry', () => {
    expect(mergeHistoryRows(
      [{ id: 'newest' }, { id: 'boundary' }],
      [{ id: 'boundary' }, { id: 'older' }, { id: 'older' }],
    )).toEqual([{ id: 'newest' }, { id: 'boundary' }, { id: 'older' }]);
  });
});
