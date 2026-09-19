import type { FastifyInstance } from 'fastify';
import type { SearchStore } from '@sentinel/search-store';
import { requireAuth } from './auth';
import { assistantConfigFromEnv, buildGroundingContext, normalizeMessages, openAssistantStream, parseSseDeltas } from './assistant';
import { looksLikeMisuse, MISUSE_REFUSAL } from './assistant-guardrails';
import type { AssistantConversationStore } from './assistant-store';

/** Turn an upstream failure into an honest, non-leaky user message. */
function assistantErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/\b429\b|insufficient_quota|\bquota\b|\bcredit|overloaded|rate.?limit/i.test(message)) {
    return 'The assistant’s AI provider is rate-limited or out of credits. Try again shortly, or check the provider account.';
  }
  if (/\b401\b|invalid_api_key|invalid x-api-key|unauthor|authentication/i.test(message)) {
    return 'The assistant’s API key was rejected. Check ANTHROPIC_API_KEY on the API service.';
  }
  return 'The assistant is temporarily unavailable. Try again in a moment.';
}

/**
 * Catalogue assistant route. Grounded in the caller's own audits (scope key `req.auth.sub`); returns
 * a clear, non-error signal when the assistant is not configured so the UI can invite adding a key.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  searchStore: SearchStore,
  assistantStore: AssistantConversationStore | null,
): void {
  // Lets the UI show an "add a key to enable" state without a failed request.
  app.get('/api/assistant/status', { preHandler: requireAuth() }, async () => ({
    enabled: assistantConfigFromEnv(process.env) !== null,
  }));

  app.post('/api/assistant', { preHandler: requireAuth() }, async (req, reply) => {
    const config = assistantConfigFromEnv(process.env);
    if (!config) {
      return reply.status(503).send({ error: 'The assistant is not configured. Set ANTHROPIC_API_KEY to enable it.' });
    }
    const messages = normalizeMessages((req.body as { messages?: unknown } | undefined)?.messages);
    if (messages.length === 0) return reply.status(400).send({ error: 'Ask a question to start.' });

    // Input guardrail (pre-generation): screen the latest user turn for prompt-injection / jailbreak
    // before any model call. Refuse politely, on-domain, as a normal answer.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser && looksLikeMisuse(lastUser.content)) {
      return reply.type('text/plain; charset=utf-8').send(MISUSE_REFUSAL);
    }

    // Confirm the upstream stream is open BEFORE hijacking, so a failure here is still a clean 502.
    let stream: Response;
    try {
      const grounding = await buildGroundingContext(searchStore, req.auth.sub);
      stream = await openAssistantStream(config, grounding, messages);
    } catch (err) {
      req.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'assistant request failed');
      return reply.status(502).send({ error: assistantErrorMessage(err) });
    }

    // Stream the answer as plain text; the web BFF forwards this body straight through to the browser.
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    let answer = '';
    try {
      for await (const delta of parseSseDeltas(stream, config.provider)) {
        answer += delta;
        reply.raw.write(delta);
      }
    } catch (err) {
      req.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'assistant stream failed');
      reply.raw.write('\n\n[The answer was cut off. Please try again.]');
    } finally {
      reply.raw.end();
    }

    // Persist to the dedicated, tenant-scoped assistant database (best-effort; never blocks the reply).
    if (assistantStore && lastUser && answer.trim()) {
      void assistantStore
        .logInteraction({ tenantId: req.auth.tenantId, userId: req.auth.sub, question: lastUser.content, answer, model: config.model })
        .catch((err) => req.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'assistant log failed'));
    }
  });
}
