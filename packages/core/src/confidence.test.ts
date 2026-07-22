import { describe, it, expect } from 'vitest';
import { classifyConfidence, requiresManualReview } from './confidence';

describe('classifyConfidence', () => {
  it('maps scores to the PRD §E bands', () => {
    expect(classifyConfidence(1.0)).toBe('confirmed');
    expect(classifyConfidence(0.98)).toBe('confirmed');
    expect(classifyConfidence(0.97)).toBe('strong');
    expect(classifyConfidence(0.9)).toBe('strong');
    expect(classifyConfidence(0.89)).toBe('probable');
    expect(classifyConfidence(0.75)).toBe('probable');
    expect(classifyConfidence(0.74)).toBe('weak');
    expect(classifyConfidence(0.5)).toBe('weak');
    expect(classifyConfidence(0.49)).toBe('no-match');
    expect(classifyConfidence(0)).toBe('no-match');
  });

  it('clamps out-of-range scores', () => {
    expect(classifyConfidence(2)).toBe('confirmed');
    expect(classifyConfidence(-1)).toBe('no-match');
  });

  it('flags fuzzy bands for manual review, never auto-confirms them', () => {
    expect(requiresManualReview('confirmed')).toBe(false);
    expect(requiresManualReview('strong')).toBe(false);
    expect(requiresManualReview('probable')).toBe(true);
    expect(requiresManualReview('weak')).toBe(true);
    expect(requiresManualReview('no-match')).toBe(true);
  });
});
