import type { SearchStore } from '@sentinel/search-store';

/**
 * Catalogue assistant: a Claude-backed helper that answers navigation questions and questions about
 * the user's own scan results. It is grounded ONLY in the user's saved audits (scope key
 * `req.auth.sub`), summarised compactly so a large catalogue stays within a sensible token budget.
 * Fails closed and clearly when no ANTHROPIC_API_KEY is configured.
 */

export interface AssistantConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

/** Read the assistant configuration from the environment. `null` when it is not configured. */
export function assistantConfigFromEnv(env: NodeJS.ProcessEnv): AssistantConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    // Default to the latest Opus; overridable so the model can be tuned without a code change.
    model: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5',
    maxTokens: Number(env.ASSISTANT_MAX_TOKENS) > 0 ? Number(env.ASSISTANT_MAX_TOKENS) : 1024,
  };
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Coerce untrusted request messages into a safe, alternating, user-first transcript. */
export function normalizeMessages(input: unknown): AssistantMessage[] {
  if (!Array.isArray(input)) return [];
  const out: AssistantMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    const text = content.trim().slice(0, 4000);
    if (text) out.push({ role, content: text });
  }
  // Anthropic requires the transcript to begin with a user turn.
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out.slice(-16);
}

const APP_KNOWLEDGE = `You are the catalogue assistant inside Catalog Sentinel, a read-only tool that verifies where an independent artist's or label's distributed tracks are live across music stores, catches wrong-profile/namesake matches, and prepares distributor-ready evidence.

The views a user can navigate to:
- Overview: catalogue health at a glance.
- Health score: the weighted score for an audit.
- Catalogue: every release and its artwork.
- Store health: store-by-store coverage per track, with evidence.
- Identity guardian: wrong-profile and namesake checks.
- Release alerts: what changed between audits.
- Audit history: every saved audit.
- Connect distributor: link a distributor over an attended browser to read the catalogue.
- One-click fixer: prepared corrections for issues.
- Manual review: triage queue for verdicts needing a human.
- Support center: evidence packets and copy-ready distributor tickets.

Verdict vocabulary (be precise):
- "confirmed live": verified present on the store.
- "not confirmed" (notLive): could not be confirmed present. It is NOT the same as "definitely missing".
- "wrong profile": found under the wrong artist profile (a namesake).
- "unverifiable" / "needs review": evidence was too weak to decide; NEVER assert a release is missing from unverifiable evidence.

How you answer:
- Ground every claim about the user's releases in the AUDIT DATA below. If the data does not contain the answer, say so plainly and suggest which view or scan would surface it.
- Be concise and specific; prefer exact counts, store names, track titles, and ISRCs from the data.
- To fix a wrong profile, point to Identity guardian / Manual review; to chase a not-confirmed store, point to Support center for a distributor ticket.
- Never fabricate releases, stores, or numbers. Never claim a store is missing a release on unverifiable evidence.`;

interface Aggregate { live: number; notLive: number; wrong: number; unver: number }

/** Build a compact, token-bounded grounding block from ALL the user's audits (newest first). */
export async function buildGroundingContext(
  store: SearchStore,
  userId: string,
  opts: { overviewLimit?: number; detailAudits?: number; sampleIssues?: number } = {},
): Promise<string> {
  const overviewLimit = opts.overviewLimit ?? 40;
  const detailAudits = opts.detailAudits ?? 3;
  const sampleIssues = opts.sampleIssues ?? 12;

  const summaries = await store.listForUser(userId);
  if (summaries.length === 0) {
    return 'AUDIT DATA: The user has no saved audits yet. Encourage them to run a scan from Connect distributor.';
  }

  const lines: string[] = [`AUDIT DATA: ${summaries.length} saved audit(s), newest first.`];
  for (const s of summaries.slice(0, overviewLimit)) {
    const c = s.summary;
    lines.push(
      `- ${s.createdAt.slice(0, 10)} | ${s.artist} (${s.distributor}) | ${c.tracks} tracks: ` +
        `${c.live} confirmed live, ${c.notLive} not confirmed, ${c.wrongProfile} wrong-profile, ${c.needsReview} need review` +
        ` | stores: ${s.stores.join(', ') || 'none'} | audit id ${s.id}`,
    );
  }

  for (const summary of summaries.slice(0, detailAudits)) {
    const record = await store.get(summary.id);
    if (!record) continue;
    const perStore = new Map<string, Aggregate>();
    const issues: string[] = [];
    for (const track of record.result.tracks) {
      for (const cell of track.perStore) {
        const agg = perStore.get(cell.store) ?? { live: 0, notLive: 0, wrong: 0, unver: 0 };
        if (cell.status === 'live') agg.live += 1;
        else if (cell.status === 'not-live') {
          agg.notLive += 1;
          if (issues.length < sampleIssues) issues.push(`"${track.title}" (${track.isrc ?? 'no ISRC'}) not confirmed on ${cell.store}`);
        } else if (cell.status === 'wrong-profile') {
          agg.wrong += 1;
          if (issues.length < sampleIssues) issues.push(`"${track.title}" wrong profile on ${cell.store}`);
        } else {
          agg.unver += 1;
        }
        perStore.set(cell.store, agg);
      }
    }
    lines.push('', `Detail for audit ${summary.id} (${record.artist}, ${record.createdAt.slice(0, 10)}):`);
    const stores = [...perStore.entries()].map(([s, a]) => `${s} ${a.live} live/${a.notLive} not-confirmed/${a.wrong} wrong/${a.unver} unverifiable`);
    if (stores.length) lines.push('  Per-store: ' + stores.join('; '));
    if (issues.length) lines.push('  Sample issues: ' + issues.join('; '));
  }

  return lines.join('\n');
}

/**
 * Open a streaming Claude completion. Resolves once the upstream response is confirmed OK (so the
 * route can still return a clean error before it starts streaming); throws otherwise. The caller
 * pipes the body through {@link parseSseDeltas}.
 */
export async function openAssistantStream(
  config: AssistantConfig,
  grounding: string,
  messages: AssistantMessage[],
): Promise<Response> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: `${APP_KNOWLEDGE}\n\n${grounding}`,
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`assistant upstream ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response;
}

/** Parse Anthropic's message-stream SSE, yielding only the text deltas. */
export async function* parseSseDeltas(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of event.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt: { type?: string; delta?: { type?: string; text?: string } };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
          yield evt.delta.text;
        }
      }
    }
  }
}
