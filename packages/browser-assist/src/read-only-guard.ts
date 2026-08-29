import type { BrowserContext, Request, Route } from 'playwright';

/**
 * Read-only guard (PRD security rule: "cannot edit/delete/add releases").
 *
 * Defense in depth. The extraction code never triggers a mutating action, and on
 * top of that this guard intercepts every request and ABORTS anything that looks
 * like a catalog mutation (non-idempotent method to a mutation-shaped path). Any
 * blocked attempt is recorded so it is auditable. Login/auth POSTs the USER
 * performs on the sign-in page are allowed; catalog-mutation verbs are not.
 */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const MUTATION_PATH_RE =
  /(delete|remove|takedown|take-down|update|edit|create|add|upload|store[s]?\/(add|select|update)|move|transfer|publish|unpublish|withdraw|takedowns|deliver|redeliver)/i;

// Auth/session endpoints the user legitimately hits while logging in themselves.
const AUTH_ALLOW_RE = /(signin|sign-in|login|log-in|auth|session|oauth|token|captcha|challenge|cdn-cgi|recaptcha|turnstile)/i;

/**
 * Pure decision function (unit-tested). A mutation-shaped request is blocked
 * during extraction always, and before extraction unless it is an auth request
 * the user needs to log in. Read (GET/HEAD) requests are never blocked.
 */
export function shouldBlockRequest(method: string, url: string, extractionMode: boolean, postData?: string | null): boolean {
  const upper = method.toUpperCase();
  if (!MUTATION_METHODS.has(upper)) return false; // GET/HEAD are always reads
  const looksLikeMutation = MUTATION_PATH_RE.test(url);
  const isAuth = AUTH_ALLOW_RE.test(url);
  if (extractionMode) {
    // Block by mutation INTENT, not by "any POST". A blanket POST block is fail-safe on paper but
    // makes real extraction impossible: distributor SPAs (DistroKid included) load per-release
    // catalogue data via READ POSTs, and blocking those starves the network-first capture so
    // every release times out with zero data. Read-only means "never change the account", not
    // "never send a POST".
    //
    //  - PUT/PATCH/DELETE are mutations by HTTP semantics → always blocked. Catalogue reads never
    //    use them.
    //  - GraphQL carries intent in the BODY, not the path → parse it: allow a lone query, block a
    //    mutation (or anything we cannot prove is a query).
    //  - Any other POST → intent is in the PATH → block only a mutation-shaped path; a read POST
    //    (a data fetch) is observed, never a state change.
    if (upper !== 'POST') return true;
    if (isGraphqlEndpoint(url)) return !isExplicitReadQuery(url, postData);
    return looksLikeMutation;
  }
  return looksLikeMutation && !isAuth;
}

function isGraphqlEndpoint(url: string): boolean {
  return /\/graphql(?:[/?#]|$)/i.test(url);
}

function isExplicitReadQuery(url: string, postData?: string | null): boolean {
  if (!/\/graphql(?:[/?#]|$)/i.test(url) || !postData) return false;
  try {
    const body = JSON.parse(postData) as { query?: unknown; operationName?: unknown };
    // Persisted-query operation names are not evidence of semantics: a mutation can be registered
    // under any friendly-looking name. Require and parse the actual executable document.
    if (typeof body.query !== 'string' || body.query.trim().length === 0) return false;
    const operations = parseGraphqlOperations(body.query);
    if (!operations || operations.length === 0) return false;
    const selectedName = typeof body.operationName === 'string' && body.operationName.length > 0
      ? body.operationName
      : null;
    if (selectedName) {
      const selected = operations.filter((operation) => operation.name === selectedName);
      return selected.length === 1 && selected[0]?.type === 'query';
    }
    // GraphQL requires operationName for a multi-operation document. Fail closed instead of
    // guessing which operation the server will execute.
    return operations.length === 1 && operations[0]?.type === 'query';
  } catch {
    return false;
  }
}

type GraphqlOperationType = 'query' | 'mutation' | 'subscription';
interface GraphqlOperation { type: GraphqlOperationType; name: string | null }
interface GraphqlToken { kind: 'name' | 'punct' | 'literal'; value: string }

/** Small fail-closed executable-document parser. It deliberately understands only the syntax
 * needed to identify top-level operations; any malformed or unfamiliar construct is rejected. */
function parseGraphqlOperations(source: string): GraphqlOperation[] | null {
  const tokens = tokenizeGraphql(source);
  if (!tokens) return null;
  const operations: GraphqlOperation[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token?.value === '{') {
      operations.push({ type: 'query', name: null });
      index = skipBalanced(tokens, index, '{', '}');
      if (index < 0) return null;
      continue;
    }
    if (token?.kind !== 'name') return null;
    if (token.value === 'fragment') {
      // fragment Name on Type [directives] { selection }
      if (tokens[index + 1]?.kind !== 'name' || tokens[index + 2]?.value !== 'on' || tokens[index + 3]?.kind !== 'name') return null;
      index += 4;
      index = skipDirectives(tokens, index);
      if (index < 0 || tokens[index]?.value !== '{') return null;
      index = skipBalanced(tokens, index, '{', '}');
      if (index < 0) return null;
      continue;
    }
    if (token.value !== 'query' && token.value !== 'mutation' && token.value !== 'subscription') return null;
    const type = token.value as GraphqlOperationType;
    index += 1;
    let name: string | null = null;
    if (tokens[index]?.kind === 'name') {
      name = tokens[index]!.value;
      index += 1;
    }
    if (tokens[index]?.value === '(') {
      index = skipBalanced(tokens, index, '(', ')');
      if (index < 0) return null;
    }
    index = skipDirectives(tokens, index);
    if (index < 0 || tokens[index]?.value !== '{') return null;
    operations.push({ type, name });
    index = skipBalanced(tokens, index, '{', '}');
    if (index < 0) return null;
  }
  return operations;
}

function skipDirectives(tokens: GraphqlToken[], start: number): number {
  let index = start;
  while (tokens[index]?.value === '@') {
    if (tokens[index + 1]?.kind !== 'name') return -1;
    index += 2;
    if (tokens[index]?.value === '(') {
      index = skipBalanced(tokens, index, '(', ')');
      if (index < 0) return -1;
    }
  }
  return index;
}

function skipBalanced(tokens: GraphqlToken[], start: number, open: string, close: string): number {
  if (tokens[start]?.value !== open) return -1;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) depth += 1;
    else if (tokens[index]?.value === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function tokenizeGraphql(source: string): GraphqlToken[] | null {
  const tokens: GraphqlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s|,/.test(char)) { index += 1; continue; }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (char === '"') {
      const block = source.slice(index, index + 3) === '"""';
      index += block ? 3 : 1;
      let closed = false;
      while (index < source.length) {
        if (block && source.slice(index, index + 3) === '"""') { index += 3; closed = true; break; }
        if (!block && source[index] === '"') { index += 1; closed = true; break; }
        if (source[index] === '\\') index += 2;
        else index += 1;
      }
      if (!closed) return null;
      tokens.push({ kind: 'literal', value: '<string>' });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) index += 1;
      tokens.push({ kind: 'name', value: source.slice(start, index) });
      continue;
    }
    if ('!$():=@[]{}|&.'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (/[+0-9-]/.test(char)) {
      const start = index++;
      while (index < source.length && /[+0-9.eE-]/.test(source[index]!)) index += 1;
      tokens.push({ kind: 'literal', value: source.slice(start, index) });
      continue;
    }
    return null;
  }
  return tokens;
}

export interface BlockedAttempt {
  method: string;
  url: string;
  at: string;
}

export interface ReadOnlyGuard {
  readonly blocked: BlockedAttempt[];
  /** Switch to strict extraction mode: block ALL mutating verbs, not just auth-exempt. */
  enterExtractionMode(): void;
  /** Remove this guard's exact Playwright route handler. Safe to call more than once. */
  dispose(): Promise<void>;
}

export async function installReadOnlyGuard(
  context: BrowserContext,
  opts: { nowIso?: () => string } = {},
): Promise<ReadOnlyGuard> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const blocked: BlockedAttempt[] = [];
  let extractionMode = false;
  let disposed = false;

  const routeHandler = (route: Route, request: Request) => {
    const method = request.method().toUpperCase();
    const url = request.url();
    if (shouldBlockRequest(method, url, extractionMode, request.postData())) {
      blocked.push({ method, url: sanitizedUrl(url), at: nowIso() });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  };

  await context.route('**/*', routeHandler);

  return {
    blocked,
    enterExtractionMode() {
      extractionMode = true;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await context.unroute('**/*', routeHandler);
    },
  };
}

function sanitizedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '{id}')
      .replace(/\/\d{5,}(?=\/|$)/g, '/{id}')}`;
  } catch {
    return '(invalid-url)';
  }
}
