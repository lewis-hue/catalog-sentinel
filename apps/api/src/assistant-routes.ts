import type { FastifyInstance } from 'fastify';
import type { SearchStore } from '@sentinel/search-store';
import { requireAuth } from './auth';
import { assistantConfigFromEnv, buildGroundingContext, normalizeMessages, openAssistantStream, parseSseDeltas } from './assistant';

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
      return reply.status(503).send({ error: 'The assistant is not configured. Set OPENAI_API_KEY to enable it.' });
    }
    const messages = normalizeMessages((req.body as { messages?: unknown } | undefined)?.messages);
    if (messages.length === 0) return reply.status(400).send({ error: 'Ask a question to start.' });

    // Confirm the upstream stream is open BEFORE hijacking, so a failure here is still a clean 502.
    let stream: Response;
    try {
      const grounding = await buildGroundingContext(searchStore, req.auth.sub);
      stream = await openAssistantStream(config, grounding, messages);
    } catch (err) {
      req.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'assistant request failed');
      return reply.status(502).send({ error: 'The assistant is temporarily unavailable. Try again in a moment.' });
    }

    // Stream the answer as plain text; the web BFF forwards this body straight through to the browser.
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    try {
      for await (const delta of parseSseDeltas(stream)) reply.raw.write(delta);
    } catch (err) {
      req.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'assistant stream failed');
      reply.raw.write('\n\n[The answer was cut off. Please try again.]');
    } finally {
      reply.raw.end();
    }
  });
}
