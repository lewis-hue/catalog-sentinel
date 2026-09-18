import type { FastifyInstance } from 'fastify';
import type { SearchStore } from '@sentinel/search-store';
import { requireAuth } from './auth';
import { askAssistant, assistantConfigFromEnv, buildGroundingContext, normalizeMessages } from './assistant';

/**
 * Catalogue assistant route. Grounded in the caller's own audits (scope key `req.auth.sub`); returns
 * a clear, non-error signal when the assistant is not configured so the UI can invite adding a key.
 */
export function registerAssistantRoutes(app: FastifyInstance, searchStore: SearchStore): void {
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

    try {
      const grounding = await buildGroundingContext(searchStore, req.auth.sub);
      const answer = await askAssistant(config, grounding, messages);
      return { answer };
    } catch (err) {
      req.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'assistant request failed');
      return reply.status(502).send({ error: 'The assistant is temporarily unavailable. Try again in a moment.' });
    }
  });
}
