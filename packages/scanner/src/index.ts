/**
 * @sentinel/scanner — distributor deep-scan. Scanner contract + DistroKid adapter
 * (resilient locators), canonical normalization, issue detection, and the
 * rate-limited, resumable orchestration used by the deep-scan worker.
 */
export * from './types';
export * from './distrokid-scanner';
export * from './normalization';
export * from './issue-detection';
export * from './orchestrate';
