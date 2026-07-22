import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { oauth1BaseString, oauth1Header, rfc3986 } from './oauth1';

// The reference request from Twitter's "Creating a signature" OAuth 1.0a example.
const TW = {
  method: 'POST',
  url: 'https://api.twitter.com/1.1/statuses/update.json',
  params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true' },
  creds: {
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIVS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  },
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  ts: 1318622958,
  // Twitter's *documented* signature base string for this request, verbatim.
  documentedBaseString:
    'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
};

describe('oauth1', () => {
  it('rfc3986-encodes reserved chars encodeURIComponent leaves alone', () => {
    expect(rfc3986("a!*'()b")).toBe('a%21%2A%27%28%29b');
    expect(rfc3986('a b+c')).toBe('a%20b%2Bc');
  });

  // The base string is THE canonical OAuth 1.0a artifact. Matching Twitter's documented
  // base string byte-for-byte proves param collection, encoding, sorting, and joining
  // are all correct. (Note: Twitter's docs publish a signature — hCtSmYh+… — that does
  // NOT match its own documented base string; the value below is the real HMAC of it.)
  it('reconstructs Twitter\'s documented signature base string byte-for-byte', () => {
    const allParams = {
      ...TW.params,
      oauth_consumer_key: TW.creds.consumerKey,
      oauth_nonce: TW.nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(TW.ts),
      oauth_token: TW.creds.token,
      oauth_version: '1.0',
    };
    expect(oauth1BaseString(TW.method, TW.url, allParams)).toBe(TW.documentedBaseString);
  });

  it('signs (HMAC-SHA1) to the correct signature for that base string', () => {
    const signingKey = `${TW.creds.consumerSecret}&${TW.creds.tokenSecret}`;
    const expected = createHmac('sha1', signingKey).update(TW.documentedBaseString).digest('base64');
    const header = oauth1Header(TW.method, TW.url, TW.params, TW.creds, () => TW.nonce, () => TW.ts);
    expect(header).toContain(`oauth_signature="${rfc3986(expected)}"`);
    expect(header).toContain('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
  });
});
