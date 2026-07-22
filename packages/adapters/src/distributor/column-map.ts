/**
 * Fuzzy header mapping for distributor CSV exports. DistroKid, TuneCore, CD Baby
 * and friends all label columns differently; we map each logical field from a
 * list of aliases against a normalized header key.
 */
export type LogicalColumn =
  | 'trackTitle'
  | 'releaseTitle'
  | 'primaryArtist'
  | 'featuredArtists'
  | 'isrc'
  | 'upc'
  | 'releaseDate'
  | 'uploadDate'
  | 'distributorUrl'
  | 'releaseId'
  | 'trackNumber'
  | 'duration'
  | 'isExplicit'
  | 'stores'
  | 'plainLyrics'
  | 'syncedLyrics'
  | 'credits'
  | 'songwriter'
  | 'producer'
  | 'label'
  | 'audiomackFlag';

const ALIASES: Record<LogicalColumn, string[]> = {
  trackTitle: ['tracktitle', 'songtitle', 'title', 'track', 'song', 'trackname', 'songname'],
  releaseTitle: ['releasetitle', 'albumtitle', 'album', 'release', 'ep', 'project', 'releasename'],
  primaryArtist: ['artist', 'artistname', 'primaryartist', 'band', 'performer', 'mainartist'],
  featuredArtists: ['featuredartists', 'featuring', 'feat', 'features', 'featartist'],
  isrc: ['isrc', 'isrccode'],
  upc: ['upc', 'ean', 'barcode', 'upcean', 'gtin'],
  releaseDate: ['releasedate', 'released', 'date', 'releaseday', 'saledate'],
  uploadDate: ['uploaddate', 'uploaded', 'dateuploaded', 'dateadded', 'addeddate', 'created', 'createdon', 'submitteddate', 'datesubmitted'],
  distributorUrl: ['distrokidurl', 'releaseurl', 'songurl', 'url', 'link', 'storelink', 'landingpage'],
  releaseId: ['releaseid', 'albumid', 'uuid', 'id'],
  trackNumber: ['tracknumber', 'trackno', 'tracknum', 'trackindex', 'seq'],
  duration: ['duration', 'length', 'durations', 'seconds', 'runtime', 'durationseconds'],
  isExplicit: ['explicit', 'explicitlyrics', 'parentaladvisory', 'iexplicit'],
  stores: ['stores', 'selectedstores', 'storesselected', 'deliveredto', 'platforms', 'shops'],
  plainLyrics: ['plainlyrics', 'lyrics', 'haslyrics', 'lyricssubmitted', 'lyricsstatus'],
  syncedLyrics: ['syncedlyrics', 'timesyncedlyrics', 'synced', 'timedlyrics'],
  credits: ['credits', 'creditsstatus', 'hascredits'],
  songwriter: ['songwriter', 'songwriters', 'writer', 'writers', 'composer'],
  producer: ['producer', 'producers'],
  label: ['label', 'recordlabel'],
  audiomackFlag: ['audiomack', 'audiomackoptin', 'audiomackselected'],
};

function normKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export type ColumnMap = Partial<Record<LogicalColumn, string>>;

/** Resolve logical columns to actual header names present in the CSV. */
export function resolveColumns(headers: string[]): ColumnMap {
  const normalized = new Map<string, string>(); // normKey -> original header
  for (const h of headers) normalized.set(normKey(h), h);

  const map: ColumnMap = {};
  for (const [logical, aliases] of Object.entries(ALIASES) as Array<[LogicalColumn, string[]]>) {
    for (const alias of aliases) {
      const hit = normalized.get(alias);
      if (hit) {
        map[logical] = hit;
        break;
      }
    }
  }
  return map;
}
