/**
 * @sentinel/browser-link — attended cloud-browser provider abstraction. The user
 * logs into their distributor inside an isolated remote browser; the backend only
 * attaches automation after the user confirms login. Provider secrets stay
 * server-side; state refs are envelope-encrypted.
 */
export * from './types';
export * from './page-helpers';
export * from './cloud-live-provider';
export * from './factory';
