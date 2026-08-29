import { describe, expect, it } from 'vitest';
import { failureReasonSummary } from './failure-reasons';

describe('failureReasonSummary', () => {
  it('admits reviewed release, catalog-index, and pipeline codes', () => {
    expect(failureReasonSummary({
      TIMEOUT: 2,
      NO_RECOGNIZABLE_RELEASES: 1,
      PIPELINE_DEADLINE_EXCEEDED: 3,
    })).toBe(
      'TIMEOUT 2, NO_RECOGNIZABLE_RELEASES 1, PIPELINE_DEADLINE_EXCEEDED 3',
    );
  });

  it('coalesces unexpected keys without rendering their text', () => {
    const summary = failureReasonSummary({
      ACCESS_TOKEN_PRIVATE_VALUE: 1,
      'provider response detail': 2,
      timeout: 4,
      REQUEST_FAILED: 0,
      PARSE_FAILED: Number.NaN,
    });

    expect(summary).toBe('UNCLASSIFIED_FAILURE 3, TIMEOUT 4');
    expect(summary).not.toContain('PRIVATE_VALUE');
    expect(summary).not.toContain('provider response');
  });
});
