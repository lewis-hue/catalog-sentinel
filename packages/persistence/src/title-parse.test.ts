import { describe, it, expect } from 'vitest';
import { parseReleaseTitle } from './title-parse';

describe('parseReleaseTitle, separates title / version / type / artists', () => {
  it('splits legacy "Title Type Artists" with a null artist', () => {
    expect(parseReleaseTitle('Feelings Single Lewis KE, Boeyylee', null)).toEqual({
      title: 'Feelings', version: null, releaseType: 'Single', primaryArtist: 'Lewis KE', featuredArtists: ['Boeyylee'],
    });
  });

  it('lifts a parenthesised version out (Sped Up, Remix, …)', () => {
    expect(parseReleaseTitle('Feelings (Sped Up) Single Lewis KE', null)).toEqual({
      title: 'Feelings', version: 'Sped Up', releaseType: 'Single', primaryArtist: 'Lewis KE', featuredArtists: [],
    });
    expect(parseReleaseTitle('Waves (Slowed Down) Single Artist', null)).toMatchObject({ title: 'Waves', version: 'Slowed Down', releaseType: 'Single' });
    expect(parseReleaseTitle('Waves [Remix] EP Artist', null)).toMatchObject({ title: 'Waves', version: 'Remix', releaseType: 'EP' });
  });

  it('handles multi-word titles', () => {
    expect(parseReleaseTitle('A Thousand Nights Single Lewis KE', null)).toMatchObject({
      title: 'A Thousand Nights', releaseType: 'Single', primaryArtist: 'Lewis KE',
    });
  });

  it('is a near no-op for the newer clean shape (title clean, artist known)', () => {
    expect(parseReleaseTitle('Feelings', 'Lewis KE, Boeyylee')).toEqual({
      title: 'Feelings', version: null, releaseType: null, primaryArtist: 'Lewis KE', featuredArtists: ['Boeyylee'],
    });
    expect(parseReleaseTitle('Never The Same', 'Lewis KE')).toMatchObject({ title: 'Never The Same', primaryArtist: 'Lewis KE', featuredArtists: [] });
  });

  it('lifts a version from a clean title when the artist is known', () => {
    expect(parseReleaseTitle('Feelings (Pitched Up)', 'Lewis KE')).toMatchObject({ title: 'Feelings', version: 'Pitched Up', primaryArtist: 'Lewis KE' });
  });

  it('splits featured artists on feat./ft./&', () => {
    expect(parseReleaseTitle('Song Single Alice feat. Bob & Carol', null)).toMatchObject({
      title: 'Song', releaseType: 'Single', primaryArtist: 'Alice', featuredArtists: ['Bob', 'Carol'],
    });
  });

  it('splits multi-track releases stated as "<N> tracks"', () => {
    expect(parseReleaseTitle('All I Want for Christmas 4 tracks Lewis KE', null)).toMatchObject({
      title: 'All I Want for Christmas', primaryArtist: 'Lewis KE', featuredArtists: [],
    });
    expect(parseReleaseTitle('Classics 2023 8 tracks Lewis KE', null)).toMatchObject({ title: 'Classics 2023', primaryArtist: 'Lewis KE' });
  });

  it('pulls a "(feat. …)" parenthetical out of the title into featured artists', () => {
    expect(parseReleaseTitle('Arsonist (feat. Calvo Madili) Single Lewis KE', null)).toEqual({
      title: 'Arsonist', version: null, releaseType: 'Single', primaryArtist: 'Lewis KE', featuredArtists: ['Calvo Madili'],
    });
  });

  it('leaves an untagged title untouched rather than guessing', () => {
    expect(parseReleaseTitle('Just A Title', null)).toEqual({
      title: 'Just A Title', version: null, releaseType: null, primaryArtist: null, featuredArtists: [],
    });
  });

  it('does not mistake ordinary words for a variant', () => {
    // "Live" only counts as a variant inside (…)/[…] or after " - ", not as a plain title word.
    expect(parseReleaseTitle('Live Your Life', 'Artist')).toMatchObject({ title: 'Live Your Life', version: null });
  });
});
