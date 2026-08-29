import type { PacketTemplateId, SupportPacketData } from './model';

export interface RenderedTemplate {
  subject: string;
  body: string;
}

type TemplateFn = (data: SupportPacketData) => RenderedTemplate;

const attachmentsNote = `Attached is a CSV containing, for each affected track:
- release title
- track title
- ISRC
- UPC
- distributor release URL
- release date
- expected platform selection/status
- evidence notes
- confidence score
- scan timestamp`;

const TEMPLATES: Record<PacketTemplateId, TemplateFn> = {
  // 1, the flagship DistroKid → Audiomack reinstatement packet (PRD §N.1).
  'distrokid-missing-audiomack': (d) => ({
    subject: `Audiomack Reinstatement Request, ${d.artistName}, ${d.rows.length} Missing Songs`,
    body: `Hello DistroKid Support,

I am requesting help redelivering or reinstating the following releases/tracks to Audiomack for artist ${d.artistName}. I audited my DistroKid catalog against my confirmed Audiomack artist profile and found ${d.rows.length} tracks expected on Audiomack but not present.

Correct Audiomack artist profile:
${d.audiomackProfileUrl ?? '(please confirm my Audiomack profile URL)'}

Distributor account reference: ${d.distributorAccountRef}
Audit scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Please redeliver/reinstate these tracks to Audiomack or confirm any delivery errors, takedowns, eligibility issues, or account-linking problems preventing delivery.

Thank you.`,
  }),

  // 2
  'wrong-artist-profile': (d) => ({
    subject: `Wrong Artist Profile, ${d.artistName}, ${d.rows.length} affected releases`,
    body: `Hello ${d.targetProvider} Support,

Some of my releases appear under an incorrect artist profile. Please move the releases listed in the attached CSV to my correct profile.

Correct profile: ${d.correctProfileUrl ?? '(provided in CSV)'}
Incorrect profile: ${d.incorrectProfileUrl ?? '(provided in CSV)'}
Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: reassign the listed releases to the correct artist profile.`,
  }),

  // 3
  'duplicate-artist-profile': (d) => ({
    subject: `Duplicate Artist Profile Merge, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

I have multiple artist profiles and my catalog is split between them. Please merge the duplicate profile into my canonical profile.

Canonical profile: ${d.correctProfileUrl ?? d.audiomackProfileUrl ?? '(provided in CSV)'}
Duplicate profile: ${d.incorrectProfileUrl ?? '(provided in CSV)'}
Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: merge profiles and consolidate the listed releases.`,
  }),

  // 4
  'foreign-content-on-profile': (d) => ({
    subject: `Content Misattribution, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

My artist profile lists releases that are not mine and do not match my known aliases or collaborations. Please separate the mismatched content.

My profile: ${d.correctProfileUrl ?? d.audiomackProfileUrl ?? '(provided in CSV)'}
Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: remove/reassign the listed content that is not mine.`,
  }),

  // 5
  'missing-lyrics': (d) => ({
    subject: `Missing Lyrics, ${d.artistName}, ${d.rows.length} tracks`,
    body: `Hello ${d.targetProvider} Support,

The tracks in the attached CSV are missing lyrics (plain and/or synced) that were expected. Please advise on submission or display status.

Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: confirm lyric ingestion/display or advise required formatting corrections.`,
  }),

  // 6
  'credits-not-showing': (d) => ({
    subject: `Credits Not Displaying, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

Submitted songwriter/producer credits are not displaying for the tracks in the attached CSV.

Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: confirm credit delivery and display timelines.`,
  }),

  // 7
  'metadata-rejection': (d) => ({
    subject: `Metadata Rejection Assistance, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

The releases in the attached CSV appear to have metadata issues (artwork, title/artist formatting, collaborator roles, or rights) that may have caused a rejection or block.

Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: identify the specific metadata field(s) needing correction.`,
  }),

  // 8
  'takedown-dispute': (d) => ({
    subject: `Takedown / Copyright Dispute, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

Content I own has been removed or claimed. I am disputing the takedown for the releases listed in the attached CSV and can provide proof of ownership.

Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: review and reinstate the listed content; advise what ownership evidence is required.`,
  }),

  // 9
  'royalty-anomaly': (d) => ({
    subject: `Royalty / Statistics Anomaly, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

Streaming/earnings statistics appear missing, delayed, or inconsistent for the items in the attached CSV.

Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: reconcile reporting for the affected period.`,
  }),

  // 10
  'splits-issue': (d) => ({
    subject: `Splits / Collaborator Issue, ${d.artistName}`,
    body: `Hello ${d.targetProvider} Support,

There is a split/collaborator configuration problem affecting payments for the items in the attached CSV (unaccepted invites, invalid emails, or percentages that do not sum correctly).

Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: help correct the split configuration.`,
  }),

  // Optional Audiomack-side verification packet (PRD §H.10).
  'audiomack-verify': (d) => ({
    subject: `Catalog Verification Request, ${d.artistName}`,
    body: `Hello Audiomack Support,

I distribute via ${d.targetProvider} and some of my catalog does not appear on my Audiomack profile. Please verify ingestion/removal status for the tracks in the attached CSV.

My Audiomack profile: ${d.audiomackProfileUrl ?? '(provided in CSV)'}
Scan timestamp: ${d.scanTimestamp}

${attachmentsNote}

Requested action: confirm whether the listed tracks were received, are pending, were removed, or were never delivered.`,
  }),
};

export function renderTemplate(data: SupportPacketData): RenderedTemplate {
  const fn = TEMPLATES[data.template];
  if (!fn) throw new Error(`Unknown support packet template: ${data.template}`);
  const rendered = fn(data);
  // Allow callers to override the human-facing requested action / summary.
  if (data.requestedAction) {
    rendered.body += `\n\nAdditional notes: ${data.requestedAction}`;
  }
  return rendered;
}

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as PacketTemplateId[];
