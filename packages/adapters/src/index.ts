/**
 * @sentinel/adapters, distributor & DSP adapter contracts plus implementations.
 * Runtime implementations use real imports and upstream APIs.
 * Scaffolded (capability-flagged, throw-until-implemented): the rest.
 */
export * from './types';
export * from './csv';
export * from './rate-limit';
export * from './platform-names';
export * from './distributor/column-map';
export * from './distributor/generic-csv';
export * from './distributor/distrokid';
export * from './stores';
export * from './lyrics/lrclib';
export * from './lyrics/web-lyrics';
export * from './registry';
