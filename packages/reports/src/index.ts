/**
 * @sentinel/reports, support-packet generation. Turns detected issues into an
 * email/ticket draft plus CSV / HTML / JSON artifacts, using per-scenario
 * templates (PRD §N). Never emits lyric text or secrets.
 */
export * from './model';
export * from './templates';
export * from './render';
export * from './packet';
